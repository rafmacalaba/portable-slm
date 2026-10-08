import assert from "node:assert/strict";
import { test } from "node:test";
import { fitMessages, lfmTemplateMessages, displayableStream, parseLfmOutput, splitLfmStream, LfmStreamParser, parseLfmToolCalls } from "../src/lfm-output.js";

test("splitLfmStream separates reasoning from content for a live trace", () => {
  assert.deepEqual(splitLfmStream("<think>weighing options"), { reasoning: "weighing options", content: "" });
  // A seeded decode has no opening tag in the generated text.
  assert.deepEqual(splitLfmStream("weighing options", { forceThink: true }), { reasoning: "weighing options", content: "" });
  assert.deepEqual(splitLfmStream("<think>weighed</think>The answer"), { reasoning: "weighed", content: "The answer" });
  assert.deepEqual(splitLfmStream("thought </think>Answer.<|tool_call_start|>[x()]"),
    { reasoning: "thought ", content: "Answer." });
  // displayableStream is the content projection of the same logic
  assert.equal(displayableStream("<think>secret", { forceThink: true }), "");
});

test("stream display hides reasoning and tool markers as they form", () => {
  assert.equal(displayableStream("<think>secret"), "");
  assert.equal(displayableStream("<think>secret</think>The ti"), "The ti");
  assert.equal(displayableStream("Let me check.<|tool_call_start|>[x()]"), "Let me check.");
  assert.equal(displayableStream("Checking<|tool"), "Checking");
  assert.equal(displayableStream("Checking<|tool_call_start|>"), "Checking");
  assert.equal(displayableStream("plain"), "plain");
  assert.equal(displayableStream(""), "");
});

test("malformed calls resync instead of killing the turn", () => {
  // Prose and junk inside the marker block are skipped; a bad call is dropped, not fatal.
  const messy = "I will check.<|tool_call_start|> let me see [bad_call( ] [get_datetime()] <|tool_call_end|>";
  const result = parseLfmOutput(messy);
  assert.equal(result.content, "I will check.");
  assert.deepEqual(result.tool_calls.map((c) => c.function.name), ["get_datetime"]);
  const dropped = parseLfmOutput("<|tool_call_start|>[bad_call(globalThis)]<|tool_call_end|>");
  assert.deepEqual(dropped.tool_calls, []);
});

test("forced-think streams stay hidden until the block closes", () => {
  assert.equal(displayableStream("reasoning mid-stream", { forceThink: true }), "");
  assert.equal(displayableStream("reasoning</think>Answer now", { forceThink: true }), "Answer now");
  // A half-written closing tag must not flash either.
  assert.equal(displayableStream("reasoning</thi", { forceThink: true }), "");
  assert.equal(displayableStream("plain"), "plain");
});

test("LFM chat-template history replays marker content, not OpenAI tool-call metadata", () => {
  const messages = lfmTemplateMessages([
    { role: "system", content: "s" },
    { role: "assistant", content: "<|tool_call_start|>[get_datetime()]<|tool_call_end|>", tool_calls: [{ id: "x", type: "function", function: { name: "get_datetime", arguments: "{}" } }] },
    { role: "tool", content: '{"datetime":"2030-02-14"}', tool_call_id: "x" },
  ]);
  assert.deepEqual(messages, [
    { role: "system", content: "s" },
    { role: "assistant", content: "<|tool_call_start|>[get_datetime()]<|tool_call_end|>" },
    { role: "tool", content: '{"datetime":"2030-02-14"}' },
  ]);
});

test("parses LFM's bracketed function syntax into agent tool_calls", () => {
  const result = parseLfmOutput("<think>Need title.</think><|tool_call_start|>[read_project_field(pointer='/study_desc/title_statement/title')]<|tool_call_end|><|im_end|>");
  assert.equal(result.content, "");
  assert.deepEqual(result.tool_calls, [{
    id: "lfm_1", type: "function",
    function: { name: "read_project_field", arguments: JSON.stringify({ pointer: "/study_desc/title_statement/title" }) },
  }]);
});

test("parses multiple calls and primitive argument types without eval", () => {
  const result = parseLfmOutput("<|tool_call_start|>[calculate(expression='1 + 2', mode='safe', count=2, ok=true, note=None)]<|tool_call_end|>");
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments),
    { expression: "1 + 2", mode: "safe", count: 2, ok: true, note: null });
  const dropped = parseLfmOutput("<|tool_call_start|>[bad(x=globalThis.fetch())]<|tool_call_end|>");
  assert.deepEqual(dropped.tool_calls, []);
});

test("keeps visible answer, strips closed reasoning and terminal markers", () => {
  const result = parseLfmOutput("<think>private reasoning</think>The title is Survey X.<|im_end|>");
  assert.equal(result.content, "The title is Survey X.");
  assert.equal(result.tool_calls.length, 0);
});

test("never exposes a truncated reasoning block and rejects incomplete tool markers", () => {
  assert.deepEqual(parseLfmOutput("<think>private unfinished thoughts"), { transcript: "", content: "", tool_calls: [] });
  assert.equal(parseLfmOutput("private reasoning</think>The title is Survey.").content, "The title is Survey.");
  assert.throws(() => parseLfmOutput("<|tool_call_start|>[read_project_field(pointer='x')"), /Unclosed LFM tool-call marker/);
});

test("stateful parser: content already emitted stays content when a think block opens later", () => {
  // The failure this replaces: streaming showed this prose, then a final re-parse found an unclosed
  // think block and discarded everything — reasoning under an answer, labelled "no text returned".
  const p = new LfmStreamParser();
  assert.deepEqual(p.push("Let me check the variables. "), [{ type: "content", text: "Let me check the variables. " }]);
  assert.deepEqual(p.push("<think>the file has 12"), [{ type: "reasoning", text: "the file has 12" }]);
  assert.deepEqual(p.flush(), []);
  assert.equal(p.content, "Let me check the variables. ");
  assert.equal(p.reasoning, "the file has 12");
});

test("stateful parser: an unclosed think tail is reasoning, never content", () => {
  const p = new LfmStreamParser({ startInThink: true });
  assert.deepEqual(p.push("weighing the options"), [{ type: "reasoning", text: "weighing the options" }]);
  assert.deepEqual(p.flush(), []);
  assert.equal(p.content, "");
  assert.equal(p.reasoning, "weighing the options");
});

test("stateful parser: a marker split across tokens never leaks its fragment", () => {
  const p = new LfmStreamParser();
  assert.deepEqual(p.push("Answer</thi"), [{ type: "content", text: "Answer" }]);
  assert.deepEqual(p.push("nk>done"), [{ type: "content", text: "done" }]);
  assert.equal(p.content, "Answerdone");
});

test("stateful parser: multiple think blocks, and tool markers inside one, stay attributable", () => {
  const p = new LfmStreamParser();
  p.push("first <think>mid");
  p.push("<|tool_call_start|>[calculate(expression='1+1')]<|tool_call_end|>");
  p.push("tail");
  assert.deepEqual(p.flush(), []);
  assert.equal(p.reasoning, "midtail");
  assert.equal(p.content, "first ");
  assert.equal(p.toolText, "<|tool_call_start|>[calculate(expression='1+1')]<|tool_call_end|>");
  assert.deepEqual(parseLfmToolCalls(p.toolText), [{
    id: "lfm_1", type: "function",
    function: { name: "calculate", arguments: JSON.stringify({ expression: "1+1" }) },
  }]);
  // Replay text keeps the markers and drops hidden reasoning.
  assert.match(p.transcript, /^first <\|tool_call_start\|>/);
});

test("stateful parser: a tool call after the think block leaves the answer as content", () => {
  const p = new LfmStreamParser({ startInThink: true });
  p.push("need the title</think>I will read it.<|tool_call_start|>[read_project_field(pointer='/title')]<|tool_call_end|>");
  assert.deepEqual(p.flush(), []);
  assert.equal(p.reasoning, "need the title");
  assert.equal(p.content, "I will read it.");
  assert.equal(parseLfmToolCalls(p.toolText).length, 1);
  assert.equal(p.transcript, "I will read it.<|tool_call_start|>[read_project_field(pointer='/title')]<|tool_call_end|>");
});

test("a truncated tool call is a dropped call, not a failed turn", () => {
  assert.deepEqual(parseLfmToolCalls("<|tool_call_start|>[read_project_field(pointer='x')"), []);
  assert.equal(parseLfmToolCalls("<|tool_call_start|>[read_project_field(pointer='x')]<|tool_call_end|>").length, 1);
});

test("stateful parser: the end-of-turn token is never shown and ends the turn", () => {
  const p = new LfmStreamParser();
  assert.deepEqual(p.push("Here is the answer.<|im_end|>trailing padding"), [
    { type: "content", text: "Here is the answer." },
  ]);
  assert.equal(p.content, "Here is the answer.");
  assert.deepEqual(p.flush(), []);
  assert.deepEqual(p.push("ignored after the stop token"), []);
});

test("stateful parser: a control token split across tokens leaks no fragment", () => {
  const p = new LfmStreamParser();
  assert.deepEqual(p.push("Done.<|im"), [{ type: "content", text: "Done." }]);
  assert.deepEqual(p.push("_end|>"), []);
  assert.equal(p.content, "Done.");
});

test("stateful parser: an unknown control token is dropped, not displayed", () => {
  const p = new LfmStreamParser();
  assert.equal(p.push("a<|weird|>b").map((d) => d.text).join(""), "ab");
  assert.equal(p.content, "ab");
});

// --- fitMessages: a long session degrades instead of the turn being rejected ---

// A stand-in for the tokenizer: one "token" per 10 characters of content plus a fixed per-message cost.
const count = (list) => list.reduce((total, m) => total + 4 + Math.ceil(String(m.content).length / 10), 0);

test("fitMessages drops the oldest exchanges until the transcript fits the budget", () => {
  const messages = [
    { role: "system", content: "S".repeat(100) },
    ...Array.from({ length: 6 }, (_, i) => ([
      { role: "user", content: `question ${i} ${"q".repeat(200)}` },
      { role: "assistant", content: `answer ${i} ${"a".repeat(200)}` },
    ])).flat(),
  ];
  const budget = 120;
  const fitted = fitMessages(messages, count, budget);
  assert.ok(count(fitted.messages) <= budget);
  assert.ok(fitted.dropped > 0);
  assert.equal(fitted.messages[0].role, "system");                       // the system prompt survives
  assert.match(fitted.messages.at(-1).content, /answer 5/);               // the newest exchange survives
  assert.doesNotMatch(JSON.stringify(fitted.messages), /question 0 /);    // the oldest is what goes
  assert.equal(messages.length, 13);                                      // the input is untouched
});

test("fitMessages never orphans a tool result from the call that requested it", () => {
  const messages = [
    { role: "system", content: "S".repeat(40) },
    { role: "user", content: "q0" },
    { role: "assistant", content: "looking", tool_calls: [{ id: "c1" }] },
    { role: "tool", content: "result one ".repeat(40) },
    { role: "tool", content: "result two ".repeat(40) },
    { role: "user", content: "q1" },
    { role: "assistant", content: "done" },
  ];
  const fitted = fitMessages(messages, count, 40);
  assert.equal(fitted.dropped, 2, "the call and both of its results went together");
  assert.equal(fitted.messages[1].role, "user");
  assert.match(fitted.messages[1].content, /q1/);
});

test("fitMessages leaves a transcript that already fits alone", () => {
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
  const fitted = fitMessages(messages, count, 10_000);
  assert.equal(fitted.dropped, 0);
  assert.equal(fitted.messages, messages);
});
