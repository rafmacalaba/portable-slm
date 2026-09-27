// Example UI. It only uses the public SDK; any other UI can do the same.
// wllama assets are bundled locally (not a CDN) so the app works offline.
import wasm from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import compatWasm from "@wllama/wllama-compat/wasm/wllama.wasm?url";
import compatWorker from "@wllama/wllama-compat/wasm/wllama.js?url";
import { createLocalSLM } from "../src/index.js";
import { checkOfflineReadiness } from "../src/readiness.js";

const HISTORY = 12; // messages kept in the prompt
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  ["status", "env", "model", "engine", "load", "download", "import", "remove", "progress", "log", "chat", "prompt", "send", "stop"].map((id) => [id, $(id)]),
);
const maxTokensSelect = $("max-tokens");
const chatLog = $("chat-log");
const chatDiagnostics = $("chat-diagnostics");
const CHAT_LOG_KEY = "portable-slm-chat-log";
const PENDING_TURN_KEY = "portable-slm-pending-turn";
maxTokensSelect.value = /iPhone|iPad|iPod/.test(navigator.userAgent) ? "256" : "512";
try { chatLog.textContent = localStorage.getItem(CHAT_LOG_KEY) ?? ""; } catch { /* storage may be unavailable */ }

function logChat(message) {
  const lines = [...chatLog.textContent.split("\n").filter(Boolean), `[${new Date().toLocaleTimeString()}] ${message}`].slice(-50);
  chatLog.textContent = lines.join("\n");
  try { localStorage.setItem(CHAT_LOG_KEY, chatLog.textContent); } catch { /* still visible */ }
}

function checkpoint(turn) {
  try {
    if (turn) localStorage.setItem(PENDING_TURN_KEY, JSON.stringify(turn));
    else localStorage.removeItem(PENDING_TURN_KEY);
  } catch { /* still usable if storage is full */ }
}

if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");

const slm = createLocalSLM({ assets: { wasm, compatWasm, compatWorker } });
const offlineStatus = $("offline-status");
async function showOfflineReadiness() {
  const id = ui.model.value;
  try {
    const r = await checkOfflineReadiness(slm, id);
    if (id !== ui.model.value) return;
    offlineStatus.textContent = r.ready ? "Ready offline: app and verified model stored on this device." :
      `Not ready: ${!r.app.ready ? `app files missing (${r.app.missing.join(", ")})` : "app cached"}; model ${r.model}.`;
  } catch (err) { offlineStatus.textContent = `Could not check offline readiness: ${err.message}`; }
}
$("offline-check").addEventListener("click", showOfflineReadiness);
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.ready.then(showOfflineReadiness);
const params = new URLSearchParams(location.search);
for (const [id, m] of Object.entries(slm.models)) ui.model.add(new Option(`${m.label} · ${Math.round(m.bytes / 1e6)} MB`, id));
ui.model.value = params.get("model") ?? "lfm2.5-350m-q4km";
ui.engine.value = params.get("engine") ?? "auto";

const system = { role: "system", content: "You are a concise, helpful assistant." };
const history = [];
let controller = null;
let working = false;
let loadedEngine = null;
const useTools = $("use-tools");
const allowNetwork = $("allow-network");
useTools.addEventListener("change", () => {
  allowNetwork.disabled = !useTools.checked;
  if (!useTools.checked) allowNetwork.checked = false;
});
const downloadLog = $("download-log");
const diagnostics = $("diagnostics");
const LOG_KEY = "portable-slm-download-log";
try { downloadLog.textContent = localStorage.getItem(LOG_KEY) ?? ""; } catch { /* storage may be unavailable */ }

function logDownload(message) {
  const lines = [...downloadLog.textContent.split("\n").filter(Boolean), `[${new Date().toLocaleTimeString()}] ${message}`].slice(-60);
  downloadLog.textContent = lines.join("\n");
  try { localStorage.setItem(LOG_KEY, downloadLog.textContent); } catch { /* diagnostics still visible */ }
}

const setStatus = (text, isError = false) => {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", isError);
};
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
async function showStorage() {
  const id = ui.model.value;
  const saved = [];
  for (const [modelId, spec] of Object.entries(slm.models)) {
    const state = (await slm.status(modelId)).state;
    if (state !== "missing") saved.push(`${spec.label}: ${state}`);
  }
  const { usage, quota } = await navigator.storage?.estimate?.().catch(() => ({})) ?? {};
  if (id !== ui.model.value) return;
  const estimate = quota ? `Browser estimate: ${mb(usage ?? 0)} used / ${mb(quota)} allowed (~${mb(Math.max(0, quota - (usage ?? 0)))} available). ` : "Storage estimate unavailable. ";
  $("storage-info").textContent = `${estimate}Selected file: ${mb(slm.models[id].bytes)}. Saved models: ${saved.join("; ") || "none"}. Estimates can differ from actual available space.`;
}
const onProgress = ({ phase, done, total }) => {
  ui.progress.hidden = false;
  ui.progress.value = done / total;
  setStatus(`${{ download: "Downloading", import: "Importing", verify: "Verifying" }[phase]}… ${Math.round((done / total) * 100)}%`);
  if (phase === "download") logDownload(`Stored chunk ${done}/${total}`);
  if (phase === "verify" && done === total) logDownload("Integrity check complete");
};

async function refresh() {
  const s = await slm.status(ui.model.value);
  ui.env.textContent = `WebGPU ${s.webgpu ? "available" : "unavailable"} · multi-threaded CPU ${s.crossOriginIsolated ? "yes" : "no"} · ${s.online ? "online" : "offline"}`;
  const idle = !working;
  ui.model.disabled = ui.engine.disabled = !idle;
  ui.load.disabled = !idle || s.state !== "installed" || s.loaded;
  ui.download.disabled = !idle || s.state === "installed" || !s.online;
  ui.download.textContent = s.state === "partial" ? "Resume download" : "Download";
  ui.import.disabled = !idle;
  ui.remove.disabled = !idle || s.state === "missing";
  ui.prompt.disabled = ui.send.disabled = !idle || !s.loaded;
  ui.prompt.placeholder = s.loaded ? "Message…" : "Load a model to start…";
  if (working) return;
  if (s.loaded) setStatus(`Ready · ${slm.models[s.model].label} on ${s.engine}`);
  else if (s.state === "installed") setStatus("Model is on this device (works offline). Tap Load.");
  else if (s.state === "partial") setStatus("Download was interrupted. Resume it, or import the file.");
  else setStatus(s.online ? "Model not on this device yet: download it, or import the .gguf file." : "Offline: import the model's .gguf file to use it.");
}

async function task(fn, failPrefix) {
  working = true;
  await refresh();
  try {
    await fn();
    working = false;
  } catch (err) {
    working = false;
    ui.progress.hidden = true;
    await refresh().catch(() => {});
    showStorage().catch(() => {});
    setStatus(`${failPrefix}: ${err.message}`, true);
    logDownload(`${failPrefix}: ${err.message}`);
    diagnostics.open = true;
    return false;
  }
  ui.progress.hidden = true;
  await refresh();
  showOfflineReadiness();
  showStorage().catch(() => {});
  return true;
}

// HF resets its outer iframe after link clicks. In its embed, use buttons that only mount
// consumers in this document: one origin, one model instance, no page navigation.
const embedded = window.top !== window.self;
let activeView = null;
let openingView = false;
for (const link of document.querySelectorAll("a[data-consumer]")) link.hidden = embedded;
for (const button of document.querySelectorAll("button[data-view]")) {
  button.hidden = !embedded;
  button.addEventListener("click", async () => {
    if (working || openingView || activeView?.busy()) { setStatus("Wait for the current operation before changing views.", true); return; }
    openingView = true;
    const root = $("consumer-content");
    root.replaceChildren();
    $("model-manager").hidden = true;
    document.querySelector("main").hidden = true;
    $("embedded-view").hidden = false;
    try {
      activeView = button.dataset.view === "nada"
        ? (await import("./nada-view.js")).mountNada(root, slm, { embedded: true })
        : button.dataset.view === "review"
          ? (await import("./review-view.js")).mountReview(root, slm, { embedded: true })
          : (await import("./benchmark-view.js")).mountBenchmark(root, slm, { embedded: true });
      $("back-to-chat").focus();
    } catch (err) {
      activeView = null;
      root.replaceChildren();
      $("embedded-view").hidden = true;
      $("model-manager").hidden = false;
      document.querySelector("main").hidden = false;
      setStatus(`Could not open view: ${err.message}`, true);
    } finally { openingView = false; }
  });
}
$("back-to-chat").addEventListener("click", async () => {
  if (openingView || activeView?.busy()) { setStatus("Wait for the current operation to finish.", true); return; }
  activeView = null;
  $("consumer-content").replaceChildren();
  $("embedded-view").hidden = true;
  $("model-manager").hidden = false;
  document.querySelector("main").hidden = false;
  await refresh();
  document.querySelector(embedded ? 'button[data-view="nada"]' : 'a[data-consumer="nada"]').focus();
});

ui.model.addEventListener("change", () => { $("mirror").value = ""; refresh(); showOfflineReadiness(); showStorage().catch(() => {}); });
ui.load.addEventListener("click", () =>
  task(async () => {
    setStatus("Loading model…");
    loadedEngine = (await slm.load(ui.model.value, { engine: ui.engine.value })).engine;
    ui.prompt.focus();
  }, "Could not load model"),
);
ui.download.addEventListener("click", () => {
  const id = ui.model.value;
  const mirror = $("mirror").value.trim();
  logDownload(`Starting ${slm.models[id].label} (${Math.round(slm.models[id].bytes / 1e6)} MB); saved chunks will be reused${mirror ? " (mirror then pinned source)" : ""}`);
  task(async () => {
    await slm.download(id, {
      sources: mirror ? [mirror, slm.models[id].url] : undefined,
      onProgress,
      onFallback: () => {
        logDownload("Host ignored byte range (HTTP 200); streaming full model in 16 MB pieces");
        setStatus("Host sent full file; saving it in small pieces…");
      },
      onRetry: ({ chunk, total, attempt, maxAttempts, reason }) => {
        logDownload(`Chunk ${chunk}/${total} attempt ${attempt}/${maxAttempts} failed: ${reason}; retrying`);
        setStatus(`Retrying chunk ${chunk}/${total}… (attempt ${attempt + 1}/${maxAttempts})`);
      },
    });
    logDownload(`Download verified: ${slm.models[id].label}`);
  }, "Download failed");
});
ui.import.addEventListener("change", async () => {
  const file = ui.import.files[0];
  if (!file) return;
  await task(async () => {
    ui.model.value = await slm.importModel(file, { onProgress });
  }, "Import failed");
  ui.import.value = "";
});
ui.remove.addEventListener("click", async () => {
  if (!confirm("Delete this model from the device? You will need the file or internet to get it back.")) return;
  await task(() => slm.remove(ui.model.value), "Could not remove");
});

function addMessage(role, text = "") {
  const li = document.createElement("li");
  li.className = role;
  li.textContent = text;
  ui.log.append(li);
  li.scrollIntoView({ block: "end" });
  return li;
}

ui.chat.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = ui.prompt.value.trim();
  if (!content || working) return;
  ui.prompt.value = "";
  history.push({ role: "user", content });
  addMessage("user", content);
  const bubble = addMessage("assistant");
  controller = new AbortController();
  ui.stop.hidden = false;
  working = true;
  // No model-status scan here: matching every cached weight chunk on each turn can
  // retain large responses in Safari. Model/install state cannot change mid-turn.
  ui.model.disabled = ui.engine.disabled = ui.remove.disabled = ui.import.disabled = true;
  ui.prompt.disabled = ui.send.disabled = useTools.disabled = allowNetwork.disabled = true;
  const readyStatus = ui.status.textContent;
  setStatus("Generating…");
  const turn = {
    id: Date.now(), model: ui.model.value, engine: ui.engine.value,
    maxTokens: Number(maxTokensSelect.value), messages: Math.min(history.length, HISTORY) + 1,
    streamed: 0,
  };
  checkpoint(turn);
  logChat(`Started turn ${turn.id}: ${turn.model}, ${turn.engine}, ${turn.maxTokens} max tokens, ${turn.messages} messages`);
  try {
    const options = {
      signal: controller.signal,
      maxTokens: turn.maxTokens,
      onToken: (t) => {
        bubble.textContent += t;
        if (++turn.streamed % 32 === 0) checkpoint(turn);
      },
    };
    const r = useTools.checked
      ? await slm.runAgent([system, ...history.slice(-HISTORY)], {
          ...options,
          allowNetwork: allowNetwork.checked && navigator.onLine,
          approveTool: ({ name, args }) => confirm(`Send this ${name} request online?\n${JSON.stringify(args)}`),
          onTool: ({ stage, name, args, result, network }) => {
            if (stage === "call") addMessage("tool", `Using ${name}${network ? " (online)" : " (offline)"}: ${JSON.stringify(args)}`);
            if (stage === "result") addMessage("tool", `${name} returned: ${JSON.stringify(result)}`);
          },
        })
      : await slm.generate([system, ...history.slice(-HISTORY)], options);
    bubble.textContent = r.text;
    history.push({ role: "assistant", content: r.text });
    const meta = document.createElement("span");
    meta.className = "meta";
    const tps = r.timings?.predicted_per_second;
    meta.textContent = `${r.engine ?? loadedEngine}${tps ? ` · ${tps.toFixed(1)} tok/s` : ""}${r.toolRounds ? ` · ${r.toolRounds} tool round(s)` : ""}${r.aborted ? " · stopped" : ""}`;
    bubble.append(meta);
    logChat(`Finished turn ${turn.id}: ${r.engine}, ${r.usage?.prompt_tokens ?? "?"} input tokens, ${r.usage?.completion_tokens ?? `${turn.streamed} streamed chunks`}, ${r.ms} ms${r.aborted ? " (stopped)" : ""}`);
  } catch (err) {
    history.pop();
    bubble.textContent = `Error: ${err.message}`;
    bubble.classList.add("error");
    logChat(`Failed turn ${turn.id}: ${err.message}`);
    chatDiagnostics.open = true;
    setStatus(`Generation failed: ${err.message}`, true);
  } finally {
    checkpoint(null);
    working = false;
    ui.stop.hidden = true;
    ui.model.disabled = ui.engine.disabled = ui.remove.disabled = ui.import.disabled = false;
    ui.prompt.disabled = ui.send.disabled = useTools.disabled = false;
    allowNetwork.disabled = !useTools.checked;
    if (!ui.status.classList.contains("error")) setStatus(readyStatus);
    ui.prompt.focus();
  }
});
ui.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ui.chat.requestSubmit();
  }
});
ui.stop.addEventListener("click", () => controller?.abort());
$("copy-chat-log").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(chatLog.textContent);
    setStatus("Chat diagnostics copied. No message content is included.");
  } catch {
    setStatus("Clipboard unavailable. Select and copy the chat diagnostics below.", true);
  }
});
addEventListener("online", refresh);
addEventListener("offline", refresh);

let interruptedTurn = false;
logChat("Page opened");
try {
  const turn = JSON.parse(localStorage.getItem(PENDING_TURN_KEY));
  if (turn && !chatLog.textContent.includes(`Finished turn ${turn.id}`)) {
    logChat(`Turn ${turn.id} did not finish: ${turn.model}, ${turn.engine}, ${turn.maxTokens} max tokens, ${turn.messages} messages, ${turn.streamed} streamed chunks. Page may have reloaded or been terminated.`);
    chatDiagnostics.open = true;
    interruptedTurn = true;
  }
  checkpoint(null);
} catch { /* no previous turn */ }
refresh()
  .then(() => {
    showOfflineReadiness();
    showStorage().catch(() => {});
    if (interruptedTurn) setStatus("Previous reply was interrupted. See Chat diagnostics; try CPU or a shorter reply.", true);
  })
  .catch((err) => setStatus(`Failed to start: ${err.message}`, true));
