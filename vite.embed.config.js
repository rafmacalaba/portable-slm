import { defineConfig } from "vite";

// Library build of the L2 embed entry. Run after `vite build` (shared outDir, no emptyOutDir).
export default defineConfig({
  base: "./",
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm"] },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: 0,
    target: "es2022",
    lib: { entry: "integrations/embed.js", formats: ["es"], fileName: () => "embed.js" },
    rollupOptions: { external: [] },
  },
});
