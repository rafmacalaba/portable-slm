// A read-only widget that drafts an improvement for one bounded snapshot the host supplies.
//
// It knows no routes and no applications: the host declares its **shapes** — a label, a route builder, an
// optional query builder and an unwrapper — and the widget offers one option per shape. A host that would
// rather not build this UI at all mounts the panel and declares the same routes in `portable-slm.host.json`.
//
// Nothing here writes: the draft is text in a `<pre>`, and saving, validating and publishing stay with the
// host after a human reviews it.
import { suggestMetadata } from "./field-suggest.js";
import { loadContextSnapshot } from "./snapshot-context.js";

export function mountContextWidget(root, ai, {
  modelId = "lfm2.5-350m-q4km",
  shapes = [],
  shape,
  recordId = "",
  path = "",
  apiBase,
  samples = {},
  showAppApi = true,
  loadSample,
  sampleLabel = "Load a sample record (online)",
} = {}) {
  if (!shapes.length) throw new Error("mountContextWidget needs `shapes`: [{ id, label, endpoint, params?, unwrap?, fieldPath? }]");
  const active = (id) => shapes.find((s) => s.id === id) ?? shapes[0];
  const initial = shape && shapes.some((s) => s.id === shape) ? shape : shapes[0].id;

  // Static markup only. Snapshots and model output are assigned with textContent/value below.
  root.innerHTML = `
    <label>Shape <select id="shape">${shapes.map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}</select></label>
    <label>Record ID <input id="record-id" /></label>
    <label id="field-label" hidden>Field path (JSON Pointer) <input id="field-path" /></label>
    <p id="sample-note"></p>
    <button id="read-api" type="button">Read from this app's API</button>
    <button id="load-sample" type="button" hidden></button>
    <p id="api-help"><small></small></p>
    <label>JSON snapshot (inspect before sending to the local model) <textarea id="snapshot" spellcheck="false"></textarea></label>
    <button id="suggest" type="button">Suggest improvement locally</button>
    <p id="status" role="status" aria-live="polite"></p>
    <pre id="output" aria-live="polite"></pre>`;

  const $ = (id) => root.querySelector(`#${id}`);
  let generating = false;
  const pick = () => active($("shape").value);
  const note = (text) => { $("sample-note").textContent = text; };

  $("shape").value = initial;
  $("record-id").value = recordId;
  $("field-path").value = path;
  $("read-api").hidden = !showAppApi;
  $("load-sample").hidden = typeof loadSample !== "function";
  $("load-sample").textContent = sampleLabel;
  $("api-help").textContent = showAppApi
    ? "Reads this app's own API on this origin, with your existing login. Offline: paste an exported JSON snapshot instead."
    : "This page is not inside the host application. Load a sample, or paste sanitized JSON (no credentials, no private data).";

  function showSample() {
    const sample = samples[pick().id];
    $("snapshot").value = sample ? JSON.stringify(sample, null, 2) : "";
    note(sample ? "Sample record, not fetched from any API." : "Read a record from this app, or paste JSON.");
  }
  function showFields() {
    $("field-label").hidden = !pick().fieldPath;
  }
  showSample();
  showFields();

  $("snapshot").addEventListener("input", () => note("Snapshot provided by hand (not saved by this widget)."));
  $("shape").addEventListener("change", () => { showFields(); showSample(); });

  $("load-sample").addEventListener("click", async () => {
    $("load-sample").disabled = true;
    $("status").textContent = "Fetching a public sample record…";
    try {
      const snapshot = await loadSample();
      $("record-id").value = snapshot.idno ?? snapshot.id ?? "";
      $("snapshot").value = JSON.stringify(snapshot, null, 2);
      note("Public sample record, fetched online. Local inference stays on this device.");
      $("status").textContent = "Sample loaded. Inspect it before asking for a suggestion.";
    } catch (err) {
      $("status").textContent = `Could not fetch the sample: ${err.message}`;
    } finally {
      $("load-sample").disabled = false;
    }
  });

  $("read-api").addEventListener("click", async () => {
    $("read-api").disabled = true;
    $("status").textContent = "Reading this app's metadata…";
    try {
      const route = pick();
      const snapshot = await loadContextSnapshot({
        id: $("record-id").value,
        endpoint: route.endpoint,
        params: route.params,
        unwrap: route.unwrap,
        pointer: route.fieldPath ? $("field-path").value : undefined,
        apiBase,
      });
      $("snapshot").value = JSON.stringify(snapshot, null, 2);
      note("Snapshot from this app's own API. Inspect it before using.");
      $("status").textContent = "Snapshot loaded. Inspect it before asking for a suggestion.";
    } catch (err) {
      $("status").textContent = `Could not read this app's metadata: ${err.message}. Paste a JSON snapshot instead.`;
    } finally {
      $("read-api").disabled = false;
    }
  });

  $("suggest").addEventListener("click", async () => {
    $("suggest").disabled = true;
    generating = true;
    $("status").textContent = "Running locally…";
    $("output").textContent = "";
    try {
      const result = await suggestMetadata(ai, {
        source: pick().label,
        snapshot: JSON.parse($("snapshot").value),
        modelId,
      });
      if (!result.formatValid) {
        $("output").textContent = `Unvalidated model draft (do not use as metadata):\n${result.raw}`;
        $("status").textContent = `Could not validate the response format: ${result.error}`;
      } else {
        $("output").textContent = `Suggestion: ${result.suggestion}\nReason: ${result.reason}`;
        $("status").textContent = "Suggestion ready. Review it before using; nothing was saved.";
      }
    } catch (err) {
      $("status").textContent = `Could not create a suggestion: ${err.message}`;
    } finally {
      generating = false;
      $("suggest").disabled = false;
    }
  });

  ai.status(modelId).then((state) => {
    if (!root.isConnected) return;
    $("status").textContent = state.state === "installed"
      ? "Model ready on this device. Click Suggest."
      : "Model missing. Import or download one on this origin first, then return here.";
    $("suggest").disabled = state.state !== "installed";
  }).catch((err) => {
    if (!root.isConnected) return;
    $("status").textContent = `Model check failed: ${err.message}`;
    $("suggest").disabled = true;
  });

  return { busy: () => generating };
}
