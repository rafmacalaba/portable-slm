# Getting started: adopt the assistant in an application

This is the on-ramp. It is deliberately short and linear: three commands to something that works and has
been verified, then a table telling you which parts are yours. The depth lives in the documents linked at
the end — read this page first, then only the one you need.

Everything here is a **read-only** integration. The assistant reads a snapshot you choose and proposes
text; your application keeps validation, saving and publishing. There is no cloud inference, no API key,
no telemetry, and no path from the model to a write API.

## What a host gets, and what it must give

| the SDK provides | your application provides |
|---|---|
| model install (SHA-256 verified), storage, load/unload, WebGPU/WASM inference | which data the assistant may read, behind your own access control |
| prompt assembly, context budget, KV-cache reuse, streaming | the endpoints or documents that hold it |
| the chat panel: transcript, reasoning trace, provenance, tool approvals | where the panel sits and what it looks like |
| tool validation, consent, byte caps, the bounded agent loop | the tools themselves, if you declare any |
| "did the model finish?" (`completeness`), grounding verdict, debug logging | what to do when it says no |

## Three commands

```sh
# 1. Build the bundle (once, in a portable-slm checkout)
npm ci && npm run build:embed

# 2. Scaffold a correct starting point into your application
npm run scaffold -- --out ../my-app/public/portable-slm --shape static --name "My App"

# 3. Pack the bundle next to it
npm run pack:site -- --out ../my-app/public/portable-slm --runtimes onnx
```

`public/portable-slm/` now holds the SDK, and four files are yours to edit: `portable-slm.host.json`,
`app.md`, `host.html`, `STARTER.md`. `STARTER.md` is a checklist generated for your shape — work through
it. A starter is safe to re-run: it never overwrites a file you already have, and the pack only prunes
files it generated itself.

Then mount it. Two elements and a script tag, in your own layout:

```html
<div id="pslm-panel" class="pslm" data-pslm data-launcher="Ask this app" data-resize></div>
<p data-pslm-note role="status" hidden></p>
<script type="module" src="/portable-slm/embed.js"></script>
```

The manifest is read from next to `embed.js`, so no `data-manifest` is needed. `data-launcher` and
`data-resize` are opt-in: a bare `<div data-pslm>` mounts the panel with no launcher, which is the right
thing on a page you fully control.

## The shape you are

| Shape | `--shape` | Declares | What the user gets |
|---|---|---|---|
| No API: a docs site, a blog, a personal site | `static` | `context.app` — one bounded document | chat grounded in that document |
| One object with a form: a record editor, a CRM entry | `record` | `context.record`, `context.field`, one read tool | chat, a Suggest tab, and *Fill this field* |
| Many objects and files | build on `record` | add `context.datafile` (+ `pslm.suggest-datafile-description`) | as above, plus data-file drafts. Not scaffolded: see the Metadata Editor reference integration |

Those are the ladder's rungs 1–3. Rung 4 — a **ranked read of your own corpus inside `onContext(question)`** —
is what you climb to when the content outgrows `maxBytes`, and it needs no SDK change. The stopping rule,
the corpus shape and the three rules retrieval must not violate are in
[CONTEXT_PROVIDERS.md](CONTEXT_PROVIDERS.md).

`static` is not a cut-down version of the others — it is the honest shape for a host with no API. Satisfy
this one first; every later level is additive.

## What you own, precisely

Read this before writing anything. The seam is: **the SDK decides how a string becomes a prompt; you
decide what the string is.**

| Decision | Owner |
|---|---|
| instruction wording, sampling, answer cap, context window, history trim | SDK |
| which endpoint or document supplies context | **you** (the manifest) |
| what that endpoint hides | **you** (your access control, your `exclude_` parameters) |
| byte caps and how truncation is worded | **you** (the manifest) |
| which fields are readable, which tools the model may call | **you** (pointer allowlist, declared tools) |
| whether a draft may reach a form | **you** (`data-fill`, your own form binding) |
| append a write, save, publish | **you**, after a human approves. Always |

Concretely, a host writes: a manifest, a grounding document or endpoints, a mount, some CSS, and — if it
wants them — a fill binding and a log endpoint. Anything else you find yourself writing is probably a bug
in your reading of this page, or a gap worth reporting.

## Verify, do not trust

```sh
open https://your-app.example/portable-slm/host-check.html?manifest=/portable-slm/portable-slm.host.json
```

Add `&sid=<a test record>` for a `record` host, and `&log=<path>` if you built a log endpoint. Run it
signed in as a real user, and paste the report into your ticket. How to read it:

- **PASS** — a mechanical contract check succeeded (same-origin, byte cap, guard fired, endpoint answered).
- **WARN** — something you have not declared yet, or a limitation worth knowing (`no mirror declared`).
- **SKIP** — the check does not apply to what you declared. A skip is never a pass.
- **FAIL** — a contract violation. Fix it before shipping.

The page also prints what only a human can confirm: offline behaviour, a suggestion that no request leaves
your origin, and that a fill is unsaved until someone saves it.

## Traps that cost real time

- **Paths in the manifest resolve against the manifest, not the page.** `"url": "app.md"` works whether the
  pack is served at `/`, at `/portable-slm/`, or under a nested base. Absolute paths are still absolute:
  use them for your API routes.
- **Model weights are per browser origin, and never leave it.** Installed on `localhost:8080` is invisible
  to `localhost:4321`, and to production. Every origin pays once per browser. They cannot be imported from
  disk for ONNX models — a multi-file export is not a file you can hand the page.
- **No COOP/COEP headers means single-threaded WASM.** Most static hosts cannot send them. Slower, not
  broken; the panel says `single-thread`.
- **The bundle ships no `Cache-Control`.** Browsers cache it heuristically, so a deploy can serve a stale
  `embed.js`. Append a version query string; `version.json` and the panel's build stamp make staleness
  visible.
- **Bundle the runtime yourself.** `embed-assets/` must come from your origin. Inference never downloads
  code at run time, and a CDN in that path is a remote-code risk.
- **Do not commit model weights.** 250 MB to 1.5 GB per model. Visitors download from the pinned upstream
  URLs, hash-verified, and only when they click Install.

## Detect a stale or broken deployment

The panel shows the build stamp it is running (`build 0.1.0+<sha>`), and `/portable-slm/version.json`
carries the same. If a fix did not appear, compare them before debugging anything else. `host-check.html`'s
first check is that stamp.

## Where to go deeper

| Read | When |
|---|---|
| [HOST_CONTRACT.md](HOST_CONTRACT.md) | the manifest field by field, the task list, the acceptance definition |
| [CHAT.md](CHAT.md) | attributes, events, theming, the answers' provenance and completeness |
| [HOST_INTEGRATION.md](HOST_INTEGRATION.md) | the two worked integrations and the bundled-pilot deployment |
| [TOOLS.md](TOOLS.md) | authoring a tool, network policy, what the limits are |
| [CONTEXT_PROVIDERS.md](CONTEXT_PROVIDERS.md) | **where context comes from**: the five-rung ladder, when to stop climbing, and the ownership seam in detail |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how the pieces fit and why the boundaries are where they are |
| [ANSWER_QUALITY.md](ANSWER_QUALITY.md) | making answers good: corpus, retrieval, evaluation, and what makes them worse |
| [AGENT.md](AGENT.md) | agent modes, engine choice, model pins, MCP and search boundaries |
| [HARNESS.md](HARNESS.md) | the guards that live in code rather than in prompts |
| [DEVICE_VALIDATION.md](DEVICE_VALIDATION.md) | before you claim it works: laptop, iOS, Android |
