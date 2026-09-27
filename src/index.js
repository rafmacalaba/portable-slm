// Public, UI-agnostic SDK. Any UI (chat, forms, extraction, benchmark) talks only to this.
// Inference runs in wllama's own Web Worker (llama.cpp → WebAssembly, WebGPU or CPU).
import { Wllama } from "@wllama/wllama/esm/index.js"; // package "main" points to a missing file
import { runAgent } from "./agent.js";
import { defaultTools } from "./tools.js";
import { DEFAULTS, MODELS } from "./models.js";
import { downloadModel, importModel, modelBlob, modelStatus, removeModel } from "./store.js";

export { DEFAULTS, MODELS, defaultTools, runAgent };

const ROLES = new Set(["system", "user", "assistant"]);
const quietLogger = { ...console, debug: () => {}, log: () => {} };

function specOf(id) {
  if (!Object.hasOwn(MODELS, id)) throw new Error(`Unknown model "${id}". Known: ${Object.keys(MODELS).join(", ")}`);
  return MODELS[id];
}

async function pickEngine(preference) {
  if (preference === "cpu" || preference === "webgpu") return preference;
  if (preference !== "auto") throw new Error(`Unknown engine "${preference}". Use auto, webgpu or cpu`);
  // iOS WebGPU works, but its GPU buffers count against Safari's tight tab budget.
  // Explicit "webgpu" remains available for testing on phones with headroom.
  if (/iPhone|iPad|iPod/.test(globalThis.navigator?.userAgent ?? "")) return "cpu";
  const adapter = await globalThis.navigator?.gpu?.requestAdapter().catch(() => null);
  return adapter ? "webgpu" : "cpu";
}

const persist = () => globalThis.navigator?.storage?.persist?.().catch(() => {});

/** @param {import("./index.d.ts").LocalSLMOptions} options */
export function createLocalSLM({ assets, ctx = DEFAULTS.ctx } = {}) {
  if (!assets?.wasm || !assets?.compatWasm || !assets?.compatWorker) {
    throw new Error("assets.wasm, assets.compatWasm and assets.compatWorker are required (self-hosted, for offline use)");
  }
  let w = null;
  let loaded = null; // { id, engine }
  let busy = false;

  const exclusive = async (fn) => {
    if (busy) throw new Error("Busy: wait for the current operation to finish");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  async function unload() {
    await w?.exit().catch(() => {});
    w = null;
    loaded = null;
  }

  async function loadOn(spec, engine) {
    const blob = await modelBlob(spec);
    w = new Wllama({ default: assets.wasm }, { suppressNativeLog: true, logger: quietLogger });
    w.setCompat({ worker: assets.compatWorker, wasm: assets.compatWasm }); // used on Safari (no JSPI)
    await w.loadModel([blob], { n_ctx: ctx, n_parallel: 1, ...(engine === "cpu" ? { n_gpu_layers: 0 } : {}) });
  }

  async function complete(messages, { tools, toolChoice, maxTokens, sampling = {}, signal }) {
    if (!loaded) throw new Error("No model loaded: call load() first");
    if (!Array.isArray(messages) || !messages.length || messages.some((m) =>
      !["system", "user", "assistant", "tool"].includes(m?.role) ||
      (m.role === "tool" ? typeof m.content !== "string" || typeof m.tool_call_id !== "string" :
        typeof m.content !== "string" && !(m.role === "assistant" && m.content === null && Array.isArray(m.tool_calls)))
    )) throw new Error("Invalid chat messages");
    const response = await w.createChatCompletion({
      messages, tools, tool_choice: toolChoice, max_tokens: Math.min(maxTokens, ctx),
      ...DEFAULTS.sampling,
      ...Object.fromEntries(["temperature", "top_k", "seed"].filter((k) => sampling[k] !== undefined).map((k) => [k, sampling[k]])),
      stream: false, abortSignal: signal,
    });
    if (!response.choices?.[0]) throw new Error("Model returned no response");
    return response.choices[0];
  }

  return {
    models: MODELS,

    async status(id) {
      return {
        model: id,
        state: await modelStatus(specOf(id)),
        loaded: loaded?.id === id,
        engine: loaded?.id === id ? loaded.engine : null,
        webgpu: Boolean(globalThis.navigator?.gpu),
        crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
        online: globalThis.navigator?.onLine ?? true,
      };
    },

    download(id, { sources, onProgress, onRetry, onFallback, signal } = {}) {
      persist();
      return exclusive(() => downloadModel(specOf(id), { sources, onProgress, onRetry, onFallback, signal }));
    },

    importModel(file, { onProgress } = {}) {
      persist();
      return exclusive(() => importModel(file, MODELS, { onProgress }));
    },

    load(id, { engine = "auto" } = {}) {
      const spec = specOf(id);
      return exclusive(async () => {
        if (loaded?.id === id && (engine === "auto" || engine === loaded.engine)) return { engine: loaded.engine };
        if ((await modelStatus(spec)) !== "installed") throw new Error(`Model "${id}" is not installed: download or import it first`);
        await unload();
        let chosen = await pickEngine(engine);
        try {
          await loadOn(spec, chosen);
        } catch (err) {
          if (chosen !== "webgpu" || engine !== "auto") throw err;
          console.warn("WebGPU load failed, retrying on CPU:", err);
          await unload();
          chosen = "cpu";
          await loadOn(spec, chosen);
        }
        loaded = { id, engine: chosen };
        return { engine: chosen };
      });
    },

    generate(messages, { onToken, signal, maxTokens = DEFAULTS.maxTokens, ...sampling } = {}) {
      if (!loaded) return Promise.reject(new Error("No model loaded: call load() first"));
      if (!Array.isArray(messages) || messages.length === 0) return Promise.reject(new Error("messages must be a non-empty array"));
      for (const m of messages) {
        if (!ROLES.has(m?.role) || typeof m.content !== "string") {
          return Promise.reject(new Error('Each message needs role "system" | "user" | "assistant" and string content'));
        }
      }
      return exclusive(async () => {
        let text = "";
        let usage = null;
        let timings = null;
        let aborted = false;
        const started = performance.now();
        try {
          await w.createChatCompletion({
            messages,
            max_tokens: Math.min(maxTokens, ctx),
            ...DEFAULTS.sampling,
            ...sampling,
            stream: true,
            abortSignal: signal,
            onData: (chunk) => {
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                text += delta;
                onToken?.(delta);
              }
              usage = chunk.usage ?? usage;
              timings = chunk.timings ?? timings;
            },
          });
        } catch (err) {
          if (!signal?.aborted) throw err;
          aborted = true;
        }
        return { text, aborted, engine: loaded.engine, usage, timings, ms: Math.round(performance.now() - started) };
      });
    },

    /** Runs a bounded read-only tool loop. Tool functions are trusted caller code; model args are not. */
    runAgent(messages, { tools = defaultTools(), ...options } = {}) {
      return exclusive(() => runAgent({ complete, messages, tools, ...options }));
    },

    remove(id) {
      const spec = specOf(id);
      return exclusive(async () => {
        if (loaded?.id === id) await unload();
        await removeModel(spec);
      });
    },

    unload: () => exclusive(unload),
  };
}
