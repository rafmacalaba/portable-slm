// The wiring, tested with an injected fetch, storage and embedder. Everything here runs in Node, so the
// logic that decides what reaches the prompt is verified without a browser, a corpus or a download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpusIndex, corpusChunks, createRetrievalContext, fetchCorpus } from "../integrations/retrieval-context.js";
import { buildIndex, indexKey, serializeIndex } from "../src/retrieval.js";
import { HOST_API_VERSION } from "../integrations/host-contract.js";

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
  const dims = 4;
  const target = docs.findIndex((chunk) => chunk.heading === "Access policy");
  const vectors = new Float32Array(docs.length * dims);
  vectors[target * dims] = 1;
  const embedder = {
    status: async () => ({ state: "installed" }),
    load: async () => ({ dims: 768 }),
    get loaded() { return { dims: 768, device: "wasm" }; },
    embed: async (texts, { kind }) => {
      void texts;
      return (Array.isArray(texts) ? texts : [texts]).map(() => (kind === "query"
        ? Float32Array.from([1, 0, 0, 0])
        : Float32Array.from([0, 1, 0, 0])));
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
  const chunks = corpusChunks(await fetchCorpus(manifest(), BASE, { fetch: textFetch({ "/handbook.md": DOC }) }));
  const dims = 2;
  const fresh = buildIndex({ chunks, vectors: new Float32Array(chunks.length * dims), dims, embedderId: "e", corpusVersion: "0" });
  const files = { "/handbook.md": DOC, "/pslm.index.json": serializeIndex(fresh) };
  const provider = createRetrievalContext({
    manifest: manifest({ retrieval: { index: "/pslm.index.json", dims, corpusVersion: "0" } }),
    base: BASE, fetch: textFetch(files), storage: memStorage(),
  });
  const prebuiltReady = await provider.ready();
  assert.equal(provider.source, "prebuilt");
  assert.match(prebuiltReady.note, /prebuilt index, \d+ section/);

  // Same key, but the corpus has moved on: the artifact must not answer from stale text.
  const edited = `${DOC}\n\n## New section\nAdded after the index was built.`;
  const stale = createRetrievalContext({
    manifest: manifest({ retrieval: { index: "/pslm.index.json", dims, corpusVersion: "0" } }),
    base: BASE, fetch: textFetch({ "/handbook.md": edited, "/pslm.index.json": serializeIndex(fresh) }),
    storage: memStorage(),
  });
  const result = await stale.ready();
  assert.notEqual(stale.source, "prebuilt", "a stale artifact must not be used");
  assert.match(result.note, /keyword search only so far/);
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
