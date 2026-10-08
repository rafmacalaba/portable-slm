import { defineConfig } from "vite";

// Library build of <pslm-chat>. Self-contained like embed.js, so a host page needs no bundler.
export default defineConfig({
  base: "./",
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm"] },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: 0,
    target: "es2022",
    lib: { entry: "integrations/chat.js", formats: ["es"], fileName: () => "chat.js" },
    rollupOptions: { external: [] },
  },
});
