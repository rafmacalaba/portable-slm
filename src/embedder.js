// Text embeddings for retrieval. The second transformers.js runtime, beside the text generator.
//
// Two things distinguish it from a generative load, and both are deliberate:
//
// 1. It uses AutoModel directly, not pipeline("feature-extraction"). The pipeline builds the export's
//    multimodal processor, which loads every modality encoder the config declares. AutoModel loads
//    only the text graph. Combined with the `text-only` transform in the catalogue, that is what keeps
//    the install at the text encoder alone instead of adding 255 MB of vision and audio weights.
// 2. It defaults to the CPU/WASM device. The generator usually holds a WebGPU context, and two GPU
//    models in one tab is the memory risk that kills the tab rather than degrading gracefully.
import { AutoModel, AutoTokenizer } from "@huggingface/transformers";
import { configureLocalFiles } from "./pinned-cache.js";
import { DEFAULTS, EMBEDDING_PREFIXES, MODELS } from "./models.js";
import { matryoshka } from "./retrieval.js";
import { downloadModel, modelStatus, removeModel } from "./store.js";

function specOf(id) {
  const spec = MODELS[id];
  if (!spec) throw new Error(`Unknown model "${id}". Known: ${Object.keys(MODELS).join(", ")}`);
  if (spec.kind !== "embedding") throw new Error(`"${id}" is not an embedding model`);
  return spec;
}

/**
 * @param {object} options
 * @param {object} options.assets self-hosted ONNX Runtime wasm and mjs paths
 */
export function createEmbedder({ assets } = {}) {
  let tokenizer = null;
  let model = null;
  let loaded = null;
  let device = null;
  let busy = false;

  const exclusive = async (fn) => {
    if (busy) throw new Error("Busy: wait for the current embedding to finish");
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };

  async function unload() {
    await model?.dispose?.().catch(() => {});
    model = null;
    tokenizer = null;
    loaded = null;
    device = null;
  }

  async function load(id = DEFAULTS.embedder, { device: requested = "wasm" } = {}) {
    const spec = specOf(id);
    if (requested !== "webgpu" && requested !== "wasm" && requested !== "cpu") throw new Error(`Unknown device "${requested}"`);
    await unload();
    const restore = configureLocalFiles(spec, assets);
    try {
      tokenizer = await AutoTokenizer.from_pretrained(spec.repo, { revision: spec.revision });
      model = await AutoModel.from_pretrained(spec.repo, {
        revision: spec.revision,
        dtype: spec.dtype,
        device: requested === "cpu" ? "wasm" : requested,
        subfolder: spec.subfolder,
      });
      loaded = spec;
      device = requested;
      return { device, dims: spec.dims, model: id };
    } catch (err) {
      await unload();
      throw err;
    } finally {
      restore();
    }
  }

  /**
   * Embed texts. `kind` selects the instruction prefix, which the model is trained with: a query and a
   * document get different ones, and using the wrong one does not error, it just returns worse vectors.
   *
   * Returns one Float32Array per input, truncated to `dims` and re-normalized. Truncation is
   * Matryoshka: taking the first N values and re-normalizing is the intended use, not a lossy
   * approximation, which is why the same index can be compared at 256 dimensions as at 768.
   */
  async function embed(texts, { kind = "document", title = "", titles, dims = DEFAULTS.retrieval.dims } = {}) {
    return exclusive(async () => {
      if (!model || !tokenizer || !loaded) throw new Error("No embedder loaded: call load() first");
      const list = Array.isArray(texts) ? texts : [texts];
      if (!list.length) return [];
      // A document prefix carries its own title, and chunks of one document have different headings, so
      // the batch form takes one title per item. `title: none` is what the card prescribes for an untitled chunk.
      const prefixed = list.map((text, index) => (kind === "query"
        ? EMBEDDING_PREFIXES.query(String(text))
        : EMBEDDING_PREFIXES.document(titles?.[index] ?? title, String(text))));
      const encoded = await tokenizer(prefixed, {
        padding: true,
        truncation: true,
        // The model's own window. Chunks are sized well below it, so a truncation here means a host
        // handed over something much larger than a chunk and should hear about it.
        max_length: loaded.ctx,
      });
      const out = await model({ input_ids: encoded.input_ids, attention_mask: encoded.attention_mask });
      // The pinned export returns a pooled, projected, already-normalized sentence embedding. If a
      // future export stops doing that, failing loudly is better than silently pooling the wrong axis.
      const pooled = out.sentence_embedding;
      if (!pooled) throw new Error(`${loaded.repo} returned no sentence_embedding; this export is not usable as an embedder`);
      const [count, width] = pooled.dims;
      const vectors = [];
      for (let i = 0; i < count; i++) {
        vectors.push(matryoshka(pooled.data.subarray(i * width, (i + 1) * width), dims));
      }
      return vectors;
    });
  }

  return {
    load,
    embed,
    unload,
    status: (id = DEFAULTS.embedder) => modelStatus(specOf(id)),
    download: (id = DEFAULTS.embedder, options) => exclusive(() => downloadModel(specOf(id), options)),
    remove: (id = DEFAULTS.embedder) => exclusive(async () => {
      const spec = specOf(id);
      if (loaded === spec) await unload();
      await removeModel(spec);
    }),
    get loaded() { return loaded ? { dims: loaded.dims, device } : null; },
  };
}
