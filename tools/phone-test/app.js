// Phone feasibility test: can this browser tab load a model, and how fast/big is it?
// Crash detection: each step is recorded in localStorage before it runs; if the tab is killed,
// the next page load reports the step that was running.
import { Wllama } from "./wllama/wllama.js";

const HF = "https://huggingface.co";
const MODELS = {
  "lfm2.5-230m-q4km": { label: "LFM2.5-230M Q4_K_M (153 MB)", bytes: 153_406_304, url: `${HF}/LiquidAI/LFM2.5-230M-GGUF/resolve/03502067c64ce32ac4fe87b0cec0310a1a13d3e9/LFM2.5-230M-Q4_K_M.gguf` },
  "lfm2.5-350m-q4km": { label: "LFM2.5-350M Q4_K_M (229 MB)", bytes: 229_312_224, url: `${HF}/LiquidAI/LFM2.5-350M-GGUF/resolve/657e078c94084481950a2d555a941481f715536b/LFM2.5-350M-Q4_K_M.gguf` },
  "lfm2.5-350m-qad-q4_0": { label: "LFM2.5-350M QAD Q4_0 (219 MB)", bytes: 219_312_832, url: `${HF}/LiquidAI/LFM2.5-350M-GGUF/resolve/657e078c94084481950a2d555a941481f715536b/LFM2.5-350M-QAD-Q4_0.gguf` },
  "lfm2.5-1.2b-q4km": { label: "LFM2.5-1.2B Instruct Q4_K_M (731 MB)", bytes: 730_895_168, url: `${HF}/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/8ed288026e23958ad9dfa92d53ed773a8eee7125/LFM2.5-1.2B-Instruct-Q4_K_M.gguf` },
};
const SAMPLING = { temperature: 0, top_k: 1, seed: 42 };
const RESULTS_KEY = "pst-results";
const RUNNING_KEY = "pst-running";

const $ = (id) => document.getElementById(id);
const log = (...a) => {
  $("log").textContent += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
};
const setStatus = (t, err = false) => {
  $("status").textContent = t;
  $("status").classList.toggle("error", err);
};
const results = JSON.parse(localStorage.getItem(RESULTS_KEY) ?? "[]");
const saveResults = () => localStorage.setItem(RESULTS_KEY, JSON.stringify(results));

for (const [id, m] of Object.entries(MODELS)) $("model").add(new Option(m.label, id));
$("model").value = "lfm2.5-350m-q4km";
if (!navigator.gpu) $("engine").value = "cpu";

// ---------- environment ----------
const hasJSPI = () => typeof WebAssembly.Suspending === "function";
const hasMem64 = () => {
  try {
    new WebAssembly.Memory({ address: "i64", initial: 1n });
    return true;
  } catch {
    return false;
  }
};

async function environment() {
  const env = {
    userAgent: navigator.userAgent,
    secureContext: isSecureContext,
    crossOriginIsolated,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    cpuThreads: navigator.hardwareConcurrency ?? null,
    webgpu: Boolean(navigator.gpu),
    jspi: hasJSPI(),
    memory64: hasMem64(),
  };
  env.wllamaBuild = env.jspi && env.memory64 ? "default" : "compat";
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    env.gpuAdapter = adapter ? `${adapter.info?.vendor ?? "?"} ${adapter.info?.architecture ?? ""}`.trim() : "none";
    env.shaderF16 = adapter?.features?.has("shader-f16") ?? false;
    env.maxBufferMB = adapter ? Math.round(adapter.limits.maxBufferSize / 2 ** 20) : null;
  }
  const est = await navigator.storage?.estimate?.().catch(() => null);
  env.storageQuotaGB = est ? +(est.quota / 1e9).toFixed(1) : null;
  env.storageUsedMB = est ? Math.round(est.usage / 1e6) : null;
  env.storagePersisted = (await navigator.storage?.persisted?.().catch(() => null)) ?? null;
  return env;
}

function renderEnv(env) {
  const rows = [
    ["Browser", env.userAgent],
    ["Secure / isolated", `${env.secureContext} / ${env.crossOriginIsolated}`],
    ["RAM hint · CPU threads", `${env.deviceMemoryGB ?? "n/a"} GB · ${env.cpuThreads ?? "n/a"}`],
    ["WebGPU", env.webgpu ? `${env.gpuAdapter} · f16 ${env.shaderF16} · max buffer ${env.maxBufferMB} MB` : "not available"],
    ["WASM build", `${env.wllamaBuild} (JSPI ${env.jspi}, memory64 ${env.memory64})`],
    ["Storage", `${env.storageUsedMB ?? "?"} MB used of ${env.storageQuotaGB ?? "?"} GB · persisted ${env.storagePersisted}`],
  ];
  $("env").tBodies[0].replaceChildren(
    ...rows.map(([k, v]) => {
      const tr = document.createElement("tr");
      tr.append(Object.assign(document.createElement("th"), { textContent: k }), Object.assign(document.createElement("td"), { textContent: v }));
      return tr;
    }),
  );
}

// ---------- memory (Chrome only; Safari has no API) ----------
async function memoryMB() {
  if (crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
    const r = await Promise.race([performance.measureUserAgentSpecificMemory(), new Promise((res) => setTimeout(res, 8000))]);
    if (r) return Math.round(r.bytes / 1e6);
  }
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
}

// ---------- results ----------
function renderResults() {
  $("results").tBodies[0].replaceChildren(
    ...results.map((r) => {
      const tr = document.createElement("tr");
      const when = new Date(r.at).toLocaleTimeString();
      const head = `${when}\n${r.config.model}\n${r.config.engine} · ${r.config.ctx / 1024}K`;
      let body;
      if (r.outcome === "crashed") body = `❌ Tab was killed during "${r.step}"`;
      else if (r.outcome === "error") body = `⚠️ ${r.step}: ${r.error}`;
      else {
        const s = r.steps;
        body = [
          `✅ loaded in ${(s.load.ms / 1000).toFixed(1)} s${s.load.downloaded ? " (after fresh download)" : ""}`,
          `decode ${s.generate.decodeTokS} tok/s · first answer "${s.short.text}"`,
          ...s.prefill.map((p) => `read ${p.tokens} tokens in ${(p.ms / 1000).toFixed(1)} s (${p.tokS} tok/s) · found fact: ${p.correct ? "yes" : "no"}`),
          `10-turn chat: ${s.chat.turns} turns, ${(s.chat.ms / 1000).toFixed(1)} s`,
          `page JS memory (excludes model): ${r.memoryMB ?? "n/a"}${r.memoryMB ? " MB" : ""}`,
        ].join("\n");
      }
      tr.append(
        Object.assign(document.createElement("td"), { textContent: head, style: "white-space:pre-wrap" }),
        Object.assign(document.createElement("td"), { textContent: body, style: "white-space:pre-wrap" }),
      );
      return tr;
    }),
  );
}

function reportCrashFromLastLoad() {
  const running = localStorage.getItem(RUNNING_KEY);
  if (!running) return;
  localStorage.removeItem(RUNNING_KEY);
  const r = JSON.parse(running);
  if (results.some((x) => x.at === r.at)) return; // run finished; only the cleanup write was lost
  results.unshift({ ...r, outcome: "crashed" });
  saveResults();
  $("crash").hidden = false;
  $("crash").textContent =
    `The previous run did not finish: the tab was killed while "${r.step}" (${r.config.model}, ${r.config.engine}, ${r.config.ctx} ctx). ` +
    `This usually means the browser ran out of memory. Try a smaller model, CPU engine, or smaller context.`;
}

// ---------- test ----------
const wllamaPaths = { default: new URL("./wllama/wllama.wasm", import.meta.url).href };
const compat = {
  worker: new URL("./wllama/compat/wllama.js", import.meta.url).href,
  wasm: new URL("./wllama/compat/wllama.wasm", import.meta.url).href,
};
// ---------- resumable model download ----------
// Model is fetched in 16 MB Range requests, each retried, each stored as its own Cache API entry.
// A dropped connection only loses the current chunk; re-running resumes. The chunks are then
// combined into one Blob (no copy into memory) that wllama reads in small slices.
const CHUNK = 16 * 2 ** 20;
const MODEL_CACHE = "pst-models";
const chunkKey = (url, i) => `${url}?pst-chunk=${i}`; // not a #fragment: Cache API ignores fragments

async function cachedChunks(model) {
  const cache = await caches.open(MODEL_CACHE);
  const n = Math.ceil(model.bytes / CHUNK);
  const have = await Promise.all(Array.from({ length: n }, (_, i) => cache.match(chunkKey(model.url, i))));
  return { cache, n, have };
}

async function fetchChunk(url, from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
      if (res.status !== 206) throw new Error(`HTTP ${res.status} (expected 206)`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== to - from + 1) throw new Error(`short chunk ${buf.byteLength}`);
      return buf;
    } catch (err) {
      if (attempt >= 6) throw new Error(`download failed after ${attempt} attempts: ${err.message}`);
      log(`chunk ${from}-${to} attempt ${attempt} failed: ${err.message}; retrying`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function modelBlob(model, onProgress) {
  const { cache, n, have } = await cachedChunks(model);
  let done = have.filter(Boolean).length;
  for (let i = 0; i < n; i++) {
    if (have[i]) continue;
    const from = i * CHUNK;
    const to = Math.min(model.bytes, from + CHUNK) - 1;
    const buf = await fetchChunk(model.url, from, to);
    await cache.put(chunkKey(model.url, i), new Response(buf));
    onProgress(++done, n);
  }
  const parts = await Promise.all(Array.from({ length: n }, async (_, i) => (await cache.match(chunkKey(model.url, i))).blob()));
  const blob = new Blob(parts);
  if (blob.size !== model.bytes) throw new Error(`model size ${blob.size} != ${model.bytes}; delete models and retry`);
  return blob;
}

function longDocument(targetTokens) {
  // ~16 tokens per line (measured); the fact to find sits in the middle.
  const lines = [];
  const n = Math.round(targetTokens / 16);
  for (let i = 0; i < n; i++) {
    lines.push(
      i === Math.floor(n / 2)
        ? `Record ${i}: the clinic in Barangay Maligaya keeps the vaccine fridge key with nurse Amihan.`
        : `Record ${i}: household ${(i * 7) % 1000} in district ${i % 37} reported ${i % 5} children.`,
    );
  }
  return lines.join("\n") + "\n\nQuestion: Who keeps the vaccine fridge key? Answer with the name only.";
}

async function run() {
  const config = { model: $("model").value, engine: $("engine").value, ctx: +$("ctx").value };
  const env = await environment();
  const record = { at: Date.now(), config, env };
  const step = (name) => {
    record.step = name;
    localStorage.setItem(RUNNING_KEY, JSON.stringify(record));
    setStatus(`Running: ${name}…`);
    log("step:", name);
  };
  $("run").disabled = true;
  let w;
  try {
    await navigator.storage?.persist?.().catch(() => {});
    const steps = {};
    w = new Wllama(wllamaPaths, { suppressNativeLog: true, logger: { ...console, debug: () => {} } });
    w.setCompat(compat);

    const model = MODELS[config.model];
    step("download model");
    $("progress").hidden = false;
    const cachedBefore = (await cachedChunks(model)).have.every(Boolean);
    const blob = await modelBlob(model, (done, n) => {
      $("progress").value = done / n;
      setStatus(`Downloading model… ${Math.round((done / n) * model.bytes / 1e6)} / ${Math.round(model.bytes / 1e6)} MB (resumes if interrupted)`);
    });
    $("progress").hidden = true;

    step("load model");
    let t0 = performance.now();
    await w.loadModel([blob], { n_ctx: config.ctx, ...(config.engine === "cpu" ? { n_gpu_layers: 0 } : {}) });
    steps.load = { ms: Math.round(performance.now() - t0), downloaded: !cachedBefore };

    const chat = (messages, max_tokens) => w.createChatCompletion({ messages, max_tokens, ...SAMPLING });

    step("short answer");
    let r = await chat([{ role: "user", content: "What is the capital of France? Answer in one word." }], 8);
    steps.short = { text: r.choices[0].message.content.trim().slice(0, 40) };

    step("generate 200 tokens");
    r = await chat([{ role: "user", content: "Explain in detail how rivers form, erode land and create deltas." }], 200);
    steps.generate = {
      tokens: r.timings?.predicted_n ?? r.usage?.completion_tokens,
      decodeTokS: +(r.timings?.predicted_per_second ?? 0).toFixed(1),
    };

    steps.prefill = [];
    for (const target of [1000, 4000].filter((t) => t < config.ctx - 256)) {
      step(`read ${target}-token document`);
      t0 = performance.now();
      r = await chat([{ role: "user", content: longDocument(target) }], 12);
      steps.prefill.push({
        tokens: r.timings?.prompt_n ?? r.usage?.prompt_tokens,
        ms: Math.round(performance.now() - t0),
        tokS: +(r.timings?.prompt_per_second ?? 0).toFixed(0),
        answer: r.choices[0].message.content.trim().slice(0, 40),
        correct: /amihan/i.test(r.choices[0].message.content),
      });
    }

    step("10-turn chat");
    const history = [{ role: "system", content: "You are a concise assistant." }];
    t0 = performance.now();
    let turns = 0;
    for (const q of ["Name a fruit.", "Its color?", "Another fruit?", "Which is sweeter?", "A vegetable?", "Its color?", "A grain?", "Where is it grown?", "A spice?", "Summarize our chat in one line."]) {
      history.push({ role: "user", content: q });
      r = await chat(history, 40);
      history.push({ role: "assistant", content: r.choices[0].message.content });
      turns++;
    }
    steps.chat = { turns, ms: Math.round(performance.now() - t0) };

    step("measure memory");
    record.memoryMB = await memoryMB();
    record.steps = steps;
    record.outcome = "ok";
    setStatus("Done. Tap “Copy results” and send them back.");
  } catch (err) {
    record.outcome = "error";
    record.error = String(err?.message ?? err);
    log("error:", record.error);
    setStatus(`Failed during "${record.step}": ${record.error}`, true);
  } finally {
    localStorage.removeItem(RUNNING_KEY);
    await w?.exit().catch(() => {});
    results.unshift(record);
    saveResults();
    renderResults();
    renderEnv(await environment());
    $("progress").hidden = true;
    $("run").disabled = false;
  }
}

$("run").addEventListener("click", run);
$("copy").addEventListener("click", async () => {
  const text = JSON.stringify(results, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${results.length} result(s) to the clipboard.`);
  } catch {
    $("log").textContent = text;
    $("log").closest("details").open = true;
    setStatus("Clipboard blocked — results are shown in the Log below; select and copy them.");
  }
});
$("clear").addEventListener("click", async () => {
  if (!confirm("Delete downloaded models from this browser? Results are kept.")) return;
  await caches.delete(MODEL_CACHE);
  renderEnv(await environment());
  setStatus("Downloaded models deleted.");
});

reportCrashFromLastLoad();
renderResults();
environment().then(renderEnv);
