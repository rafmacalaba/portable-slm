import { defineConfig } from "vite";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "./",
  build: {
    outDir: "../../dist-extension", emptyOutDir: true, target: "es2022",
    rollupOptions: { input: new URL("./panel.html", import.meta.url).pathname },
  },
});
