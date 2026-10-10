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
| **Two embedder tiers** | `src/embedder.js`: the default tier is ternlight, bundled in the package, so it installs nothing and was measured at 1.49 ms per embedding in Node and again through the browser runtime. The quality tier is EmbeddingGemma 2 text, pinned at a revision with per-file SHA-256 and confirmed to load with only its six pinned files present. `src/transforms.js` holds the `text-only` edit that keeps that export from fetching 93 MB of vision and 162 MB of audio weights |
| **Freezing, and freshness** | `npm run index -- <dir> --out <file>` writes a prebuilt artifact; `corpusHash` puts a hash of the indexed documents into the index key, sorted so order and path spelling cannot change it, which makes a stale artifact or cache entry impossible rather than unlikely. Measured on a 1.9 MB documentation corpus: 4,264 chunks, 96 s to embed, 10.6 MB artifact, and a reader then fetches vectors instead. 218 tests |
| **Retrieval as the default** | `integrations/retrieval-context.js` wires the corpus fetcher, the index cache and the provider into `<pslm-chat>`; manifest validation refuses a typo or a cross-origin path at mount. Verified in real Chrome by `npm run e2e:retrieval`: 27 checks over three manifests (a prebuilt artifact, none, and keyword-only), with the real bundled embedder and nothing faked. It observes the network, so `embedder: "none"` is proved to fetch no embedder runtime at all, and the paraphrase and off-corpus checks run against the real model |
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

## Retrieval: the gate that was honoured

The project's rule was embeddings only after keyword scoring measurably failed, and the measurement is what
this shipped on. [`CONTEXT_PROVIDERS.md`](CONTEXT_PROVIDERS.md) records the ladder and what the numbers
decided; [`RETRIEVAL.md`](RETRIEVAL.md) is the host's guide.

Two things remain open, both named rather than implied:

- **A per-record corpus cannot be requested.** `context.documents` does not expand `{id}` while `record`,
  `field` and declared tools do, so "the guidance for the template this record uses" has no route. It is a few
  lines reusing the existing `expand()`.
- **No test ingests a real documentation set.** The suite covers the artifact's acceptance, its refusal when
  the corpus changes, and document order, all against small fixtures. Every number at documentation scale was
  measured by hand, which is why it is written down in `RETRIEVAL.md` rather than trusted to a checkmark.
