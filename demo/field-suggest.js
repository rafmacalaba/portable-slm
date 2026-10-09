import wasm from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import compatWasm from "@wllama/wllama-compat/wasm/wllama.wasm?url";
import compatWorker from "@wllama/wllama-compat/wasm/wllama.js?url";
import { createLocalSLM } from "../src/index.js";
import { mountFieldSuggest } from "./field-suggest-view.js";

if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
const ai = createLocalSLM({ assets: { wasm, compatWasm, compatWorker }, ctx: 4096 });
const params = new URLSearchParams(location.search || location.hash.slice(1));
mountFieldSuggest(document.getElementById("suggest-root"), ai, {
  source: params.get("source") === "record-editor" ? "record-editor" : undefined,
  recordId: params.get("id") ?? "",
  path: params.get("path") ?? undefined,
  apiBase: params.get("apiBase") ?? undefined,
});
