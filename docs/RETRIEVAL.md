# Retrieval: indexing a corpus so questions can be answered from it

The assistant answers from a bounded document by default. That works until the corpus outgrows the byte
cap, and then the cap, not the question, decides what the model sees. Retrieval is how a host with more
content than fits keeps answering correctly: BM25 and embeddings over the host's own corpus, ranked per
question, trimmed to the same cap.

**Both scorers, always.** BM25 needs no model, works offline on the first visit, and is strong on the
things metadata corpora are full of: identifiers, field names, acronyms, exact phrases. Embeddings are
strong on paraphrase, where the user's words match none of the document's. Each is weak exactly where the
other is strong, so the default is the mix (`alpha: 0.5`) rather than a choice between them.

## Two ways to get an index

| | when | cost |
|---|---|---|
| **Prebuilt** | the host commits a vectors file next to its manifest | nothing on a first visit, and retrieval quality is testable in CI before shipping |
| **In the browser** | the host ships no index file | the first visit downloads the embedder (~181 MB) and embeds the corpus; later visits reuse the cached index |

A host may do both: ship a prebuilt index, and let the browser build one when the artifact is missing or
does not match the current corpus. The browser path checks the prebuilt file first.

## Declaring a corpus

```json
{
  "apiVersion": "pslm-host/1",
  "app": { "name": "Example App", "version": "1.0.0" },
  "context": {
    "app": { "url": "app.md", "maxBytes": 8192, "kind": "content" },
    "documents": [
      { "url": "handbook.md", "label": "Handbook" },
      "/glossary.md",
      "/api/reference.txt"
    ],
    "credentials": "same-origin"
  },
  "retrieval": {
    "index": "/pslm.index.json",
    "corpusVersion": "2026-10-09",
    "dims": 256,
    "alpha": 0.5,
    "topK": 6,
    "maxBytes": 8192
  },
  "writeBack": false
}
```

- **`context.documents`** is a list of same-origin paths or URLs. Each is fetched once, chunked and
  indexed. `context.app` is indexed too, as the first document, so nothing declared for the old path is
  lost. Relative paths resolve against the manifest, not the page, so the pack can be served under any
  subpath.
- **`retrieval.corpusVersion`** is the host's own statement that the content changed. Bump it whenever it
  does; it is part of the cache key. Without it, an unchanged corpus produces an unchanged index.
- **`retrieval.dims`** is a Matryoshka truncation of the embedder's 768 (`768`, `512`, `256`, `128`).
  Lower is smaller and faster to compare; 256 is the default and quarters the index size. It is part of
  the cache key, so changing it rebuilds rather than mixing vector spaces.
- **`retrieval.alpha`** is the embedding weight. `0` is BM25 alone, `1` is embeddings alone.
- Everything here is optional. No `documents` means no retrieval, and a bare mount stays cheap.

## The embedder

`embeddinggemma-2-text-q4f16` is pinned in `src/models.js`: **the text encoder only**, ~181 MB, 768
dimensions, 8K context, Apache-2.0, from `onnx-community/embeddinggemma-2-ONNX`.

EmbeddingGemma 2 also ships a vision encoder and an audio encoder. They are not in the catalogue, and
they are not merely unused: the pinned fetch layer throws on any file the catalogue does not name, so an
undeclared encoder cannot be downloaded even by accident. Text-only means text-only.

Two details matter more than they look:

- **Instruction prefixes.** The model is trained with them. A query is
  `task: search result | query: {question}`; a document is `title: {heading} | text: {chunk}`. Omit them
  and nothing errors, the vectors are just worse. They are in `EMBEDDING_PREFIXES` in `src/models.js`.
- **Pooling is mean, and vectors are L2-normalized**, so a dot product is the cosine.

## Building a prebuilt index

The index is a plain JSON artifact (`format: "pslm-index/1"`), so a host can commit it and review a diff
of it. Build it with the same code the browser uses, so the two cannot disagree:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { chunkText, serializeIndex, buildIndex, tokenize } from "portable-slm/retrieval";

const files = ["handbook.md", "glossary.md"];
const chunks = files.flatMap((path) => chunkText(readFileSync(path, "utf8"), { path }));

// Embed `chunks` with the pinned embedder, in your own build step, with the prefixes above.
// Then truncate every vector to `dims` (Matryoshka: take the first `dims` values and re-normalize).
const vectors = await embedAll(chunks, { dims: 256 });

writeFileSync("public/pslm.index.json", serializeIndex(buildIndex({
  chunks,
  vectors,
  dims: 256,
  embedderId: "embeddinggemma-2-text-q4f16",
  corpusVersion: "2026-10-09",
})));
```

## Rules that keep retrieval honest

Retrieval decides what reaches the model, so these are not style preferences:

1. **The cache key is the corpus identity**: corpus version, embedder id, dimensions, chunker version.
   Change any one and the index is rebuilt. A 768-dim index answering a 256-dim query, or an index for a
   corpus that has moved on, returns confident nonsense with no error anywhere.
2. **A prebuilt artifact that does not match this build is refused, not partially used.**
   `deserializeIndex` returns `null` rather than a half-index.
3. **The byte cap is applied before the prompt, and what was dropped is reported.** A silent cut makes
   "the corpus does not cover this" indistinguishable from "it covered this and did not fit".
4. **Nothing is fetched from another origin, and nothing is written anywhere.** Retrieval reads the same
   same-origin documents the panel is already allowed to read.
5. **BM25 is the floor, not a fallback.** If the embedder is absent, uninstalled or refused, retrieval
   still answers from the corpus rather than failing.
6. **The question is what gets embedded.** `onContext(question)` receives it, which is why the seam
   exists; a provider that ignores the argument answers from the whole corpus instead.

## Checking it

```js
import { chunkText, buildIndex, rankChunks, selectUnderCap } from "portable-slm/retrieval";

const chunks = chunkText(readFileSync("handbook.md", "utf8"));
const index = buildIndex({ chunks });
const ranked = rankChunks(index, "how long is the embargo", { k: 3 });
const { text, omitted, truncated } = selectUnderCap(ranked, { maxBytes: 8192 });
```

A retrieval change is accepted the way any other is: `npm test`, then the acceptance page on a real
origin, then read *What was sent to the model* and check that the chunk a human would pick is in the
top few. The unit tests cover chunking, tokenizing, BM25 weighting, the hybrid weight, the cap and the
serialization round trip; they cannot tell you whether your corpus ranks well, which is why the last step
matters.

## What is and is not built today

**Built and tested:** the chunker, BM25, the hybrid ranker, the cap, the index format and its cache key
(`src/retrieval.js`); the embedder runtime (`src/embedder.js`); the text-only transform that keeps the
install to the text encoder (`src/transforms.js`, with the reason in the code); the pinned catalogue entry;
and the manifest validation for `context.documents` and `retrieval`, so a typo or a cross-origin path fails
the mount. 24 tests across `test/retrieval.test.js` and `test/transforms.test.js`.

**Verified by running it, not by reading it.** The pinned file set was installed and the model was loaded
with only those files present, in Node, against the real weights:

```
loaded with ONLY the 6 pinned files, in 0.5 s
sentence_embedding dims: [4, 768], float32, norm 1.000000 (already normalized)
cosine query -> "embargo is released after twelve months"   (paraphrase)   0.8718
cosine query -> "stored as house_hold_id"                   (identifier)   0.6291
cosine query -> "write to the data team"                    (unrelated)    0.6514
same paraphrase at 256 dims (Matryoshka)                                   0.8958
```

Two things worth reading off that. Truncating to 256 dimensions *improved* the paraphrase match, which is
Matryoshka doing what it claims. And the identifier scored **below** the unrelated sentence: embeddings
alone would rank a question about `house_hold_id` wrong, which is the measured case for BM25 being in the
default mix rather than replaced by it.

**Not yet wired:** the corpus fetcher, the index cache keyed by `indexKey`, and the default `onContext` in
`integrations/embed.js` that ties them to a question. Until that lands, a host can use `retrieval.js` and
`embedder.js` directly at rung 4, and `docs/STATUS.md` records the gap rather than implying otherwise.
