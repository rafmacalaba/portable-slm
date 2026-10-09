// The edits applied to pinned upstream files, and the invariants of the embedding catalogue entry.
//
// These are the parts that fail silently in production: a transform that stops applying just makes the
// install bigger, and a catalogue entry that stops declaring a file makes it unloadable. Both are
// cheaper to assert here than to discover in a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRANSFORMS, applyTransform } from "../src/transforms.js";
import { DEFAULTS, MODELS } from "../src/models.js";

const UPSTREAM = JSON.stringify({
  model_type: "embedding_gemma2",
  text_config: { hidden_size: 512, embedding_dim: 768 },
  vision_config: { hidden_size: 768, patch_size: 16 },
  audio_config: { hidden_size: 1024 },
  architectures: ["EmbeddingGemma2Model"],
  transformers_version: "5.18.0.dev0",
  image_token_id: 258880,
  audio_token_id: 258881,
});

test("text-only removes the modality blocks and nothing else", () => {
  const out = JSON.parse(TRANSFORMS["text-only"](UPSTREAM));
  assert.equal(out.vision_config, undefined, "vision_config makes transformers.js open a vision session");
  assert.equal(out.audio_config, undefined, "audio_config makes transformers.js open an audio session");
  assert.equal(out.model_type, "embedding_gemma2");
  assert.deepEqual(out.text_config, { hidden_size: 512, embedding_dim: 768 });
  assert.deepEqual(out.architectures, ["EmbeddingGemma2Model"]);
  assert.equal(out.image_token_id, 258880, "the token ids stay: the model compares them and it is the count, not the value, that must match");
});

test("text-only is idempotent and deterministic", () => {
  const once = TRANSFORMS["text-only"](UPSTREAM);
  assert.equal(TRANSFORMS["text-only"](once), once);
  assert.equal(TRANSFORMS["text-only"](UPSTREAM), once);
});

test("applyTransform leaves a file alone unless the catalogue names a transform", async () => {
  const blob = new Blob([UPSTREAM]);
  const untouched = await applyTransform(blob, { path: "config.json" }, {});
  assert.equal(await untouched.text(), UPSTREAM);
  const other = await applyTransform(blob, { path: "tokenizer.json" }, { transforms: { "config.json": "text-only" } });
  assert.equal(await other.text(), UPSTREAM, "a transform for one path must not touch another");
});

test("applyTransform applies a named transform and refuses an unknown one", async () => {
  const applied = await applyTransform(new Blob([UPSTREAM]), { path: "config.json" }, { transforms: { "config.json": "text-only" } });
  assert.equal(JSON.parse(await applied.text()).vision_config, undefined);
  await assert.rejects(
    () => applyTransform(new Blob([UPSTREAM]), { path: "config.json" }, { transforms: { "config.json": "does-not-exist" } }),
    /Unknown transform/,
  );
});

test("the pinned embedder is text-only by construction, not by convention", () => {
  const spec = MODELS[DEFAULTS.embedder];
  assert.ok(spec, "the default embedder must exist in the catalogue");
  assert.equal(spec.kind, "embedding");
  assert.equal(spec.output, "sentence_embedding");
  assert.equal(spec.transforms?.["config.json"], "text-only", "without this, a text-only install fetches the modality encoders");
  const paths = spec.files.map((file) => file.path);
  for (const encoder of ["vision_encoder", "audio_encoder"]) {
    assert.ok(!paths.some((path) => path.includes(encoder)), `${encoder} must not be installed`);
  }
  assert.ok(paths.includes("onnx/model_q4f16.onnx"), "the text graph must be pinned");
  assert.ok(paths.includes("onnx/model_q4f16.onnx_data"), "the text weights must be pinned");
});

test("every pinned file carries a real sha256 and a size", () => {
  for (const [id, spec] of Object.entries(MODELS)) {
    for (const file of spec.files || []) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${id} ${file.path} needs a sha256`);
      assert.ok(file.bytes > 0, `${id} ${file.path} needs a size`);
      assert.ok(file.url.startsWith("https://huggingface.co/"), `${id} ${file.path} must resolve from the pinned revision`);
      assert.ok(file.url.includes(spec.revision), `${id} ${file.path} must pin the immutable revision`);
    }
  }
});

test("the embedder advertises the dimensions retrieval can truncate to", () => {
  const spec = MODELS[DEFAULTS.embedder];
  assert.equal(spec.dims, 768);
  assert.ok(spec.mrl.includes(DEFAULTS.retrieval.dims), "the default dims must be a supported Matryoshka step");
  assert.ok(DEFAULTS.retrieval.dims < spec.dims, "the default should truncate, not store the full width");
});
