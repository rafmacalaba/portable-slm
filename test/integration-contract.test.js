import assert from "node:assert/strict";
import { test } from "node:test";
import { answerStudyQuestion } from "../src/nada-qa.js";
import { suggestMetadata } from "../integrations/metadata-review.js";

const study = { idno: "S1", title: "Example survey", abstract: "Survey measures household welfare." };
function mockAI(text) {
  const calls = { loaded: [], messages: null, options: null };
  return {
    calls,
    async load(id) { calls.loaded.push(id); return { engine: "cpu" }; },
    async generate(messages, options) { calls.messages = messages; calls.options = options; return { text, engine: "cpu" }; },
  };
}

test("NADA task contract loads locally and returns evidence assessment", async () => {
  const ai = mockAI('{"answer":"Measure household welfare","evidence":"measures household welfare"}');
  const result = await answerStudyQuestion(ai, study, "What does it measure?");
  assert.deepEqual(ai.calls.loaded, ["lfm2.5-350m-q4km"]);
  assert.equal(ai.calls.options.response_format.json_schema.name, "study_answer");
  assert.equal(result.status, "quoted");
  assert.equal(result.engine, "cpu");
});

test("Metadata Editor task contract returns a structured draft without writing", async () => {
  const ai = mockAI('{"suggestion":"Example survey on household welfare","reason":"Clarifies the subject."}');
  const result = await suggestMetadata(ai, {
    source: "metadata-editor",
    snapshot: { id: "P1", path: "/identification/title", value: "Example" },
    modelId: "test-model",
  });
  assert.deepEqual(ai.calls.loaded, ["test-model"]);
  assert.match(ai.calls.messages[1].content, /metadata-editor/);
  assert.equal(result.formatValid, true);
  assert.equal(result.suggestion, "Example survey on household welfare");
  assert.equal(ai.calls.options.response_format.json_schema.name, "metadata_review");
});

test("malformed model output stays an explicitly unvalidated draft", async () => {
  const ai = mockAI("not JSON");
  const result = await answerStudyQuestion(ai, study, "Question?");
  assert.equal(result.status, "invalid");
  assert.equal(result.raw, "not JSON");
  const metadataAI = mockAI("not JSON");
  const draft = await suggestMetadata(metadataAI, { source: "nada", snapshot: { idno: "S1" } });
  assert.equal(draft.formatValid, false);
  assert.equal(draft.raw, "not JSON");
});
