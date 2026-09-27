// Read-only widget for NADA and Metadata Editor frontends. Host supplies a loaded-capable
// createLocalSLM instance and its own project/study id. No write or publish API is called.
import { suggestMetadata } from "./metadata-review.js";
import { loadMetadataContext, loadPublicNadaDemoStudy } from "./metadata-context.js";

export function mountMetadataWidget(root, ai, { modelId = "lfm2.5-350m-q4km", source = "nada", recordId = "", path = "/identification/title", apiBase, samples = {}, showAppApi = true } = {}) {
  // Static markup only. Snapshot and model output are assigned with textContent/value below.
  root.innerHTML = `
    <label>Source <select id="source"><option value="nada">NADA catalog study</option><option value="metadata-editor">Metadata Editor project</option></select></label>
    <label>Study / project ID <input id="record-id" /></label>
    <label id="field-label" hidden>Editor field path (JSON Pointer) <input id="field-path" /></label>
    <p id="sample-note"></p>
    <button id="read-api" type="button">Read from this app's API</button>
    <button id="public-nada" type="button">Load public NADA demo study (online)</button>
    <p id="api-help"><small></small></p>
    <label>JSON snapshot (inspect before sending to local model) <textarea id="snapshot" spellcheck="false"></textarea></label>
    <button id="suggest" type="button">Suggest improvement locally</button>
    <p id="status" role="status" aria-live="polite"></p>
    <pre id="output" aria-live="polite"></pre>`;
  const $ = (id) => root.querySelector(`#${id}`);
  let generating = false;
  $("source").value = source;
  $("record-id").value = recordId;
  $("field-path").value = path;
  $("read-api").hidden = !showAppApi;
  $("api-help").textContent = showAppApi
    ? "Public NADA demo needs no login. App API needs this UI hosted inside NADA or Metadata Editor with your normal login. Offline: paste exported JSON."
    : "This HF-hosted demo is not inside NADA or Metadata Editor. Load the public NADA study, or paste sanitized JSON (no credentials or sensitive project data).";
  if (samples[source]) $("snapshot").value = JSON.stringify(samples[source], null, 2);
  $("sample-note").textContent = samples[source] ? "Fictional sample record; not fetched from NADA or Metadata Editor." : "Load a record from this app or paste JSON.";
  $("snapshot").addEventListener("input", () => { $("sample-note").textContent = "User-provided JSON snapshot (not saved by this widget)."; });
  $("field-label").hidden = source !== "metadata-editor";
  $("public-nada").hidden = source !== "nada";
  $("source").addEventListener("change", () => {
    $("field-label").hidden = $("source").value !== "metadata-editor";
    $("public-nada").hidden = $("source").value !== "nada";
    $("snapshot").value = samples[$("source").value] ? JSON.stringify(samples[$("source").value], null, 2) : "";
    $("sample-note").textContent = samples[$("source").value] ? "Fictional sample record; not fetched from NADA or Metadata Editor." : "Load a record from this app or paste JSON.";
  });
  $("public-nada").addEventListener("click", async () => {
    $("public-nada").disabled = true;
    $("status").textContent = "Fetching one published NADA demo study…";
    try {
      const snapshot = await loadPublicNadaDemoStudy();
      $("record-id").value = snapshot.idno;
      $("snapshot").value = JSON.stringify(snapshot, null, 2);
      $("sample-note").textContent = "Real public NADA demo study. Its metadata was fetched online; local inference remains on this device.";
      $("status").textContent = "Public study loaded. Inspect it before requesting a local suggestion.";
    } catch (err) { $("status").textContent = `Could not fetch NADA demo: ${err.message}`; }
    finally { $("public-nada").disabled = false; }
  });
  $("read-api").addEventListener("click", async () => {
    $("read-api").disabled = true;
    $("status").textContent = "Reading authorized metadata from this app…";
    try {
      const snapshot = await loadMetadataContext({ source: $("source").value, id: $("record-id").value, path: $("field-path").value, apiBase });
      $("snapshot").value = JSON.stringify(snapshot, null, 2);
      $("sample-note").textContent = "Snapshot from this app's authenticated API. Inspect before using.";
      $("status").textContent = "Snapshot loaded. Inspect it before requesting a local suggestion.";
    } catch (err) {
      $("status").textContent = `Could not read this app's metadata: ${err.message}. Paste a JSON snapshot instead.`;
    } finally { $("read-api").disabled = false; }
  });
  $("suggest").addEventListener("click", async () => {
    $("suggest").disabled = true;
    generating = true;
    $("status").textContent = "Running locally…";
    $("output").textContent = "";
    try {
      const result = await suggestMetadata(ai, {
        source: $("source").value,
        snapshot: JSON.parse($("snapshot").value),
        modelId,
      });
      if (!result.formatValid) {
        $("output").textContent = `Unvalidated model draft (do not use as metadata):\n${result.raw}`;
        $("status").textContent = `Could not validate response format: ${result.error}`;
      } else {
        $("output").textContent = `Suggestion: ${result.suggestion}\nReason: ${result.reason}`;
        $("status").textContent = "Suggestion ready. Review before using; nothing was saved.";
      }
    } catch (err) {
      $("status").textContent = `Could not create a suggestion: ${err.message}`;
    } finally { generating = false; $("suggest").disabled = false; }
  });
  ai.status(modelId).then((state) => {
    if (!root.isConnected) return;
    $("status").textContent = state.state === "installed" ? "Model ready on this device. Click Suggest." :
      "Model missing. Import or download 350M on this origin first, then return here.";
    $("suggest").disabled = state.state !== "installed";
  }).catch((err) => {
    if (!root.isConnected) return;
    $("status").textContent = `Model check failed: ${err.message}`; $("suggest").disabled = true;
  });
  return { busy: () => generating };
}
