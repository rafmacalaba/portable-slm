# Status: what is verified, and what is not

Read this before trusting any other document. "Verified" below means it was run and observed, with the
observation named; everything else is either unverified or deliberately unbuilt.

## Verified

| area | evidence |
|---|---|
| **Model install and storage** | pinned revisions and per-file SHA-256 in `src/models.js`; resumable 16 MB chunks into OPFS with a Cache Storage fallback; multi-file ONNX verified as a set; import from a local file works with no network |
| **Inference** | ONNX through WebGPU with a WASM fallback, and GGUF through wllama; KV-cache prefix reuse with an exact-match guard; the same tasks answered by both engines |
| **Offline** | `src/readiness.js` checks the app shell and the model separately, because `navigator.onLine` proves neither. `npm run e2e` stops the mirror, imports a model, blocks DNS and still answers, with `chat`, `/catalogue-qa.html`, `/field-suggest.html` and `/benchmark.html` sharing one cached model |
| **The tool loop** | argument validation against the declared schema, the same-origin guard, the record-id spoof guard, byte caps, timeouts, and approval per call: unit-tested, and `host-check.html` calls every declared tool on a live origin |
| **The host contract** | `validateManifest()` and `mountMode()` tested as pure functions; a manifest with a typo or a missing context source fails the mount rather than the conversation |
| **Answer quality signals** | grounding (answer tokens absent from the supplied context) and completeness (empty, plan-shaped, truncated, narrating) are decided in code and shown per answer; both have tests built from real observed failures |
| **Retrieval, the ranker half** | `src/retrieval.js`: a heading-aware chunker, BM25, a hybrid rank over the same chunks, a byte cap that reports what it dropped, and an index format with a cache key that changes with the corpus, embedder, dimensions or chunker |
| **The embedder** | `src/embedder.js` and `src/transforms.js`: EmbeddingGemma 2's text encoder, pinned at a revision with per-file SHA-256, loaded with only the six pinned files present and confirmed to return normalized 768-dim vectors. The `text-only` transform is what makes the text-only claim true: without it the export's config makes transformers.js fetch 93 MB of vision and 162 MB of audio weights |
| **Retrieval as the default** | `integrations/retrieval-context.js` wires the corpus fetcher, the index cache and the provider into `<pslm-chat>`; manifest validation refuses a typo or a cross-origin path at mount. Verified end to end in real Chrome by `npm run e2e:retrieval`: 15 checks over a prebuilt-index manifest and a BM25-only one, including that a paraphrase sharing no words reaches the right section |
| **The app** | chat and model manager at `/`, evidence-checked Q&A at `/catalogue-qa.html`, field suggestion at `/field-suggest.html`, twelve authored benchmark cases at `/benchmark.html`, and the acceptance page at `/host-check.html` |
| **Desktop Chrome extension** | MV3 side panel in `integrations/chrome-extension/`: imports a local GGUF, calls an offline tool, restarts offline and calls it again |
| **Devices** | a laptop and an iPhone, on the smaller tiers. `DEVICE_VALIDATION.md` records the matrix |

## Not verified

- **A private, authenticated deployment.** The worked host integrations were exercised against a local
  deployment and against API fixtures. A host's own access rules should be re-checked on the host's origin,
  which is what the acceptance page is for.
- **Android Chrome**, and any phone benchmark numbers.
- **The largest tier on a phone.** It can exhaust the tab; the app falls back to a smaller model and CPU on
  iOS, but that path is not a measurement.
- **Anything architectural about a second host's backend.** A host that reaches an LLM through its own
  service is a supported shape with no code in this repository to point at.

## Deliberately not built

- **Reranking, query expansion and incremental indexing.** Top-k is ranked once and offered; a corpus edit
  triggers a full rebuild, which is cached but not incremental. [RETRIEVAL.md](RETRIEVAL.md) lists these.
- **Any write path.** There is none, structurally: a draft reaches a form only when a person clicks.
- **A published npm package.** A host vendors the built bundle; [`GETTING_STARTED.md`](GETTING_STARTED.md) is
  the path.
- **Bundled model weights.** They are hundreds of megabytes to a gigabyte and carry their own licences.

## The one gated follow-up: retrieval

[`CONTEXT_PROVIDERS.md`](CONTEXT_PROVIDERS.md) defines the context ladder: rung 0 the SDK's own description,
1 `context.app`, 2 `context.record`, 3 narrow declared reads, 4 a ranked read inside `onContext(question)`,
5 SDK-provided retrieval. Rungs 0 to 4 exist and need no further SDK surface; rung 4 is the documented
extension point and already receives the question.

Rung 5 is deliberately not started, and the trigger is written down: keyword ranking misses answers that a
human finds by paraphrase, on a meaningful share of a golden set, **and** the miss is recall rather than the
byte cap. Only then does the shape get decided — a pinned embedder with SHA-256 in `src/models.js`, a
feature-extraction runtime path beside the text one, a vector cache keyed by corpus version, and a decision
about where search runs. No embedder is chosen today.
