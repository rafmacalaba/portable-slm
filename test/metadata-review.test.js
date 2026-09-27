import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, reviewMessages } from "../examples/metadata-review.js";

test("NADA and Editor snapshots create bounded untrusted context", () => {
  assert.match(reviewMessages("nada", { idno: "X", title: "Example" })[1].content, /Source: nada/);
  assert.match(reviewMessages("metadata-editor", { identification: { title: "Example" } })[1].content, /metadata-editor/);
  assert.throws(() => reviewMessages("nada", { title: "x".repeat(6000) }), /too large/);
});

test("suggestions must be parseable and bounded", () => {
  assert.deepEqual(parseReview('{"suggestion":"Add survey year","reason":"Year missing"}'), { suggestion: "Add survey year", reason: "Year missing" });
  assert.throws(() => parseReview('{"suggestion":"Save directly"}'), /valid/);
});
