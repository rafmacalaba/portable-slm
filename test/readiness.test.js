import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOfflineReadiness } from "../src/readiness.js";

test("uses an active service worker before it controls the first page", async () => {
  const worker = { postMessage(_message, ports) { ports[0].postMessage({ ready: true, missing: [] }); } };
  const serviceWorker = { controller: null, getRegistration: async () => ({ active: worker }) };
  const result = await checkOfflineReadiness({ status: async () => ({ state: "installed" }) }, "m", serviceWorker);
  assert.equal(result.ready, true);
});

test("requires BOTH cached app shell and verified model", async () => {
  const worker = { controller: { postMessage(_message, ports) { ports[0].postMessage({ ready: true, missing: [] }); } } };
  assert.equal((await checkOfflineReadiness({ status: async () => ({ state: "installed" }) }, "m", worker)).ready, true);
  assert.equal((await checkOfflineReadiness({ status: async () => ({ state: "partial" }) }, "m", worker)).ready, false);
  const noWorker = await checkOfflineReadiness({ status: async () => ({ state: "installed" }) }, "m", {});
  assert.equal(noWorker.ready, false);
  assert.match(noWorker.app.missing[0], /service worker/);
});
