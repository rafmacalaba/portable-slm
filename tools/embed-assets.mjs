// Copies the three wllama runtime assets next to embed.js and writes embed-assets.json,
// so a host page needs no bundler and never imports @wllama paths itself.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const outDir = "dist/embed-assets";
mkdirSync(outDir, { recursive: true });

const WANTED = {
  wasm: "@wllama/wllama/esm/wasm/wllama.wasm",
  compatWasm: "@wllama/wllama-compat/wasm/wllama.wasm",
  compatWorker: "@wllama/wllama-compat/wasm/wllama.js",
  // Transformers.js external-WASM build; self-hosted so ONNX inference never fetches runtime code.
  onnxWasm: "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm",
  onnxMjs: "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs",
};

const assets = {};
for (const [key, specifier] of Object.entries(WANTED)) {
  const from = require.resolve(specifier);
  const ext = key === "onnxMjs" ? "mjs" : specifier.endsWith(".js") ? "js" : "wasm";
  const name = `${key}.${ext}`;
  copyFileSync(from, join(outDir, name));
  assets[key] = `./embed-assets/${name}`;
}

writeFileSync("dist/embed-assets.json", `${JSON.stringify(assets, null, 2)}\n`);

// The vanilla chat page, the host acceptance page and the implementation-options page are plain
// markup that import the built bundles, so none of them needs its own bundler pass.
for (const page of ["chat.html", "host-check.html", "framework-options.html"])
  copyFileSync(`integrations/${page}`, `dist/${page}`);
console.log(`embed-assets.json -> ${JSON.stringify(assets)}`);
