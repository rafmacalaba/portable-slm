# Implementation status and release gates

## Product focus

Portable SLM is a **local AI capability service embedded by software developers**—a browser
SDK/PWA for NADA, Metadata Editor and other development-data tools, not a standalone chatbot, cloud
LLM API, native-only app or local server. The same browser runtime must work on laptop, iOS Safari
and Android Chrome. Host apps supply authorized context and workflow; the harness supplies on-device
inference, offline readiness and bounded tools. Host retains schema validation, review, save and
publish authority. Local inference stays default both online and offline; network access is an
explicit consumer choice for data refresh/sync or approved tools. App shell and model must be
prepared in each browser origin/device before offline use.

Priority lifecycle: Metadata Editor curators create/import, document and validate records; the
Editor can publish to NADA through its existing authorized flow; NADA catalogs and disseminates
records under its own access policies. Portable SLM assists at authoring/review and discovery—it does
not replace either system or hold their publishing credentials.

## Recommended execution order

1. **Make harness setup and recovery dependable.** Stabilize HTTPS/PWA shell caching, model
   download/import/resume, first-launch readiness, storage errors, offline reopen and recovery after
   browser eviction. Preserve one simple SDK contract for consumers. Decide code/open-source license
   and package distribution before advertising a third-party release; model licenses remain separate.
2. **Integrate priority consumers through host-approved hooks.** First NADA, then Metadata Editor:
   mount the consumer within the host origin or use an approved API/export. Read only the active,
   bounded record; validate suggestions; show evidence and diffs; require human approval. A PWA or
   extension-free companion cannot read another tab. Server-backed hosts need their own offline
   support; otherwise operate on an imported/saved snapshot. No extension is a dependency.
3. **Prove the integrated browser consumers across devices.** Run the install/offline/restart/
   recovery checklist in [`DEVICE_VALIDATION.md`](DEVICE_VALIDATION.md) on laptop, iPhone/iPad
   Safari and Android Chrome. Platform checks are part of integration acceptance, not a later native
   port. Record browser/OS/device, model, engine, storage, task completion and crash/reload. User
   reports 230M/350M stable on iPhone; Android is untested. Optimize speed only when a reliability
   or task-completion blocker is measured.
4. **Prove one adjacent development-data task using same harness.** Start with data-quality triage:
   deterministic rules flag missing/range/consistency issues; local model explains flags and suggests
   checks. Then consider questionnaire design, geospatial metadata, sampling guidance and interview
   support as separate task packs, with domain owners and validation. Statistics/GIS calculations
   remain in trusted code, not model guesses.
5. **Expand from evidence.** Evaluate task accuracy, unsupported claims, schema failures, human
   acceptance, offline completion, setup burden and resource use. Add or tune models only when these
   results show a real blocker. Do not claim field readiness before representative field testing.

The near-term work is **steps 1–2**: harden the browser SDK/PWA setup, then prove the NADA/Metadata
Editor consumer contract. Step 2 needs an approved host integration point for live API testing;
sanitized fixtures remain usable meanwhile. Run browser/device checks as each integration lands.
Extension access and a separate local server are not dependencies.

## Implemented and verified in this repository

1. **Local subsystem:** `src/index.js`, `src/store.js`, `src/models.js`—pinned GGUF catalog,
   resumable chunks from HF or an alternate HTTPS mirror, USB/Files import, SHA-256, wllama
   WebGPU/CPU with iPhone CPU default.
2. **Offline readiness:** `src/readiness.js` asks the service worker to verify every precached app
   file and checks the selected model independently. UI does not equate `navigator.onLine` with
   offline capability. Browsers can still evict stored files later.
3. **Tool loop:** `src/agent.js`, `src/tools.js`—native LFM tool calls, validation, timeout, bounded
   results; offline date/calculator and online Wikipedia with exact-query approval.
4. **Four same-origin web consumers:** chat `/`, grounded NADA Q&A `/nada.html`, metadata review
   `/review.html`, general benchmark `/benchmark.html`. Public study snapshot supports offline
   questions; benchmark resumes per case, exports JSON and compares 230M/350M.
5. **Third-party integration contract:** `integrations/metadata-context.js` reads one authorized
   Metadata Editor field or NADA study. `suggestMetadata()` and `answerStudyQuestion()` expose typed,
   read-only task calls; the mountable widget demonstrates a consumer. Unit/E2E use fixtures and
   public NADA; no change to either upstream application was made.
6. **Desktop Chrome consumer:** MV3 side panel in `integrations/chrome-extension/`, same subsystem.
   E2E verifies local GGUF import, offline tool after restart; manual online Wikipedia consent
   also passed in Chrome for Testing.

`npm test` is the focused unit run. `npm run e2e` verifies web mirror → import → offline readiness
→ API fixtures → chat/tools/review/benchmark after server and DNS stop. `npm run e2e:extension`
uses an unpacked desktop extension in an **approved developer environment**; it must not be
used to bypass managed Chrome policy.

## Current blockers and validation status

- **Harness hardening (step 1):** model chunks are resumable and SHA-verified; app shell and model
  readiness are separate. Readiness queries an active service worker before it controls the first
  page. E2E now checks cached-shell status before page reload; still verify browser-specific
  install/recovery and storage-eviction behavior.
- **NADA / Metadata Editor integration (step 2):** browser SDK now has host-callable typed task
  contracts: `answerStudyQuestion()` returns evidence status for a bounded NADA study snapshot;
  `suggestMetadata()` returns a format-checked draft for a bounded NADA/Editor snapshot. The
  public NADA demo fetch and offline reopen pass; some 350M answers are flagged unverified. A live
  Metadata Editor instance and native host-app contribution remain untested. APIs must stay within
  host permissions; no extension workaround.
- **Device matrix (step 3):** laptop Chrome offline E2E passes. User reports iPhone Safari stable
  with 230M/350M; 1.2B crashes and is not in the catalog. Android Chrome has not been tested.
  Capture per-device setup, offline reopen, reload/recovery and task outcomes before expanding.
- **Adjacent development-data task (step 4):** data-quality triage is proposed, not implemented.
  Geospatial metadata, questionnaire design, sampling guidance and interviewer support are future
  task packs, not current capabilities.
- **Distribution:** public source is live at https://github.com/rafmacalaba/portable-slm under MIT.
  npm package preparation passes dry-run; publication is blocked until npm CLI authentication is
  configured. Review each model license separately; package does not bundle weights. Browser model
  storage does not migrate between origins.
- **Model-catalog expansion:** each added model needs a pinned file, verified checksum, license and
  device qualification. User-supplied URLs currently work only for pinned models.

## Constraints

- Browser storage is per origin **and top-level partition**. HF's cross-origin iframe may not
  share its model cache with a direct static-app tab. Inside the HF embed, review/benchmark mount
  in-page and share the chat SDK instance. Extension and other site origins need separate imports.
- Desktop Chrome extensions are not a mobile implementation. iOS Safari and Android Chrome use
  web consumers. Server-backed NADA/Editor pages do not become offline merely because inference
  is local; use exported snapshots when those servers are unavailable.
- Online tools can send **approved queries**; model inference remains local in both modes.
