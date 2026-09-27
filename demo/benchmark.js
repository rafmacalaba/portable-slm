import wasm from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import compatWasm from "@wllama/wllama-compat/wasm/wllama.wasm?url";
import compatWorker from "@wllama/wllama-compat/wasm/wllama.js?url";
import { createLocalSLM } from "../src/index.js";
import { mountBenchmark } from "./benchmark-view.js";

if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
const ai = createLocalSLM({ assets: { wasm, compatWasm, compatWorker }, ctx: 4096 });
mountBenchmark(document.getElementById("benchmark-root"), ai);
