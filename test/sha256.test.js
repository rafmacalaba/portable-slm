import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { createSha256 } from "../src/sha256.js";

const hex = (...parts) => {
  const h = createSha256();
  for (const p of parts) h.update(p);
  return h.hex();
};

test("known vectors", () => {
  assert.equal(hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("matches node:crypto for random data split at random points", () => {
  const data = randomBytes(1_000_003);
  const cuts = [0, 1, 63, 64, 65, 4097, 500_000, data.length].sort((a, b) => a - b);
  const parts = cuts.slice(1).map((c, i) => data.subarray(cuts[i], c));
  assert.equal(hex(...parts), createHash("sha256").update(data).digest("hex"));
});
