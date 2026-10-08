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
//  4. it narrated the prompt back instead of answering, which is what a reasoning stream looks like when
//     the round was not seeded with a think block.
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

// `let me know` is a closing courtesy, not an action the assistant is about to take: "Let me know what
// you'd like to do!" and "Let me know if you need anything else." are complete replies, and flagging them
// as plans sent a real conversation into a repair round — which is how the leak below surfaced. A plan
// names something the assistant will do; `know` names something the reader will do.
const PLAN_TAIL = /^\s*(?:let me(?!\s+know\b)|let'?s|i(?:'ll| will| should| need to| am going to| can(?: also)?)|next,? i|now i(?:'ll| will))\b/i;
const DANGLING_TAIL = /(?::|,|\band|\bthe|\bwith|\bto|\bbecause|\bso)\s*$/i;

/** A reply this short that is one planning utterance has no findings in it. 240 chars is the
 * observed 89-char fragment with margin; the threshold is one constant because it is the only knob
 * in this file that trades a false "incomplete" against a missed one. */
const WHOLE_REPLY_PLAN_CHARS = 240;

/**
 * `{ ok, reason, evidence }`. `reason` is null when the answer is complete, otherwise one of
 * `empty` | `plan-shaped` | `truncated` | `narrating`. `evidence` is the text that decided it, for the repair
 * instruction and for the log — a verdict a human cannot check is not worth having.
 */
export function assessCompleteness(text, { wholeReplyPlanChars = WHOLE_REPLY_PLAN_CHARS, instruction = "" } = {}) {
  const value = String(text ?? "").trim();
  if (!value) return { ok: false, reason: "empty", evidence: null };
  // The model echoing our own instruction back means it is talking to itself, not to the reader — the
  // observed shape of a leaked reasoning stream. The instruction is unique text, so this is exact rather
  // than a guess about tone, and it catches a round the length and punctuation checks would pass.
  if (instruction && echo(value, instruction)) {
    return { ok: false, reason: "narrating", evidence: value.slice(0, 160) };
  }
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

/** Does `value` quote `instruction` back — i.e. is the model narrating the prompt rather than answering? */
function echo(value, instruction) {
  const needle = String(instruction).replace(/^[^"]*"/, "").trim().slice(0, 40).toLowerCase();
  return needle.length >= 20 && value.toLowerCase().includes(needle);
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
  if (reason === "narrating") return "⚠ The model described the conversation instead of answering it — its reasoning was not separated from the answer.";
  return null;
}
