# portable-slm

**On-device AI capability service for software developers.** Embed this browser SDK in NADA,
Metadata Editor or another web consumer: host app supplies authorized context and owns its workflow;
Portable SLM manages verified GGUF storage, local inference and bounded tool calling. No cloud
inference endpoint or extension required. Current consumers: web chat, grounded NADA study Q&A,
metadata-review example and offline benchmark. This is an SDK/harness prototype—not yet a published
package or a native integration in either host application.

- [Architecture and boundaries](docs/ARCHITECTURE.md)
- [Host integration: NADA and Metadata Editor](docs/HOST_INTEGRATION.md)
- [Laptop pilot: NADA + Metadata Editor](docs/LAPTOP_PILOT.md)
- [Chrome extension guide](integrations/chrome-extension/README.md)
- [Metadata consumer example](examples/README.md)
- [Implementation status and next steps](docs/IMPLEMENTATION_PLAN.md)

## Run

```sh
npm install
npm run dev                 # web chat: http://localhost:5173/
                            # NADA study Q&A: http://localhost:5173/nada.html
                            # metadata review: http://localhost:5173/review.html
                            # general benchmark: http://localhost:5173/benchmark.html
npm run build && npm run preview  # offline-capable static web build, port 4173
npm run build:extension     # unpacked desktop Chrome extension in dist-extension/
npm test                    # SHA-256, store, agent/tool safety, example adapters
npm run e2e                 # Chrome: mirror/import → chat + NADA Q&A + review + benchmark, offline
# Developer-only extension test, in an environment where unpacked extensions are authorized:
CHROME_PATH=/path/to/approved-test-chrome npm run e2e:extension
```

The E2E tests use `.cache/models/LFM2.5-350M-Q4_K_M.gguf`; `npm run e2e` downloads it if absent.
`e2e:extension` imports that file rather than redownloading it. A managed-Chrome policy block
requires IT approval; do not use a different browser build to evade it.

## Use subsystem from another web UI

```js
import { createLocalSLM } from "./src/index.js";
import wasm from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import compatWasm from "@wllama/wllama-compat/wasm/wllama.wasm?url";
import compatWorker from "@wllama/wllama-compat/wasm/wllama.js?url";

const ai = createLocalSLM({ assets: { wasm, compatWasm, compatWorker } });
const model = "lfm2.5-350m-q4km";
if ((await ai.status(model)).state !== "installed") {
  await ai.importModel(fileFromPicker); // or ai.download(model) while online
  // or ai.download(model, { sources: [yourHttpsMirror, ai.models[model].url] })
}
await ai.load(model);

// Plain streaming chat; no tools or internet required.
await ai.generate([{ role: "user", content: "Summarize this note." }], { onToken: append });

// Agent: the model can select declared tools. Offline is the default.
const r = await ai.runAgent([{ role: "user", content: "What time is it?" }], {
  onTool: (event) => showToolEvent(event),
});
console.log(r.text);

// Optional online tool: requires opt-in AND approval of exact arguments for each call.
await ai.runAgent([{ role: "user", content: "Search Wikipedia for France." }], {
  allowNetwork: true,
  approveTool: ({ name, args }) => confirm(`Send ${name} ${JSON.stringify(args)} online?`),
});
```

The host must bundle JS/WASM locally and precache its app assets for offline use. Models and cache
belong to the **browser origin**: the extension, this app and a third-party site each need their
own import/download. See [`src/index.d.ts`](src/index.d.ts) for the complete API.

## NADA study Q&A (first laptop workflow)

Open [NADA study Q&A](https://rafmacalaba-portable-slm.static.hf.space/nada.html) in a direct
first-party tab, or use the **NADA study Q&A** button inside the HF Space so it shares that
embedded app's model cache. Load one published NADA study while online. The app stores its short
public title/abstract snapshot locally for offline reopen. Ask a question: it requests a verbatim
source quote from the model and checks that the quote occurs in the source. Unsupported or missing
evidence is visibly marked **unverified**. Quote matching does *not* prove the interpretation is
correct. This is read-only; no NADA account or write API. See `src/nada-qa.js`.

## Integrating NADA or Metadata Editor

`integrations/metadata-context.js` reads one authorized Metadata Editor field or NADA study via
same-origin APIs. `integrations/metadata-review.js` exports `suggestMetadata(ai, request)`;
`src/nada-qa.js` exports `answerStudyQuestion(ai, study, question)`. Both load a local model and
return read-only results for the host to review. Metadata Editor schema validation, save and publish
remain host responsibilities. `/review.html` is a demo consumer, not a modification to either
application. The initial `TEST-2030` record is **fictional sample input**. See
[the host integration contract](docs/HOST_INTEGRATION.md).

## Offline setup

Open the web app once on HTTPS so the service worker caches its files. Download a listed model
from Hugging Face or an alternate HTTPS mirror, or import the same GGUF from Files/USB; the store
verifies the **same pinned SHA-256** regardless of source. **Offline readiness** checks cached app
assets and the verified model separately; then reopen the site without internet. The model manager
shows approximate browser storage use/quota and installed or partial models. On `Quota exceeded`,
select an unused model and **Remove** it, then resume; existing models are never deleted automatically.
HF's embedded Space and a direct static-app tab may have separate storage partitions, so a model
installed in one may not appear in the other. Offline tools work; online Wikipedia search is neither advertised to the model nor run
unless enabled and approved. Browser storage may be evicted, so keep the source GGUF for re-import.

## Compare models

Inside the [Hugging Face Space](https://huggingface.co/spaces/rafmacalaba/portable-slm), use the
**Metadata review** and **Benchmark** buttons at the top of chat. They mount in the same embedded
app and reuse its model cache. HF may redraw its iframe once shortly after opening the Space;
wait for the app status to settle before using the buttons. Direct
[benchmark.html](https://rafmacalaba-portable-slm.static.hf.space/benchmark.html) is also available,
but a direct tab may have storage partitioned separately from the HF embed and need a re-import.
After installing a model on the chosen origin, the benchmark runs 12 short authored cases covering
classification, JSON extraction, grounded QA, instruction following and a fixture-based tool call. Results checkpoint
after each case, resume after reload, compare installed models, and export JSON. This is a smoke
benchmark—not a broad quality claim. See `bench/tasks.js` and `bench/run.js`.

## License

Portable SLM source code is MIT licensed; see [`LICENSE`](LICENSE). wllama is MIT licensed.
Model weights have separate terms: Liquid AI models use LFM Open License v1.0, including its
conditions. Review the license for each model before redistributing weights; this SDK does not
bundle model files.
