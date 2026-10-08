// The log request body is the contract a host endpoint implements, so it is tested as data rather than
// through a browser. Field names here are what a host writes its endpoint against.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachAssistantLog, buildLogPayload, logFieldsFor, MAX_FIELD_CHARS, RESERVED_LOG_KEYS } from "../integrations/logging.js";

test("the payload carries the view context and the event's own fields", () => {
  const payload = buildLogPayload("answer", { q: "what is the title?", a: "Yearbook 2025", engine: "webgpu", ms: 4210 },
    { recordId: "11", section: "Project overview", dataFileId: "F1" });
  assert.deepEqual(payload, {
    event: "answer", sid: "11", section: "Project overview", fileId: "F1",
    q: "what is the title?", a: "Yearbook 2025", engine: "webgpu", ms: 4210,
  });
});

test("a body cannot claim identity, time, origin — or a different event name", () => {
  // The endpoint stamps these from its own session; a client that could set them could forge them.
  const payload = buildLogPayload("answer", {
    q: "x", user_id: 999, ts: "spoofed", sess: "spoofed", ip: "1.2.3.4", user: "someone@else", event: "tool",
  });
  assert.equal(payload.event, "answer");
  for (const key of RESERVED_LOG_KEYS) {
    if (key === "event") continue;
    assert.equal(key in payload, false, `${key} must not come from the client`);
  }
});

test("field values are bounded, and an oversized object degrades to a cut string", () => {
  const small = buildLogPayload("tool", { args: { pointer: "/study_desc/title" } });
  assert.deepEqual(small.args, { pointer: "/study_desc/title" }, "a small object stays an object to query");

  const payload = buildLogPayload("answer", { a: "x".repeat(MAX_FIELD_CHARS + 500), tools: ["a".repeat(MAX_FIELD_CHARS)] });
  assert.equal(payload.a.length, MAX_FIELD_CHARS + "…[cut]".length);
  assert.match(payload.a, /…\[cut\]$/);
  assert.match(payload.tools, /…\[cut\]$/);
  assert.equal(typeof payload.tools, "string");
});

test("the answer fields include whether the model actually finished", () => {
  const notAnAnswer = logFieldsFor("answer", {
    question: "q", text: "Let me check the next field as well.",
    completeness: { ok: false, reason: "plan-shaped", evidence: "Let me check the next field as well." },
    usage: { peakPromptTokens: 9010, windowSize: 65536, generatedTokens: 1205, trimmed: 0, toolRounds: 2 },
  });
  assert.equal(notAnAnswer.complete, false);
  assert.equal(notAnAnswer.completeReason, "plan-shaped");
  assert.equal(notAnAnswer.completeEvidence, "Let me check the next field as well.");
  assert.equal(notAnAnswer.peakPrompt, 9010);
  assert.equal(notAnAnswer.window, 65536);
  assert.equal(notAnAnswer.toolRounds, 2);
});

test("neutral status lines are not logged, warnings and errors are", () => {
  assert.equal(logFieldsFor("state", { tone: "", text: "reading field…" }), null);
  assert.deepEqual(logFieldsFor("state", { tone: "warn", text: "model needed" }), { tone: "warn", text: "model needed" });
});

test("an unparsed suggest draft keeps its raw text, a parsed one does not need to", () => {
  const broken = logFieldsFor("suggest", { task: "pslm.suggest-field", formatValid: false, error: "JSON.parse", raw: "prose" });
  assert.equal(broken.raw, "prose");
  assert.equal(logFieldsFor("suggest", { formatValid: true, raw: "{}" }).raw, null);
});

test("attachAssistantLog without a url is inert, not broken", () => {
  // A host that has not built an endpoint must still mount; logging is opt-in by supplying one.
  const detach = attachAssistantLog({ dataset: {} }, {});
  assert.equal(typeof detach, "function");
  detach();
});

test("host context from extra() reaches the payload, reserved keys still do not", () => {
  // A hook that silently did nothing would be worse than no hook, so this is asserted rather than
  // assumed: the editor passes { app: "metadata-editor" } and expects it in every line.
  const payload = buildLogPayload("state", { tone: "warn", text: "model needed" },
    { recordId: "11", section: "Project overview", app: "metadata-editor", user_id: 999 });
  assert.equal(payload.app, "metadata-editor");
  assert.equal(payload.sid, "11");
  assert.equal(payload.section, "Project overview");
  assert.equal("user_id" in payload, false);
  // The harness's own context keys are not repeated as extra fields.
  assert.equal("recordId" in payload, false);
});

test("a detail field wins over host context of the same name", () => {
  const payload = buildLogPayload("tool", { name: "get_current_page" }, { recordId: "1", name: "wrong" });
  assert.equal(payload.name, "get_current_page");
});
