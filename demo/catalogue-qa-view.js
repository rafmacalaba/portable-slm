import { loadContextSnapshot, pickStudySummary } from "../integrations/snapshot-context.js";
// The public demo belongs to the example, not the SDK: this is the file that names a host.
import { PUBLIC_CATALOGUE, loadPublicDemoStudy } from "../examples/catalogue/public-catalogue-demo.js";
import { answerFromEvidence, loadSnapshot, saveSnapshot } from "../src/qa-evidence.js";

// One bounded public-study workflow. Host UI and data source are replaceable; inference is the
// same local SDK as chat/review. The source snapshot is public and small enough for localStorage.
export function mountCatalogueQa(root, ai, { embedded = false, source = "public-demo", recordId = "Test001_OD", apiBase, catalogBase } = {}) {
  root.innerHTML = `
    <h2>Catalogue study Q&A</h2>
    <p>Ask about one public study. Answers must quote the title or abstract, or say UNKNOWN.
    A matching quote is a source check—not proof the interpretation is correct.</p>
    ${embedded ? "" : '<p><a href="./">Chat / model manager</a> · <a href="./benchmark.html">Benchmark</a></p>'}
    <label>Model <select id="study-model"></select></label>
    <label>Study ID <input id="study-id" /></label>
    <button id="study-fetch" type="button">Load study ${source === "instance" ? "from this instance" : "from the public demo"} (online)</button>
    <p id="study-status" role="status" aria-live="polite">Checking saved study and model…</p>
    <p>${source === "instance" ? "Uses this instance's same-origin API and access controls; any session cookie goes only to the host, never to the model." : "Fetches published metadata from the public demo without credentials."} The last study is saved here for offline questions.</p>
    <h3>Source text</h3><pre id="study-source" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
    <a id="study-link" href="#" target="_blank" rel="noopener noreferrer" hidden>Open the source page</a>
    <label for="study-question">Question about this study</label>
    <textarea id="study-question" placeholder="What is this survey used for?"></textarea>
    <button id="study-ask" type="button" disabled>Ask locally</button>
    <h3>Answer</h3><p id="study-answer" aria-live="polite"></p>
    <h3>Evidence quoted from source</h3><p id="study-evidence"></p>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const model = $("study-model");
  for (const [id, spec] of Object.entries(ai.models)) model.add(new Option(spec.label, id));
  model.value = "lfm2.5-350m-q4km";
  let study = null;
  let busy = false;

  const render = () => {
    $("study-source").textContent = study ? `${study.title}\n\n${study.abstract}` : "No saved study. Load one while online.";
    $("study-link").hidden = !study;
    if (study) {
      const base = source === "instance" ? (catalogBase ?? "/index.php/catalog/") : `${PUBLIC_CATALOGUE}/index.php/catalog/`;
      $("study-link").href = new URL(`${encodeURIComponent(study.idno)}`, new URL(base.endsWith("/") ? base : `${base}/`, location.origin)).href;
    }
  };
  const updateModel = async (notify = true) => {
    const id = model.value;
    const s = await ai.status(id);
    if (!root.isConnected || id !== model.value) return;
    $("study-ask").disabled = busy || !study || s.state !== "installed";
    if (notify && s.state !== "installed") $("study-status").textContent = "Model missing. Install it in Chat / model manager, then return here.";
    else if (notify && !busy) $("study-status").textContent = study ? "Study available locally. Ask online or in airplane mode." : "Model ready. Load a public study while online.";
  };
  try {
    const saved = loadSnapshot();
    study = source === "instance" && recordId && saved?.idno !== recordId ? null : saved;
  } catch { $("study-status").textContent = "Saved study was invalid; load it again while online."; }
  $("study-id").value = study?.idno ?? recordId;
  if (source === "instance") $("study-status").textContent = "Use this instance's API. The fetched record will be saved here for offline Q&A.";
  render();
  updateModel().catch((err) => { $("study-status").textContent = err.message; });
  model.addEventListener("change", () => updateModel());

  $("study-fetch").addEventListener("click", async () => {
    if (busy) return;
    busy = true; $("study-fetch").disabled = true;
    $("study-status").textContent = `Fetching one published study ${source === "instance" ? "from this instance" : "from the public demo"}…`;
    try {
      const id = $("study-id").value.trim();
      study = source === "instance"
        ? await loadContextSnapshot({
          source: "instance",
          id,
          apiBase,
          endpoint: (studyId) => `catalog/${encodeURIComponent(studyId)}`,
          unwrap: (data, { id: studyId }) => pickStudySummary(data, studyId),
        })
        : await loadPublicDemoStudy(id);
      render();
      try { saveSnapshot(study); $("study-status").textContent = "Study saved locally for offline questions."; }
      catch { $("study-status").textContent = "Study loaded, but browser could not save it. Keep this page open or free storage."; }
    } catch (err) { $("study-status").textContent = `Could not fetch study: ${err.message}. Saved study, if any, remains available.`; }
    finally { busy = false; $("study-fetch").disabled = false; await updateModel(false); }
  });
  $("study-ask").addEventListener("click", async () => {
    if (busy || !study) return;
    busy = true; $("study-ask").disabled = true; $("study-fetch").disabled = true;
    $("study-answer").textContent = $("study-evidence").textContent = "";
    $("study-status").textContent = "Answering locally…";
    try {
      const result = await answerFromEvidence(ai, study, $("study-question").value, { modelId: model.value });
      if (result.status === "invalid") {
        $("study-answer").textContent = `Unvalidated model draft: ${result.raw}`;
        $("study-status").textContent = `Cannot verify response: ${result.error}`;
      } else {
        $("study-answer").textContent = result.answer;
        $("study-evidence").textContent = result.evidence || "No quote provided.";
        $("study-status").textContent = result.status === "quoted"
          ? "Evidence quote appears in source. Check that the answer interprets it correctly."
          : result.status === "answer-in-source" ? "Answer text appears in source, but the model's evidence quote did not. Verify the context yourself." :
            result.status === "not-stated" ? "Model answered UNKNOWN; verify against source." :
              "Evidence was not found in source. Treat this answer as unverified.";
      }
    } catch (err) { $("study-status").textContent = `Could not answer locally: ${err.message}`; }
    finally { busy = false; $("study-fetch").disabled = false; await updateModel(false); }
  });
  return { busy: () => busy };
}
