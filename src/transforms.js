// Deterministic edits applied to a pinned upstream file before it is served.
//
// Kept apart from pinned-cache.js so they can be tested without a runtime, a browser or a model: an
// edit that silently stops applying would be invisible in production, which is exactly the kind of bug
// this split exists to make testable.

/**
 * Named, deterministic edits applied to a pinned upstream file before it is served.
 *
 * These run after the upstream bytes have been hash-verified, so the pin still describes what was
 * downloaded. Each one exists because a runtime would otherwise request something we do not want, and
 * each is a pure function so the edit is readable and testable rather than buried in a load path.
 */
export const TRANSFORMS = {
  /**
   * EmbeddingGemma 2: the commercial export declares `vision_config` and `audio_config`, and
   * transformers.js adds a session for every modality a config declares, so a text-only install would
   * still fetch 93 MB of vision weights and 162 MB of audio weights it never uses. Removing the two
   * blocks is what makes text-only true rather than aspirational: the text graph, its tokenizer and its
   * weights are untouched, and only the modality encoders become unreachable.
   */
  "text-only"(text) {
    const config = JSON.parse(text);
    delete config.vision_config;
    delete config.audio_config;
    return JSON.stringify(config);
  },
};

/** Apply a declared transform to a verified file, or return the original blob untouched. */
export async function applyTransform(blob, file, spec, ResponseClass = Response) {
  const declared = spec?.transforms?.[file.path];
  if (!declared) return blob;
  // A catalogue entry names a transform, so the catalogue stays data and the edit stays here.
  const transform = typeof declared === "function" ? declared : TRANSFORMS[declared];
  if (!transform) throw new Error(`Unknown transform ${JSON.stringify(declared)} declared for ${file.path}`);
  return new ResponseClass(new Blob([transform(await blob.text())]));
}
