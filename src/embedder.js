// Text embeddings for retrieval. Two runtimes behind one interface, because the right embedder depends on
// the corpus and the audience, not on the SDK's preference:
//
//   ternlight        bundled in the package, ~7 MB on the wire, 1.5 ms per embedding, 128-token input.
//                    Nothing to download, so a visitor can index a corpus in the browser.
//   embeddinggemma2  pinned ONNX, ~181 MB downloaded once, 8K input, better separated vectors, multilingual.
//
// Both are needed. A portfolio's visitor will not download 181 MB to ask a question, and a large private
// documentation corpus answers better with the larger model. The catalogue entry decides which, so a host
// chooses a tier in one field rather than in code.
import { DEFAULTS, EMBEDDING_PREFIXES, MODELS } from "./models.js";
import { matryoshka } from "./retrieval.js";
import { downloadModel, modelStatus, removeModel } from "./store.js";

/**
 * Runtimes are loaded through literal specifiers, never a computed one. A bundle cannot resolve
 * `import(spec.package)`: a computed specifier is left untouched, so it reaches the browser as a bare
 * module name and fails to resolve at the moment the embedder is first used. Each loader stays a literal
 * so the bundler can see it, and a code-split keeps the runtime out of the bundle a host does not use.
 */
const RUNTIMES = {
  ternlight: () => import("@ternlight/base"),
  transformers: () => import("@huggingface/transformers"),
};

function specOf(id) {
  const spec = MODELS[id];
  if (!spec) throw new Error(`Unknown model "${id}". Known: ${Object.keys(MODELS).join(", ")}`);
  if (spec.kind !== "embedding") throw new Error(`"${id}" is not an embedding model`);
  return spec;
}

/** The nearest Matryoshka step the embedder actually supports, so a request cannot invent dimensions. */
export function embedDims(spec, requested = DEFAULTS.retrieval.dims) {
  const steps = spec.mrl ?? [spec.dims];
  return steps.includes(requested) ? requested : steps[0];
}

/**
 * @param {object} options
 * @param {object} options.assets self-hosted ONNX Runtime wasm and mjs paths, for the ONNX tier
 */
export function createEmbedder({ assets } = {}) {
  let backend = null; // { spec, embed(texts), dispose() }
  let busy = false;

  const exclusive = async (fn) => {
    if (busy) throw new Error("Busy: wait for the current embedding to finish");
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };

  async function unload() {
    await backend?.dispose?.().catch(() => {});
    backend = null;
  }

  async function load(id = DEFAULTS.embedder, { device } = {}) {
    const spec = specOf(id);
    await unload();
    if (spec.runtime === "ternlight") {
      // Imported on demand: 7 MB of wasm should not be in the bundle of a host that chose the ONNX tier.
      const { embed, engineInfo } = await RUNTIMES.ternlight();
      backend = {
        spec,
        device: "cpu",
        info: engineInfo?.() ?? "",
        // Synchronous and CPU-only, so there is nothing to await and no GPU context to contend with the
        // generator. No instruction prefix: this is a symmetric bi-encoder, unlike EmbeddingGemma.
        embed: (text) => embed(text),
        dispose: async () => {},
      };
      return { device: "cpu", dims: spec.dims, model: id, info: backend.info };
    }
    if (spec.runtime !== "transformers") throw new Error(`Unknown embedder runtime "${spec.runtime}"`);
    // The pinned ONNX export needs WebGPU. Its q4f16 weights quantize the embedding gather, and ONNX Runtime
    // Web's WASM backend has no kernel for it: on CPU the session fails with "Failed to find kernel for
    // com.microsoft.GatherBlockQuantized". The alternative is the export's no-gather variant, which is a
    // different pin. So WebGPU is the default and CPU is not offered as a quiet fallback that cannot work.
    const chosen = device ?? "webgpu";
    const { AutoModel, AutoTokenizer } = await RUNTIMES.transformers();
    const { configureLocalFiles } = await import("./pinned-cache.js");
    if (chosen !== "webgpu" && chosen !== "wasm" && chosen !== "cpu") throw new Error(`Unknown device "${chosen}"`);
    const restore = configureLocalFiles(spec, assets);
    try {
      const tokenizer = await AutoTokenizer.from_pretrained(spec.repo, { revision: spec.revision });
      const model = await AutoModel.from_pretrained(spec.repo, {
        revision: spec.revision,
        dtype: spec.dtype,
        device: chosen === "cpu" ? "wasm" : chosen,
        subfolder: spec.subfolder,
      });
      backend = {
        spec,
        device: chosen,
        tokenizer,
        model,
        embed: null,
        dispose: async () => { await model?.dispose?.().catch(() => {}); },
      };
    } catch (err) {
      await unload();
      // Name the cause rather than relaying a kernel name, because the fix is a device or a different pin.
      if (/GatherBlockQuantized/i.test(err.message)) {
        throw new Error(`${id} needs WebGPU: its quantized embedding gather has no WASM kernel. Pass device: "webgpu", or pin the export's no-gather variant.`, { cause: err });
      }
      throw err;
    } finally {
      restore();
    }
    return { device: chosen, dims: spec.dims, model: id };
  }

  /**
   * Embed texts. Returns one Float32Array per input.
   *
   * `kind` selects the instruction prefix where the model is trained with one. Getting it wrong does not
   * error, it just returns worse vectors, which is why it is decided here from the catalogue rather than at
   * each call site.
   */
  async function embed(texts, { kind = "document", title = "", titles, dims } = {}) {
    return exclusive(async () => {
      if (!backend) throw new Error("No embedder loaded: call load() first");
      const list = Array.isArray(texts) ? texts : [texts];
      if (!list.length) return [];
      const spec = backend.spec;
      const width = embedDims(spec, dims ?? spec.dims);
      const prefixed = spec.prefixes === "embeddinggemma"
        ? list.map((text, index) => (kind === "query"
          ? EMBEDDING_PREFIXES.query(String(text))
          : EMBEDDING_PREFIXES.document(titles?.[index] ?? title, String(text))))
        : list.map((text) => String(text));

      if (spec.runtime === "ternlight") {
        // The engine truncates at its own 128-token limit, silently. Chunks are sized for it, so a
        // truncation here means a caller bypassed the chunker.
        return prefixed.map((text) => matryoshka(backend.embed(text), width));
      }

      const encoded = await backend.tokenizer(prefixed, {
        padding: true, truncation: true, max_length: spec.ctx,
      });
      const out = await backend.model({ input_ids: encoded.input_ids, attention_mask: encoded.attention_mask });
      // The pinned export returns a pooled, projected, already-normalized sentence embedding. If a future
      // export stops doing that, failing loudly beats silently pooling the wrong axis.
      const pooled = out.sentence_embedding;
      if (!pooled) throw new Error(`${spec.repo} returned no sentence_embedding; this export is not usable as an embedder`);
      const [count, rowWidth] = pooled.dims;
      const vectors = [];
      for (let i = 0; i < count; i++) {
        vectors.push(matryoshka(pooled.data.subarray(i * rowWidth, (i + 1) * rowWidth), width));
      }
      return vectors;
    });
  }

  return {
    load,
    embed,
    unload,
    /** A bundled runtime is always installed; the ONNX tier has to be downloaded and verified first. */
    status: async (id = DEFAULTS.embedder) => {
      const spec = specOf(id);
      if (spec.runtime === "ternlight") return { state: "installed", bundled: true, bytes: 0 };
      return modelStatus(spec);
    },
    async download(id = DEFAULTS.embedder, options) {
      const spec = specOf(id);
      if (spec.runtime === "ternlight") return { bundled: true };
      return exclusive(() => downloadModel(spec, options));
    },
    remove: (id = DEFAULTS.embedder) => exclusive(async () => {
      const spec = specOf(id);
      if (spec.runtime === "ternlight") throw new Error("ternlight ships inside the package and cannot be removed");
      if (backend?.spec === spec) await unload();
      await removeModel(spec);
    }),
    /** The chunk size this embedder expects. Its input limit is what decides it. */
    chunkChars: (id = DEFAULTS.embedder) => specOf(id).chunkChars,
    minSimilarity: (id = DEFAULTS.embedder) => specOf(id).minSimilarity ?? 0,
    get loaded() { return backend ? { dims: embedDims(backend.spec, backend.spec.dims), device: backend.device } : null; },
    get spec() { return backend?.spec ?? null; },
  };
}
