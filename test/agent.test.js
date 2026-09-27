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
