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
- **`retrieval.embedder`** picks the tier, or refuses one: `"auto"` (the default tier), a catalogue id such as
  `"embeddinggemma-2-text-q4f16"`, or `"none"` for keyword search over the same corpus with **no embedder
  runtime fetched at all**. `"none"` is a real choice rather than a degraded state, and `alpha: 0` reaches the
  same saving by a different route: either way the question is never embedded, because computing a vector to
  multiply by zero is a download spent on nothing.
- Everything here is optional. No `documents` means no retrieval, and a bare mount stays cheap.

## The embedder: two tiers, and the corpus decides

| | **ternlight** (default) | **EmbeddingGemma 2 text** (quality) |
|---|---|---|
| install | **nothing.** The model ships inside the package | ~181 MB, downloaded once, pinned by revision and per-file SHA-256 |
| speed | **1.49 ms** per embedding, measured over 200 runs | 44 s for 249 chunks on CPU, which is why it wants a prebuilt index |
| dimensions | 384, no Matryoshka training | 768, MRL to 512 / 256 / 128 |
| input | 128 tokens, so chunks are 480 characters | 8K tokens, so chunks are 1200 characters |
| instruction prefixes | none, it is a symmetric encoder | required: a query and a document take different ones, and omitting them does not error, it just returns worse vectors |
| similarity floor | 0.18 | 0.62 |
| licence | MIT | Apache-2.0 |

Both floors and both chunk sizes are **measured values, not preferences**. On 8 in-corpus and 6 out-of-corpus
questions the best in-corpus match scored 0.26 to 0.65 for ternlight and 0.66 to 0.85 for EmbeddingGemma, while
the best out-of-corpus match scored 0.00 to 0.12 and 0.53 to 0.60. The two scales are not comparable, so a
shared constant would be wrong for at least one of them. A *margin* signal was tried first and rejected: one
ternlight in-corpus question had a margin of 0.098, below an out-of-corpus margin of 0.118, so it does not
separate cleanly. The floors reduce false positives; they are not a guarantee, and the grounding stamp remains
the check that an answer came from the supplied context.

`retrieval.minSimilarity` in the manifest overrides the catalogue's floor, because a host that has measured
its own questions knows better than a default.

### Which tier to choose

This is a decision about the corpus and the audience, not about the SDK's preference.

| | ternlight | EmbeddingGemma 2 |
|---|---|---|
| a public site, casual visitors, short sessions | **yes.** Nothing to download, and the browser indexes the corpus in milliseconds | no: 181 MB for a visitor who will ask one question |
| an internal tool with returning users and a large documentation corpus | workable | **yes**, if answers matter more than a one-time download |
| a corpus of identifiers, field names, codes | **yes**, and it is not a compromise: measured, it ranked `house_hold_id` correctly where the larger model put it below an unrelated sentence, because it shares the WordPiece tokenizer's view of that identifier | check your own corpus |
| many languages | English-leaning, distilled from MiniLM | 100+ languages |

Practical starting rule: **compare chunk count against the cost before choosing.** At 480 characters a corpus of
200 KB is roughly 400 chunks, which ternlight indexes in under a second in the browser. The same corpus at 1200
characters is roughly 160 chunks and takes EmbeddingGemma about 28 seconds, so it needs a prebuilt artifact
rather than a browser build. Past roughly 500 chunks, index in the build, whatever the tier.

## Instruction prefixes and chunk sizes are not a host's business

Both are decided by the embedder and read from the catalogue, which is why `indexParams()` exists. A build
script must use it, or the artifact's key will not match what the runtime computes and the artifact will be
refused with no error beyond a fallback to keywords.

## Building a prebuilt index

The index is plain JSON (`format: "pslm-index/1"`), so a host can commit it and review a diff of it. Use the
runtime's own helpers, so the artifact cannot disagree with the reader:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { embed } from "@ternlight/base";
import { chunkText, buildIndex, serializeIndex } from "portable-slm/retrieval";
import { indexParams } from "portable-slm/retrieval-context";

// The runtime derives the chunk size, the width and the floor from the embedder. Ask for the same values.
const { dims, chunks: chunkChars, embedderId } = indexParams("ternlight-base", {});
const chunks = files.flatMap((path) => chunkText(readFileSync(path, "utf8"), { path, targetChars: chunkChars }));
const vectors = new Float32Array(chunks.length * dims);
chunks.forEach((chunk, i) => vectors.set(embed(chunk.text), i * dims));

writeFileSync("public/pslm.index.json", serializeIndex(buildIndex({
  chunks, vectors, dims, embedderId, chunkChars, corpusVersion: "2026-10-09",
})));
```

An artifact is refused, not half-used, when its key differs from the runtime's. That covers a changed corpus
version, a different embedder, a different width and a different chunk size, and it covers a corpus that has
been edited since the artifact was built: the chunk text must match too.

**A prebuilt artifact removes the corpus embedding cost, not the query cost.** The index is instant, and the
question is still embedded at query time, so the embedder loads on the first question. With ternlight that is
milliseconds and nothing to download. With EmbeddingGemma it is the 181 MB install, so an artifact does not
make the large tier cheap for a first-time visitor.

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

## What is built

Retrieval is the default when a host declares a corpus. `context.documents` and `retrieval` are validated at
mount, and `integrations/retrieval-context.js` provides the context: the corpus is fetched once, chunked,
indexed, and every question is answered from the few sections that match it.

| piece | where |
|---|---|
| chunking, BM25, the hybrid rank, the cap, the index format and its cache key | `src/retrieval.js` |
| the embedder runtime | `src/embedder.js` |
| the text-only transform that keeps the install to the text encoder | `src/transforms.js` |
| the corpus fetcher, the index cache, and the provider wired into `<pslm-chat>` | `integrations/retrieval-context.js` |
| the pinned EmbeddingGemma 2 text encoder | `src/models.js` |
| manifest validation for `context.documents` and `retrieval` | `integrations/host-contract.js` |

### How it behaves

- **BM25 answers the first question, with nothing downloaded.** The embedder joins when it is installed, in
  the background, and the index is cached so the next visit skips both steps. A first visit is never a 181 MB
  prerequisite for an answer keyword search could have given.
- **A prebuilt artifact removes the corpus embedding cost, not the query cost.** This is worth stating
  plainly because it is easy to assume otherwise: an artifact makes the *index* instant, but a question is
  embedded at query time, so semantic matching needs the embedder installed in the browser. With an artifact
  and no embedder you get fast BM25, not semantic search.
- **A question the corpus does not cover returns nothing** rather than loosely matched sections. That is BM25
  terms being required to be distinctive, plus function words being dropped. It matters because sections
  attached to an unrelated question invite the model to reason over them.
- **The panel discloses what is answering.** The status chip reads, for example, `source: retrieved from this
  application's own documents (prebuilt index, 9 section(s))`, so `application help text` is never claimed
  while the corpus is the actual source.

### How it was verified

`npm run e2e:retrieval` runs real Chrome against a real origin, with the fixture generated by the test so the
corpus, the manifests and the artifact cannot drift from the assertions: 15 checks over two manifests, one
declaring a prebuilt index and one not. It asserts that an identifier is retrieved and labelled, that the
context is a selection rather than the document, that an uncovered question yields nothing, and that a
paraphrase sharing no words reaches the right section when an embedder is present.

The embedder itself was verified against the real weights, by installing only the six pinned files and
loading the model with no others present:

```
loaded with ONLY the 6 pinned files, in 0.5 s
sentence_embedding dims: [4, 768], float32, norm 1.000000 (already normalized)
cosine query -> "embargo is released after twelve months"   (paraphrase)   0.8718
cosine query -> "stored as house_hold_id"                   (identifier)   0.6291
cosine query -> "write to the data team"                    (unrelated)    0.6514
the same paraphrase at 256 dims (Matryoshka)                               0.8958
```

Two things worth reading off that. Truncating to 256 dimensions *improved* the paraphrase match, which is
Matryoshka doing what it claims. And the identifier scored **below** the unrelated sentence: embeddings alone
rank a question about `house_hold_id` wrong, which is the measured case for BM25 being in the default mix
rather than replaced by it.

### Not built

- **Reranking, and anything beyond top-k.** Twelve sections are ranked and six are offered; nothing reorders
  them afterwards.
- **Multi-vector or late-interaction retrieval**, and query expansion.
- **Incremental indexing.** A corpus edit means a rebuild. The rebuild is keyed and cached, so it is one
  embedding pass rather than one per visit, but it is still a pass.
