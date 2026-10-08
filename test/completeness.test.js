// The fixtures here are the observed failures from the editor integration, not invented examples:
// the 89-character "answer" and the tail of a real 3.6 KB answer. A verifier is only worth having if
// it is proven against the failure that actually happened.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCompleteness, describeIncomplete, repairInstruction } from "../src/completeness.js";

// Verbatim, from logs/pslm-assistant.jsonl (sid=11, "Help me populate the information on the datafile
// for experts_survey_raw"): the whole reply the reader received.
const OBSERVED_FRAGMENT = "The analysis_unit field is also null. Let me check the geographic coverage field as well.";

// Verbatim tail of the observed complete 3 599-char answer to "what are the things that I can improve
// in the documentation of this project".
const OBSERVED_COMPLETE_TAIL = "The rank-based policy priority questions (rank_1 through rank_9) suggest the analysis focuses on policy priorities related to female labor, but this isn't formally documented in the study description.";

// Verbatim tail of the other observed answer, which closes by asking the reader a question.
const OBSERVED_QUESTION_TAIL = "Would you like me to help draft improved metadata for this project?";

test("the observed plan-shaped reply is not an answer", () => {
  const verdict = assessCompleteness(OBSERVED_FRAGMENT);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "plan-shaped");
  // The evidence is the sentence that decided it, so the marker and the repair can quote the model back
  // to itself rather than saying "try again".
  assert.equal(verdict.evidence, "Let me check the geographic coverage field as well.");
});

test("a real complete answer passes, including one that ends by asking a question", () => {
  assert.deepEqual(assessCompleteness(`The project metadata shows 24 variables. ${OBSERVED_COMPLETE_TAIL}`).ok, true);
  // A trailing "?" is a question to the reader, not a plan to act on.
  assert.equal(assessCompleteness(`I checked every field. ${OBSERVED_QUESTION_TAIL}`).ok, true);
});

test("an empty reply is reported as empty, not as a short answer", () => {
  for (const value of ["", "   ", "\n", undefined, null]) {
    assert.equal(assessCompleteness(value).reason, "empty");
  }
});

test("a reply cut off inside a code block is truncated", () => {
  const verdict = assessCompleteness('Here is the JSON:\n\n```json\n{"name": "Amina", "age": 34');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "truncated");
  assert.equal(verdict.evidence, "unclosed code fence");
});

test("a reply that stops on a dangling connective is truncated", () => {
  assert.equal(assessCompleteness("The variable list includes duration, unit, expertise area and").reason, "truncated");
  assert.equal(assessCompleteness("The main gaps in the record are the following:").reason, "truncated");
});

test("ordinary short answers are complete", () => {
  for (const value of [
    "Statistical Yearbook 2025.",
    "The abstract field is empty, so there is nothing to summarise.",
    "I could not find that field in this project's record.",
    "UNKNOWN",
  ]) {
    assert.equal(assessCompleteness(value).ok, true, value);
  }
});

test("a lone {id} in prose is not treated as a truncated JSON structure", () => {
  // Prose legitimately quotes a placeholder; only an unclosed code fence is evidence of a cut decode.
  assert.equal(assessCompleteness("The endpoint is /index.php/api/editor/json_field/{id}?path={pointer} and it reads one field.").ok, true);
});

test("the known false positive is pinned: a short complete reply ending in an offer is flagged", () => {
  // Documents the trade instead of hiding it. Raise `wholeReplyPlanChars` to trade the other way; the
  // cost here is one repair generation and a marker, never a lost answer.
  const verdict = assessCompleteness("The title is Statistical Yearbook 2025. I can also check the abstract if you want.");
  assert.equal(verdict.reason, "plan-shaped");
  // A long answer ending the same way is not flagged, which is why the length guard exists.
  const long = `${"The record lists 24 variables across one data file. ".repeat(12)}I can also check the abstract if you want.`;
  assert.equal(assessCompleteness(long).ok, true);
});

test("the repair instruction quotes the failure instead of repeating the question", () => {
  const instruction = repairInstruction(assessCompleteness(OBSERVED_FRAGMENT));
  assert.match(instruction, /Let me check the geographic coverage field as well\./);
  assert.match(instruction, /Do not describe what you would do next/);
  assert.match(repairInstruction({ reason: "truncated" }), /stopped in the middle/);
  assert.match(repairInstruction({ reason: "empty" }), /Give your answer now/);
});

test("the marker names what went wrong, in the reader's words", () => {
  assert.match(describeIncomplete(assessCompleteness(OBSERVED_FRAGMENT)), /stopped mid-plan/);
  assert.match(describeIncomplete({ reason: "truncated" }), /cut off mid-sentence/);
  assert.match(describeIncomplete({ reason: "empty" }), /returned no answer/);
  assert.equal(describeIncomplete({ reason: null }), null);
});

test("polite closings are complete replies, not plans", () => {
  // Observed in production and wrongly flagged, which sent the turn into a repair round whose unseeded
  // retry leaked its reasoning. "Let me know" asks the READER to act; a plan names what the assistant will
  // do. The distinction is the whole reason this file exists, so it is asserted with the exact strings.
  for (const closing of [
    "Let me know what you’d like to do!",
    "Let me know if you need anything else.",
    "Let me know if you want more detail on any of these.",
  ]) {
    assert.equal(assessCompleteness(closing).ok, true, closing);
  }
  // A real plan is still caught, which is the case this check was built for.
  assert.equal(assessCompleteness("Let me check the geographic coverage field as well.").reason, "plan-shaped");
});
