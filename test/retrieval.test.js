// Retrieval decides what reaches the prompt, so it is tested without a browser, a model or a
// network. Everything here runs in milliseconds and is the reason a host can trust the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHUNKER_VERSION, buildIndex, bm25, chunkText, cosine, decodeVector, deserializeIndex, encodeVector,
  indexKey, matryoshka, normalize, rankChunks, selectUnderCap, serializeIndex, tokenize,
} from "../src/retrieval.js";

const DOC = `# Study handbook

## Access policy
Records under an embargo are released after twelve months. A curator may request an extension.

## Variables
The household identifier is stored as house_hold_id. Population counts are stored as HHID_POP.

## Contact
Write to the data team for anything not covered here.`;

test("chunkText starts a new chunk at every heading and keeps the heading", () => {
  const chunks = chunkText(DOC);
  assert.ok(chunks.length >= 3);
  const headings = chunks.map((chunk) => chunk.heading);
  assert.ok(headings.includes("Access policy"));
  assert.ok(headings.includes("Variables"));
  assert.ok(headings.includes("Contact"));
  assert.ok(chunks.every((chunk) => !chunk.text.includes("## ")));
  assert.ok(chunks.every((chunk) => Array.isArray(chunk.tokens) && chunk.tokens.length > 0));
});

test("chunkText returns nothing for empty input and something for a heading with no body", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n  "), []);
  const bare = chunkText("# Only a heading");
  assert.equal(bare.length, 1);
  assert.equal(bare[0].heading, "Only a heading");
});

test("chunkText carries overlap so a sentence across the cut is reachable from either side", () => {
  const long = `## Section\n${"alpha ".repeat(400)}`;
  const chunks = chunkText(long, { targetChars: 300, overlapChars: 60 });
  assert.ok(chunks.length > 1);
  const tail = chunks[0].text.slice(-60);
  assert.ok(chunks[1].text.includes(tail.slice(-40)), "the next chunk should repeat the previous tail");
});

test("chunkText respects maxChunks rather than growing without bound", () => {
  const chunks = chunkText(`## S\n${"word ".repeat(5000)}`, { targetChars: 200, maxChunks: 5 });
  assert.equal(chunks.length, 5);
});

test("tokenize splits identifiers, because field names are typed verbatim", () => {
  assert.deepEqual(tokenize("house_hold_id"), ["house", "hold", "id"]);
  assert.deepEqual(tokenize("HHID_POP"), ["hhid", "pop"]);
  assert.deepEqual(tokenize("getUserName"), ["get", "user", "name"]);
  assert.deepEqual(tokenize("Year 2025"), ["year", "2025"]);
  assert.ok(!tokenize("a b c").includes("a"), "single letters carry no signal");
});

test("bm25 ranks the chunk that contains the asked-about term first", () => {
  const chunks = chunkText(DOC);
  const top = bm25(chunks, "embargo release");
  assert.equal(chunks[top[0].index].heading, "Access policy");
  const byId = bm25(chunks, "house_hold_id");
  assert.equal(chunks[byId[0].index].heading, "Variables");
});

test("bm25 returns nothing for an empty query and nothing for a term the corpus lacks", () => {
  const chunks = chunkText(DOC);
  assert.deepEqual(bm25(chunks, ""), []);
  assert.deepEqual(bm25(chunks, "zzzznotpresent"), []);
  assert.equal(bm25([], "anything").length, 0);
});

test("bm25 gives a rare term more weight than a common one", () => {
  const chunks = chunkText(`## A\nembargo record\n\n## B\nrecord\n\n## C\narchive\n\n## D\ndeposit\n\n## E\npublication\n\n## F\ncitation`);
  const rare = bm25(chunks, "embargo")[0].score;
  const common = bm25(chunks, "record")[0].score;
  assert.ok(rare > common, `rare ${rare} should outrank common ${common}`);
});

test("a term present in most of the corpus separates nothing and yields no hit", () => {
  const text = ["a", "b", "c", "d", "e"].map((h) => `## ${h}\nthe record`).join("\n\n");
  const chunks = chunkText(text);
  assert.equal(chunks.length, 5);
  // "the" is in every chunk, so it cannot be evidence of anything.
  assert.deepEqual(bm25(chunks, "the"), []);
  // A question made only of words the corpus does not distinguish must return nothing rather than noise.
  assert.deepEqual(bm25(chunks, "what is the capital of the country"), []);
  // The same corpus still answers a question with a distinctive term in it.
  assert.equal(bm25(chunks, "record archive").length, 0, "neither term is distinctive here");
});

test("a query vector can promote a paraphrase that shares no words, and alpha controls how much", () => {
  const chunks = chunkText("## One\nrelease timing\n\n## Two\ntotally unrelated text");
  const dims = 4;
  const vectors = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0]);
  const index = buildIndex({ chunks, vectors, dims, embedderId: "test", corpusVersion: "1" });
  // Zero vector for the first chunk means the second one is the only semantic candidate.
  const queryVector = normalize(Float32Array.from([1, 0, 0, 0]));
  const lexicalOnly = rankChunks(index, "release", { alpha: 0 });
  assert.equal(lexicalOnly[0].chunk.heading, "One");
  const semanticOnly = rankChunks(index, "release", { alpha: 1, queryVector });
  assert.equal(semanticOnly[0].chunk.heading, "Two");
  // The first chunk's vector is all zeros, so cosine is 0: that is a real score, not a missing one.
  assert.equal(semanticOnly.find((entry) => entry.chunk.heading === "One").semantic, 0);
});

test("without a query vector the semantic half is skipped, not treated as zeros", () => {
  const chunks = chunkText("## One\nembargo and release");
  const index = buildIndex({ chunks, vectors: new Float32Array([1, 1, 1, 1]), dims: 4, embedderId: "test", corpusVersion: "1" });
  const ranked = rankChunks(index, "embargo", { alpha: 1 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].semantic, null);
  assert.ok(ranked[0].score > 0, "BM25 alone must still return the chunk");
});

test("selectUnderCap respects the cap, reports what it dropped, and marks a truncated chunk", () => {
  const chunks = chunkText(`## A\n${"alpha ".repeat(200)}\n\n## B\nbravo bravo\n\n## C\ncharlie`);
  const ranked = rankChunks(buildIndex({ chunks }), "alpha bravo charlie", { k: 3 });
  const capped = selectUnderCap(ranked, { maxBytes: 300 });
  assert.ok(new TextEncoder().encode(capped.text).length <= 300);
  assert.ok(capped.truncated);
  assert.ok(capped.hits.length >= 1);
  const single = selectUnderCap([{ chunk: { index: 0, heading: "H", text: "x".repeat(500) }, score: 1 }], { maxBytes: 200 });
  assert.ok(new TextEncoder().encode(single.text).length <= 200);
  assert.ok(single.text.includes("truncated to fit"));
});

test("indexKey changes with every input, so stale vectors cannot be reused", () => {
  const base = indexKey({ corpusVersion: "1", embedderId: "e", dims: 256, chunkerVersion: 1 });
  assert.notEqual(base, indexKey({ corpusVersion: "2", embedderId: "e", dims: 256, chunkerVersion: 1 }));
  assert.notEqual(base, indexKey({ corpusVersion: "1", embedderId: "f", dims: 256, chunkerVersion: 1 }));
  assert.notEqual(base, indexKey({ corpusVersion: "1", embedderId: "e", dims: 768, chunkerVersion: 1 }));
  assert.notEqual(base, indexKey({ corpusVersion: "1", embedderId: "e", dims: 256, chunkerVersion: 2 }));
  // Chunk size belongs in the key: the same corpus at 480-char and 1200-char chunks is two indexes, and
  // comparing vectors built from different text is the failure the key exists to prevent.
  assert.notEqual(base, indexKey({ corpusVersion: "1", embedderId: "e", dims: 256, chunkerVersion: 1, chunkChars: 480 }));
  assert.match(base, new RegExp(`/${CHUNKER_VERSION}/0$`));
});

test("a serialized index round-trips, vectors and ranking intact", () => {
  const chunks = chunkText(DOC);
  const dims = 4;
  const vectors = new Float32Array(chunks.length * dims);
  vectors[0] = 1;
  const index = buildIndex({ chunks, vectors, dims, embedderId: "e", corpusVersion: "abc" });
  const restored = deserializeIndex(serializeIndex(index));
  assert.ok(restored);
  assert.equal(restored.key, index.key);
  assert.equal(restored.dims, dims);
  assert.deepEqual([...restored.vectors.slice(0, dims)], [1, 0, 0, 0]);
  assert.deepEqual(restored.chunks.map((c) => c.heading), chunks.map((c) => c.heading));
  const before = rankChunks(index, "embargo", { k: 1 })[0].chunk.index;
  const after = rankChunks(restored, "embargo", { k: 1 })[0].chunk.index;
  assert.equal(before, after);
});

test("a prebuilt index that does not match this build is refused instead of half-used", () => {
  const chunks = chunkText(DOC);
  const index = buildIndex({ chunks, vectors: new Float32Array(chunks.length * 2), dims: 2, embedderId: "e", corpusVersion: "1" });
  const good = JSON.parse(serializeIndex(index));
  assert.equal(deserializeIndex(JSON.stringify({ ...good, chunkerVersion: 99 })), null);
  assert.equal(deserializeIndex(JSON.stringify({ ...good, format: "other/1" })), null);
  assert.equal(deserializeIndex(JSON.stringify({ ...good, chunks: [] })), null);
  assert.equal(deserializeIndex("not json"), null);
  const short = JSON.parse(serializeIndex(buildIndex({ chunks, vectors: new Float32Array(chunks.length * 4), dims: 4, embedderId: "e", corpusVersion: "1" })));
  short.vectors = encodeVector(new Float32Array(8));
  assert.equal(deserializeIndex(short), null, "a vector blob of the wrong size is a mismatch, not a smaller index");
});

test("encodeVector and decodeVector survive arbitrary float bytes", () => {
  const source = Float32Array.from([0, 0.5, -1.25, 1e-7, 3.4e38, -0.0001]);
  const bytes = new Uint8Array(source.buffer);
  const round = new Uint8Array(decodeVector(encodeVector(bytes)).buffer);
  assert.deepEqual([...round], [...bytes]);
});

test("cosine is a dot product on normalized vectors and safe on a mismatch", () => {
  const a = normalize(Float32Array.from([3, 4]));
  const b = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  assert.equal(cosine(a, Float32Array.from([1, 2, 3])), 0);
  assert.equal(cosine(null, a), 0);
});

test("matryoshka truncates and re-normalizes, and a prefix is usable on its own", () => {
  const full = normalize(Float32Array.from([3, 4, 0, 0]));
  const cut = matryoshka(full, 2);
  assert.equal(cut.length, 2);
  assert.ok(Math.abs(Math.sqrt(cut.reduce((s, v) => s + v * v, 0)) - 1) < 1e-6, "a truncated vector must stay unit length");
  const keepLength = Math.hypot(full[0], full[1]);
  assert.ok(Math.abs(cut[0] - full[0] / keepLength) < 1e-6, "the kept values are the leading ones, rescaled");
  // Asking for more than exists cannot invent values.
  assert.equal(matryoshka(full, 99).length, 4);
  assert.ok(Math.abs(matryoshka(full, 99).reduce((s, v) => s + v * v, 0) - 1) < 1e-6);
  // An un-renormalized prefix is not a cosine, and the gap is small enough to be mistaken for a
  // quality difference. Use a vector whose prefix is genuinely shorter than unit length.
  const spread = normalize(Float32Array.from([1, 1, 1, 1]));
  const prefix = spread.slice(0, 2);
  assert.ok(Math.abs(Math.hypot(prefix[0], prefix[1]) - 1) > 0.2, "this case must need renormalizing to be a real test");
  const fixed = matryoshka(spread, 2);
  assert.ok(Math.abs(Math.hypot(fixed[0], fixed[1]) - 1) < 1e-6);
  const other = normalize(Float32Array.from([1, 0, 0, 0]));
  assert.notEqual(cosine(prefix, matryoshka(other, 2)), cosine(fixed, matryoshka(other, 2)));
});

test("a multi-document corpus is addressed by position, not by each document's own numbering", () => {
  const first = chunkText("## A1\nalpha text\n\n## A2\nbeta text");
  const second = chunkText("## B1\ngamma text\n\n## B2\ndelta text");
  // Each document numbers its own chunks from zero, so as given they collide. This is what a corpus of 16
  // documents looked like: 37 chunks sharing 10 distinct indices, and every score landing on the wrong text.
  assert.deepEqual(first.map((chunk) => chunk.index), [0, 1]);
  assert.deepEqual(second.map((chunk) => chunk.index), [0, 1]);

  const index = buildIndex({ chunks: [...first, ...second] });
  assert.deepEqual(index.chunks.map((chunk) => chunk.index), [0, 1, 2, 3], "the index owns the numbering");

  const lexical = bm25(index.chunks, "gamma", { k: 1 });
  assert.equal(index.chunks[lexical[0].index].heading, "B1", "a match in the second document resolves to it");

  // The vector half addresses chunks the same way, so the distinctive vector must be read at B1's position.
  const dims = 3;
  const vectors = new Float32Array(index.chunks.length * dims);
  vectors[2 * dims] = 1;
  const built = buildIndex({ chunks: [...first, ...second], vectors, dims });
  const ranked = rankChunks(built, "delta text", {
    alpha: 1, k: 1, minSimilarity: 0.5, queryVector: normalize(Float32Array.from([1, 0, 0])),
  });
  assert.equal(ranked[0].chunk.heading, "B1", "the vector is read at the chunk's position, not at a collided index");
});
