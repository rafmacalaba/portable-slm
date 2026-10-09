import assert from "node:assert/strict";
import { test } from "node:test";
import { assessAnswer, loadSnapshot, evidenceMessages, saveSnapshot } from "../src/qa-evidence.js";

const study = { idno: "Test001_OD", title: "Popstan Synthetic Household Survey 2023", abstract: "The survey is used to update the national poverty profile." };

test("bounded public snapshot survives reload and builds source-only prompts", () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  saveSnapshot(study, storage);
  assert.deepEqual(loadSnapshot(storage), study);
  const prompt = evidenceMessages(study, "What is the purpose?");
  assert.match(prompt[1].content, /poverty profile/);
  assert.throws(() => evidenceMessages(study, "x".repeat(401)), /max 400/);
});

test("evidence must occur in title or abstract, not be invented", () => {
  assert.deepEqual(assessAnswer('{"answer":"Update the poverty profile","evidence":"update the national poverty profile"}', study),
    { answer: "Update the poverty profile", evidence: "update the national poverty profile", status: "quoted" });
  assert.equal(assessAnswer('{"answer":"The survey covered 10 million","evidence":"10 million people"}', study).status, "unverified");
  assert.equal(assessAnswer('{"answer":"update the national poverty profile","evidence":"a study"}', study).status, "answer-in-source");
  assert.equal(assessAnswer('{"answer":"UNKNOWN","evidence":""}', study).status, "not-stated");
  assert.throws(() => assessAnswer('{"answer":"Paris"}', study), /short answer and evidence/);
});
