import wasm from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import compatWasm from "@wllama/wllama-compat/wasm/wllama.wasm?url";
import compatWorker from "@wllama/wllama-compat/wasm/wllama.js?url";
import { createLocalSLM } from "../src/index.js";
import { mountNada } from "./nada-view.js";

if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
const ai = createLocalSLM({ assets: { wasm, compatWasm, compatWorker }, ctx: 4096 });
const params = new URLSearchParams(location.search || location.hash.slice(1));
mountNada(document.getElementById("nada-root"), ai, {
  source: params.get("source") === "nada" ? "nada" : "public-demo",
  recordId: params.get("id") ?? "Test001_OD",
  apiBase: params.get("apiBase") ?? undefined,
  catalogBase: params.get("catalogBase") ?? undefined,
});
