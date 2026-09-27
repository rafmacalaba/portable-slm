# Portable SLM architecture (MVP)

Portable SLM is an **on-device AI capability service for software developers**: NADA, Metadata
Editor or another consumer embeds a browser runtime and calls it through an SDK/PWA. Laptop, iOS
Safari and Android Chrome are the target—not a native-only app or local inference daemon. This is
SaaS-like in its consumer contract, not cloud inference: the model runs on the user's device. A
consumer supplies UI, authorized context and its workflow; the subsystem owns verified model
storage, inference, a bounded tool loop and tool permissions. Network access is optional for data
refresh/sync or explicitly approved tools; it is not the default inference path.

```text
NADA / Metadata Editor UI, web chat, Chrome side panel
        │ context snapshot + user request (never automatic page scraping)
        ▼
src/index.js  SDK: status · import/download · load · generate · runAgent
        ├─ src/store.js   Cache API, 16 MB chunks, mirrors/resume, SHA-256, GGUF import
        ├─ src/readiness.js   app-shell + verified-model offline check
        ├─ src/nada-qa.js     grounded public-study Q&A + local snapshot
        ├─ wllama         bundled WASM; Chrome WebGPU/CPU, iOS CPU by default
        ├─ src/agent.js   tool-call validation, consent, max 2 rounds, bounded results
        └─ src/tools.js   offline date + safe calculator; opt-in Wikipedia search
        ▼
model weights stored per browser origin → local inference
```

## Components and boundaries

A host connector reads only data the signed-in user is allowed to access and passes a bounded
snapshot into the local runtime. Portable SLM returns a draft; the host keeps schema validation,
review, save and publish authority. For the current priority workflow, Metadata Editor is where
curators author/validate metadata; NADA is where catalogs disseminate studies and apply data-access
policy. Editor-to-NADA publishing remains the host's existing workflow. See the
[official Editor guide](https://worldbank.github.io/metadata-editor-docs/documenting_general_instructions.html),
[Publish to NADA guide](https://worldbank.github.io/metadata-editor-docs/publish_to_nada.html), and
[NADA API documentation](https://ihsn.github.io/nada-api-redoc/catalog-admin/).

## Components and boundaries

| Component | Path | Responsibility |
|---|---|---|
| Engine and model vault | `src/index.js`, `src/store.js`, `src/models.js` | Verify/download/import GGUF, load one model, generate text; no DOM or NADA knowledge |
| Tool loop | `src/agent.js`, `src/tools.js` | Parse native wllama tool calls, validate flat JSON arguments, enforce offline mode/consent/limits; no arbitrary JS execution |
| Web chat consumer | `demo/index.html`, `demo/main.js` | Model manager, alternate mirror URL, offline-readiness check, chat and tool toggles |
| NADA Q&A consumer | `demo/nada.html`, `demo/nada-view.js`, `src/nada-qa.js` | Fetch one public study, save its bounded title/abstract, ask locally with evidence check; offline reopen |
| Metadata consumer | `demo/review.html`, `integrations/metadata-widget.js`, `integrations/metadata-context.js` | Mountable widget: same-origin NADA study / Editor field API or pasted JSON → read-only suggestion |
| Benchmark consumer | `demo/benchmark.html`, `bench/` | Twelve authored general-task fixtures; per-example checkpoint, local comparison and JSON export |
| Chrome consumer | `integrations/chrome-extension/` | MV3 side panel; selected/page text on explicit click; bundled engine + local model in extension storage |

`src/index.js` is the contract consumed by every UI. It exposes `createLocalSLM({assets,ctx})`
with `status(id)`, `download(id)`, `importModel(file)`, `load(id)`, `generate(messages)` and
`runAgent(messages,{tools,allowNetwork,approveTool,onTool})`. Normal `generate` streams; the agent
uses non-streaming model steps to obtain structured native tool calls, then reports its final text.
See [`src/index.d.ts`](../src/index.d.ts) for exact types.

### Tool round-trip

1. Consumer explicitly enables tools; `allowNetwork` defaults to **false**.
2. Subsystem advertises only permitted, declared tool schemas to wllama.
3. Model returns `tool_calls`; subsystem JSON-parses and validates name, allowed keys, types,
   length and required fields. Unknown tool or invalid arguments fail closed.
4. An online tool additionally requires `approveTool({name,args}) === true` for **each call**;
   UIs show the exact outbound arguments to the user. No approval → no network call.
5. Trusted tool code runs with a timeout. Result is limited to 2 KB and fed back as a `tool`
   message; model gives a final answer. At most 2 rounds by default (hard cap 3).

Built-in tools: offline `get_datetime`, offline arithmetic `calculate` (parser, never `eval`), and
online `wiki_search` (Wikipedia API; query leaves device after consent). Consumers may register
trusted read-only tools. Tool **results and page text are untrusted**: render with `textContent`;
never automatically save model output or let the model invoke arbitrary code.

## Desktop browser: Ask-Gemini-like surface

The Chrome MV3 side panel is a **consumer**, not the subsystem's background server. It runs the
same SDK in its own page; wllama runs inference in its worker. The extension service worker only
opens the panel (Chrome may terminate idle extension workers).

- User clicks extension action. `activeTab` grants temporary permission for that tab.
- User clicks **Use selected text** or **Use page text**. `chrome.scripting.executeScript` copies at
  most 4,000 characters; the panel shows the snapshot before generation.
- User asks; subsystem answers locally. Tool calls are visible; online queries need consent.
- Bundled JS/WASM meet MV3 remote-code/CSP rules. Model data is imported or downloaded to
  extension-origin storage, then reused offline.

This extension is for **desktop Chrome**. Standard mobile Chrome does not offer the same extension
side-panel platform. Mobile consumers use the web SDK/UI. User confirmed stable iPhone Safari use; Android Chrome still
needs field testing.
See [`integrations/chrome-extension/README.md`](../integrations/chrome-extension/README.md).

## NADA and Metadata Editor

[NADA](https://github.com/ihsn/nada) exposes catalog study metadata (`GET /index.php/api/catalog/{IDNo}`).
The public demo returns `{status,dataset}`; the adapter extracts title and abstract from nested
`dataset.metadata.study_desc`. Its **Load public NADA demo study** action uses a fixed public host
without credentials. See the [laptop pilot](LAPTOP_PILOT.md).
[Metadata Editor](https://github.com/worldbank/metadata-editor) exposes one JSON field at
`GET /index.php/api/editor/json-field/{id}?path=<JSON Pointer>`. The MVP adapter
[`integrations/metadata-context.js`](../integrations/metadata-context.js) fetches those endpoints
with same-origin credentials and returns a bounded snapshot. The reusable
[`integrations/metadata-widget.js`](../integrations/metadata-widget.js) mounts a read-only UI in a
host application; `/review.html` is its demo host. [`examples/metadata-review.js`](../examples/metadata-review.js)
builds the prompt and checks suggestion JSON. Live-API mode works under the application's origin;
pasted-snapshot mode works anywhere. **No write API is called.**
The web E2E intercepts both endpoints with fixtures; deployment inside the upstream apps remains
for their maintainers.

The first selected laptop workflow is **NADA study Q&A**: `loadPublicNadaDemoStudy` fetches only
one published study from the public demo without credentials; `src/nada-qa.js` saves a bounded
snapshot in localStorage, builds a source-only prompt, and checks whether model-provided evidence
is a verbatim substring of the title or abstract. A matching quote is **not** proof of factual
interpretation. If model evidence fails, UI marks the answer unverified; if model says UNKNOWN,
UI still asks the user to check the source. The saved public snapshot can be used offline with a
cached model and app shell.

An extension can work on those pages without modifying them, but can only reliably read selected
or visible DOM text, not private application state. NADA and Metadata Editor are PHP/database-backed:
their full apps do **not** become offline because the model is local. Offline review requires a
previously exported/pasted snapshot; syncing edits back waits for their servers.

## Offline and browser storage

- A web host serves the app over HTTPS once. Its service worker caches chat, NADA Q&A, review, benchmark,
  JavaScript and both wllama WASM builds. `src/readiness.js` asks it to verify the precache and
  independently checks every model chunk. The model sits in origin-scoped Cache API, SHA-256
  verified. File import from USB/Files works without internet.
- The pinned catalog in `src/models.js` provides model id, size, SHA-256 and a default URL. A user
  can supply an alternate HTTPS mirror; fallback goes to the pinned source. **Source never changes
  the expected hash.** The model's original source is not an inference dependency.
- An unpacked extension bundles its own JS/WASM. Model storage is under its **extension origin**.
- Same-origin web pages share weights (`/`, `/nada.html`, `/review.html`, `/benchmark.html`) **within the same
  browser storage partition**. The HF Space embeds the static app cross-origin; Chrome partitions
  that iframe's cache from a direct static-app tab. Inside the HF wrapper, NADA Q&A, review and
  benchmark therefore mount *in-page* using one SDK instance and one embedded cache. The HF wrapper may
  replace its initial iframe once during hydration; wait for app status to settle before clicking.
  A different website or extension origin needs its own model import.
- Browsers can evict storage or refuse a second model with `QuotaExceededError`, particularly in
  third-party HF iframes. UI shows approximate usage/quota, installed and partial models. On quota
  failure, existing models are retained; user explicitly removes an unused model before resuming
  a partial download. Keep the original GGUF for re-import. First-time setup requires HTTPS, not
  necessarily Hugging Face (the app can be served by any static HTTPS host).
- Online mode **does not change inference location**. It only enables explicitly approved tools.
  An API-backed host UI may need its own connection for fetching/saving records.

## Verified versus unverified

- `npm run e2e`: real Chrome, download from a non-HF local mirror + local-file import, authenticated
  Editor/NADA API fixture reads, public NADA snapshot caching, and offline readiness. After server
  and mirror stop and DNS is blocked, chat, `get_datetime` tool, `/nada.html`, `/review.html` and
  `/benchmark.html` share cached models.
  Benchmark runs 12 general-task cases per model and compares 230M against 350M.
- `npm run e2e:extension` with Chrome for Testing: unpacked extension imports model, calls a tool,
  restarts offline with DNS blocked and calls it again.
- HF wrapper on desktop Chrome: after wrapper initialization, in-page review/benchmark buttons
  open without navigating or losing the model cache. Direct URLs work separately but may have
  different partitioned storage.
- Wikipedia online tool was exercised in the extension with a consent prompt; public API returns
  results. Each host must permit the Wikipedia origin for online use.
- User-confirmed stable iPhone Safari use for 230M/350M; 1.2B kills the tab. The app defaults to
  CPU and 256-token replies on iPhone. Android Chrome and phone benchmark scores need field tests.
- Public NADA Popstan study was fetched through its live API into the laptop NADA Q&A and review
  UIs. The Q&A saves a short public snapshot for offline reopen and checks evidence quotes;
  unsupported quotes are flagged. The fixture locks the real response shape. This is a
  read-only pilot, not a factual-quality endorsement.
- Extension `activeTab`/DOM capture on live NADA/Editor pages, authenticated upstream Editor
  deployments and mobile offline review/benchmark UI have **not** been verified yet.
