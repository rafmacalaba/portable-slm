import { defineConfig } from "vite";

// Library build of the generic host-side helpers a host imports directly — currently the log forwarder.
// Same shape as embed/chat: self-contained, so a host page needs no bundler of its own.
export default defineConfig({
  base: "./",
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm"] },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: 0,
    target: "es2022",
    lib: { entry: "integrations/logging.js", formats: ["es"], fileName: () => "logging.js" },
    rollupOptions: { external: [] },
  },
});
