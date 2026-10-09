import assert from "node:assert/strict";
import { test } from "node:test";
import { answerFromEvidence } from "../src/qa-evidence.js";
import { suggestMetadata, suggestMessages, SUGGEST_DATAFILE_TASK } from "../integrations/field-suggest.js";

const study = { idno: "S1", title: "Example survey", abstract: "Survey measures household welfare." };
function mockAI(text) {
  const calls = { loaded: [], messages: null, options: null };
  return {
    calls,
    async load(id) { calls.loaded.push(id); return { engine: "cpu" }; },
    async generate(messages, options) { calls.messages = messages; calls.options = options; return { text, engine: "cpu" }; },
  };
}

test("the evidence task loads locally and returns an assessment", async () => {
  const ai = mockAI('{"answer":"Measure household welfare","evidence":"measures household welfare"}');
  const result = await answerFromEvidence(ai, study, "What does it measure?");
  assert.deepEqual(ai.calls.loaded, ["lfm2.5-350m-q4km"]);
  assert.equal(ai.calls.options.response_format.json_schema.name, "study_answer");
  assert.equal(result.status, "quoted");
  assert.equal(result.engine, "cpu");
});

test("the field-suggestion task returns a structured draft without writing", async () => {
  const ai = mockAI('{"suggestion":"Example survey on household welfare","reason":"Clarifies the subject."}');
  const result = await suggestMetadata(ai, {
    source: "record-editor",
    snapshot: { id: "P1", path: "/identification/title", value: "Example" },
    modelId: "test-model",
  });
  assert.deepEqual(ai.calls.loaded, ["test-model"]);
  assert.match(ai.calls.messages[1].content, /Task: pslm\.suggest-field\. Source: record-editor/);
  assert.equal(result.task, "pslm.suggest-field");
  assert.equal(result.formatValid, true);
  assert.equal(result.suggestion, "Example survey on household welfare");
  assert.equal(ai.calls.options.response_format.json_schema.name, "metadata_review");
});

test("malformed model output stays an explicitly unvalidated draft", async () => {
  const ai = mockAI("not JSON");
  const result = await answerFromEvidence(ai, study, "Question?");
  assert.equal(result.status, "invalid");
  assert.equal(result.raw, "not JSON");
  const metadataAI = mockAI("not JSON");
  const draft = await suggestMetadata(metadataAI, { source: "catalogue", snapshot: { idno: "S1" } });
  assert.equal(draft.formatValid, false);
  assert.equal(draft.raw, "not JSON");
});

test("a task id the helper does not implement is an error, not a silent fallback", async () => {
  const ai = mockAI('{"suggestion":"x","reason":"y"}');
  await assert.rejects(
    suggestMetadata(ai, { task: "pslm.chat", source: "catalogue", snapshot: { idno: "S1" } }),
    /Unsupported task/,
  );
  assert.deepEqual(ai.calls.loaded, []);
});

test("datafile-description task prompts from file facts and variable labels, not invention", () => {
  const snapshot = { target: "datafile.description", datafile: { file_name: "experts_survey_raw", var_count: 87 }, variables: [{ name: "age", label: "Age of respondent" }] };
  const messages = suggestMessages("Record editor", snapshot, SUGGEST_DATAFILE_TASK);
  assert.match(messages[0].content, /datafile Description/);
  assert.match(messages[0].content, /do not invent or mix counts/);
  assert.match(messages[1].content, /Task: pslm\.suggest-datafile-description/);
  assert.match(messages[1].content, /experts_survey_raw/);

  const ai = mockAI('{"suggestion":"Raw expert survey file with 87 variables.","reason":"Names file and scale."}');
  return suggestMetadata(ai, { task: SUGGEST_DATAFILE_TASK, source: "record editor", snapshot, modelId: "m1" })
    .then((result) => {
      assert.equal(result.formatValid, true);
      assert.deepEqual(ai.calls.loaded, ["m1"]);
    });
});
