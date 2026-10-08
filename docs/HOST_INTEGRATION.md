# Worked host integrations: NADA and Metadata Editor

These pages document two worked examples, not product limits. Portable SLM is a reusable browser
SDK/PWA for many web applications; NADA and Metadata Editor are initial priority consumers. Current
host-specific adapters cover these two. Other hosts can reuse the local runtime but need to provide
their own authorized context connector and task UI.

## Product model

Portable SLM is an **on-device AI capability service consumed by software**, not an AI product that
replaces the host tool. “As a service” describes the SDK contract: host apps send authorized,
bounded context to a local runtime and receive a draft/result. Inference remains on the user's
device; optional network calls are separate and explicit. This is not a cloud LLM SaaS endpoint.

The official workflows have different roles:

- **Metadata Editor:** curators create/import a project, choose a schema/template, document fields,
  validate, then export or publish. It supports several data types/standards, including DDI microdata
  and ISO geospatial metadata. The Editor's existing publish flow sends validated metadata to NADA.
- **NADA:** catalog administrators manage studies, collections and access policy; researchers
  search, discover and access cataloged studies under those policies.

Portable SLM fits alongside authoring/review in Metadata Editor and discovery/metadata help in
NADA. Host app remains source of truth and retains all save/publish/access authority. References:
[Editor workflow](https://worldbank.github.io/metadata-editor-docs/documenting_general_instructions.html),
[Editor publish to NADA](https://worldbank.github.io/metadata-editor-docs/publish_to_nada.html),
[NADA overview](https://ihsn.github.io/nada-documentation/intro/),
[NADA catalog-admin API](https://ihsn.github.io/nada-api-redoc/catalog-admin/).

Portable SLM runs as a consumer inside an approved web application. **No browser extension is
needed.** A standalone PWA cannot read another tab, page DOM or authenticated session. The host
must load the consumer itself, or provide an authorized export/snapshot.

## Bundled pilot (no npm runtime dependency)

Build Portable SLM, then copy `dist/` into each host's public document root as `portable-slm/`:

```sh
npm ci
npm run build
cp -R dist/. /path/to/host/public/portable-slm/
```

This ships SDK code, worker, WASM and app shell with host. It does **not** ship model weights;
users prepare a model on each host origin through `/portable-slm/`. No npm registry or CDN needed
at runtime. Keep generated host files synchronized with this repo's build.

Add a same-origin launch link. Use URL fragments for context IDs so IDs do not go to web-server
logs or asset-request referrers; never put field values, credentials or tokens in URL:

```php
// NADA, published survey/microdata page
$url = base_url('portable-slm/nada.html') . '#' . http_build_query(array(
    'source' => 'nada', 'id' => $survey['idno'],
    'apiBase' => base_url('index.php/api/'),
    'catalogBase' => base_url('index.php/catalog/'),
));

// Metadata Editor, authorized project page
$url = base_url('portable-slm/review.html') . '#' . http_build_query(array(
    'source' => 'metadata-editor', 'id' => $sid,
    'apiBase' => base_url('index.php/api/'),
));
```

NADA page reads one published study from its same-origin catalog API. Metadata Editor reads one
JSON field after user chooses its JSON Pointer and presses **Read from this app**. Both retain
host API access control and return local drafts only; neither calls a host write API. `/portable-slm/`
provides model preparation. The host and assistant share origin-scoped model storage, but NADA and
Metadata Editor need separate model setup when origins differ.

The static bundle's same-origin NADA and Metadata Editor flows pass browser E2E with API fixtures.
Local host-view patches exist in sibling working clones, not upstream branches; real NADA and
Metadata Editor deployments are not yet certified. The Metadata Editor link/API patch needs its
approved app instance checked before merge.

## Integration boundary

Host application supplies:

- A DOM mount point and current study/project ID.
- The approved same-origin API route or an explicit JSON snapshot.
- Its existing login/session and data-access decisions.
- Its own display, review, approval and save/publish workflow.

Portable SLM supplies:

- Local model import/download, verification, load and inference via `createLocalSLM`.
- Bounded task prompts and read-only consumer UI (`mountMetadataWidget`).
- Source snapshot inspection and structured-output validation.

Widget does not save or publish model output. Host must show a proposed diff and require human
approval before invoking its own write API. Never pass credentials to the model or the public HF
Space.

## Current adapters

`integrations/metadata-context.js` supports:

- **NADA:** one study from the current origin's `/index.php/api/catalog/{IDNo}` endpoint. The
  separate `loadPublicNadaDemoStudy()` helper fetches the public Popstan demo with credentials
  omitted; this is the only cross-origin NADA fetch currently implemented.
- **Metadata Editor:** one bounded JSON field from
  `/index.php/api/editor/json_field/{id}?path=<JSON Pointer>`, with same-origin credentials and
  `exclude_private_fields=1`.

The adapter rejects cross-origin `apiBase`. Test API shape and access rules against the approved
host version: current automated tests use fixtures, not a live private Editor instance.

## Task contract (headless host UI)

Host reads one authorized context using its own session, then calls a task helper with that bounded
snapshot. The helper loads the chosen local model, returns a structured draft/result, and never
fetches or writes host records.

```js
import { createLocalSLM } from "portable-slm";
import { loadMetadataContext } from "portable-slm/metadata-context";
import { suggestMetadata } from "portable-slm/metadata-review";
import { answerStudyQuestion } from "portable-slm/nada-qa";

// Host bundles these @wllama assets locally and creates one runtime per app origin.
const ai = createLocalSLM({ assets: { wasm, compatWasm, compatWorker } });
const modelId = "lfm2.5-350m-q4km"; // host may expose a device-appropriate installed model

// Any application: declare your own route. The loader keeps the guards (bounded id and JSON
// Pointer, same-origin only, an error that names the cause); you keep the endpoint, the query
// string and the response envelope.
const field = await loadMetadataContext({
  id: activeProjectId,
  pointer: "/identification/title",
  endpoint: (id) => `editor/json_field/${id}`,
  params: ({ pointer }) => ({ path: pointer, exclude_private_fields: "1" }),
  unwrap: (data, { id, pointer }) => {
    if (data.status !== "success" || !data.found) throw new Error(`Field ${pointer} was not found`);
    return { id, path: pointer, value: data.value };
  },
  apiBase: "/index.php/api/",
});
const draft = await suggestMetadata(ai, { source: "Metadata Editor", snapshot: field, modelId });
// `draft.task` is "pslm.suggest-field", the id a host manifest allowlists in `tasks`. `source` says
// whose metadata was read and is any short label — not a name the SDK has to recognise, and not
// what a host gates on.
if (draft.formatValid) showForHumanReview(draft.suggestion, draft.reason);
else showUnvalidatedDraft(draft.raw); // JSON-shape check is not factual validation.

// NADA: same-origin catalog record → local answer checked against title/abstract text.
// `source: "nada"` below is the legacy shape: it resolves to a shipped default in LEGACY_SOURCES,
// so calls written before the manifest keep working. Defaults, not permitted hosts.
const study = await loadMetadataContext({ source: "nada", id: activeStudyId });
const answer = await answerStudyQuestion(ai, study, question, { modelId });
showAnswerAndEvidence(answer); // `quoted` means quote occurs in source, not that interpretation is correct.
```

The host owns `showForHumanReview`, apply/save/publish decisions and any schema validation. Never
pass NADA publish API keys to these helpers. The npm package is not yet public; these imports
represent the intended package exports. Host must bundle all WASM and worker assets locally—no CDN
dependency at inference time.

```js
import wasm from "@wllama/wllama/esm/wasm/wllama.wasm?url";
import compatWasm from "@wllama/wllama-compat/wasm/wllama.wasm?url";
import compatWorker from "@wllama/wllama-compat/wasm/wllama.js?url";
import { createLocalSLM } from "portable-slm";
import { mountMetadataWidget } from "portable-slm/metadata-widget";

const ai = createLocalSLM({ assets: { wasm, compatWasm, compatWorker } });
mountMetadataWidget(document.querySelector("#local-ai"), ai, {
  source: "metadata-editor",       // or "nada"
  recordId: activeProjectId,
  path: "/identification/title",   // Editor JSON Pointer; ignored for NADA
  apiBase: "/index.php/api/",
});
```

For NADA use its active study ID and `source: "nada"`. Mount the widget on the same origin as the
host API. Host supplies IDs from its existing route/state; widget does not scrape page DOM.

## Local chat API and task boundary

The core exports a typed JavaScript API, not a REST server. Optional
`portable-slm/openai-compatible` exposes an OpenAI-shaped `chat.completions.create()` facade over
the same in-process runtime. It supports text messages, streaming chunks, basic sampling and JSON
response formats; it has no API key, HTTP listener or network path. It is not full OpenAI protocol
compatibility. Use `runAgent()` for caller-defined tools. Current model IDs remain pinned GGUF
entries; arbitrary model URLs are not trusted implicitly.

Do not force every model into chat completions. Vision, ASR and GLiNER-style classification need
task-specific input/output contracts and model assets. Add those as optional modules only when a
browser runtime and pinned artifacts are validated; keep them out of the text SDK's default bundle
until then. In particular, GLiNER returns labels/spans rather than generated prose.

## Offline behavior

- Host precaches the consumer, SDK, WASM and worker through its HTTPS service worker.
- User downloads a pinned model while online, or imports the verified GGUF from local Files/USB.
- Host fetches the authorized record while connected; offline mode can use a snapshot explicitly
  saved/exported by the host or pasted by the user. Current widget does not persist host records.
- Model inference stays local online and offline. API refresh, sync and optional network tools are
  separate actions. Do not silently fall back to cloud inference.
- Browser model storage is per origin and device. NADA and Metadata Editor origins need separate
  setup; each consumer must show app-shell and model readiness independently.
- Local inference does not make server-backed NADA or Metadata Editor usable offline. Host needs
  offline data access and save/sync behavior for a complete offline editing workflow.

## Host acceptance checks

Run [`portable-slm/host-check.html`](HOST_CONTRACT.md#7-acceptance-page) from the host origin while
signed in as a curator — `…/portable-slm/host-check.html?manifest=/portable-slm.host.json&sid=<record>`
— and paste the report into the integration ticket. It automates the mechanical part of the list
below and prints the rest as a checklist. The list stays the definition of "accepted"; the page only
removes the manual labour of re-deriving it per host.

1. Use a non-sensitive approved test record; confirm only selected bounded fields reach the model.
2. Verify existing host login/access applies; no token or credential enters prompt or logs.
3. Check result structure and schema locally; render as text; show source/evidence and proposed diff.
4. Confirm no write occurs until host's normal human approval path.
5. After setup, disable network and verify app shell, model, saved context and local inference. Test
   recovery after app restart and missing/evicted model.
6. Repeat per host origin and target device. Passing public NADA demo or fixtures does not certify a
   private instance or offline host application.
