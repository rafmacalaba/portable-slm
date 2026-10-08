import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAICompatibleClient } from "../src/openai-compatible.js";

const model = "lfm2.5-350m-q4km";

function mockAI() {
  const calls = { load: [], messages: null, options: null };
  return {
    calls,
    models: { [model]: {} },
    async load(id) { calls.load.push(id); },
    async generate(messages, options) {
      calls.messages = messages;
      calls.options = options;
      options.onToken?.("local ");
      options.onToken?.("answer");
      return { text: "local answer", usage: { prompt_tokens: 3, completion_tokens: 2 } };
    },
  };
}

test("local chat facade maps request and response to chat-completion shape", async () => {
  const ai = mockAI();
  const client = createOpenAICompatibleClient(ai);
  const result = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Question?" }],
    max_completion_tokens: 64,
    temperature: 0.2,
    top_p: 0.8,
    seed: 17,
  });
  assert.deepEqual(ai.calls.load, [model]);
  assert.deepEqual(ai.calls.messages, [{ role: "user", content: "Question?" }]);
  assert.equal(ai.calls.options.maxTokens, 64);
  assert.equal(ai.calls.options.temperature, 0.2);
  assert.equal(ai.calls.options.top_p, 0.8);
  assert.equal(ai.calls.options.seed, 17);
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.content, "local answer");
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test("stream mode yields completion chunks from local token callbacks", async () => {
  const client = createOpenAICompatibleClient(mockAI());
  const chunks = [];
  for await (const chunk of client.chat.completions.create({
    model, messages: [{ role: "user", content: "Question?" }], stream: true,
  })) chunks.push(chunk);
  assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta), [
    { role: "assistant" }, { content: "local " }, { content: "answer" }, {},
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test("facade rejects unpinned models and unsupported multimodal/tool requests", () => {
  const client = createOpenAICompatibleClient(mockAI());
  assert.throws(() => client.chat.completions.create({ model: "other", messages: [{ role: "user", content: "x" }] }), /Unknown model/);
  assert.throws(() => client.chat.completions.create({ model, messages: [{ role: "user", content: [{ type: "image_url" }] }] }), /text content/);
  assert.throws(() => client.chat.completions.create({ model, messages: [{ role: "user", content: "x" }], tools: [] }), /Unsupported chat option: tools/);
});
