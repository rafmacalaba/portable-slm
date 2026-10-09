// The embedded runtime, tested for real: ternlight ships inside the package, so unlike the ONNX tier there
// is no download, no hash and no browser needed to exercise the actual model. 1.5 ms per embedding makes
// this affordable in the ordinary test run, which is the point of choosing it as the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbedder, embedDims } from "../src/embedder.js";
import { DEFAULTS, MODELS } from "../src/models.js";
import { cosine } from "../src/retrieval.js";

const DOCS = [
  "Records under an embargo become public twelve months after deposit. A curator may ask for an extension.",
  "The household identifier is stored as house_hold_id. Population counts are stored as HHID_POP.",
  "Deliverables are distributed as CSV and Stata files, with a codebook in PDF.",
];

test("the default embedder loads with nothing downloaded and returns unit vectors", async () => {
  const embedder = createEmbedder({});
  const status = await embedder.status();
  assert.equal(status.state, "installed", "a bundled runtime is always installed");
  assert.equal(status.bundled, true);
  assert.equal(status.bytes, 0);
  const loaded = await embedder.load();
  assert.equal(loaded.dims, MODELS[DEFAULTS.embedder].dims);

  const [vector] = await embedder.embed(["how long before I can read it"], { kind: "query" });
  assert.equal(vector.length, loaded.dims);
  assert.ok(Math.abs(Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) - 1) < 1e-6, "vectors must be unit length");
  await embedder.unload();
});

test("it retrieves a paraphrase and an identifier, which is why it is the default", async () => {
  const embedder = createEmbedder({});
  await embedder.load();
  const docs = await embedder.embed(DOCS);
  const ranked = async (question) => {
    const [q] = await embedder.embed([question], { kind: "query" });
    return docs.map((v, i) => ({ i, sim: cosine(q, v) })).sort((a, b) => b.sim - a.sim)[0].i;
  };
  assert.equal(await ranked("how long before I can read it"), 0, "a paraphrase that shares no words");
  assert.equal(await ranked("house_hold_id"), 1, "an identifier, which the larger model got wrong");
  await embedder.unload();
});

test("the floor separates an off-corpus question from an in-corpus one", async () => {
  const spec = MODELS[DEFAULTS.embedder];
  const embedder = createEmbedder({});
  await embedder.load();
  const docs = await embedder.embed(DOCS);
  const best = async (question) => {
    const [q] = await embedder.embed([question], { kind: "query" });
    return Math.max(...docs.map((v) => cosine(q, v)));
  };
  const inCorpus = await best("how long before I can read it");
  const offCorpus = await best("how do I bake sourdough bread");
  assert.ok(inCorpus > spec.minSimilarity, `in-corpus ${inCorpus.toFixed(3)} must clear the floor ${spec.minSimilarity}`);
  assert.ok(offCorpus < spec.minSimilarity, `off-corpus ${offCorpus.toFixed(3)} must not clear the floor ${spec.minSimilarity}`);
  await embedder.unload();
});

test("a request for dimensions the model cannot produce is refused rather than invented", () => {
  const spec = MODELS["ternlight-base"];
  assert.equal(spec.mrl.length, 1, "this encoder has no Matryoshka training");
  assert.equal(embedDims(spec, 256), spec.dims, "an unsupported width falls back to the model's own");
  assert.equal(embedDims(MODELS["embeddinggemma-2-text-q4f16"], 256), 256, "the quality tier supports the step");
});

test("a bundled runtime cannot be removed, because it is the dependency itself", async () => {
  const embedder = createEmbedder({});
  await assert.rejects(() => embedder.remove(), /cannot be removed/);
});

test("chunk size and floor come from the catalogue, not from a call site", async () => {
  const embedder = createEmbedder({});
  assert.equal(embedder.chunkChars(), MODELS["ternlight-base"].chunkChars);
  assert.equal(embedder.minSimilarity(), MODELS["ternlight-base"].minSimilarity);
  assert.equal(embedder.chunkChars("embeddinggemma-2-text-q4f16"), MODELS["embeddinggemma-2-text-q4f16"].chunkChars);
});
