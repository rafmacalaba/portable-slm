// Models this runtime is tested with. A model = one GGUF file, pinned by revision and sha256.
// `verified` = where it ran end to end (phone-test Space: iOS 26 Safari, desktop Chrome).
const HF = "https://huggingface.co";
const LICENSE = "LFM Open License v1.0";

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
  // LFM2.5-1.2B (731 MB) crashed the tab on iPhone Safari; not offered until device fit (M2).
};

export const DEFAULTS = {
  ctx: 8192, // KV cache is ~12 KB/token for LFM2.5; 8K costs ~80 MB more than 2K
  maxTokens: 512,
  // Liquid's recommended sampling for LFM2.5.
  sampling: { temperature: 0.1, top_k: 50, penalty_repeat: 1.05 },
  license: "LFM Open License v1.0 — https://huggingface.co/LiquidAI/LFM2.5-350M/blob/main/LICENSE",
};
