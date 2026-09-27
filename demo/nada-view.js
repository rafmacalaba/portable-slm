import { loadPublicNadaDemoStudy } from "../integrations/metadata-context.js";
import { answerStudyQuestion, loadPublicStudy, savePublicStudy } from "../src/nada-qa.js";

// One bounded public-study workflow. Host UI and data source are replaceable; inference is the
// same local SDK as chat/review. The source snapshot is public and small enough for localStorage.
export function mountNada(root, ai, { embedded = false } = {}) {
  root.innerHTML = `
    <h2>NADA study Q&A</h2>
    <p>Ask about one public study. Answers must quote the title or abstract, or say UNKNOWN.
    A matching quote is a source check—not proof the interpretation is correct.</p>
    ${embedded ? "" : '<p><a href="./">Chat / model manager</a> · <a href="./benchmark.html">Benchmark</a></p>'}
    <label>Model <select id="nada-model"></select></label>
    <label>Public NADA study ID <input id="nada-id" value="Test001_OD" /></label>
    <button id="nada-fetch" type="button">Load study from public NADA (online)</button>
    <p id="nada-status" role="status" aria-live="polite">Checking saved study and model…</p>
    <p>Only published metadata is fetched; no login or credentials. The last study is saved here for offline questions.</p>
    <h3>Source text</h3><pre id="nada-source" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
    <a id="nada-link" href="#" target="_blank" rel="noopener noreferrer" hidden>Open source in NADA</a>
    <label for="nada-question">Question about this study</label>
    <textarea id="nada-question" placeholder="What is this survey used for?"></textarea>
    <button id="nada-ask" type="button" disabled>Ask locally</button>
    <h3>Answer</h3><p id="nada-answer" aria-live="polite"></p>
    <h3>Evidence quoted from source</h3><p id="nada-evidence"></p>`;
  const $ = (id) => root.querySelector(`#${id}`);
  const model = $("nada-model");
  for (const [id, spec] of Object.entries(ai.models)) model.add(new Option(spec.label, id));
  model.value = "lfm2.5-350m-q4km";
  let study = null;
  let busy = false;

  const render = () => {
    $("nada-source").textContent = study ? `${study.title}\n\n${study.abstract}` : "No saved study. Load one while online.";
    $("nada-link").hidden = !study;
    if (study) $("nada-link").href = `https://nada-demo.ihsn.org/index.php/catalog/${encodeURIComponent(study.idno)}`;
  };
  const updateModel = async (notify = true) => {
    const id = model.value;
    const s = await ai.status(id);
    if (!root.isConnected || id !== model.value) return;
    $("nada-ask").disabled = busy || !study || s.state !== "installed";
    if (notify && s.state !== "installed") $("nada-status").textContent = "Model missing. Install it in Chat / model manager, then return here.";
    else if (notify && !busy) $("nada-status").textContent = study ? "Study available locally. Ask online or in airplane mode." : "Model ready. Load a public study while online.";
  };
  try { study = loadPublicStudy(); }
  catch { $("nada-status").textContent = "Saved study was invalid; load it again while online."; }
  if (study) $("nada-id").value = study.idno;
  render();
  updateModel().catch((err) => { $("nada-status").textContent = err.message; });
  model.addEventListener("change", () => updateModel());

  $("nada-fetch").addEventListener("click", async () => {
    if (busy) return;
    busy = true; $("nada-fetch").disabled = true;
    $("nada-status").textContent = "Fetching one public NADA study…";
    try {
      study = await loadPublicNadaDemoStudy($("nada-id").value.trim());
      render();
      try { savePublicStudy(study); $("nada-status").textContent = "Study saved locally for offline questions."; }
      catch { $("nada-status").textContent = "Study loaded, but browser could not save it. Keep this page open or free storage."; }
    } catch (err) { $("nada-status").textContent = `Could not fetch study: ${err.message}. Saved study, if any, remains available.`; }
    finally { busy = false; $("nada-fetch").disabled = false; await updateModel(false); }
  });
  $("nada-ask").addEventListener("click", async () => {
    if (busy || !study) return;
    busy = true; $("nada-ask").disabled = true; $("nada-fetch").disabled = true;
    $("nada-answer").textContent = $("nada-evidence").textContent = "";
    $("nada-status").textContent = "Answering locally…";
    try {
      const result = await answerStudyQuestion(ai, study, $("nada-question").value, { modelId: model.value });
      if (result.status === "invalid") {
        $("nada-answer").textContent = `Unvalidated model draft: ${result.raw}`;
        $("nada-status").textContent = `Cannot verify response: ${result.error}`;
      } else {
        $("nada-answer").textContent = result.answer;
        $("nada-evidence").textContent = result.evidence || "No quote provided.";
        $("nada-status").textContent = result.status === "quoted"
          ? "Evidence quote appears in source. Check that the answer interprets it correctly."
          : result.status === "answer-in-source" ? "Answer text appears in source, but the model's evidence quote did not. Verify the context yourself." :
            result.status === "not-stated" ? "Model answered UNKNOWN; verify against source." :
              "Evidence was not found in source. Treat this answer as unverified.";
      }
    } catch (err) { $("nada-status").textContent = `Could not answer locally: ${err.message}`; }
    finally { busy = false; $("nada-fetch").disabled = false; await updateModel(false); }
  });
  return { busy: () => busy };
}
