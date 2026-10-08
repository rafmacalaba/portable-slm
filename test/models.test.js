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
