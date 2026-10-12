import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS } from "../src/models.js";

test("registry pins per-model native context windows", () => {
  assert.equal(MODELS["lfm2.5-350m-onnx-q4f16"].ctx, undefined);
  assert.equal(MODELS["lfm2.5-1.2b-instruct-onnx-q4f16"].ctx, undefined);
  assert.equal(MODELS["lfm2.5-2.6b-onnx-q4f16"].ctx, 65536); // 128K wedged WebGPU; 64K is the current ceiling
});

test("ONNX registry pins each multi-file model to immutable Hub URLs and SHA-256", () => {
  for (const id of ["lfm2.5-350m-onnx-q4f16", "lfm2.5-1.2b-instruct-onnx-q4f16", "lfm2.5-2.6b-onnx-q4f16"]) {
    const model = MODELS[id];
    assert.equal(model.runtime, "transformers");
    assert.equal(model.format, "ONNX");
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.ok(model.files.length >= 6);
    for (const file of model.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(file.bytes > 0, true);
      assert.ok(file.url.includes(`/resolve/${model.revision}/${file.path}`));
    }
  }
  assert.equal(MODELS["lfm2.5-2.6b-onnx-q4f16"].files.filter((file) => file.path.startsWith("onnx/model_q4f16")).length, 3);
});

test("wllama GGUF models remain registered and unchanged for existing hosts", () => {
  assert.equal(MODELS["lfm2.5-350m-q4km"].format, "GGUF");
  assert.equal(MODELS["lfm2.5-350m-q4km"].runtime, undefined);
});

// The guarantee README states is about every downloadable byte, not just the ONNX exports, and one of
// the GGUF tiers is the default a bare mount installs. So the rule is written over the whole registry:
// if it is fetched, it is pinned and hashed. The one exemption is argued for below, in code.
test("every model a host could download is pinned to a revision and verified by SHA-256", () => {
  const downloadable = Object.entries(MODELS).filter(([, model]) => model.files?.length || model.url);
  for (const [id, model] of downloadable) {
    const urls = model.files?.length ? model.files.map((file) => file.url) : [model.url];
    const hashes = model.files?.length ? model.files.map((file) => file.sha256) : [model.sha256];
    for (const url of urls) {
      assert.match(url, /\/resolve\/[a-f0-9]{40}\//, `${id}: ${url} is not pinned to an immutable revision`);
    }
    for (const sha of hashes) {
      assert.match(sha, /^[a-f0-9]{64}$/, `${id}: a file carries no SHA-256 to verify against`);
    }
  }
  // Nothing was left out by accident: the only model not in the set is the embedder that ships inside
  // the package, so there is no download to pin and no revision to trust, and it says so by naming the
  // npm package its weights arrive in.
  const exempt = Object.keys(MODELS).filter((id) => !downloadable.some(([pid]) => pid === id));
  assert.deepEqual(exempt, ["ternlight-base"]);
  assert.equal(MODELS["ternlight-base"].package, "@ternlight/base");
});
