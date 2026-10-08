// Assistant debug logging — the host-side half of the harness, generic so no host rewrites it.
//
// Every host that wants to debug the assistant needs the same thing: forward the events the SDK already
// emits to an endpoint of the host's own, one JSON line per event. The SDK's job ends at *emitting*
// (`pslm-answer`, `pslm-tool`, … — see docs/CHAT.md); deciding what to store, and who the user is, is
// the host's. This module is the wire between them and nothing else:
//
//   attachAssistantLog(panel, { url: "/index.php/api/editor/pslm-log" });
//
// What it deliberately does not do: invent identity (the endpoint takes that from its own session — a
// body that could set `user_id` is a body that can forge one), write to a store, or keep any state
// beyond the last status line it de-duplicated. docs/HOST_CONTRACT.md §logging is the contract the
// host's endpoint has to meet.

/** Per-field bound. The endpoint bounds the body again: the client is not a trust boundary. */
export const MAX_FIELD_CHARS = 4000;

/** Keys the host endpoint owns. Dropped, so a log line cannot claim another user, time or origin. */
export const RESERVED_LOG_KEYS = ["ts", "user_id", "user", "sess", "ip", "event"];

function cut(text, max) {
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
}

/**
 * Bound one value. Objects stay objects while they fit — `tools` is an array in the log and a host
 * queries it as one — and only degrade to a truncated JSON string when they do not.
 */
function bound(value, max) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return cut(value, max);
  if (typeof value !== "object") return value;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.length <= max ? value : `${cut(json, max)}…[cut]`;
}

/**
 * The request body for one event — pure, so the contract a host implements is testable without a
 * browser. `context` says what the reader was looking at (their record, their section); it never says
 * what they may read, which is the host endpoint's own decision.
 */
export function buildLogPayload(event, detail = {}, context = {}, { maxFieldChars = MAX_FIELD_CHARS } = {}) {
  const payload = {
    event: String(event),
    sid: context.recordId ?? "",
    section: context.section ?? "",
    fileId: context.dataFileId ?? "",
  };
  // Anything else the host put in `context` is kept, reserved keys excepted — that is what
  // `attachAssistantLog({ extra })` is for, and a hook that silently did nothing would be worse than
  // no hook. The three context keys above are the harness's own and are not repeated here.
  for (const [key, value] of Object.entries(context)) {
    if (key === "recordId" || key === "section" || key === "dataFileId") continue;
    if (RESERVED_LOG_KEYS.includes(key)) continue;
    payload[key] = bound(value, maxFieldChars);
  }
  for (const [key, value] of Object.entries(detail)) {
    if (RESERVED_LOG_KEYS.includes(key)) continue;
    payload[key] = bound(value, maxFieldChars);
  }
  return payload;
}

/**
 * One event's fields. A table rather than a pile of branches, and the single place that decides what is
 * worth recording — a host reads docs/CHAT.md for the events and this for the fields.
 */
export function logFieldsFor(event, detail = {}) {
  switch (event) {
    case "answer": {
      const usage = detail.usage ?? {};
      return {
        q: detail.question ?? null,
        a: detail.text ?? null,
        engine: detail.engine ?? null,
        ms: typeof detail.ms === "number" ? detail.ms : null,
        tools: detail.tools ?? null,
        grounding: detail.grounding ?? null,
        sources: detail.sources ?? null,
        // Whether the model actually finished, decided in code (src/completeness.js).
        // `completeReason` set means the reply was not an answer.
        complete: detail.completeness ? Boolean(detail.completeness.ok) : null,
        completeReason: detail.completeness?.reason ?? null,
        completeEvidence: detail.completeness?.evidence ?? null,
        peakPrompt: usage.peakPromptTokens ?? null,
        window: usage.windowSize ?? null,
        generated: usage.generatedTokens ?? null,
        trimmed: usage.trimmed ?? 0,
        toolRounds: usage.toolRounds ?? 0,
      };
    }
    case "error":
      return { message: detail.message ?? null };
    // Neutral status lines ("reading field…") are noise; warnings and errors are not.
    case "state":
      return detail.tone === "warn" || detail.tone === "err" ? { tone: detail.tone, text: detail.text ?? null } : null;
    case "suggest":
      return {
        task: detail.task ?? null,
        pointer: detail.pointer ?? null,
        label: detail.label ?? null,
        formatValid: Boolean(detail.formatValid),
        suggestion: detail.suggestion ?? null,
        reason: detail.reason ?? null,
        // A draft that did not parse is the interesting failure: keep the raw text, not just the error.
        error: detail.error ?? null,
        raw: detail.formatValid ? null : (detail.raw ?? null),
        model: detail.model ?? null,
        engine: detail.engine ?? null,
      };
    case "tool":
      return {
        stage: detail.stage ?? null,
        name: detail.name ?? null,
        args: detail.args ?? null,
        network: detail.network ?? null,
        dropped: detail.dropped ?? null,
        cap: detail.cap ?? null,
        bytes: detail.bytes ?? null,
        digest: detail.digest ?? null,
        reason: detail.reason ?? null,
        message: detail.message ?? null,
      };
    case "fill":
      return {
        kind: detail.kind ?? null,
        pointer: detail.pointer ?? null,
        label: detail.label ?? detail.fileId ?? null,
        recordId: detail.recordId ?? null,
        suggestion: detail.suggestion ?? null,
      };
    case "fill_result":
      return { kind: detail.kind ?? null, accepted: detail.accepted ?? null, note: detail.note ?? null };
    default:
      return detail;
  }
}

/**
 * Forward the SDK's events on `root` to `url`; returns a detach function.
 *
 * `url` is the only required option and the only host-specific fact. Everything else — which events,
 * which fields, when an event is dropped — is harness, and identical for every host. `extra()` may add
 * host context; reserved keys are stripped from it too.
 */
export function attachAssistantLog(root, { url, extra, onSend, maxFieldChars = MAX_FIELD_CHARS } = {}) {
  if (!url || !root || typeof document === "undefined") return () => {};

  function noteText() {
    const note = document.querySelector("[data-pslm-note]");
    return note && !note.hidden ? note.textContent : null;
  }

  function send(event, detail = {}) {
    const fields = logFieldsFor(event, detail);
    if (!fields) return;
    let body;
    try {
      const context = {
        recordId: root.dataset.recordId, section: root.dataset.section, dataFileId: root.dataset.dataFileId,
        ...(extra ? extra(event, detail) : null),
      };
      const payload = buildLogPayload(event, fields, context, { maxFieldChars });
      onSend?.(payload);
      body = JSON.stringify(payload);
    } catch { return; }
    try {
      // sendBeacon survives a tab close mid-answer and never blocks the turn; fetch is the fallback.
      if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, credentials: "same-origin" })
        .catch(() => { /* logging is best-effort; a failure must never surface in the conversation */ });
    } catch { /* same */ }
  }

  const on = (type, handler) => {
    document.addEventListener(type, handler);
    return () => document.removeEventListener(type, handler);
  };
  // Mount can announce the same state several times in one burst (one per panel refresh), so repeats
  // collapse to the first — otherwise "model needed" alone drowns the log.
  let lastState = null;

  const detach = [
    on("pslm-answer", (e) => send("answer", e.detail)),
    on("pslm-error", (e) => send("error", e.detail)),
    on("pslm-state", (e) => {
      const d = e.detail ?? {};
      const key = `${d.tone}\u0000${d.text}`;
      if (key === lastState) return;
      lastState = key;
      send("state", d);
    }),
    on("pslm-suggest", (e) => send("suggest", e.detail)),
    on("pslm-tool", (e) => send("tool", e.detail)),
    on("pslm-fill-request", (e) => {
      send("fill", { ...(e.detail ?? {}), kind: "field" });
      // Read the outcome after dispatch, so the answer does not depend on which document listener ran
      // first. Acceptance is the host's own preventDefault.
      setTimeout(() => send("fill_result", { kind: "field", accepted: e.defaultPrevented, note: noteText() }), 0);
    }),
    on("pslm-datafile-fill", (e) => {
      send("fill", { ...(e.detail ?? {}), kind: "datafile-description" });
      // ponytail: this path acknowledges through accept()/deny() callbacks whose last caller wins, so
      // wrapping them would log a coin flip. The host's own note is logged instead; upgrade by having
      // the bundle emit the outcome once, if a field-level distinction is ever needed.
      setTimeout(() => send("fill_result", { kind: "datafile-description", note: noteText() }), 0);
    }),
  ];
  return () => detach.forEach((off) => off());
}
