import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Cross-origin isolation enables multi-threaded WASM (the fallback engine on low-end devices).
// Production hosts must send the same two headers.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: "demo",
  base: "./",
  build: {
    outDir: "../dist", emptyOutDir: true, target: "es2022",
    rollupOptions: { input: {
      chat: new URL("./demo/index.html", import.meta.url).pathname,
      nada: new URL("./demo/nada.html", import.meta.url).pathname,
      review: new URL("./demo/review.html", import.meta.url).pathname,
      benchmark: new URL("./demo/benchmark.html", import.meta.url).pathname,
    } },
  },
  worker: { format: "es" },
  server: { headers: isolation },
  preview: { headers: isolation },
  plugins: [precacheServiceWorker()],
});

// Emits sw.js with the exact list of built files so the app shell works offline.
function precacheServiceWorker() {
  return {
    name: "precache-service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      const publicFiles = readdirSync(new URL("./demo/public", import.meta.url));
      // Vite emits HTML after generateBundle; list each HTML entry explicitly.
      const files = ["./", "./nada.html", "./review.html", "./benchmark.html", ...Object.keys(bundle).map((f) => `./${f}`), ...publicFiles.map((f) => `./${f}`)];
      const source = readFileSync(new URL("./demo/sw.js", import.meta.url), "utf8")
        .replace("self.__PRECACHE__", JSON.stringify(files))
        .replace("self.__VERSION__", JSON.stringify(String(Date.now())));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
