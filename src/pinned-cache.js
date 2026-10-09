// The pinned fetch layer: every file a runtime may request is installed and hash-verified first, and
// anything the catalogue does not name is refused rather than quietly fetched from the Hub.
//
// Shared by both transformers.js runtimes. The text generator and the embedder need the same guard, and
// a second copy of a guard only proves that the first one works.
import { modelFileBlob } from "./store.js";
import { env } from "@huggingface/transformers";
import { applyTransform } from "./transforms.js";

export function pinnedCache(spec) {
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
      const blob = await applyTransform(await modelFileBlob(file), file, spec);
      return new Response(blob, { headers: { "content-length": String(blob.size) } });
    },
    // All files this model can request are installed and hash-verified before load. Unexpected
    // remote assets are refused (allowRemoteModels=false), not silently cached from the network.
    async put() {},
  };
}

export function configureLocalFiles(spec, assets) {
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
