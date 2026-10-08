import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import { calculate, defaultTools } from "../src/tools.js";

const toolCall = (name, args = "{}") => ({
  message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }] },
});
const final = { message: { role: "assistant", content: "Today is 2030-02-14." } };

test("model tool call → validated offline tool → final answer", async () => {
  let calls = 0;
  const events = [];
  const r = await runAgent({
    messages: [{ role: "user", content: "What date is it?" }],
    tools: [{ ...defaultTools()[0], run: async () => ({ datetime: "2030-02-14" }) }],
    complete: async (history, { tools }) => {
      if (calls++ === 0) {
        assert.equal(tools[0].function.name, "get_datetime");
        return toolCall("get_datetime");
      }
      assert.deepEqual(JSON.parse(history.at(-1).content), { datetime: "2030-02-14" });
      return final;
    },
    onTool: (e) => events.push(e.stage),
  });
  assert.equal(r.text, "Today is 2030-02-14.");
  assert.equal(r.toolRounds, 1);
  assert.deepEqual(events, ["call", "result"]);
});

test("surplus calls in one round are dropped, not fatal", async () => {
  const ran = [];
  const events = [];
  const call = (id, expression) => ({ id, type: "function", function: { name: "calculate", arguments: JSON.stringify({ expression }) } });
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "do a lot of math" }],
    tools: [{ ...defaultTools()[1], run: ({ expression }) => { ran.push(expression); return { result: calculate(expression) }; } }],
    complete: async () => (round++ === 0
      ? { message: { role: "assistant", content: "", tool_calls: [call("c1", "1+1"), call("c2", "2+2"), call("c3", "3+3"), call("c4", "4+4"), call("c5", "5+5"), call("c6", "6+6")] } }
      : final),
    onTool: (e) => events.push(e),
  });
  assert.equal(r.text, "Today is 2030-02-14.");
  assert.deepEqual(ran, ["1+1", "2+2", "3+3", "4+4"]); // cap is 4; the rest are dropped
  assert.deepEqual(events.filter((e) => e.stage === "capped"), [{ stage: "capped", dropped: 2 }]);
});

test("a stray tool call on the answer-only round is refused; the text survives if the model repeats it", async () => {
  const r = await runAgent({
    messages: [{ role: "user", content: "what date is it?" }],
    tools: [defaultTools()[0]],
    maxRounds: 1,
    complete: async (_history, { tools }) => (tools.length
      ? toolCall("get_datetime")
      : { message: { role: "assistant", content: "I could not confirm the date.", tool_calls: [{ id: "c9", type: "function", function: { name: "get_datetime", arguments: "{}" } }] } }),
  });
  assert.equal(r.text, "I could not confirm the date.");
  // Round 2 is the retry the refusal asks for; the model repeats itself, so the text is kept rather
  // than the turn ending on nothing.
  assert.equal(r.toolRounds, 2);
});

test("offline hides network tools and refuses invented network calls", async () => {
  let ran = false;
  await assert.rejects(runAgent({
    messages: [{ role: "user", content: "search" }],
    tools: [{ ...defaultTools({ fetch: () => { ran = true; } })[2] }],
    complete: async (_, { tools }) => {
      assert.deepEqual(tools, []);
      return toolCall("wiki_search", '{"query":"secret"}');
    },
  }), /Tool not permitted: wiki_search/);
  assert.equal(ran, false);
});

test("rejects invalid arguments before executing a tool", async () => {
  let ran = false;
  await assert.rejects(runAgent({
    messages: [{ role: "user", content: "math" }],
    tools: [{ ...defaultTools()[1], run: () => { ran = true; } }],
    complete: async () => toolCall("calculate", '{"expression": "2+2", "extra": true}'),
  }), /Unexpected tool argument: extra/);
  assert.equal(ran, false);
});

test("online tools cannot send a query without per-call approval", async () => {
  let requested = false;
  const wiki = defaultTools({ fetch: () => { requested = true; } })[2];
  await assert.rejects(runAgent({
    messages: [{ role: "user", content: "Search" }], tools: [wiki], allowNetwork: true,
    complete: async () => toolCall("wiki_search", '{"query":"private page content"}'),
  }), /not approved/);
  assert.equal(requested, false);
});

test("a tool may declare a larger result budget than the 2048 default", async () => {
  const huge = { big: "x".repeat(4000) };
  const run = async () => huge;
  const toolCall = { message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "wide_cap", arguments: "{}" } }] } };
  const done = { message: { role: "assistant", content: "done" } };
  const events = [];
  // Over the declared budget: the payload is trimmed to it and reported, not thrown. Killing the turn
  // punished the reader for a tool's bug; a short tool result still lets the model answer.
  let calls = 0;
  const trimmed = await runAgent({
    messages: [{ role: "user", content: "q" }],
    tools: [{ name: "wide_cap", description: "", parameters: { type: "object", properties: {} }, run }],
    allowNetwork: true, approveTool: () => true,
    complete: async (history) => (calls++ === 0 ? toolCall : done),
    onTool: (e) => events.push(e),
  });
  assert.equal(trimmed.text, "done");
  assert.deepEqual(events.filter((e) => e.stage === "truncated"), [{ stage: "truncated", name: "wide_cap", cap: 2048 }]);
  // A budget wide enough for the same result leaves it whole.
  let wider = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "q" }],
    tools: [{ name: "wide_cap", description: "", parameters: { type: "object", properties: {} }, maxResultBytes: 16000, run }],
    allowNetwork: true, approveTool: () => true,
    complete: async () => (wider++ === 0 ? toolCall : done),
  });
  assert.equal(r.text, "done");
});

test("safe arithmetic: precedence, parentheses, invalid input", () => {
  assert.equal(calculate("(2+3)*7 - 4/2"), 33);
  assert.equal(calculate("-.5 * -8"), 4);
  assert.throws(() => calculate("2/0"), /Division by zero/);
  assert.throws(() => calculate("constructor.constructor('x')"), /Only short arithmetic/);
  assert.throws(() => calculate("2 ** 3"), /Expected a number/);
});

test("online wiki uses CORS API with bounded results", async () => {
  let url;
  const wiki = defaultTools({ fetch: async (u) => { url = new URL(u); return new Response(JSON.stringify({ query: { search: [{ title: "Test", snippet: "<b>Safe</b> summary" }] } }), { status: 200 }); } })[2];
  const r = await runAgent({
    messages: [{ role: "user", content: "Search" }], tools: [wiki], allowNetwork: true,
    approveTool: ({ name, args }) => name === "wiki_search" && args.query === "test",
    complete: async (history) => history.some((m) => m.role === "tool") ? final : toolCall("wiki_search", '{"query":"test"}'),
  });
  assert.equal(url.searchParams.get("origin"), "*");
  assert.equal(r.toolRounds, 1);
});

test("an answer-less round is nudged once instead of ending the turn empty", async () => {
  const nudges = [];
  let n = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "suggest something" }],
    tools: [defaultTools()[0]],
    complete: async (history) => {
      const last = history.at(-1);
      if (last.role === "user" && last.content !== "suggest something") nudges.push(last.content);
      n++;
      if (n === 1) return toolCall("get_datetime");
      if (n === 2) return { message: { role: "assistant", content: "" } }; // reasoned, never answered
      return { message: { role: "assistant", content: "Today is 2030-02-14." } };
    },
  });
  assert.equal(r.text, "Today is 2030-02-14.");
  assert.equal(r.toolRounds, 2);
  assert.equal(nudges.length, 1);
});

test("the answer-less nudge happens at most once, then the turn ends empty", async () => {
  let n = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "q" }],
    tools: [defaultTools()[0]],
    complete: async () => (++n === 1 ? toolCall("get_datetime") : { message: { role: "assistant", content: "" } }),
  });
  assert.equal(r.text, "");
  assert.equal(n, 3); // rounds 0,1,2 — no runaway retry
});

test("a tool that throws hands the error to the model instead of killing the turn", async () => {
  const events = [];
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "what is on screen?" }],
    tools: [{ name: "read_page", description: "read", parameters: { type: "object", properties: {}, required: [] },
      run: async () => { throw new Error("get_current_page returned too much data (limit 16000)"); } }],
    complete: async (history) => {
      if (round++ === 0) return toolCall("read_page");
      // The failure is visible to the model as a tool result, and it is told not to retry it.
      assert.match(history.at(-2).content, /too much data/);
      assert.match(history.at(-1).content, /TOOL CONTROLLER: read_page failed/);
      return final;
    },
    onTool: (e) => events.push(e.stage),
  });
  assert.equal(r.text, "Today is 2030-02-14.");
  assert.deepEqual(events, ["call", "failed"]);
});

test("the same tool with the same arguments is not run twice; the model is told instead", async () => {
  let runs = 0;
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "read the title, twice if you must" }],
    tools: [{ name: "read_title", description: "read", parameters: { type: "object", properties: {}, required: [] },
      run: async () => { runs++; return { title: "Survey 2025" }; } }],
    complete: async (history) => {
      if (round++ === 0) return toolCall("read_title");
      if (round === 2) return toolCall("read_title");   // identical call
      assert.match(history.at(-1).content, /already called with those exact arguments/);
      return final;
    },
    onTool: (e) => e.stage === "repeat" && assert.equal(e.name, "read_title"),
  });
  assert.equal(runs, 1);
  assert.equal(r.text, "Today is 2030-02-14.");
});

test("an oversized tool result is trimmed and reported, never a failed turn", async () => {
  const events = [];
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "read everything" }],
    tools: [{ name: "read_all", description: "read", parameters: { type: "object", properties: {}, required: [] },
      maxResultBytes: 200, run: async () => ({ text: "x".repeat(5000) }) }],
    complete: async (history) => {
      if (round++ === 0) return toolCall("read_all");
      const payload = history.at(-1).content;
      assert.ok(payload.length <= 260, `kept ${payload.length} bytes`);
      assert.match(payload, /\[cut \d+ bytes\]/);
      return final;
    },
    onTool: (e) => events.push(e),
  });
  assert.equal(r.text, "Today is 2030-02-14.");
  assert.deepEqual(events.filter((e) => e.stage === "truncated"), [{ stage: "truncated", name: "read_all", cap: 200 }]);
});

test("a digest tool keeps the bulk out of the conversation", async () => {
  const raw = "page ".repeat(4000);                     // ~20 KB of disposable tool output
  const seen = [];
  let mainRounds = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "search for the population figure" }],
    tools: [{ name: "wiki_search", description: "search", parameters: { type: "object", properties: {}, required: [] },
      network: true, digest: true, maxResultBytes: 600, run: async () => ({ results: raw }) }],
    allowNetwork: true,
    approveTool: async () => true,
    complete: async (history, { tools }) => {
      seen.push(tools.length);
      // The digest turn is recognisable by its own prompt, and is offered no tools so it cannot start
      // a research loop of its own.
      if (String(history.at(-1).content).startsWith("Tool: wiki_search")) {
        return { message: { role: "assistant", content: "The population is about 2.9 million." } };
      }
      return mainRounds++ === 0 ? toolCall("wiki_search") : final;
    },
  });
  assert.deepEqual(seen, [1, 0, 1]);                    // tools offered, digest turn, answer round
  const toolMessage = r.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage.content.length <= 600, `tool message kept ${toolMessage.content.length} bytes`);
  assert.match(toolMessage.content, /distilled from \d+ bytes/);
  assert.doesNotMatch(toolMessage.content, /page page page page/);
});

test("no more than 5 tool calls execute in one turn, however many the model asks for", async () => {
  let executed = 0;
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "keep looking until you find it" }],
    // A distinct argument each round, so the repeat guard cannot be what stops it.
    tools: [{ name: "look", description: "look", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      run: async () => { executed++; return { found: false }; } }],
    complete: async (_history, { tools }) => {
      round++;
      if (!tools.length) return { message: { role: "assistant", content: "I could not find it in what I have." } };
      return { message: { role: "assistant", content: "", tool_calls: [
        { id: `c${round}`, type: "function", function: { name: "look", arguments: JSON.stringify({ n: round }) } }] } };
    },
  });
  assert.equal(executed, 5);
  assert.equal(r.text, "I could not find it in what I have.");
  // The model is offered no tools once the budget is spent, so it has to answer instead of looping.
  assert.equal(round, 6);
});

test("a failed call still spends a slot, so retrying cannot run forever", async () => {
  let executed = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "keep trying" }],
    tools: [{ name: "flaky", description: "flaky", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      run: async () => { executed++; throw new Error("boom"); } }],
    complete: async (_history, { tools }) => (tools.length
      ? { message: { role: "assistant", content: "", tool_calls: [
        { id: `c${executed}`, type: "function", function: { name: "flaky", arguments: JSON.stringify({ n: executed }) } }] } }
      : { message: { role: "assistant", content: "It keeps failing, so I will stop." } }),
  });
  assert.equal(executed, 5);
  assert.equal(r.text, "It keeps failing, so I will stop.");
});

test("the turn reports what it consumed: peak prompt, generated tokens and rounds", async () => {
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "what date is it?" }],
    tools: [defaultTools()[0]],
    complete: async () => (round++ === 0
      ? { ...toolCall("get_datetime"), usage: { prompt_tokens: 900, completion_tokens: 30 } }
      : { message: { role: "assistant", content: "2030-02-14" }, usage: { prompt_tokens: 1400, completion_tokens: 12 } }),
  });
  // Summing prompts would report 2300; the window's real pressure is the largest prompt, 1400.
  assert.equal(r.usage.peakPromptTokens, 1400);
  assert.equal(r.usage.generatedTokens, 42);
  assert.deepEqual(r.usage.rounds, [
    { round: 0, promptTokens: 900, generatedTokens: 30 },
    { round: 1, promptTokens: 1400, generatedTokens: 12 },
  ]);
});

test("surplus calls in one round still get a result, so the transcript stays one-to-one", async () => {
  const ran = [];
  const call = (id, n) => ({ id, type: "function", function: { name: "read", arguments: JSON.stringify({ n }) } });
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "read six fields" }],
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      run: async ({ n }) => { ran.push(n); return { n }; } }],
    complete: async () => (round++ === 0
      ? { message: { role: "assistant", content: "", tool_calls: [call("c1", 1), call("c2", 2), call("c3", 3), call("c4", 4), call("c5", 5), call("c6", 6)] } }
      : { message: { role: "assistant", content: "done" } }),
  });
  assert.deepEqual(ran, [1, 2, 3, 4]);
  const results = r.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 6, "every call the model made has a matching result");
  assert.deepEqual(results.slice(4).map((m) => JSON.parse(m.content).error && "not executed"),
    ["not executed", "not executed"]);
  assert.deepEqual(results.slice(4).map((m) => m.tool_call_id), ["c5", "c6"]);
});

test("the reasoning block is seeded on every round, and left off for the nudge retry", async () => {
  // The root cause of reasoning reaching the reader: the model's chat template ends its generation
  // prompt at `<|im_start|>assistant` with no ` thinking`, so only a seeded round delimits reasoning
  // from the answer. Round 1 must be seeded too, not just round 0.
  const seeds = [];
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "read the field" }],
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {}, required: [] }, run: async () => ({ v: 1 }) }],
    complete: async (_history, opts) => {
      seeds.push(opts.seedThink);
      round++;
      if (round === 1) return { message: { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] } };
      if (round === 2) return { message: { role: "assistant", content: "" } };   // spent it inside think
      return { message: { role: "assistant", content: "Done." } };
    },
  });
  assert.deepEqual(seeds, [true, true, false]);
  assert.equal(r.text, "Done.");
});

test("the model is told the tool budget is spent before the answer-only round", async () => {
  const seen = [];
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "look until you find it" }],
    maxRounds: 1,
    tools: [{ name: "look", description: "look", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      run: async () => ({ found: false }) }],
    complete: async (history, opts) => {
      round++;
      seen.push({ tools: opts.tools.length, last: String(history.at(-1).content) });
      return opts.tools.length
        ? { message: { role: "assistant", content: "", tool_calls: [
          { id: `c${round}`, type: "function", function: { name: "look", arguments: JSON.stringify({ n: round }) } }] } }
        : { message: { role: "assistant", content: "I found nothing." } };
    },
  });
  assert.equal(seen[0].tools, 1);
  assert.equal(seen[1].tools, 0);
  // Without this line the model writes its next step as the answer: "Let me check the geographic
  // coverage field as well."
  assert.match(seen[1].last, /TOOL CONTROLLER: the tool budget for this turn is spent/);
  assert.match(seen[1].last, /do not describe what you would do next/);
  assert.equal(r.text, "I found nothing.");
});

test("an empty answer-only round is nudged rather than returned blank", async () => {
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "what date is it?" }],
    maxRounds: 0,
    tools: [],
    complete: async () => {
      round++;
      return round === 1
        ? { message: { role: "assistant", content: "  " } }   // reasoned past the block, no answer
        : { message: { role: "assistant", content: "2030-02-14" } };
    },
  });
  assert.equal(round, 2);
  assert.equal(r.text, "2030-02-14");
});

test("a tool call on the answer-only round is refused, and the model is asked to answer", async () => {
  // The observed bug: the cap is spent, the model tries to keep checking fields, and we returned the
  // plan text that preceded the discarded call — so the reply was a preamble and then nothing.
  const refused = [];
  const rounds = [];
  let round = 0;
  const strayCall = { message: { role: "assistant",
    content: "The analysis_unit field is also null. Let me check the geographic coverage field as well.",
    tool_calls: [{ id: "c9", type: "function", function: { name: "read_project_field", arguments: "{}" } }] } };
  const r = await runAgent({
    messages: [{ role: "user", content: "help me populate the datafile" }],
    maxRounds: 0,                    // round 0 is already answer-only
    tools: [{ name: "read_project_field", description: "read", parameters: { type: "object", properties: {}, required: [] },
      run: async () => ({ value: null }) }],
    complete: async (history, opts) => {
      round++;
      rounds.push({ tools: opts.tools.length, last: String(history.at(-1).content).slice(0, 60), seed: opts.seedThink });
      return round === 1 ? strayCall : { message: { role: "assistant", content: "Here is what I found…" } };
    },
    onTool: (e) => refused.push(e),
  });
  // The call is refused, not executed, and the refusal is reported so a host can show it.
  assert.deepEqual(refused, [{ stage: "refused", name: "read_project_field", reason: "tool budget spent" }]);
  // The fragment is not returned as the answer: the retry produces a real one.
  assert.equal(r.text, "Here is what I found…");
  assert.equal(round, 2);
  assert.match(rounds[1].last, /tool budget for this turn is spent/);
  assert.equal(rounds[1].seed, false, "the retry asks for a direct answer, unseeded");
});

test("if the retry after a refused call also says nothing, the fragment is kept rather than lost", async () => {
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "help me populate the datafile" }],
    maxRounds: 0,
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {}, required: [] }, run: async () => ({}) }],
    complete: async () => {
      round++;
      return { message: { role: "assistant", content: round === 1 ? "Let me check the next field." : "",
        tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: "{}" } }] } };
    },
  });
  assert.equal(r.text, "Let me check the next field.");
});

test("a plan-shaped reply is repaired once, and the verdict travels with the result", async () => {
  // The observed failure, end to end: the model answers with its next step instead of an answer.
  const FRAGMENT = "The analysis_unit field is also null. Let me check the geographic coverage field as well.";
  const seen = [];
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "help me populate the datafile" }],
    maxRounds: 0,
    tools: [],
    complete: async (history) => {
      round++;
      seen.push(String(history.at(-1).content));
      // First reply is the plan; the repair is the last message before the retry.
      return { message: { role: "assistant", content: round === 1 ? FRAGMENT : "The record has no abstract, universe, or analysis unit." } };
    },
  });
  assert.equal(round, 2);
  assert.match(seen[1], /Your reply ended with "Let me check the geographic coverage field as well\."/);
  assert.match(seen[1], /Do not describe what you would do next/);
  assert.equal(r.text, "The record has no abstract, universe, or analysis unit.");
  assert.deepEqual(r.completeness, { ok: true, reason: null, evidence: null });
});

test("a reply that is still not an answer after the repair is returned marked incomplete", async () => {
  let round = 0;
  const r = await runAgent({
    messages: [{ role: "user", content: "help me populate the datafile" }],
    maxRounds: 0,
    tools: [],
    complete: async () => {
      round++;
      return { message: { role: "assistant", content: "Let me check the next field as well." } };
    },
  });
  assert.equal(round, 2, "one retry, then it stops");
  // Never a silent fragment: the caller gets the text *and* the verdict that it is not an answer.
  assert.equal(r.text, "Let me check the next field as well.");
  assert.equal(r.completeness.ok, false);
  assert.equal(r.completeness.reason, "plan-shaped");
});
