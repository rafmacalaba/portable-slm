# portable-slm

**On-device AI for browser applications, with chat as the product.** `<pslm-chat>` installs a
SHA-256-verified model into the browser, streams answers locally, runs bounded tools, and takes its
context from a single host-supplied callback. There is no cloud inference endpoint, no telemetry and
no path from the assistant to a host write API.

The seam is one line. A host declares what may be read and answers one callback; everything else is the
SDK's:

```mermaid
flowchart TB
  subgraph host["your application"]
    direction LR
    D["manifest<br/><small>pslm-host/1: endpoints, caps, tasks, tools</small>"]
    M["mount<br/><small>&lt;div data-pslm&gt; + CSS</small>"]
    B["bindings<br/><small>form input · log endpoint</small>"]
  end
  subgraph sdk["portable-slm"]
    direction LR
    H["harness<br/><small>embed.js · chat.js · host-contract.js</small>"]
    R["runtime<br/><small>store · engine · agent loop</small>"]
  end
  D -->|"declares what may be read"| H
  H -->|"onContext(question) → text"| M
  H -->|"events: answer · error · tool · suggest"| M
  H -->|"pslm-fill-request (cancelable)"| B
  H --> R
  R -->|"answers, verdicts, provenance"| H
  H -.->|"no write path, ever"| host
```

The runtime never leaves the browser: weights are verified once per origin, inference is local, and the only
requests are the context reads you declared and the mirror you named.

The package is layered so a host can adopt as little as it wants:

| Layer | Artifact | What it is |
|---|---|---|
| **Chat (vanilla)** | `dist/chat.js`, `dist/chat.html`, `portable-slm/chat` | framework-free `<pslm-chat>` — install, import, load, stream, tools, approval, provenance. Runs with no host at all |
| **Core SDK** | `portable-slm` | verified GGUF storage, resumable download, WebGPU/CPU inference, bounded tool loop |
| **Host adapters** | `portable-slm/embed`, `metadata-*`, `nada-qa` | manifest-driven context and tasks for a specific host application |

NADA and Metadata Editor are the worked examples — the reference for "a host builds on the vanilla
component without forking it" — not exclusive targets. This is an SDK/harness prototype, not yet a
published package or a native integration in either example host.

- [Getting started — the three-command on-ramp for a host application](docs/GETTING_STARTED.md)
- [Chat — vanilla usage, attributes, events, theming](docs/CHAT.md)
- [Tools — defaults, network policy, authoring](docs/TOOLS.md)
- [Context providers — how a host feeds the assistant](docs/CONTEXT_PROVIDERS.md)
- [Making the assistant answer better — corpus, retrieval, evaluation, fine-tuning](docs/ANSWER_QUALITY.md)
- [Architecture and boundaries](docs/ARCHITECTURE.md)
- [Worked host integrations: NADA and Metadata Editor](docs/HOST_INTEGRATION.md)
- [Host integration contract (`pslm-host/1`): manifest, embed levels, acceptance](docs/HOST_CONTRACT.md)
- [Agent modes: declared tools, engine choice, model pins, MCP and search boundaries](docs/AGENT.md)
- [Laptop pilot: NADA + Metadata Editor](docs/LAPTOP_PILOT.md)

Three pages ship in the bundle and need no build step of their own: `chat.html` (the vanilla
surface), `host-check.html` (run the acceptance checks on your own origin) and
`framework-options.html` (compare implementation approaches — vanilla custom element, lit, Stencil,
React, Vue, Svelte — and read the recommendation).
### The documents, by kind

**Contracts** — normative. A host implements these, and `host-check.html` verifies them.

| document | what it fixes |
|---|---|
| [HOST_CONTRACT.md](docs/HOST_CONTRACT.md) | the `pslm-host/1` manifest, the context sources, the tasks, the acceptance definition |
| [CHAT.md](docs/CHAT.md) | the element's attributes and the events a host may rely on |
| [LOGGING / §logging](docs/HOST_CONTRACT.md#logging) | the optional log endpoint a host implements |
| [TOOLS.md](docs/TOOLS.md) | what a tool may be, and the limits the loop enforces |

**Guides** — how to build with it.

| document | read when |
|---|---|
| [GETTING_STARTED.md](docs/GETTING_STARTED.md) | integrating into an application, from zero, with diagrams |
| [CONTEXT_PROVIDERS.md](docs/CONTEXT_PROVIDERS.md) | deciding where answers come from: the five-rung ladder, and where to stop |
| [ADDONS.md](docs/ADDONS.md) | extending the harness: the six extension points and what each owes |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the layers fit, and why the boundaries are where they are |
| [HARNESS.md](docs/HARNESS.md) | what is enforced in code rather than asked for in a prompt |
| [ANSWER_QUALITY.md](docs/ANSWER_QUALITY.md) | making answers good: corpus, retrieval, evaluation, and the bounded-context arithmetic |
| [AGENT.md](docs/AGENT.md) | agent modes, engine choice, model pins, MCP and search boundaries |
| [HOST_INTEGRATION.md](docs/HOST_INTEGRATION.md) | the two worked integrations, end to end |
| [AGENTS.md](AGENTS.md) | working **in this repository**: invariants, module map, how to verify a change |

**Status** — what is proven, and what is not. Read before trusting any of the above.

| document | what it records |
|---|---|
| [IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | status, release gates, the gated retrieval follow-up |
| [DEVICE_VALIDATION.md](docs/DEVICE_VALIDATION.md) | what has been run on which device, and what has not |
| [LAPTOP_PILOT.md](docs/LAPTOP_PILOT.md) | the first real workflow, on real hardware |

- [Chrome extension guide](integrations/chrome-extension/README.md)
- [Metadata consumer example](examples/README.md)
- [Implementation status and next steps](docs/IMPLEMENTATION_PLAN.md)

## When this is the right tool, and when it is not

Portable SLM is a few hundred million parameters, quantized, in a browser tab. What it guarantees is
about **where the computation happens**, not about how good the answer is: nothing you type leaves the
machine, the model bytes are verified by checksum, and it runs with no network at all.

| Right tool when | Wrong tool when |
|---|---|
| the material cannot leave the network — embargoed or confidential statistics | being wrong is costly: numbers, dates, quotes, decisions |
| no model service is reachable — field laptops, blocked mirrors, air-gapped offices | the answer needs knowledge the supplied context does not contain |
| a stated policy rules out pasting into a hosted assistant | long reasoning or multi-step analysis |
| someone drafts short text and a human edits it | volume — hundreds of records to process |
| a team needs to see what local inference actually is | anything autonomous, browsing, or acting without review |

The rule that settles most arguments: **the answer must be recoverable from the context you supply.**
In the snapshot → useful. Needs general knowledge → unreliable. Needs judgement → not a model's job.
The grounding stamp and the *"not in the record"* behaviour exist to make the failure visible, not to
fix the model — which is also why [answer quality is a corpus problem, not a model
problem](docs/ANSWER_QUALITY.md).

## Try the vanilla chat

```sh
npm install && npm run build:embed
npx serve dist        # open http://localhost:3000/chat.html
```

One custom element, no host application, no bundler:

```html
<pslm-chat model="lfm2.5-350m-q4km" tools="offline"></pslm-chat>
<script type="module" src="/portable-slm/chat.js"></script>
```

```js
chat.onContext = async () => await myAuthorizedSnapshot();   // the only host seam
```

### Any page, no host at all

The tabbed surface hosts embed works the same way with nothing declared. One script tag and one
element is a complete, honest assistant on any page of any application:

```html
<div data-pslm style="width:24rem;height:32rem"></div>
<script type="module" src="/portable-slm/embed.js"></script>
```

No manifest, no record, no knowledge of what the page is about: chat, install, import, build stamp.
Portable SLM's own description of itself is always in the prompt (`composeContext`, append-only), so
the assistant can say what it is and what it cannot do; a host's `onContext` text is added after it,
never in place of it. Adding a manifest and a record id is what unlocks grounded answers about data,
and a record-less page can declare `context.app` to be grounded in the application's own help text
instead. The whole ladder is
[`HOST_CONTRACT.md` §1b](docs/HOST_CONTRACT.md#1b-the-panel-degrades-it-does-not-refuse).

## Run

```sh
npm install
npm run dev                 # web chat: http://localhost:5173/
                            # NADA study Q&A: http://localhost:5173/nada.html
                            # metadata review: http://localhost:5173/review.html
                            # general benchmark: http://localhost:5173/benchmark.html
npm run build && npm run preview  # offline-capable static web build, port 4173
npm run build:embed    # dist/chat.js + dist/chat.html + dist/embed.js + host-check.html + embed-assets
npm run scaffold -- --out <dir> --shape static|record   # a correct host starting point
npm run pack:site -- --out <dir> --runtimes onnx|wllama|both   # the bundle subset a host serves itself
                       # both builds also write dist/version.json (version, gitSha, builtAt)
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

### OpenAI-shaped local chat API

An optional adapter provides `chat.completions.create()` request/response shapes directly in JS:

```js
import { createOpenAICompatibleClient } from "./src/openai-compatible.js";

const local = createOpenAICompatibleClient(ai);
const completion = await local.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Summarize this note." }],
  max_completion_tokens: 128,
});
console.log(completion.choices[0].message.content);
```

Set `stream: true` to receive an `AsyncIterable` of completion chunks. This is an in-process
browser API: no HTTP endpoint, API key or network request. It supports text messages and basic
sampling/JSON options; use `ai.runAgent()` for declared tools. It does not claim full OpenAI API
compatibility. Vision, audio and classifier runtimes stay outside this adapter; add each as an
optional task module only after its model/runtime and browser limits are validated. Do not add
placeholder models to the pinned GGUF catalog.

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

## Worked integrations: NADA and Metadata Editor

`integrations/metadata-context.js` reads one authorized Metadata Editor field or NADA study via
same-origin APIs. `integrations/metadata-review.js` exports `suggestMetadata(ai, request)`;
`src/nada-qa.js` exports `answerStudyQuestion(ai, study, question)`. Both load a local model and
return read-only results for the host to review. Metadata Editor schema validation, save and publish
remain host responsibilities. `/review.html` is also a demo consumer; it can be bundled under a
host's `/portable-slm/` path and launched with same-origin API context. Browser E2E covers this with
fixtures. Local launch-link patches sit in sibling NADA and Metadata Editor clones only; no upstream
integration is merged or approved. The initial `TEST-2030` record is **fictional sample input**.
npm publication is disabled. A host that wants to verify instead of trust runs
`/portable-slm/host-check.html` on its own origin ([acceptance page](docs/HOST_CONTRACT.md#7-acceptance-page)).
See [the host integration contract](docs/HOST_INTEGRATION.md).

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
