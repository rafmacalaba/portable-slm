import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantSystemPrompt, buildMessages, composeContext, DEFAULT_CONTEXT, formatGrounding, lexicalGrounding, parseInline,
  parseMarkdown, resolveTools, routesDirect, stripDecorativeMarkdown, toolInstructions } from "../integrations/chat-core.js";

const tools = [
  { name: "calculate", network: false },
  { name: "get_datetime", network: false },
  { name: "wiki_search", network: true },
];

test("tool policy keeps online tools out unless the host opts in", () => {
  assert.deepEqual(resolveTools("offline", { tools }).map((t) => t.name), ["calculate", "get_datetime"]);
  assert.deepEqual(resolveTools("none", { tools }), []);
  // "all" is still not enough: runAgent drops network tools without allowNetwork.
  assert.deepEqual(resolveTools("all", { tools }).map((t) => t.name), ["calculate", "get_datetime"]);
  assert.deepEqual(resolveTools("all", { tools, allowNetwork: true }).map((t) => t.name),
    ["calculate", "get_datetime", "wiki_search"]);
  assert.deepEqual(resolveTools("calculate", { tools, allowNetwork: true }).map((t) => t.name), ["calculate"]);
  assert.deepEqual(resolveTools(undefined, { tools }).map((t) => t.name), ["calculate", "get_datetime"]);
});

test("host context rides in the system message so history trimming cannot drop it", () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }));
  const messages = buildMessages({
    system: "Answer from context only.",
    context: `{"title":"HIES 2025"}`,
    history,
    question: "What is the title?",
    maxHistory: 6,
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /Answer from context only\./);
  assert.match(messages[0].content, /Context from the host application:\n\{"title":"HIES 2025"\}/);
  assert.equal(messages.length, 1 + 6 + 1);
  assert.deepEqual(messages.at(-1), { role: "user", content: "What is the title?" });
});

test("a chat with no host context sends no system padding", () => {
  const messages = buildMessages({ question: "hello" });
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("lexical grounding flags invented numbers and passes quoted metadata", () => {
  const context = JSON.stringify({
    study_desc: { study_info: { abstract: "Household Income and Expenditure Survey 2025", geog_coverage: "National, urban and rural strata" } },
  });
  const invented = lexicalGrounding("The current population of Saint Lucia is approximately 1.2 million.", context);
  assert.equal(invented.grounded, false);
  assert.match(formatGrounding(invented), /not in provided context .* verify/);

  const quoted = lexicalGrounding("Coverage is National, urban and rural strata.", context);
  assert.equal(quoted.grounded, true);
  assert.match(formatGrounding(quoted), /^grounded \d+\/\d+$/);

  const nothing = lexicalGrounding("?", context);
  assert.equal(nothing.checked, 0);
  assert.equal(formatGrounding(nothing), "no checkable terms");
});

test("the shipped context is always present and hosts can only append to it", () => {
  // With no host at all, the assistant still knows what it is and what it cannot do.
  const alone = composeContext("");
  assert.equal(alone.text, DEFAULT_CONTEXT);
  assert.deepEqual(alone.sources, ["portable-slm"]);

  // A host appends after a marker; it cannot replace, reorder or delete the shipped block.
  const withHost = composeContext('{"title":"My study"}');
  assert.ok(withHost.text.startsWith(DEFAULT_CONTEXT));
  assert.ok(withHost.text.endsWith('{"title":"My study"}'));
  assert.deepEqual(withHost.sources, ["portable-slm", "host"]);

  // Blank, whitespace and null are all "no host context", not an empty appended section.
  for (const empty of ["", "   \n", null, undefined]) {
    assert.deepEqual(composeContext(empty).sources, ["portable-slm"]);
  }

  // The shipped block is what keeps the honesty claims answerable, so it must actually say them.
  assert.match(DEFAULT_CONTEXT, /cannot inspect the page/);
  assert.match(DEFAULT_CONTEXT, /never claim that you did/);
  assert.match(DEFAULT_CONTEXT, /Answer general questions from your own knowledge/);
  assert.match(DEFAULT_CONTEXT, /rather than inventing a value/);

  // An answer lifted from the shipped block is grounded, not invented — "I cannot save anything"
  // used to read as ungrounded on a chat with no host.
  assert.equal(lexicalGrounding("I cannot save or publish anything.", composeContext("").text).grounded, true);
});

test("host prompts allow general chat while bounding application-specific claims", () => {
  const record = assistantSystemPrompt({ app: "Example App", context: "record" });
  assert.match(record, /Answer general questions normally/);
  assert.match(record, /open project's saved metadata/);
  assert.match(record, /Never guess a project value/);
  assert.match(record, /General advice is allowed/);

  const app = assistantSystemPrompt({ app: "Example App", context: "app" });
  assert.match(app, /general guidance clearly labeled/);
  assert.match(app, /have not read a project/);
  assert.match(assistantSystemPrompt({ context: "none" }), /Answer general questions normally/);
});

test("capability and greeting turns route direct without tools", () => {
  for (const question of ["What can you do?", "who are you", "Hi", "Henlo", "sup", "What are your tools?", "can you save my changes?"]) {
    assert.equal(routesDirect(question), true, question);
  }
  for (const question of ["What is the title of this project?", "calculate (19*23)+8", "What is the universe field value?", ""] ) {
    assert.equal(routesDirect(question), false, question);
  }
});

test("tool prompt names available tools and sets expectations without suppressing general chat", () => {
  const prompt = toolInstructions([
    { name: "read_project_field", description: "Read exact saved field value." },
    { name: "calculate", description: "Calculate arithmetic." },
  ]);
  assert.match(prompt, /never need one/);
  assert.match(prompt, /When in doubt, do not call a tool/);
  assert.match(prompt, /read_project_field: Read exact saved field value/);
  assert.match(prompt, /calculate: Calculate arithmetic/);
  const lfmPrompt = toolInstructions([{ name: "read_project_field", description: "Read a field." }], { lfm: true });
  assert.match(lfmPrompt, /<\|tool_call_start\|>\[tool_name\(parameter='value'\)\]<\|tool_call_end\|>/);
  assert.equal(toolInstructions([]), "");
});

test("renders pipe tables as data, cells through the inline parser", () => {
  const blocks = parseMarkdown(
    "| Variable | Label |\n|---|---|\n| SubmissionDate | date of submission |\n| rank | respondent rank |\n"
  );
  assert.deepEqual(blocks.map((b) => b.type), ["table"]);
  assert.deepEqual(blocks[0].header.map((runs) => runs.map((r) => r.v).join("")), ["Variable", "Label"]);
  assert.equal(blocks[0].rows.length, 2);
  assert.deepEqual(
    blocks[0].rows[1].map((cell) => cell.map((r) => r.v).join("")),
    ["rank", "respondent rank"],
  );
  // a lone pipe line that is not a table stays prose
  assert.deepEqual(parseMarkdown("| just some pipes |\n").map((b) => b.type), ["p"]);
});

test("markdown renders what a small model emits and nothing else", () => {
  const blocks = parseMarkdown(
    "The **universe** is `de jure` residents.\n" +
    "- Coverage: `National`\n" +
    "- Unit: individual\n" +
    "\n1. First\n2. Second\n" +
    "\n## Notes\n" +
    "```json\n{\"a\": 1}\n```\n" +
    "See [the handbook](https://example.org/x)."
  );
  assert.deepEqual(blocks.map((b) => b.type), ["p", "list", "list", "heading", "code", "p"]);
  assert.deepEqual(blocks[0].runs.map((r) => r.t), ["text", "strong", "text", "code", "text"]);
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[3].level, 2);
  assert.deepEqual(blocks[3].runs, [{ t: "text", v: "Notes" }]);
  assert.equal(blocks[4].lang, "json");
  assert.equal(blocks[4].text, '{"a": 1}');
  // Links are never clickable: a model this size invents URLs, so the text survives and the URL
  // stays visible but inert.
  assert.deepEqual(blocks[5].runs, [{ t: "text", v: "See the handbook (https://example.org/x)." }]);
});

test("markdown that is not markdown stays literal", () => {
  // Unmatched markers are what the model meant; swallowing them would edit the sentence.
  assert.deepEqual(parseInline("**half a bold"), [{ t: "text", v: "**half a bold" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ t: "text", v: "2 * 3 * 4" }]);
  // Underscore emphasis is unsupported on purpose: identifiers are ordinary metadata vocabulary.
  assert.deepEqual(parseInline("house_hold and snake_case_value"),
    [{ t: "text", v: "house_hold and snake_case_value" }]);
  assert.deepEqual(parseInline("*de jure* residents"),
    [{ t: "em", v: "de jure" }, { t: "text", v: " residents" }]);
  assert.deepEqual(parseInline("no markup here"), [{ t: "text", v: "no markup here" }]);
  // Markup inside a code span is literal, not markup.
  assert.deepEqual(parseInline("`**not bold**`"), [{ t: "code", v: "**not bold**" }]);
  // An unterminated fence is still code — half a JSON block as prose is worse.
  const open = parseMarkdown("```\n{\"a\": 1");
  assert.deepEqual(open.map((b) => b.type), ["code"]);
  assert.equal(open[0].text, '{"a": 1');
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown(null), []);
  // CRLF input parses like LF input.
  assert.deepEqual(parseMarkdown("a\r\n\r\nb").map((b) => b.type), ["p", "p"]);
});

test("decoration is stripped only in pairs, because fields hold data not markup", () => {
  assert.equal(stripDecorativeMarkdown("**National** coverage"), "National coverage");
  assert.equal(stripDecorativeMarkdown("`de jure` residents"), "de jure residents");
  assert.equal(stripDecorativeMarkdown("## Notes\n- first item"), "Notes\nfirst item");
  // Unpaired markers survive: losing a character the curator meant beats leaving decoration behind.
  assert.equal(stripDecorativeMarkdown("2 * 3 * 4 and half ** open"), "2 * 3 * 4 and half ** open");
  assert.equal(stripDecorativeMarkdown(""), "");
});

test("an app document declared as content gets an instruction to answer, not to offer help", () => {
  // The observed deflection — "Let me know what you'd like to do!" — is the help-text instruction being
  // followed: it says to fall back to general guidance when the text does not cover the answer.
  const help = assistantSystemPrompt({ app: "My Site", context: "app", kind: "help" });
  const content = assistantSystemPrompt({ app: "My Site", context: "app", kind: "content" });
  assert.match(help, /offer general guidance/);
  assert.match(content, /answer the question that was asked/);
  assert.match(content, /do not end by asking the user what they want or offering to help/);
  assert.match(content, /say that plainly rather than filling the gap from general knowledge/);
  assert.doesNotMatch(content, /offer general guidance/);
  // The default stays the help-text wording: a manifest that says nothing keeps its current behaviour.
  assert.equal(assistantSystemPrompt({ app: "My Site", context: "app" }), help);
});
