// L2 embed entry for host pages: <div data-pslm data-record-id="6"></div>
// <script type="module" src="/portable-slm/embed.js"></script>
//
// Reads its own directory for `portable-slm.host.json` (host manifest) and
// `embed-assets.json` (wasm/worker URLs), so the host never imports @wllama assets
// or hardcodes SDK paths. Read-only: no host write API is ever called.
import { createLocalSLM } from "../src/index.js";
import { MODELS } from "../src/models.js";
import { defaultTools } from "../src/tools.js";
import { SUGGEST_FIELD_TASK, suggestMetadata } from "./field-suggest.js";
import {
  allowsTask, byteCap, buildHostTools, DECLARED_POINTERS, expand, fileSubjectChanged, fitToolResult,
  hostTools, mountMode, validateManifest,
} from "./host-contract.js";
import { fetchDatafileContext } from "./datafile-context.js";
// The manifest-declared context reads live in their own DOM-free module so they can be tested without a
// browser. Re-exported below, because host-check and the docs import them from here.
import { contextCredentials, fetchApp, fetchField, fetchJson, fetchRecord } from "./context-read.js";
import { buildCorpusIndex, corpusChunks, createRetrievalContext, fetchCorpus, indexCache, indexParams } from "./retrieval-context.js";
import { createEmbedder } from "../src/embedder.js";
import { MD_CSS, renderMarkdown } from "./chat.js"; // also registers <pslm-chat>, the chat surface
import { assistantSystemPrompt } from "./chat-core.js";

const DEFAULT_MODEL = "lfm2.5-350m-q4km";

async function readJson(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${res.status}`);
  return res.json();
}

// A manifest is what turns a plain assistant into a host-aware one, so "not served here" is a mode
// and not an error — but 403, 500 or a broken file is. Absent degrades, present-and-wrong fails.
async function readOptionalJson(url) {
  // Configuration must not arrive stale. Most hosts serve this JSON as a plain static file with no
  // Cache-Control, so the browser caches it heuristically from Last-Modified and keeps serving the
  // previous manifest after an edit — which silently changes the endpoints, byte caps and task
  // allowlist the assistant operates under. `no-store` is the smallest honest fix.
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${res.status}`);
  return res.json();
}

// Host APIs commonly redirect an expired session to the login page with HTTP 200 and HTML,
// which would otherwise surface as a JSON parse error.

// Manifest lives next to the bundle by default; a host that keeps it outside the bundle
// (e.g. mounted separately in Docker) points at it with data-manifest, and a caller may pass the
// URL directly (host-check.html does).
// Assets are always resolved from the bundle directory.
async function loadConfig(source) {
  const here = new URL(".", import.meta.url);
  const declared = typeof source === "string" ? source : source?.dataset?.manifest;
  const manifestUrl = declared ? new URL(declared, window.location.origin) : new URL("portable-slm.host.json", here);
  const declaredManifest = await readOptionalJson(manifestUrl);
  // A manifest that exists but does not match this contract is a hard stop: "no guessing" is the
  // whole reason to have a version string. A missing one is just a page that has not declared anything.
  const manifest = declaredManifest === null ? null : validateManifest(declaredManifest);
  const assetsFile = await readJson(new URL("embed-assets.json", here));
  const assets = {};
  for (const [key, path] of Object.entries(assetsFile)) assets[key] = new URL(path, here).href;
  // The build stamp is optional: a host still running an older dist/ must mount, not fail.
  const version = await readJson(new URL("version.json", here)).catch(() => null);
  // The directory the manifest was served from: relative URLs in it resolve against this, so a host can
  // serve the pack at any subpath. Assets stay relative to the bundle, which is a separate question.
  const base = new URL(".", manifestUrl).href;
  return { here, manifest, assets, version, base };
}




// The user's own project list (server-scoped to their access). Lets "what projects do I have?"
// work on record-less pages, where no record snapshot exists.
async function fetchProjects(manifest) {
  const projects = manifest.context?.projects;
  if (!projects?.url) throw new Error("Manifest has no context.projects.url");
  const url = new URL(expand(projects.url, {}), window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("context.projects.url must be same-origin");
  const json = await fetchJson(url.href, "Projects list");
  // Rows arrive as `projects` (array in some builds, id-keyed map in others).
  const raw = json.projects ?? json.result;
  const rows = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  const compact = rows.slice(0, 100).map((row) => ({
    id: row.id, idno: row.idno,
    title: typeof row.title === "string" ? row.title.slice(0, 200) : "",
    type: typeof row.type === "string" ? row.type : "",
    changed: typeof row.changed_utc === "string" ? row.changed_utc.slice(0, 10) : "",
  })).filter((row) => row.title || row.idno);
  return byteCap(compact, projects.maxBytes || 8192);
}

const TEMPLATE = `
<style>
  /* Structure and behaviour: the SDK's job. Geometry, position and palette belong to the host,
     which is why every rule here is wrapped in :where() — zero specificity, so the host's own
     stylesheet overrides any of it without !important. */
  :where(.pslm){box-sizing:border-box;font:13px/1.45 system-ui,sans-serif;border:1px solid #d0d7de;
        background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(27,31,36,.12);padding:10px;
        height:70vh;max-height:70vh;overflow:hidden;display:flex;flex-direction:column;gap:8px}
  :where(.pslm) *,:where(.pslm) *::before,:where(.pslm) *::after{box-sizing:border-box}
  :where(.pslm) h3{margin:0;font-size:13px;display:flex;justify-content:space-between;align-items:center;flex:0 0 auto}
  :where(.pslm) .bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:#57606a;flex:0 0 auto}
  :where(.pslm) select[data-model-select]{border-radius:999px;padding:3px 10px;border-color:#d0d7de;
    background:#fff;color:#1c2b36;font-weight:600;cursor:pointer;max-width:220px}
  :where(.pslm) select[data-model-select]:hover{border-color:#0969da}
  :where(.pslm) .bar button{border-radius:999px;font-size:12px;padding:3px 10px}
  :where(.pslm) button,:where(.pslm) select,:where(.pslm) input{font:inherit;padding:4px 8px}
  :where(.pslm) .tabs{display:flex;gap:4px;border-bottom:1px solid #d0d7de;flex:0 0 auto}
  :where(.pslm) .tabs button{border:0;background:none;padding:6px 10px;cursor:pointer;border-bottom:2px solid transparent}
  :where(.pslm) .tabs button[aria-selected=true]{border-bottom-color:#0969da;font-weight:600}
  /* Panes are the scroll owner: display only when not [hidden], and min-height:0 so the
     transcript inside can scroll instead of pushing the composer out of the panel. */
  :where(.pslm) [data-pane]{display:none;flex-direction:column;gap:8px;flex:1 1 auto;min-height:0}
  :where(.pslm) [data-pane]:not([hidden]){display:flex}
  :where(.pslm) pslm-chat{border:0;padding:0;flex:1 1 auto;min-height:0;width:100%}
  :where(.pslm) [data-pane=suggest]{overflow-y:auto}
  :where(.pslm) .out{white-space:pre-wrap;background:#f6f8fa;padding:8px;border-radius:6px;min-height:48px}
  :where(.pslm) .out .kv{margin:0 0 .5rem}
  :where(.pslm) .out .kv>b{display:block;font-size:11px;text-transform:uppercase;
    letter-spacing:.04em;color:#57606a;margin-bottom:.15rem}
  ${MD_CSS}
  :where(.pslm) details{font-size:12px;color:#57606a}
  :where(.pslm) pre{white-space:pre-wrap;word-break:break-word;max-height:18vh;overflow:auto;background:#f6f8fa;padding:6px}
  :where(.pslm) .state{font-weight:600}
  :where(.pslm) .state.ok{color:#1a7f37}:where(.pslm) .state.warn{color:#9a6700}:where(.pslm) .state.err{color:#cf222e}
  :where(.pslm) .build{color:#8b949e}
  :where(.pslm) .notice{color:#9a6700;flex:1 1 100%}
</style>
<h3><span></span><button type="button" data-close title="Close">✕</button></h3>
<div class="bar">
  <span class="state"></span>
  <select data-model-select aria-label="Assistant model" hidden></select>
  <span data-model-label hidden></span>
  <span class="build" data-build hidden></span>
  <span class="notice" data-notice hidden>no record on this page — answers are not grounded in your data</span>
  <button type="button" data-install hidden>Install model</button>
  <button type="button" data-load hidden>Load model</button>
  <button type="button" data-unload hidden>Unload from memory</button>
  <button type="button" data-remove hidden>Delete cached files</button>
  <button type="button" data-clear-models hidden>Clear all model files</button>
  <button type="button" data-reload hidden>Reload assistant</button>
</div>
<div class="tabs" role="tablist">
  <button type="button" role="tab" data-tab="chat" aria-selected="true">Chat</button>
  <button type="button" role="tab" data-tab="suggest" aria-selected="false">Suggest field</button>
</div>
<div data-pane="chat">
  <pslm-chat data-chat tools="offline" no-model-bar style="width:100%"></pslm-chat>
</div>
<div data-pane="suggest" hidden>
  <label>Field <select data-pointers></select></label>
  <button type="button" data-suggest>Suggest improvement</button>
  <button type="button" data-copy hidden>Copy suggestion</button>
  <button type="button" data-fill hidden>Fill this field</button>
  <div class="out" data-out aria-live="polite"></div>
  <!-- Only this tab's disclosure: <pslm-chat> renders its own inside the chat pane. -->
  <details data-sent><summary>What was sent to the model</summary><pre data-sent-body></pre></details>
  <div class="bar" data-prov></div>
</div>
`;

function mount(root, { manifest, ai, version, base = window.location.origin, assets }) {
  root.innerHTML = TEMPLATE;
  // Two declarations decide everything the panel can do: a manifest (authorized reads) and a record
  // id (which record). Neither is needed to mount — see mountMode() for the ladder.
  const mode = mountMode({ manifest, recordId: root.dataset.recordId });
  root.querySelector("h3 span").textContent = `${manifest?.app?.name || "Portable SLM"} · local assistant`;
  const $ = (sel) => root.querySelector(sel);
  // Compact selector name; the full label (size, role) moves to the hover title.
  const shortModel = (id) => MODELS[id]?.label.match(/LFM2\.5-[\d.]+[MB](?:-Instruct)?/)?.[0] || MODELS[id]?.label || id;
  const state = { model: manifest?.model || DEFAULT_MODEL, installed: false, draft: null, fileId: null, section: root.dataset.section || "" };
  const datafileMode = mode.datafile;
  const datafileContext = () => {
    const fileId = state.fileId || root.dataset.dataFileId || "";
    return fileId ? fetchDatafileContext({ source: manifest.context.datafile, recordId: root.dataset.recordId, fileId,
      credentials: contextCredentials(manifest) })
      : Promise.resolve(null);
  };
  const onFileChange = () => {
    const next = root.dataset.dataFileId || "";
    if (next === state.fileId) return;
    // Only a move between two concrete files invalidates the transcript: the new file's snapshot
    // replaces the old one, so keeping history would re-ground an old answer on a new subject.
    // Entering or leaving a file section (the datafiles list, a project view) keeps the chat.
    const switched = fileSubjectChanged(state.fileId, next);
    state.fileId = next;
    if (switched) chat.clear();
    refreshDatafileTab();
  };
  root.addEventListener("pslm-datafile-change", onFileChange);
  // The host router announces every navigation (section label + file id). The section becomes a
  // "Current view" line in the context; file sections additionally drive the datafile feed.
  root.addEventListener("pslm-state", (event) => {
    const { text, tone } = event.detail || {};
    if (typeof text === "string") setState(text, tone);
  });
  root.addEventListener("pslm-route-change", (event) => {
    state.section = event.detail?.section || root.dataset.section || "";
    onFileChange();
  });

  const chat = $("[data-chat]");
  // Keep general chat's local utilities (calculator/date) available alongside host-declared tools.
  // Do not implicitly include online tools such as wiki_search.
  chat.tools = defaultTools().filter((tool) => !tool.network);
  // Which build the host is really serving, visible in the panel: a stale bind mount or a half-
  // copied dist/ becomes a one-glance diagnosis instead of a debugging session.
  $("[data-build]").textContent = version
    ? `build ${version.version}${version.gitSha ? `+${version.gitSha}` : ""}`
    : "";
  // Context-source disclosure lives in the status chip's hover, not as a permanent bar element:
  // the claim stays checkable without occupying the widget.
  let sourceNotice = mode.context === "app"
    ? "source: application help text (no record on this page — answers come from the application's own help text, not your data)"
    : mode.context === "record"
      ? "source: record snapshot (grounded in this record's saved data)"
      : "source: model general knowledge (no project or help context on this page)";
  $("[data-notice]").hidden = true;

  function setState(text, cls) {
    const el = $(".state");
    el.textContent = text;
    el.className = `state ${cls || ""}`;
    // The data-source disclosure rides the status chip's hover — never a permanent bar element.
    el.title = `${text} — ${sourceNotice}`;
  }
  function provenance(parts) {
    $("[data-prov]").textContent = parts.filter(Boolean).join(" · ");
  }
  function showSent(text, truncated) {
    $("[data-sent-body]").textContent = truncated ? `${text}\n… truncated to fit the byte cap` : text;
  }

  // Chat is the vanilla <pslm-chat>; this host supplies its shared engine, authorized snapshot,
  // local utilities, and (on record pages only) explicitly approved host reads. No online search
  // tool is enabled implicitly.
  chat.ai = ai;
  chat.model = state.model;
  const modelSelect = $("[data-model-select]");
  const modelChoices = manifest?.models?.available;
  if (Array.isArray(modelChoices)) {
    if (!modelChoices.length || modelChoices.some((id) => !MODELS[id] || MODELS[id].runtime !== "transformers")) {
      throw new Error("manifest.models.available must contain known Transformers.js model ids");
    }
    if (!modelChoices.includes(state.model)) throw new Error(`manifest.model "${state.model}" is not in models.available`);
    for (const id of modelChoices) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = shortModel(id);
      option.title = MODELS[id].label;
      modelSelect.append(option);
    }
    modelSelect.hidden = modelChoices.length < 2;
    modelSelect.value = state.model;
    $("[data-model-select]").addEventListener("change", async (event) => {
      const previous = state.model;
      state.model = event.target.value;
      chat.model = state.model;
      setState("checking model status…"); // clear any prior model's quota error immediately
      // Free the previous model's RAM/GPU memory right away; loading the new one would unload it
      // lazily anyway, but switching means the curator wants the other model now.
      if (state.loadedId && state.loadedId !== state.model) {
        try { await ai.unload(); } catch { /* nothing loaded */ }
      }
      autoLoad().catch((err) => setState(err.message, "err"));
    });
  }
  // Declared tools are offered only when the element asks for them, exactly like data-fill: a host
  // that has not thought about what its API exposes should not get a model that goes looking. And
  // only on a record page: every declared endpoint is scoped to {id}, so with no record on screen
  // there is no narrower permission to work under — "any project" is not what the host declared.
  if (root.hasAttribute("data-tools") && root.dataset.recordId) {
    const declared = buildHostTools(manifest, root.dataset.recordId, { base });
    if (declared.length) {
      chat.tools = [...chat.tools, ...declared];                // offline utilities plus scoped host reads
      chat.setAttribute("tools", chat.tools.map((t) => t.name).join(","));  // explicit, never "all"
      chat.setAttribute("allow-network", "");                  // network tools are dropped without it
    }
  }
  // On-demand page context: the current view line is always on, but the heavy page payload
  // (data file facts + variable inventory) loads only when the model asks. Same-origin, GET,
  // capped — and it still waits for per-call approval like every other host read.
  if (mode.context === "record") {
    chat.tools.push({
      name: "get_current_page",
      description: "Load the context of the current application view: the open data file's metadata "
        + "and variable inventory (names, labels, descriptions), or the project record when a full "
        + "snapshot is needed. Call it when the user asks about what is on screen, a data file, its "
        + "variables, or needs details beyond the supplied project header.",
      parameters: { type: "object", properties: {}, required: [] },
      network: true,
      maxResultBytes: 16000,
      run: async () => {
        // Headroom under maxResultBytes: fitToolResult measures what agent.js measures (the encoded
        // result), but the two must not sit exactly on the same byte or a rounding difference is a
        // failed turn. Every return below is fitted — both sources are capped by *prompt* budgets
        // (24 KB record, 16 KB datafile) that can exceed this tool's result budget.
        const budget = 15600;
        try {
          try {
            const file = await datafileContext();
            if (file) {
              const page = JSON.parse(file.text);
              return fitToolResult({ view: state.section || "data file", page }, budget);
            }
          } catch (fileErr) {
            console.warn("get_current_page: datafile context failed", fileErr);
          }
          const record = await fetchRecord(manifest, root.dataset.recordId, base);
          // record.text is byte-capped and may be truncated JSON — pass it through as text.
          return fitToolResult({ view: state.section || "project", record: record.text }, budget);
        } catch (err) {
          // Never throw: the model relays the failure, the turn survives, and the cause is visible.
          console.warn("get_current_page failed:", err);
          return { error: `Could not load page context: ${err.message}` };
        }
      },
    });
    chat.setAttribute("tools", chat.tools.map((t) => t.name).join(","));
    chat.setAttribute("allow-network", "");
  }
  // Hosts may wave read-only tools through without a per-call click (manifest.toolApproval=auto).
  // The other guards — GET-only, same-origin, record-pinned id, pointer allowlist, byte caps —
  // are unchanged; this only removes the human click, never widens what a tool can reach.
  if (manifest?.toolApproval === "auto") chat.approveTool = async () => true;
  // Keep general conversation available in every mode; only claims about host-specific data are
  // bounded by the help text, saved record snapshot, and explicitly approved tools.
  const app = manifest?.app?.name || "this application";
  chat.system = assistantSystemPrompt({ app, context: mode.context, kind: manifest?.context?.app?.kind ?? "help" });
  // Which host source feeds the prompt, if any. With none attached, <pslm-chat> still carries
  // Portable SLM's own description and says the answer is not grounded in the user's data.
  if (mode.context === "record") {
    chat.onContext = async () => {
      const parts = [];
      if (state.section) parts.push(`--- current view (declared by the application) ---\n${state.section}`);
      if (state.fileId || root.dataset.dataFileId) {
        // File page: compact header + current view always on; the variable inventory is pulled
        // on demand through the get_current_page tool instead of prefilled every turn.
        const declared = new Map((manifest.context?.field?.pointers || []).map((p) => [p.pointer, p.label || p.pointer]));
        const header = {};
        for (const pointer of ["/study_desc/title_statement/title", "/study_desc/study_info/abstract", "/study_desc/study_info/universe"]) {
          if (!declared.has(pointer)) continue;
          try {
            const field = await fetchField(manifest, root.dataset.recordId, pointer, base);
            header[declared.get(pointer)] = JSON.parse(field.text).value;
          } catch { /* header is best-effort; the file context carries the page */ }
        }
        if (Object.keys(header).length) parts.push(`--- project (compact header) ---\n${JSON.stringify(header)}`);
      } else {
        const record = await fetchRecord(manifest, root.dataset.recordId, base);
        parts.push(record.truncated ? `${record.text}\n… truncated to fit the byte cap` : record.text);
      }
      const file = state.fileId || root.dataset.dataFileId ? null : await datafileContext().catch((err) => {
        setState(err.message, "warn");
        return null;
      });
      if (file) parts.push(`--- open data file ---\n${file.text}${file.truncated ? "\n… variable list truncated to fit the byte cap" : ""}`);
      return parts.join("\n\n");
    };
  } else if (mode.context === "app") {
    chat.onContext = async () => {
      const app = await fetchApp(manifest, base);
      const parts = [app.truncated ? `${app.text}\n… truncated to fit the byte cap` : app.text];
      if (manifest.context?.projects?.url) {
        try {
          const projects = await fetchProjects(manifest);
          parts.push(`--- the user's projects (from the application, server-scoped to their access) ---\n${projects.text}${projects.truncated ? "\n… truncated to fit the byte cap" : ""}`);
        } catch (err) {
          setState(`Projects list unavailable: ${err.message}`, "warn");
        }
      }
      return parts.join("\n\n");
    };
  }

  // A declared corpus turns the provider into a ranked read. This supersedes the whole-document
  // providers above, because the whole point is that the byte cap stops deciding what the model sees.
  // BM25 answers from the first question with nothing downloaded; embeddings join when they are
  // installed. A failure here degrades to the provider that was already set, never to no context.
  const retrieval = createRetrievalContext({
    manifest, base,
    storage: typeof caches === "undefined" ? null : indexCache(),
    embedder: createEmbedder({ assets }),
    // A warning is worth the status line. Progress is not: it would be overwritten by the next model
    // state and the reader would lose the one durable fact, which is what the answers are drawn from.
    onStatus: (message, level) => {
      if (level === "warn") setState(message, "warn");
      else {
        // Retrieval replaces the whole-document source, so the disclosure has to stop claiming the
        // document is the source. Naming both would be describing the old behaviour as if it were current.
        sourceNotice = `source: retrieved from this application's own documents (${message})`;
        $(".state").title = `${$(".state").textContent} — ${sourceNotice}`;
      }
    },
  });
  if (retrieval) {
    chat.onContext = (question) => retrieval.onContext(question);
    // The source of the answers is announced through onStatus, which writes the disclosure title rather
    // than the status line: a status line would be replaced by the next model state and the fact lost.
    retrieval.ready().catch(() => {});
  }

  async function refresh() {
    const st = await ai.status(state.model);
    state.installed = st.state === "installed";
    state.loadedId = st.loaded ? state.model : null;
    const ctxTokens = MODELS[state.model]?.ctx ?? 32768;
    const full = MODELS[state.model]?.label || state.model;
    // The selector carries identity compactly; size, engine and install state are hover detail.
    const select = $("[data-model-select]");
    if (select.value !== state.model) select.value = state.model;
    select.title = `${full} · ${state.installed
      ? (st.loaded ? `${st.engine || "loaded"} · ${Math.round(ctxTokens / 1024)}K ctx` : "on disk, not loaded")
      : "not installed on this device"}${st.crossOriginIsolated ? "" : " · single-thread"}`;
    $("[data-model-label]").textContent = state.installed
      ? `${full} · ${st.loaded ? (st.engine || "loaded") : "on disk, not loaded"} · ${Math.round(ctxTokens / 1024)}K ctx${st.crossOriginIsolated ? "" : " · single-thread"}`
      : `${full} · not installed on this device`;
    $("[data-install]").hidden = state.installed;
    // One model in memory at a time: Load appears when bytes are on disk but weights are not in
    // RAM; Unload appears only while something is loaded. Loading a different model implicitly
    // unloads the previous one (see createLocalSLM.load).
    $("[data-load]").hidden = !(state.installed && !st.loaded);
    $("[data-unload]").hidden = !st.loaded;
    setState(
      state.installed ? (st.loaded ? "ready" : "installed — click Load or send a message") : "model needed",
      state.installed ? "ok" : "warn",
    );
    return st;
  }

  async function suggest() {
    const pointer = $("[data-pointers]").value;
    if (!pointer) return;
    $("[data-out]").textContent = "";
    if (pointer === "@datafile") {
      setState("reading data file…");
      const file = await datafileContext().catch((err) => { setState(err.message, "err"); return null; });
      if (!file) return;
      showSent(file.text, file.truncated);
      setState("suggesting locally…");
      try {
        const result = await suggestMetadata(ai, {
          task: "pslm.suggest-datafile-description",
          source: manifest?.app?.name || "unspecified host",
          snapshot: JSON.parse(file.text),
          modelId: state.model,
        });
        renderDraft(result, { pointer, label: `Description of ${file.context.datafile.file_name}`, fileId: file.context.datafile.file_id });
      } catch (err) { setState(err.message, "err"); }
      return;
    }
    setState("reading field…");
    let field;
    try {
      field = await fetchField(manifest, root.dataset.recordId, pointer, base);
    } catch (err) { return setState(err.message, "err"); }
    showSent(field.text, field.truncated);
    setState("suggesting locally…");
    try {
      const result = await suggestMetadata(ai, {
        task: SUGGEST_FIELD_TASK,
        // Whose metadata this is, from the host's own declaration — never a name hardcoded here.
        source: manifest?.app?.name || "unspecified host",
        snapshot: JSON.parse(field.text),
        modelId: state.model,
      });
      renderDraft(result, { pointer, label: $("[data-pointers]").selectedOptions[0]?.textContent || pointer, fileId: null });
    } catch (err) {
      setState(err.message, "err");
    }
  }

  function renderDraft(result, { pointer, label, fileId }) {
    const out = $("[data-out]");
    if (result.formatValid) {
      // Formatted for reading; the value handed to Copy and to Fill is the plain text the model
      // returned (already decoratively normalised in metadata-review), so what you see is what
      // lands in the field.
      out.replaceChildren(...[["Suggestion", result.suggestion], ["Reason", result.reason]]
        .map(([entry, value]) => {
          const section = document.createElement("div");
          section.className = "kv";
          const title = document.createElement("b");
          title.textContent = entry;
          section.append(title, renderMarkdown(value));
          return section;
        }));
      $("[data-copy]").hidden = false;
      $("[data-copy]").dataset.value = result.suggestion;
      state.draft = {
        task: result.task,
        recordId: root.dataset.recordId,
        pointer,
        label,
        fileId,
        suggestion: result.suggestion,
        reason: result.reason,
      };
      // Datafile drafts route through the host's own datafile-form listener; field drafts through
      // pslm-fill-request. Each only when the host opted in.
      $("[data-fill]").hidden = !(root.hasAttribute("data-fill") && (fileId ? datafileMode : mode.fill));
    } else {
      out.textContent = `Model output was not valid JSON (${result.error}).\n\n${result.raw}`;
      state.draft = null;
      $("[data-fill]").hidden = true;
    }
    provenance([`task ${result.task}`, `model ${state.model}`, fileId ? `file ${fileId}` : `pointer ${pointer}`, result.engine,
      "shape check only — not factual review"]);
    // Host seam: the draft as data, so a host can log or diff it without scraping [data-out].
    // Carries no host knowledge and writes nothing — the host decides what, if anything, to do.
    root.dispatchEvent(new CustomEvent("pslm-suggest", {
      bubbles: true,
      detail: {
        task: result.task, model: state.model, engine: result.engine ?? null,
        recordId: root.dataset.recordId, fileId, pointer, label,
        formatValid: Boolean(result.formatValid),
        suggestion: result.suggestion ?? null, reason: result.reason ?? null,
        error: result.error ?? null, raw: result.raw ?? null,
      },
    }));
    setState("ready", "ok");
  }

  // A datafile mount adds one picker entry for the open file's Description; the host announces
  // navigation with data-file-id + pslm-datafile-change, so the option follows the curator.
  function refreshDatafileTab() {
    const select = $("[data-pointers]");
    let option = select.querySelector("option[value='@datafile']");
    const active = Boolean(root.dataset.dataFileId) && datafileMode && allowsTask(manifest, "pslm.suggest-datafile-description");
    if (active && !option) {
      option = document.createElement("option");
      option.value = "@datafile";
      option.textContent = "Data file description (open file)";
      select.prepend(option);
    } else if (!active && option) {
      option.remove();
    }
  }

  $("[data-install]").addEventListener("click", async () => {
    const spec = MODELS[state.model];
    setState(`installing… 0%`);
    try {
      await ai.download(state.model, {
        sourceForFile: (file) => {
          const relative = file.path ? `${state.model}/${file.path}` : file.file;
          const mirror = manifest.models?.mirror
            ? new URL(`${manifest.models.mirror.replace(/\/$/, "")}/${relative}`, window.location.origin).href
            : null;
          return [mirror, file.url].filter(Boolean);
        },
        onProgress: (p) => setState(`${p.phase} ${Math.round((p.done / (p.total || 1)) * 100)}% · ${p.file || spec.label}`),
      });
      setState("loading model…");
      await ai.load(state.model);
      await refresh();
    } catch (err) {
      await refresh().catch(() => {}); // reveal Remove model if a failed transfer left partial chunks
      setState(err.message, "err");
      $("[data-reload]").hidden = false;
      revealClearButton();
    }
  });
  $("[data-load]").addEventListener("click", async () => {
    try {
      setState("loading model into memory…");
      await ai.load(state.model);
      await refresh();
    } catch (err) { setState(err.message, "err"); }
  });
  $("[data-unload]").addEventListener("click", async () => {
    try {
      setState("unloading model from memory…");
      await ai.unload();
      await refresh();
    } catch (err) { setState(err.message, "err"); }
  });
  $("[data-remove]").addEventListener("click", async () => {
    const label = MODELS[state.model]?.label || state.model;
    if (!window.confirm(`Delete cached files for ${label}? This browser must download them again before reuse.`)) return;
    try {
      setState("deleting cached files…");
      await ai.remove(state.model);
      await refresh();
    } catch (err) { setState(err.message, "err"); }
  });
  $("[data-clear-models]").addEventListener("click", async () => {
    if (!window.confirm("Delete all Portable SLM model files from this browser profile, including older model versions? This does not clear other site data or the remote Hugging Face models.")) return;
    try {
      setState("clearing Portable SLM model files…");
      const count = await ai.clearModels();
      await refresh();
      setState(`cleared ${count} cached model chunks`, "ok");
    } catch (err) { setState(err.message, "err"); }
  });
  // The nuclear option lives one click away: reveal it only after a failed install, when leftover
  // chunks are the likely suspect and freeing everything is the honest next step.
  const revealClearButton = () => { $("[data-clear-models]").hidden = false; };
  $("[data-reload]").addEventListener("click", () => window.location.reload());
  $("[data-close]").addEventListener("click", () => { root.hidden = true; });
  $("[data-suggest]").addEventListener("click", suggest);
  $("[data-copy]").addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(e.target.dataset.value || "");
    e.target.textContent = "Copied";
    setTimeout(() => { e.target.textContent = "Copy suggestion"; }, 1500);
  });
  // Fill this field: the bundle still never writes to the host. One human click announces an
  // intent as a cancelable event; the host's own form code decides whether its input receives the
  // text and acknowledges by calling preventDefault(). Nothing here touches a host write API, so
  // writeBack stays false in pslm-host/1 — the curator reviews and saves as before.
  $("[data-fill]").addEventListener("click", () => {
    if (!state.draft) return;
    // Datafile drafts go to the host's datafile-form listener (document-level, accept/deny);
    // field drafts use the cancelable pslm-fill-request, as before.
    const datafileDraft = Boolean(state.draft.fileId);
    if (datafileDraft) {
      let accepted = false;
      root.dispatchEvent(new CustomEvent("pslm-datafile-fill", {
        bubbles: true, detail: {
          fileId: state.draft.fileId,
          suggestion: state.draft.suggestion,
          accept: () => { accepted = true; },
          deny: () => { accepted = false; },
        },
      }));
      const button = $("[data-fill]");
      button.textContent = accepted ? "Filled" : "Host did not accept";
      setTimeout(() => { button.textContent = "Fill this field"; }, 1800);
      return;
    }
    const accepted = !root.dispatchEvent(new CustomEvent("pslm-fill-request", {
      bubbles: true, cancelable: true, detail: state.draft,
    }));
    const button = $("[data-fill]");
    button.textContent = accepted ? "Filled" : "Host did not accept";
    setTimeout(() => { button.textContent = "Fill this field"; }, 1800);
  });
  function selectTab(name) {
    for (const t of root.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const pane of root.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== name;
  }
  // A manifest allowlist is a real allowlist: a task the host did not declare gets no tab rather
  // than a disabled one, so the host never advertises a capability it switched off.
  const allowed = { chat: allowsTask(manifest, "pslm.chat"), suggest: mode.suggest && allowsTask(manifest, SUGGEST_FIELD_TASK) };
  for (const [name, on] of Object.entries(allowed)) {
    const tab = root.querySelector(`[data-tab=${name}]`);
    tab.hidden = !on;
    tab.addEventListener("click", () => selectTab(name));
  }
  if (allowed.chat || allowed.suggest) selectTab(allowed.chat ? "chat" : "suggest");
  else setState("Host manifest allows no tasks", "warn");

  for (const p of (mode.suggest && manifest.context?.field?.pointers) || []) {
    const option = document.createElement("option");
    option.value = p.pointer;
    option.textContent = p.label || p.pointer;
    $("[data-pointers]").appendChild(option);
  }
  refreshDatafileTab();
  if (root.dataset.dataFileId) state.fileId = root.dataset.dataFileId;

  refresh().catch((err) => setState(err.message, "err"));
  // Auto-load: an installed model becomes ready without waiting for the first message.
  const autoLoad = async () => {
    try {
      const st = await ai.status(state.model);
      if (st.state === "installed" && !st.loaded) {
        setState("loading model into memory…");
        await ai.load(state.model);
      }
      await refresh();
    } catch (err) { setState(err.message, "warn"); }
  };
  autoLoad();
  return { refresh, setState, autoLoad };
}

/**
 * Mount the panel on `root`, reading the host manifest if one is served. A page that serves no
 * manifest still gets a working assistant — plain chat, its own engine, nothing groundless claimed
 * about it. See mountMode() for what each declaration unlocks.
 */
export async function mountFromManifest(root) {
  const { manifest, assets, version, base } = await loadConfig(root);
  const ai = createLocalSLM({ assets });
  const panel = mount(root, { manifest, ai, version, base, assets });
  // Chrome last: it appends into the panel, so running it before the template write would have its
  // handles replaced immediately (which the observer would then fix, one re-render later).
  const detachChrome = mountChrome(root);
  return typeof panel === "function" ? () => { detachChrome(); panel(); } : panel;
}

// The primitives below are re-exported for host-check.html, which must run its acceptance checks
// against the same bundle the panel loads — a second copy of a guard only proves the test passes.
export {
  DEFAULT_MODEL, MODELS, buildHostTools, createLocalSLM, allowsTask, byteCap, expand, hostTools,
  DECLARED_POINTERS, mountMode, validateManifest,
  // Re-exported from context-read.js: these were defined here until they moved somewhere testable.
  contextCredentials, fetchApp, fetchField, fetchJson, fetchRecord, loadConfig,
  // Retrieval, re-exported for the same reason: host-check must exercise the panel's own provider.
  createRetrievalContext, buildCorpusIndex, fetchCorpus, corpusChunks, createEmbedder, indexParams,
};

// Auto-mount only in a browser; hosts may call mountFromManifest() themselves.
if (typeof document !== "undefined") {
  for (const root of document.querySelectorAll("[data-pslm]")) {
    mountFromManifest(root).catch((err) => {
      root.hidden = false;
      root.textContent = `Local assistant unavailable: ${err.message}`;
    });
  }
}

/**
 * Panel chrome: the launcher button, the dock resize handles and the persisted size.
 *
 * Generic on purpose — every host that docks the assistant wants the same three things, and each one
 * that writes it by hand gets the pointer maths subtly wrong (the native resize corner is bottom-right,
 * which is the wrong side for a right-docked panel). The host keeps geometry and palette through CSS;
 * this owns only behaviour, and only when asked for by attribute:
 *
 *   <div data-pslm data-launcher="Local assistant" data-resize data-dock="right"></div>
 *
 * Both are opt-in: a bare `data-pslm` mount behaves exactly as before, so the ladder in
 * HOST_CONTRACT.md §1b is unchanged. Handles carry `part="resize-left"` / `part="resize-corner"` and
 * the launcher `part="launcher"`, so the host styles them like any other part.
 */
function mountChrome(root, { minWidth = 320, minHeight = 300 } = {}) {
  const label = root.dataset.launcher;
  const dockLeft = root.dataset.dock === "left";
  const persistKey = root.dataset.persistKey || "pslm-panel-size";

  // Size first: the handles and the launcher both assume the panel starts where the user left it.
  let saveTimer = null;
  const save = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try { localStorage.setItem(persistKey, JSON.stringify({ width: root.style.width, height: root.style.height })); }
      catch { /* private mode: size just does not persist */ }
    }, 300);
  };
  try {
    const saved = JSON.parse(localStorage.getItem(persistKey) || "null");
    if (saved?.width && saved?.height) { root.style.width = saved.width; root.style.height = saved.height; }
  } catch { /* unreadable or absent: keep the host's CSS size */ }

  let launcher = null;
  if (label) {
    // A sibling, not a child: the panel is hidden while closed, and a launcher inside it would go too.
    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.setAttribute("part", "launcher");
    launcher.textContent = label;
    root.hidden = true;
    launcher.addEventListener("click", () => {
      root.hidden = !root.hidden;
      launcher.textContent = root.hidden ? label : (root.dataset.launcherHide || "Hide assistant");
    });
    (root.parentNode || document.body).insertBefore(launcher, root.nextSibling);
  }

  if (!root.hasAttribute("data-resize")) return () => { launcher?.remove(); };

  const drag = (handle, mode) => {
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      const { clientX: startX, clientY: startY } = down;
      const rect = root.getBoundingClientRect();
      const move = (event) => {
        // The docked edge is the anchor, so a left-docked panel grows the other way.
        if (mode !== "height") {
          const delta = dockLeft ? event.clientX - startX : startX - event.clientX;
          root.style.width = `${Math.min(Math.max(minWidth, rect.width + delta), window.innerWidth - 32)}px`;
        }
        if (mode !== "width") {
          const delta = dockLeft ? startY - event.clientY : event.clientY - startY;
          root.style.height = `${Math.min(Math.max(minHeight, rect.height + delta), window.innerHeight - 80)}px`;
        }
      };
      const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); save(); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(save).observe(root);

  // The mount replaces the panel's content, so the handles live inside it and are re-injected whenever
  // that happens — rather than being owned by a host view that cannot know when the SDK re-renders.
  const ensureHandles = () => {
    if (!root.isConnected || root.querySelector('[part="resize-corner"]')) return;
    const strip = document.createElement("div");
    strip.setAttribute("part", "resize-left");
    strip.title = "Drag to resize width";
    const corner = document.createElement("div");
    corner.setAttribute("part", "resize-corner");
    corner.title = "Drag to resize";
    drag(strip, "width");
    drag(corner, "both");
    root.append(strip, corner);
  };
  ensureHandles();
  const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(ensureHandles) : null;
  observer?.observe(root, { childList: true });
  return () => { observer?.disconnect(); launcher?.remove(); };
}

