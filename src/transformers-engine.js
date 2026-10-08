// ONNX runtime for LFM2.5 models. Separate dynamic chunk: existing GGUF consumers keep wllama;
// this adapter only loads when a registry spec declares runtime:"transformers".
import { AutoModelForCausalLM, AutoTokenizer, DynamicCache, StoppingCriteria, TextStreamer, Tensor, env } from "@huggingface/transformers";
import { modelFileBlob } from "./store.js";
import { LfmStreamParser, fitMessages, lfmTemplateMessages, parseLfmToolCalls } from "./lfm-output.js";
import { DEFAULTS } from "./models.js";

const THINK_OPEN = "<think>";

/**
 * Memoise one rendered token list per message-array identity. The fit loop re-counts the same array
 * several times and the decode needs the ids again, so re-rendering a long prompt to recover an
 * answer the loop already computed is pure waste. Trims produce new arrays, which invalidate it.
 */
function memoIds(count) {
  let seen = null;
  let ids = null;
  return (list) => {
    if (seen !== list) {
      seen = list;
      ids = count(list);
    }
    return ids;
  };
}

class AbortGeneration extends StoppingCriteria {
  constructor(signal) { super(); this.signal = signal; }
  _call(inputIds) { return inputIds.map(() => Boolean(this.signal?.aborted)); }
}

// Some LFM2.5 templates ship a `{%- endgeneration %}` statement that not every Transformers.js
// build supports; Liquid's own WebGPU agent strips it before first render. Same defense here.
function normalizeChatTemplate(tokenizer) {
  const strip = (template) => typeof template === "string"
    ? template.replace(/{%-?\s*endgeneration\s*-?%}/g, "")
    : template;
  if (typeof tokenizer.chat_template === "string") tokenizer.chat_template = strip(tokenizer.chat_template);
  else if (tokenizer.chat_template && typeof tokenizer.chat_template === "object") {
    tokenizer.chat_template = Object.fromEntries(
      Object.entries(tokenizer.chat_template).map(([name, template]) => [name, strip(template)]),
    );
  }
}

function pinnedCache(spec) {
  const repoPrefix = `/${spec.repo}/resolve/`;
  const files = new Map(spec.files.map((file) => [file.path, file]));
  return {
    async match(request) {
      let pathname;
      try { pathname = new URL(String(request), globalThis.location?.origin || "https://huggingface.co").pathname; }
      catch { return undefined; }
      const at = pathname.lastIndexOf(repoPrefix);
      if (at < 0) return undefined;
      const rest = pathname.slice(at + repoPrefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) return undefined;
      const revision = rest.slice(0, slash);
      const path = decodeURIComponent(rest.slice(slash + 1));
      // AutoTokenizer's file-existence probe omits revision and checks `/resolve/main/`;
      // answer only that metadata lookup from our pinned tokenizer config. Actual file loads
      // still require the immutable revision declared in MODELS.
      if (revision !== spec.revision && !(revision === "main" && path === "tokenizer_config.json")) return undefined;
      const file = files.get(path);
      if (!file) return undefined;
      const blob = await modelFileBlob(file);
      return new Response(blob, { headers: { "content-length": String(file.bytes) } });
    },
    // All files this model can request are installed and hash-verified before load. Unexpected
    // remote assets are refused (allowRemoteModels=false), not silently cached from the network.
    async put() {},
  };
}

function configureLocalFiles(spec, assets) {
  if (!assets?.onnxWasm || !assets?.onnxMjs) throw new Error("Self-hosted ONNX Runtime wasm + mjs assets are required");
  const previous = {
    allowRemoteModels: env.allowRemoteModels, useCustomCache: env.useCustomCache,
    customCache: env.customCache, useBrowserCache: env.useBrowserCache, useFSCache: env.useFSCache,
    fetch: env.fetch, wasmPaths: env.backends.onnx.wasm.wasmPaths,
  };
  // Transformers.js rejects the combination allowLocalModels=false + allowRemoteModels=false
  // before checking customCache. Keep its setting enabled but block all cache misses via env.fetch:
  // known pinned files are served from SHA-verified Cache API; no Hub request can escape.
  env.allowRemoteModels = true;
  env.fetch = async (url) => { throw new Error(`Unpinned Transformers.js fetch blocked: ${String(url)}`); };
  env.useCustomCache = true;
  env.customCache = pinnedCache(spec);
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.backends.onnx.wasm.wasmPaths = { wasm: assets.onnxWasm, mjs: assets.onnxMjs };
  return () => {
    env.allowRemoteModels = previous.allowRemoteModels;
    env.useCustomCache = previous.useCustomCache;
    env.customCache = previous.customCache;
    env.useBrowserCache = previous.useBrowserCache;
    env.useFSCache = previous.useFSCache;
    env.fetch = previous.fetch;
    env.backends.onnx.wasm.wasmPaths = previous.wasmPaths;
  };
}

export function createTransformersEngine({ ctx = DEFAULTS.ctx, assets } = {}) {
  let model = null;
  let tokenizer = null;
  let loaded = null;
  let engine = null;
  // KV cache reuse: follow-up turns that extend the previous prompt skip re-prefill. Guarded by an
  // exact token-prefix check; any mismatch (history trim, reasoning stripping by the template,
  // model switch) disposes the cache and falls back to a full prefill.
  let kvCache = null;
  let cachedIds = [];

  async function unload() {
    await model?.dispose?.();
    model = null;
    tokenizer = null;
    loaded = null;
    engine = null;
    await kvCache?.dispose?.().catch(() => {});
    kvCache = null;
    cachedIds = [];
  }

  async function load(spec, { engine: requested = "webgpu" } = {}) {
    if (spec.runtime !== "transformers" || spec.format !== "ONNX") throw new Error("Transformers runtime needs a pinned ONNX model");
    if (requested !== "webgpu" && requested !== "cpu") throw new Error(`Unknown engine "${requested}"`);
    const restore = configureLocalFiles(spec, assets);
    try {
      tokenizer = await AutoTokenizer.from_pretrained(spec.repo, { revision: spec.revision });
      normalizeChatTemplate(tokenizer);
      model = await AutoModelForCausalLM.from_pretrained(spec.repo, {
        revision: spec.revision,
        dtype: spec.dtype,
        device: requested === "cpu" ? "wasm" : "webgpu",
        subfolder: spec.subfolder,
      });
      loaded = spec;
      engine = requested;
      return { engine };
    } catch (err) {
      await unload();
      throw err;
    } finally {
      restore();
    }
  }

  async function complete(messages, { tools = [], maxTokens = DEFAULTS.maxTokens, sampling = {}, signal, onStreamToken, onReasonToken, onMetrics, seedThink = true } = {}) {
    if (!model || !tokenizer || !loaded) throw new Error("No ONNX model loaded: call load() first");
    signal?.throwIfAborted();
    if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array");
    // Render the template as TEXT so the reasoning seed is an append, not tensor surgery, and so
    // the exact token ids are known for the KV-cache prefix guard.
    const render = (list) => tokenizer.apply_chat_template(lfmTemplateMessages(list), {
      add_generation_prompt: true,
      tokenize: false,
      ...(tools.length ? { tools } : {}),
    }) + (seedThink ? THINK_OPEN : "");
    const idsFor = memoIds((list) => tokenizer(render(list), { add_special_tokens: false }).input_ids.tolist()[0]);
    // Fit the window by dropping the oldest turns rather than rejecting the request: a session that
    // has grown past the window should lose its oldest context, not the ability to answer. The drop
    // is announced to the model so it cannot imply it still remembers what was removed.
    let fitted = fitMessages(messages, idsFor, ctx);
    if (fitted.dropped) {
      const [first, ...rest] = fitted.messages;
      const note = `\n\n[${fitted.dropped} earlier exchange(s) were dropped to fit the context window. Do not claim to remember them.]`;
      const noted = first?.role === "system"
        ? [{ ...first, content: `${first.content}${note}` }, ...rest]
        : [{ role: "system", content: note.trim() }, ...fitted.messages];
      // The note itself costs tokens, so fit again against the annotated transcript.
      const again = fitMessages(noted, idsFor, ctx);
      fitted = { messages: again.messages, tokens: again.tokens, dropped: fitted.dropped + again.dropped };
    }
    // Nothing left to drop and still over budget: one message is larger than the whole window. Cut its
    // text by halving until it fits, which is the last resort before refusing to answer at all.
    if (fitted.tokens > ctx) {
      const list = [...fitted.messages];
      const last = list[list.length - 1];
      let content = typeof last?.content === "string" ? last.content : "";
      while (fitted.tokens > ctx && content.length > 1) {
        content = content.slice(0, Math.floor(content.length / 2));
        list[list.length - 1] = { ...last, content: `${content}\u2026[cut to fit the context window]` };
        fitted = { ...fitted, messages: list, tokens: idsFor(list) };
      }
    }
    if (fitted.tokens > ctx) throw new Error(`Prompt uses ${fitted.tokens} tokens; context limit is ${ctx}`);
    // The fitted transcript is what gets rendered and fed; `messages` is left untouched so the caller's
    // history (and the agent loop's) is unaffected by a trim that only had to apply to this decode.
    const activeMessages = fitted.messages;
    // KV cache reuse: follow-up turns that extend the previous prompt skip re-prefill entirely.
    // Guarded by an exact token-prefix check against the cache length; any mismatch — a trim, a
    // digest turn, template reasoning-stripping, a model switch — disposes the cache and re-prefills.
    const promptIds = idsFor(activeMessages);
    const cacheLen = Number(await kvCache?.get_seq_length?.() ?? 0);
    const reusable = kvCache && cacheLen > 0
      && cachedIds.length === cacheLen
      && cachedIds.length <= promptIds.length
      && cachedIds.every((token, index) => token === promptIds[index]);
    if (!reusable) {
      await kvCache?.dispose?.().catch(() => {});
      kvCache = new DynamicCache();
      cachedIds = [];
    }
    const newIds = reusable ? promptIds.slice(cachedIds.length) : promptIds;
    const limit = Math.min(maxTokens, ctx - promptIds.length);
    if (limit < 1) throw new Error(`Prompt uses ${promptIds.length} tokens; context limit is ${ctx}`);
    const temperature = sampling.temperature ?? DEFAULTS.sampling.temperature;
    // One stateful parser per decode: what it emits as content is exactly what the reader has on
    // screen, so the final message is taken from the parser rather than re-derived from the raw text
    // by a second, differently-behaving split. Re-deriving is what put reasoning under an answer and
    // truncated replies at the wrong marker once a tool call was involved.
    const parser = new LfmStreamParser({ startInThink: seedThink });
    const pump = (deltas) => {
      for (const delta of deltas) {
        if (delta.type === "reasoning") onReasonToken?.(delta.text);
        else onStreamToken?.(delta.text);
      }
    };
    let tokenCount = 0;
    const streamer = onStreamToken || onReasonToken || onMetrics
      ? new TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: false,
        callback_function: (token) => pump(parser.push(token)),
        token_callback_function: (tokenIds) => {
          tokenCount += tokenIds.length;
          onMetrics?.(tokenCount);
        },
      })
      : undefined;
    const start = performance.now();
    const generated = await model.generate({
      input_ids: new Tensor("int64", BigInt64Array.from(newIds.map((t) => BigInt(t))), [1, newIds.length]),
      attention_mask: new Tensor("int64", BigInt64Array.from(newIds.map(() => 1n)), [1, newIds.length]),
      past_key_values: kvCache,
      use_cache: true,
      max_new_tokens: limit,
      ...(temperature > 0 ? { do_sample: true, temperature,
        top_k: sampling.top_k ?? DEFAULTS.sampling.top_k } : { do_sample: false }),
      repetition_penalty: sampling.penalty_repeat ?? DEFAULTS.sampling.penalty_repeat,
      stopping_criteria: signal ? [new AbortGeneration(signal)] : undefined,
      ...(streamer ? { streamer } : {}),
      return_dict_in_generate: true,
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const allTokens = (generated.sequences ?? generated).tolist()[0];
    // `sequences` is the ACCUMULATED sequence (what we fed in, plus what was generated) — not the
    // new tokens alone. Slicing off the fed-in prefix is what makes token counts, the token cap,
    // and the decode honest; guessing it away inflated completion_tokens by ~1000 and silently
    // broke cache-prefix reuse.
    const includesInput = allTokens.length >= newIds.length
      && newIds.every((token, index) => token === allTokens[index]);
    const generatedTokens = includesInput ? allTokens.slice(newIds.length) : allTokens;
    const cacheLenAfter = Number(await kvCache?.get_seq_length?.() ?? 0);
    cachedIds = [...promptIds, ...generatedTokens.map((t) => BigInt(t))].slice(0, cacheLenAfter);
    const elapsed = Math.max(1, performance.now() - start);
    const raw = tokenizer.decode(generatedTokens.map((t) => BigInt(t)), { skip_special_tokens: false });
    // Engines with no callbacks registered never fed the parser; give it the whole decode. With a
    // streamer, flush only releases the held tail — the tag fragments it withheld while they could
    // still have become a marker.
    if (!streamer) parser.push(raw);
    pump(parser.flush());
    const tool_calls = parseLfmToolCalls(parser.toolText);
    const message = {
      role: "assistant",
      // Tool markers are replayed into the next prompt turn because the model's chat template does
      // not serialize OpenAI tool_calls objects. Only when tools were offered: an answer-only turn
      // has no next tool turn, so a stray marker there must not leak into the text the user sees.
      // A seeded think block that never closed leaves `content` empty by construction — the model
      // spent the decode reasoning — so "no answer" stays visible instead of being guessed.
      content: tool_calls.length && tools.length ? parser.transcript : parser.content,
      ...(tool_calls.length ? { tool_calls } : {}),
    };
    return {
      message,
      engine,
      ms: Math.round(elapsed),
      usage: { prompt_tokens: promptIds.length, completion_tokens: generatedTokens.length },
      timings: null,
      // How many exchanges the window forced out, so a caller can surface "answering from a trimmed
      // history" instead of implying the model still holds the whole session.
      trimmed: fitted.dropped,
    };
  }

  return {
    load,
    complete,
    async generate(messages, { onToken, onReasonToken, onMetrics, maxTokens = DEFAULTS.maxTokens, signal, ...sampling } = {}) {
      const result = await complete(messages, { maxTokens, sampling, signal, onStreamToken: onToken, onReasonToken, onMetrics });
      const text = result.message.content || "";
      // `trimmed` is how many exchanges the window forced out of this prompt.
      return { text, aborted: false, engine, usage: result.usage, timings: result.timings, ms: result.ms, trimmed: result.trimmed ?? 0 };
    },
    unload,
    get engine() { return engine; },
  };
}
