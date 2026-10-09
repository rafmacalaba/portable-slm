// Model files are pinned by immutable Hub revision + SHA-256. GGUF entries use wllama;
// ONNX entries use Transformers.js. `engine` below still means webgpu|cpu, not runtime.
const HF = "https://huggingface.co";
const LICENSE = "LFM Open License v1.0";

function onnxFiles(repo, revision, files) {
  return files.map(([path, bytes, sha256]) => ({
    path, file: path, bytes, sha256,
    url: `${HF}/${repo}/resolve/${revision}/${path}`,
  }));
}

const ONNX_350_REV = "d11593fd9eb408e322667926656598896c2d5ff9";
const ONNX_12B_REV = "10f72e70abf67ac0fd7ebf15bc5854726891d864";
const ONNX_26B_REV = "66826372fd4fa166f53be0371c9315745c07cace";
const EMBEDDINGGEMMA2_REV = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

/**
 * Instruction prefixes. A wrong or missing prefix does not error, it quietly returns worse vectors,
 * so they live here as data with a test rather than as strings scattered through call sites.
 */
export const EMBEDDING_PREFIXES = {
  query: (text) => `task: search result | query: ${text}`,
  document: (title, text) => `title: ${title || "none"} | text: ${text}`,
};

export const MODELS = {
  "lfm2.5-230m-q4km": {
    label: "LFM2.5-230M (Q4_K_M)", format: "GGUF", license: LICENSE,
    url: `${HF}/LiquidAI/LFM2.5-230M-GGUF/resolve/03502067c64ce32ac4fe87b0cec0310a1a13d3e9/LFM2.5-230M-Q4_K_M.gguf`,
    file: "LFM2.5-230M-Q4_K_M.gguf",
    bytes: 153_406_304,
    sha256: "7bbd90384d3deffe4c646ec9643b212802d32d4ce417c90a1ec9282100650062",
    verified: "iPhone (Safari 26), desktop Chrome",
  },
  "lfm2.5-350m-q4km": {
    label: "LFM2.5-350M (Q4_K_M)", format: "GGUF", license: LICENSE,
    url: `${HF}/LiquidAI/LFM2.5-350M-GGUF/resolve/657e078c94084481950a2d555a941481f715536b/LFM2.5-350M-Q4_K_M.gguf`,
    file: "LFM2.5-350M-Q4_K_M.gguf",
    bytes: 229_312_224,
    sha256: "7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4",
    verified: "iPhone (Safari 26), desktop Chrome",
  },
  "lfm2.5-350m-qad-q4_0": {
    label: "LFM2.5-350M QAD (Q4_0)", format: "GGUF", license: LICENSE,
    url: `${HF}/LiquidAI/LFM2.5-350M-GGUF/resolve/657e078c94084481950a2d555a941481f715536b/LFM2.5-350M-QAD-Q4_0.gguf`,
    file: "LFM2.5-350M-QAD-Q4_0.gguf",
    bytes: 219_312_832,
    sha256: "3d10b6ab8fc91a919534b9558e266255aca0bbc7f6d015963599aa9e74e05b1d",
    verified: "iPhone (Safari 26), desktop Chrome",
  },
  "lfm2.5-350m-onnx-q4f16": {
    label: "LFM2.5-350M ONNX (Q4F16 · ~259 MB)", runtime: "transformers", format: "ONNX",
    repo: "LiquidAI/LFM2.5-350M-ONNX", revision: ONNX_350_REV, dtype: "q4f16", subfolder: "onnx",
    license: LICENSE, verified: "Chrome WebGPU probe; Safari not yet verified",
    files: onnxFiles("LiquidAI/LFM2.5-350M-ONNX", ONNX_350_REV, [
      ["config.json", 1443, "544d8d604bacf4cb89383c49c9a54621afa26a6741f3f55fd8b840ca1d640419"],
      ["generation_config.json", 136, "94bfac0e1c207691baf4e172389a8efb114f8b60eb3a5c07a2f418aefa8f8bb6"],
      ["tokenizer.json", 3297793, "29d43b4be8e8a896fefd7cd836ca6d6b4eedd249f823866ce0453b368e646f49"],
      ["tokenizer_config.json", 3269, "95c85d0860d06c9529345f386004e8e67743375b15c5d39e9f46427d8977577b"],
      ["onnx/model_q4f16.onnx", 182827, "3012c28a119828561c90196331435d91c43c1a6ab4898ac79715585fff1dff85"],
      ["onnx/model_q4f16.onnx_data", 254965760, "9256ecd417b801b441d926ebe5ead4ebf50ac1a5a0f8f7914cf60d9d6452ef69"],
    ]),
  },
  "lfm2.5-1.2b-instruct-onnx-q4f16": {
    label: "LFM2.5-1.2B-Instruct ONNX (Q4F16 · ~764 MB)", runtime: "transformers", format: "ONNX",
    repo: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX", revision: ONNX_12B_REV, dtype: "q4f16", subfolder: "onnx",
    license: LICENSE, verified: "Chrome WebGPU probe; tool call parsed; Safari not yet verified",
    files: onnxFiles("LiquidAI/LFM2.5-1.2B-Instruct-ONNX", ONNX_12B_REV, [
      ["config.json", 1599, "dd5d4c6e32a992ad7ddac5c07f5e4711e42c69125f2b94287af7a8ec19963be5"],
      ["generation_config.json", 131, "25f750b7e6a790f86ed01cd6f128f905152cb60bbfe2e6618ceca833b452cf80"],
      ["tokenizer.json", 3297799, "0a1f2cb9fc2769030ca1f4207e81c1af493319373d41b8d3cf5be53860c13760"],
      ["tokenizer_config.json", 2391, "0f11f4ffa5750369414bb24e41f26e2bbf23f1d01def533cad5f584e59ae3bef"],
      ["onnx/model_q4f16.onnx", 182795, "a9986ad188200507342ac32f727aa4691edb5428b0aa8c4a9fbdf0c85a6fe667"],
      ["onnx/model_q4f16.onnx_data", 760279040, "46cfacc12941150620a3f644a5269e9baebd75d681cfa09cadeef71b8ed64ac2"],
    ]),
  },
  "lfm2.5-2.6b-onnx-q4f16": {
    label: "LFM2.5-2.6B ONNX (Q4F16 · ~1.55 GB · agent)", runtime: "transformers", format: "ONNX",
    repo: "LiquidAI/LFM2.5-2.6B-ONNX", revision: ONNX_26B_REV, dtype: "q4f16", subfolder: "onnx",
    // Native 128K, but Transformers.js pre-allocates WebGPU KV buffers: 128K (~1.5 GB of GPU
    // buffers) wedged on the second generation; 32K is proven stable; 64K (~768 MB) is the tested
    // compromise requested for this fleet. Revert to 32K if the wedge reappears.
    ctx: 65536,
    license: LICENSE, verified: "Chrome WebGPU probe; tool call emitted; Safari not yet verified",
    files: onnxFiles("LiquidAI/LFM2.5-2.6B-ONNX", ONNX_26B_REV, [
      ["config.json", 1728, "3df9ebb278bf43eddd8a240086449f197976a1783d6c4d2bfe9eaec4920f4184"],
      ["generation_config.json", 146, "e5e1e91829a9ae65809b578bff350dca876febbda88a9e36f415b002f6b3ddf0"],
      ["tokenizer.json", 17905598, "695be7802a0e4b8a81048f0ff5ebb7fc811a0ba5a6be63dbb24deb5a81096f41"],
      ["tokenizer_config.json", 6063, "cf46c3cdb18cf88542ee0d5d2afd98d78b3eeffd0e6d00a26f8b76800ff9a446"],
      ["onnx/model_q4f16.onnx", 222160, "871354d43abc0d718a7a089d2fe10ad5d1f83e08acbfb9f45e4d137b41a1e9a4"],
      ["onnx/model_q4f16.onnx_data", 1063972864, "34537bf4a6d70ddf1627bd3709d31c8b7db8d5bcaee2098c45661be59476fbec"],
      ["onnx/model_q4f16.onnx_data_1", 469958656, "1b645b44902caccd406098c4dbef5724927c5fb2a2be4a087ae328989b111a7f"],
    ]),
  },
};

// Embedding models are a different kind of entry: `kind` lets a caller tell a generator from an
// encoder without guessing from the id, and `dims`/`mrl` are what retrieval needs to size an index.
// Only the text encoder is listed. EmbeddingGemma 2 also ships a vision encoder and an audio encoder,
// and they are deliberately absent: an undeclared file cannot be downloaded, because the pinned fetch
// layer throws on anything the catalogue does not name.
// The default embedder. Its model ships inside the wasm, so there is nothing to download at runtime, no
// revision to pin and nothing for the store to verify: the dependency is the pin. 1.5 ms per embedding
// measured on CPU, which is what makes indexing a corpus in the browser affordable at all.
MODELS["ternlight-base"] = {
  label: "ternlight base (384d · ~7 MB, bundled)",
  kind: "embedding",
  runtime: "ternlight", tier: "default",
  package: "@ternlight/base", version: "0.1.1",
  dims: 384, mrl: [384], ctx: 128, chunkChars: 480, pooling: "model",
  // Measured on 8 in-corpus and 6 out-of-corpus questions: the best in-corpus match scored 0.26 to 0.65
  // and the best out-of-corpus match 0.00 to 0.12. 0.18 sits in that gap. It is a heuristic that reduces
  // false positives rather than a guarantee, which is why the grounding stamp remains the real check.
  minSimilarity: 0.18,
  license: "MIT",
  verified: "Node, 200 runs: 1.49 ms/embedding, 384 dims, L2 norm 1.000000",
};

MODELS["embeddinggemma-2-text-q4f16"] = {
  label: "EmbeddingGemma 2 text (Q4F16 · ~181 MB)",
  kind: "embedding",
  runtime: "transformers", format: "ONNX", tier: "quality",
  prefixes: "embeddinggemma",
  chunkChars: 1200,
  // Measured on the same questions: the best in-corpus match scored 0.66 to 0.85 and the best
  // out-of-corpus match 0.53 to 0.60, so the floor sits at 0.62 rather than in a wide gap.
  minSimilarity: 0.62,
  repo: "onnx-community/embeddinggemma-2-ONNX", revision: EMBEDDINGGEMMA2_REV,
  dtype: "q4f16", subfolder: "onnx",
  dims: 768, mrl: [768, 512, 256, 128], ctx: 8192, output: "sentence_embedding",
  // The export declares vision_config and audio_config, and transformers.js opens a session for every
  // modality a config declares. Without this, a "text only" install fetches 93 MB of vision and 162 MB
  // of audio weights. The transform runs on the hash-verified upstream bytes.
  transforms: { "config.json": "text-only" },
  license: "Apache-2.0",
  verified: "Pinned from the Hub tree API; the 495 KB graph hash was recomputed locally and matched",
  files: onnxFiles("onnx-community/embeddinggemma-2-ONNX", EMBEDDINGGEMMA2_REV, [
    ["config.json", 5031, "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d"],
    ["tokenizer.json", 32170510, "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4"],
    ["tokenizer_config.json", 1599, "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874"],
    // Not read for text, but the pipeline probes for it, and an undeclared probe is a hard failure.
    ["preprocessor_config.json", 560, "9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa"],
    ["onnx/model_q4f16.onnx", 495298, "53feeced79582d661e30adeaa9829cea90d92b1c78347e26fd123773580f71d0"],
    ["onnx/model_q4f16.onnx_data", 156862464, "c39fbaa1fb4221f04beb82786a06b81999c514fd39e84fcd58ef79413c87fa56"],
  ]),
};

export const DEFAULTS = {
  // Native LFM2.5 context. KV cache is ~12 KB/token and grows with actual usage, so a higher
  // limit costs nothing until a long prompt uses it. Per-model overrides live on MODELS entries
  // (the 2.6B supports 128K; the smaller models 32K). Hosts may still lower via the ctx attribute.
  ctx: 32768,
  maxTokens: 512,
  // Liquid's recommended sampling for LFM2.5.
  sampling: { temperature: 0.1, top_k: 50, penalty_repeat: 1.05 },
  license: "LFM Open License v1.0 — https://huggingface.co/LiquidAI/LFM2.5-350M/blob/main/LICENSE",
  // Retrieval defaults. `alpha` is the embedding weight, so 0 is BM25 alone and 1 is embeddings
  // alone; the mix is the default because each scorer is weak exactly where the other is strong.
  // dims 256 is a Matryoshka truncation of the embedder's 768, which quarters the index for a
  // quality difference that is not measurable on short chunks.
  // dims is a request, not a promise: the provider takes the nearest Matryoshka step the chosen embedder
  // actually supports, and ternlight has none, so it uses all 384.
  retrieval: { alpha: 0.5, dims: 256, topK: 6, maxBytes: 8192 },
  embedder: "ternlight-base",
};
