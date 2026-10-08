// Is this a finished answer?
//
// A caller that only asks "is there text?" cannot tell a complete answer from a small model's three
// ways of stopping early, and all three were observed on this project's own editor integration:
//
//   1. it reasoned past its budget inside the think block and produced no answer at all;
//   2. it emitted the plan it was about to act on — "The analysis_unit field is also null. Let me
//      check the geographic coverage field as well." — which reached the reader as the whole reply;
//   3. it was cut off mid-structure, leaving an unclosed code fence or a dangling connective.
//
// Prompt wording cannot be relied on to prevent these (docs/HARNESS.md: "if a rule matters, it lives in
// code"). What code *can* do is refuse to present a fragment as an answer, and say why.
//
// Deliberately conservative, because the two errors are not symmetric: a false "incomplete" flags a
// good answer and teaches the reader to ignore the marker, while a missed fragment is merely the status
// quo. So `plan-shaped` fires only when the whole reply is one short planning utterance — never when a
// long answer merely *ends* with an offer — and a trailing "?" is a question to the reader, never a plan.
//
// Known limit, pinned by a test rather than left to surprise anyone: a *short* complete reply that ends
// with an offer ("The title is X. I can also check the abstract if you want.") is flagged too. The cost
// is one repair generation and a marker, not a broken answer; raise `wholeReplyPlanChars` to trade the
// other way.

const PLAN_TAIL = /^\s*(?:let me|let'?s|i(?:'ll| will| should| need to| am going to| can(?: also)?)|next,? i|now i(?:'ll| will))\b/i;
const DANGLING_TAIL = /(?::|,|\band|\bthe|\bwith|\bto|\bbecause|\bso)\s*$/i;

/** A reply this short that is one planning utterance has no findings in it. 240 chars is the
 * observed 89-char fragment with margin; the threshold is one constant because it is the only knob
 * in this file that trades a false "incomplete" against a missed one. */
const WHOLE_REPLY_PLAN_CHARS = 240;

/**
 * `{ ok, reason, evidence }`. `reason` is null when the answer is complete, otherwise one of
 * `empty` | `plan-shaped` | `truncated`. `evidence` is the text that decided it, for the repair
 * instruction and for the log — a verdict a human cannot check is not worth having.
 */
export function assessCompleteness(text, { wholeReplyPlanChars = WHOLE_REPLY_PLAN_CHARS } = {}) {
  const value = String(text ?? "").trim();
  if (!value) return { ok: false, reason: "empty", evidence: null };
  // An odd number of fences means a code block was opened and the decode stopped inside it. Only
  // fences, not brackets: prose legitimately quotes a lone `{id}`, and JSON answers are already
  // shape-checked by the task layer (metadata-review), so a bracket count would mostly add noise.
  if ((value.match(/```/g) ?? []).length % 2 === 1) {
    return { ok: false, reason: "truncated", evidence: "unclosed code fence" };
  }
  const tail = value.slice(-160);
  const lastSentence = (tail.split(/(?<=[.!?])\s+/).pop() ?? tail).trim();
  const isQuestion = lastSentence.endsWith("?");
  if (!isQuestion && value.length <= wholeReplyPlanChars && PLAN_TAIL.test(lastSentence)) {
    return { ok: false, reason: "plan-shaped", evidence: lastSentence };
  }
  if (DANGLING_TAIL.test(value)) {
    return { ok: false, reason: "truncated", evidence: tail.trim().slice(-60) };
  }
  return { ok: true, reason: null, evidence: null };
}

/**
 * What to tell the model when its reply was not an answer. Names the specific failure instead of
 * saying "try again", because a small model repeats itself given the same instruction — which is
 * exactly why this exists rather than a second identical prompt.
 */
export function repairInstruction({ reason, evidence } = {}) {
  if (reason === "plan-shaped") {
    return `Your reply ended with "${evidence}" and stated no answer. Give the answer now, using only what you already have. Do not describe what you would do next and do not call a tool.`;
  }
  if (reason === "truncated") {
    return "Your reply stopped in the middle. Give the whole answer again in one piece, shorter if it does not fit.";
  }
  return "Give your answer now. One or two short sentences, no analysis, no tool calls.";
}

/** The reader-facing sentence for an incomplete reply, kept beside the verdict that produced it. */
export function describeIncomplete({ reason, evidence } = {}) {
  if (reason === "plan-shaped") {
    return `⚠ The model stopped mid-plan — “${evidence}” is what it was about to do, not an answer. Ask again, or raise the tool budget.`;
  }
  if (reason === "truncated") return "⚠ The reply was cut off mid-sentence rather than finished.";
  if (reason === "empty") return "⚠ The model returned no answer to this question.";
  return null;
}
