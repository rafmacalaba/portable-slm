import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { beforeEach, test } from "node:test";
import { CHUNK, downloadModel, importModel, modelBlob, modelStatus, removeModel } from "../src/store.js";

// Minimal in-memory Cache API (keys are URL strings).
function fakeCaches() {
  const stores = new Map();
  return {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        match: async (k) => (m.has(k) ? new Response(m.get(k)) : undefined),
        put: async (k, res) => void m.set(k, new Uint8Array(await res.arrayBuffer())),
        delete: async (k) => m.delete(k),
        _keys: () => [...m.keys()],
      };
    },
  };
}

// Model = GGUF magic + random bytes spanning 2.5 chunks.
const data = new Uint8Array(Math.floor(CHUNK * 2.5));
data.set(randomBytes(data.length));
data.set(new TextEncoder().encode("GGUF"), 0);
const spec = {
  url: "https://models.example/m.gguf",
  file: "m.gguf",
  bytes: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
};

// Range-serving fetch; `failures` = number of initial requests to fail.
function fakeFetch({ failures = 0, body = data } = {}) {
  const calls = [];
  const fn = async (url, { headers }) => {
    calls.push(headers.Range);
    if (failures-- > 0) throw new TypeError("Failed to fetch");
    const [, a, b] = headers.Range.match(/bytes=(\d+)-(\d+)/);
    return new Response(body.slice(+a, +b + 1), { status: 206 });
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  globalThis.caches = fakeCaches();
});

test("download stores, verifies and returns the exact bytes", async () => {
  assert.equal(await modelStatus(spec), "missing");
  const progress = [];
  await downloadModel(spec, { fetch: fakeFetch(), onProgress: (p) => progress.push(p.phase) });
  assert.equal(await modelStatus(spec), "installed");
  const blob = await modelBlob(spec);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
  assert.ok(progress.includes("download") && progress.includes("verify"));
});

test("HTTP 200 on a range request is streamed as the whole model, not stored as one chunk", async () => {
  const fallback = [];
  const ranges = [];
  const fetch = async (_, { headers }) => {
    ranges.push(headers.Range);
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset === data.length) return controller.close();
        const end = Math.min(data.length, offset + 1024 * 1024);
        controller.enqueue(data.subarray(offset, end));
        offset = end;
      },
    }), { status: 200 });
  };
  await downloadModel(spec, { fetch, onFallback: (event) => fallback.push(event) });
  assert.deepEqual(ranges, [`bytes=0-${CHUNK - 1}`]);
  assert.deepEqual(fallback, [{ chunk: 1, total: 3 }]);
  assert.equal(await modelStatus(spec), "installed");
  assert.deepEqual(new Uint8Array(await (await modelBlob(spec)).arrayBuffer()), data);
});

test("interrupted full-file stream keeps complete chunks and retries safely", async () => {
  let calls = 0;
  const retries = [];
  const fetch = async (_, { headers }) => {
    calls++;
    if (calls === 2) assert.equal(headers.Range, `bytes=${CHUNK}-${2 * CHUNK - 1}`);
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (calls === 1 && offset >= CHUNK) return controller.error(new Error("connection lost"));
        if (offset === data.length) return controller.close();
        const end = Math.min(data.length, offset + 1024 * 1024);
        controller.enqueue(data.subarray(offset, end));
        offset = end;
      },
    }), { status: 200 });
  };
  await downloadModel(spec, { fetch, retryDelayMs: 1, onRetry: (event) => retries.push(event) });
  assert.equal(calls, 2);
  assert.match(retries[0].reason, /connection lost/);
  assert.equal(await modelStatus(spec), "installed");
});

test("tries a non-HF mirror, then the pinned source; still verifies SHA-256", async () => {
  const seen = [];
  const original = fakeFetch();
  await downloadModel(spec, {
    sources: ["https://mirror.example/model.gguf", spec.url],
    fetch: (url, opts) => { seen.push(url); return url.includes("mirror.example") ? Promise.reject(new Error("mirror down")) : original(url, opts); },
  });
  assert.equal(await modelStatus(spec), "installed");
  assert.deepEqual(seen.slice(0, 2), ["https://mirror.example/model.gguf", spec.url]);
});

test("rejects unsafe model sources", async () => {
  await assert.rejects(downloadModel(spec, { sources: ["http://remote.example/model.gguf"] }), /HTTPS/);
});

test("a failed request reports the retry and its chunk", async () => {
  const fetch = fakeFetch({ failures: 1 });
  const retries = [];
  await downloadModel(spec, { fetch, retryDelayMs: 1, onRetry: (r) => retries.push(r) });
  assert.equal(await modelStatus(spec), "installed");
  assert.equal(fetch.calls.length, 4); // 3 chunks + 1 retry
  assert.deepEqual(retries, [{ chunk: 1, total: 3, attempt: 1, maxAttempts: 6, reason: "Failed to fetch" }]);
});

test("an interrupted download resumes without refetching stored chunks", async () => {
  const flaky = fakeFetch({ failures: 99 });
  const first = fakeFetch();
  let n = 0;
  const once = (url, opts) => (n++ === 0 ? first(url, opts) : flaky(url, opts));
  await assert.rejects(downloadModel(spec, { fetch: once, retryDelayMs: 1 }), /Chunk 2\/3 \(bytes .*\) failed after 6 attempts: Failed to fetch/);
  assert.equal(await modelStatus(spec), "partial");
  const resume = fakeFetch();
  await downloadModel(spec, { fetch: resume });
  assert.equal(resume.calls.length, 2); // only the 2 missing chunks
  assert.equal(await modelStatus(spec), "installed");
});

test("corrupted content fails the sha256 check and is removed", async () => {
  const bad = data.slice();
  bad[CHUNK + 5] ^= 0xff;
  await assert.rejects(downloadModel(spec, { fetch: fakeFetch({ body: bad }) }), /integrity/);
  assert.equal(await modelStatus(spec), "missing");
});

test("import matches the registry by size, checks GGUF magic and sha256", async () => {
  const models = { m: spec };
  const id = await importModel(new File([data], "copy-from-usb.gguf"), models);
  assert.equal(id, "m");
  assert.equal(await modelStatus(spec), "installed");
  await assert.rejects(importModel(new File([data.slice(1)], "x.gguf"), models), /not a known model/);
  const notGguf = data.slice();
  notGguf[0] = 0;
  await assert.rejects(importModel(new File([notGguf], "x.gguf"), models), /not a GGUF/);
});

test("quota failure is actionable, keeps existing models and partial resumable chunks", async () => {
  const previous = { ...spec, bytes: 4, file: "old.gguf", sha256: createHash("sha256").update("GGUF").digest("hex") };
  await importModel(new File(["GGUF"], "old.gguf"), { old: previous });
  const backing = globalThis.caches;
  globalThis.caches = { open: async (name) => {
    const cache = await backing.open(name);
    return { ...cache, put: (key, res) => key.endsWith("chunk-1")
      ? Promise.reject(new DOMException("Quota exceeded", "QuotaExceededError")) : cache.put(key, res) };
  } };
  await assert.rejects(downloadModel(spec, { fetch: fakeFetch() }), /storage quota exceeded.*Existing models were kept/);
  assert.equal(await modelStatus(previous), "installed");
  assert.equal(await modelStatus(spec), "partial");
  await assert.rejects(importModel(new File([data], spec.file), { model: spec }), /storage quota exceeded/);
});

test("HTTP 200 stream stops on quota instead of retrying network six times", async () => {
  const backing = globalThis.caches;
  globalThis.caches = { open: async (name) => {
    const cache = await backing.open(name);
    return { ...cache, put: (key, res) => key.endsWith("chunk-1")
      ? Promise.reject(new DOMException("Quota exceeded", "QuotaExceededError")) : cache.put(key, res) };
  } };
  let calls = 0;
  const fetch = async () => {
    calls++;
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === data.length) return controller.close();
      const end = Math.min(data.length, offset + 1024 * 1024);
      controller.enqueue(data.subarray(offset, end)); offset = end;
    } }), { status: 200 });
  };
  await assert.rejects(downloadModel(spec, { fetch, retryDelayMs: 1 }), /storage quota exceeded/);
  assert.equal(calls, 1);
  assert.equal(await modelStatus(spec), "partial");
});

test("remove deletes every stored piece", async () => {
  await downloadModel(spec, { fetch: fakeFetch() });
  await removeModel(spec);
  assert.equal(await modelStatus(spec), "missing");
  assert.equal((await caches.open("portable-slm-models"))._keys().length, 0);
});
