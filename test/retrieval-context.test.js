// The wiring, tested with an injected fetch, storage and embedder. Everything here runs in Node, so the
// logic that decides what reaches the prompt is verified without a browser, a corpus or a download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpusIndex, corpusChunks, createRetrievalContext, fetchCorpus } from "../integrations/retrieval-context.js";
import { buildIndex, corpusHash, indexKey, serializeIndex } from "../src/retrieval.js";
import { indexParams } from "../integrations/retrieval-context.js";
import { HOST_API_VERSION } from "../integrations/host-contract.js";
import { DEFAULTS } from "../src/models.js";

const BASE = "https://host.example/app/";
const DOC = `# Handbook

## Access policy
Records under an embargo are released after twelve months. A curator may request an extension.

## Variables
The household identifier is stored as house_hold_id. Population counts are stored as HHID_POP.

## Contact
Write to the data team for anything not covered here.`;

const manifest = (extra = {}) => ({
  apiVersion: HOST_API_VERSION,
  app: { name: "Example App", version: "1.0.0" },
  context: { app: { url: "app.md", kind: "content" }, documents: ["/handbook.md"], ...(extra.context || {}) },
  ...extra,
  writeBack: false,
});

const textFetch = (files) => async (url) => {
  const path = new URL(url).pathname;
  if (!(path in files)) return new Response("not found", { status: 404 });
  const body = files[path];
  return new Response(body, {
    status: 200,
    headers: { "content-type": path.endsWith(".json") ? "application/json" : "text/markdown" },
  });
};

const memStorage = () => {
  const map = new Map();
  return { get: async (key) => map.get(key) ?? null, put: async (key, text) => { map.set(key, text); }, map };
};

test("the corpus is fetched same-origin, text only, and reported per document", async () => {
  const corpus = await fetchCorpus(manifest(), BASE, { fetch: textFetch({ "/handbook.md": DOC }) });
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0].path, "/handbook.md");
  assert.match(corpus[0].text, /embargo are released/);
  assert.ok(corpusChunks(corpus).length >= 3, "the corpus should chunk into sections");
});

test("an HTML response is refused rather than indexed as corpus text", async () => {
  const request = async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(() => fetchCorpus(manifest(), BASE, { fetch: request }), /returned HTML/);
});

test("a document over the size limit is refused, with the size in the message", async () => {
  const big = "x".repeat(3 * 1024 * 1024);
  await assert.rejects(
    () => fetchCorpus(manifest(), BASE, { fetch: textFetch({ "/handbook.md": big }) }),
    /the limit is/,
    "a corpus is indexed, not pasted, so an oversized file is a mistake worth naming",
  );
});

test("a corpus that cannot be read degrades to no context, it does not fail the question", async () => {
  const provider = createRetrievalContext({
    manifest: manifest(), base: BASE,
    fetch: async () => new Response("nope", { status: 500 }),
    storage: memStorage(),
  });
  const out = await provider.onContext("how long is the embargo");
  assert.equal(out, "", "returning empty context is the degraded path; throwing would end the turn");
});

test("with no embedder the first answer comes from BM25 and says so", async () => {
  const provider = createRetrievalContext({
    manifest: manifest(), base: BASE,
    fetch: textFetch({ "/handbook.md": DOC }),
    storage: memStorage(),
  });
  const out = await provider.onContext("embargo release");
  assert.match(out, /Access policy/);
  assert.match(out, /keyword search only/, "the reader should know what is answering");
  assert.equal(provider.source, "bm25");
});

test("no declared corpus means no provider at all", () => {
  const bare = { apiVersion: HOST_API_VERSION, app: { name: "A", version: "1" }, context: { app: { url: "a.md" } }, writeBack: false };
  assert.equal(createRetrievalContext({ manifest: bare, base: BASE, fetch: textFetch({}), storage: memStorage() }), null);
});

test("a paraphrase finds the right section once embeddings are available", async () => {
  const docs = corpusChunks(await fetchCorpus(manifest(), BASE, { fetch: textFetch({ "/handbook.md": DOC }) }));
  // A fake embedder: the paraphrase vector is close to the section that shares no words with the question.
  // dims must be one the chosen model supports; the default has no Matryoshka steps, so it is 384.
  const dims = 384;
  const target = docs.findIndex((chunk) => chunk.heading === "Access policy");
  const vectors = new Float32Array(docs.length * dims);
  vectors[target * dims] = 1;
  const embedder = {
    status: async () => ({ state: "installed" }),
    load: async () => ({ dims: 768 }),
    get loaded() { return { dims: 768, device: "wasm" }; },
    embed: async (texts, { kind }) => {
      void texts;
      // Query and document must land on the same axis or every cosine is 0, which is what a self-inconsistent
    // fake looks like: a passing test with an empty context.
    return (Array.isArray(texts) ? texts : [texts]).map((text) => {
        const v = new Float32Array(dims);
        const matches = kind === "query" ? /how long until it is public/.test(text) : /embargo are released/.test(text);
        v[matches ? 0 : 1] = 1;
        return v;
      });
    },
  };
  const storage = memStorage();
  const provider = createRetrievalContext({
    manifest: manifest({ retrieval: { dims, corpusVersion: "v1" } }),
    base: BASE, fetch: textFetch({ "/handbook.md": DOC }), storage, embedder,
  });
  await provider.ready();
  const upgraded = await new Promise((resolve) => setTimeout(resolve, 10));
  void upgraded;
  assert.equal(provider.source, "embedded", "the background upgrade should have landed");
  assert.equal(storage.map.size, 1, "the built index should be cached for the next visit");
  const out = await provider.onContext("how long until it is public");
  assert.match(out, /embargo are released/, "the paraphrase must retrieve the section that shares no words");
  assert.doesNotMatch(out, /keyword search only/, "an upgraded provider should stop saying it is keyword-only");
});

test("a prebuilt index is used as-is, and a stale one is refused rather than answered from", async () => {
  // A builder must use the same derived parameters the runtime does, including the chunk size: 480-char and
  // 1200-char chunks of one corpus are different indexes, and the runtime refuses the one it did not build.
  const { dims, chunks: chunkChars, embedderId } = indexParams(DEFAULTS.embedder, {});
  const chunks = corpusChunks(await fetchCorpus(manifest(), BASE, { fetch: textFetch({ "/handbook.md": DOC }) }), { targetChars: chunkChars });
  // A builder must hash what it ingested, because the runtime hashes what it fetched. An artifact without the
  // hash is refused, which is the point: a promise about freshness is not a check.
  const contentHash = corpusHash([{ text: DOC }]);
  const fresh = buildIndex({ chunks, vectors: new Float32Array(chunks.length * dims), dims, embedderId, corpusVersion: "0", chunkChars, contentHash });
  const files = { "/handbook.md": DOC, "/pslm.index.json": serializeIndex(fresh) };
  const provider = createRetrievalContext({
    manifest: manifest({ retrieval: { index: "/pslm.index.json", dims, corpusVersion: "0" } }),
    base: BASE, fetch: textFetch(files), storage: memStorage(),
  });
  const prebuiltReady = await provider.ready();
  assert.equal(provider.source, "prebuilt");
  assert.match(prebuiltReady.note, /\d+ sections · prebuilt index/);

  // Same key, but the corpus has moved on: the artifact must not answer from stale text.
  const edited = `${DOC}\n\n## New section\nAdded after the index was built.`;
  const stale = createRetrievalContext({
    manifest: manifest({ retrieval: { index: "/pslm.index.json", dims, corpusVersion: "0" } }),
    base: BASE, fetch: textFetch({ "/handbook.md": edited, "/pslm.index.json": serializeIndex(fresh) }),
    storage: memStorage(),
  });
  const result = await stale.ready();
  assert.notEqual(stale.source, "prebuilt", "a stale artifact must not be used");
  assert.match(result.note, /keyword search only/);
});

test("the cache key changes with the corpus version, so an edit rebuilds", async () => {
  assert.notEqual(
    indexKey({ corpusVersion: "v1", embedderId: "e", dims: 256 }),
    indexKey({ corpusVersion: "v2", embedderId: "e", dims: 256 }),
  );
  const built = await buildCorpusIndex({
    manifest: manifest({ retrieval: { corpusVersion: "v1" } }), base: BASE,
    fetch: textFetch({ "/handbook.md": DOC }), storage: memStorage(),
  });
  assert.equal(built.source, "bm25");
  assert.ok(built.index.chunks.length >= 3);
});

test('embedder: "none" is a real choice, and the embedder is never used', async () => {
  let touched = 0;
  const embedder = {
    status: async () => { touched++; return { state: "installed" }; },
    load: async () => { touched++; return {}; },
    get loaded() { return { dims: 384, device: "wasm" }; },
    embed: async () => { touched++; return [new Float32Array(384)]; },
  };
  const quiet = manifest({ retrieval: { embedder: "none" } });
  const provider = createRetrievalContext({
    manifest: quiet, base: BASE, fetch: textFetch({ "/handbook.md": DOC }), storage: memStorage(), embedder,
  });
  const { note } = await provider.ready();
  assert.equal(provider.tier, null, "the provider reports that no tier is in use");
  assert.match(note, /keyword search only/);
  const out = await provider.onContext("house_hold_id");
  assert.match(out, /house_hold_id/, "keyword retrieval still works over the same corpus");
  assert.equal(touched, 0, "nothing should have asked the embedder for anything, not even its status");
});

test("alpha 0 skips the query embedding rather than computing something multiplied by nothing", async () => {
  let embedded = 0;
  const ready = { dims: 384 };
  const embedder = {
    status: async () => ({ state: "installed" }),
    load: async () => ready,
    get loaded() { return ready; },
    embed: async (texts) => { embedded++; return (Array.isArray(texts) ? texts : [texts]).map(() => new Float32Array(384).fill(0.1)); },
  };
  const chunks = corpusChunks(await fetchCorpus(manifest(), BASE, { fetch: textFetch({ "/handbook.md": DOC }) }));
  const built = buildIndex({ chunks, vectors: new Float32Array(chunks.length * 384), dims: 384, embedderId: "ternlight-base", corpusVersion: "0", chunkChars: 480 });
  const storage = { get: async () => serializeIndex(built), put: async () => {} };
  const provider = createRetrievalContext({
    manifest: manifest({ retrieval: { alpha: 0, corpusVersion: "0" } }),
    base: BASE, fetch: textFetch({ "/handbook.md": DOC }), storage, embedder,
  });
  await provider.ready();
  // The fake vectors are wrong for the query on purpose: with alpha 0 the result must not depend on them.
  const out = await provider.onContext("house_hold_id");
  assert.match(out, /house_hold_id/);
  const before = embedded;
  await provider.onContext("embargo release");
  assert.equal(embedded, before, "a question must not be embedded when the embedding weight is zero");
});

test("a frozen artifact is accepted whatever order the manifest lists its documents", async () => {
  // The bug this pins down: the artifact builder sorted its files, the manifest declared them in another order,
  // and the runtime compared chunk text position by position, so a provably identical corpus was refused and
  // the session silently fell back to keyword search. The content hash is order-independent; the comparison
  // that was not, is gone.
  const { dims, chunks: chunkChars, embedderId } = indexParams(DEFAULTS.embedder, {});
  const files = { "/first.md": "# First\n\nalpha content about identifiers", "/second.md": "# Second\n\nbravo content about embargoes" };
  // Built the way tools/build-index.mjs does it: sorted by path.
  const built = Object.entries(files).map(([url, text]) => ({ path: url, text })).sort((a, b) => a.path.localeCompare(b.path));
  const chunks = corpusChunks(built, { targetChars: chunkChars });
  const artifact = serializeIndex(buildIndex({
    chunks, vectors: new Float32Array(chunks.length * dims), dims, embedderId, corpusVersion: "0", chunkChars,
    contentHash: corpusHash(built),
  }));

  // The runtime fetches in the order the manifest declares, which here is the reverse.
  const declared = {
    apiVersion: HOST_API_VERSION, app: { name: "App", version: "1.0.0" },
    context: { app: { url: "/app.md" }, documents: [{ url: "/second.md" }, { url: "/first.md" }] },
    retrieval: { index: "/pslm.index.json" },
    writeBack: false,
  };
  const request = textFetch({ ...files, "/app.md": "# App\n\nan application", "/pslm.index.json": artifact });
  const provider = createRetrievalContext({ manifest: declared, base: BASE, fetch: request, storage: memStorage() });
  const ready = await provider.ready();
  assert.equal(provider.source, "prebuilt", `expected the artifact to be accepted, got ${provider.source}`);
  assert.match(ready.note, /prebuilt index/);
  assert.match(await provider.onContext("embargoes"), /bravo content/);
});

test("a declared artifact that cannot be used says so instead of failing silently", async () => {
  const warnings = [];
  const manifest = {
    apiVersion: HOST_API_VERSION, app: { name: "App", version: "1.0.0" },
    context: { app: { url: "/app.md" }, documents: [{ url: "/first.md" }] },
    retrieval: { index: "/pslm.index.json" },
    writeBack: false,
  };
  const request = textFetch({ "/first.md": "# First\n\nalpha", "/app.md": "# App" , "/pslm.index.json": "not an index" });
  const provider = createRetrievalContext({ manifest, base: BASE, fetch: request, storage: memStorage(), onStatus: (m, l) => warnings.push(`${l}: ${m}`) });
  await provider.ready();
  assert.notEqual(provider.source, "prebuilt");
  assert.ok(warnings.some((w) => /refused/.test(w)), `a refusal must be reported, got: ${warnings.join(" | ")}`);
});
