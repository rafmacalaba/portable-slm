// Model store: keeps model files in the Cache API as 16 MB chunks.
// - Download: Range requests, each chunk retried; an interrupted download resumes.
// - Import: a user-picked file (from USB / SD card / Files) is copied in chunk by chunk.
// - Every model is sha256-verified before it is marked installed (files are parsed by native code).
// - Reading returns one Blob made of the chunk Blobs; wllama reads it in small slices, so the model
//   is never copied whole into memory. This layout is the one proven on iOS Safari (phone-test).
import { createSha256 } from "./sha256.js";

export const CHUNK = 16 * 2 ** 20;
const CACHE_NAME = "portable-slm-models";
const chunkCount = (spec) => Math.ceil(spec.bytes / CHUNK);
// Keys are synthetic same-origin URLs, content-addressed by sha256 (never fetched).
const base = (spec) => {
  // Cache API keys require HTTP(S) URLs, even in chrome-extension:// pages. Cache is still
  // origin-scoped, so this synthetic URL is never fetched and cannot expose stored weights.
  const origin = globalThis.location?.origin;
  return new URL(`/__models__/${spec.sha256}/`, origin?.startsWith("http") ? origin : "https://portable-slm.invalid").href;
};
const chunkKey = (spec, i) => `${base(spec)}chunk-${i}`;
const doneKey = (spec) => `${base(spec)}verified`;

const open = () => caches.open(CACHE_NAME);
const quotaExceeded = (err) => err?.name === "QuotaExceededError" || /quota exceeded/i.test(err?.message ?? "");
const quotaError = (err) => new Error(
  "Browser storage quota exceeded. Existing models were kept; incomplete new-model chunks may still use space. Select an unused model and Remove it, then Resume download (or Remove the partial model).",
  { cause: err },
);

/** @returns {Promise<"installed" | "partial" | "missing">} */
export async function modelStatus(spec) {
  const cache = await open();
  const hits = await Promise.all(Array.from({ length: chunkCount(spec) }, (_, i) => cache.match(chunkKey(spec, i))));
  const have = hits.filter(Boolean).length;
  if (have === hits.length && (await cache.match(doneKey(spec)))) return "installed";
  return have ? "partial" : "missing";
}

async function fetchChunk(spec, i, { fetch, sources, signal, retries = 5, retryDelayMs = 500, onRetry }) {
  const from = i * CHUNK;
  const to = Math.min(spec.bytes, from + CHUNK) - 1;
  for (let attempt = 1; ; attempt++) {
    let lastError;
    for (const url of sources) {
      try {
        const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
        if (res.status === 200) return res; // Some hosts ignore Range; stream the full response instead.
        if (res.status !== 206) throw new Error(`HTTP ${res.status}, expected 206 or 200`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== to - from + 1) throw new Error(`chunk ${i}: got ${buf.byteLength} bytes`);
        return buf;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
      }
    }
    const reason = lastError?.message ?? String(lastError);
    if (attempt > retries) throw new Error(`Chunk ${i + 1}/${chunkCount(spec)} (bytes ${from}-${to}) failed after ${attempt} attempts: ${reason}`, { cause: lastError });
    onRetry?.({ chunk: i + 1, total: chunkCount(spec), attempt, maxAttempts: retries + 1, reason });
    await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** attempt));
  }
}

// A 200 response is the whole file, not one chunk. Never call arrayBuffer() on it: Safari can
// kill the tab if the entire model is materialized in JS. Commit only complete chunks so a
// dropped connection can resume at the first missing chunk (or re-read if Range is still ignored).
async function storeFullResponse(spec, response, cache, onProgress, signal) {
  const length = response.headers.get("Content-Length");
  if (length && Number(length) !== spec.bytes) throw new Error(`Full response size ${length} does not match model size ${spec.bytes}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Browser cannot stream the full model response");
  let received = 0;
  let filled = 0;
  let chunk = new Uint8Array(Math.min(CHUNK, spec.bytes));
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.length > spec.bytes) throw new Error("Full response exceeds model size");
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(chunk.length - filled, value.length - offset);
        chunk.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        received += count;
        if (filled === chunk.length) {
          const i = Math.floor((received - 1) / CHUNK);
          if (!(await cache.match(chunkKey(spec, i)))) await cache.put(chunkKey(spec, i), new Response(chunk));
          onProgress?.({ phase: "download", done: i + 1, total: chunkCount(spec) });
          filled = 0;
          if (received < spec.bytes) chunk = new Uint8Array(Math.min(CHUNK, spec.bytes - received));
        }
      }
    }
    if (received !== spec.bytes) throw new Error(`Full response ended after ${received} of ${spec.bytes} bytes`);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

async function verifyAndSeal(spec, cache, onProgress) {
  const hash = createSha256();
  const n = chunkCount(spec);
  for (let i = 0; i < n; i++) {
    hash.update(new Uint8Array(await (await cache.match(chunkKey(spec, i))).arrayBuffer()));
    onProgress?.({ phase: "verify", done: i + 1, total: n });
  }
  if (hash.hex() !== spec.sha256) {
    await removeModel(spec);
    throw new Error("Model file failed its integrity check (sha256 mismatch) and was removed");
  }
  await cache.put(doneKey(spec), new Response(JSON.stringify({ sha256: spec.sha256, at: Date.now() })));
}

/** Download (or resume) a registry model. */
export async function downloadModel(spec, { sources = [spec.url], onProgress, onRetry, onFallback, signal, fetch = globalThis.fetch, retryDelayMs = 500 } = {}) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 3) throw new Error("Choose 1–3 model sources");
  for (const source of sources) {
    const u = new URL(source);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) {
      throw new Error("Model sources must use HTTPS (or localhost for development)");
    }
  }
  const cache = await open();
  const n = chunkCount(spec);
  let streamFailures = 0;
  for (let i = 0; i < n; i++) {
    if (!(await cache.match(chunkKey(spec, i)))) {
      signal?.throwIfAborted();
      const result = await fetchChunk(spec, i, { fetch, sources: [...sources.slice(streamFailures % sources.length), ...sources.slice(0, streamFailures % sources.length)], signal, retryDelayMs, onRetry });
      if (result instanceof Response) {
        onFallback?.({ chunk: i + 1, total: n });
        try {
          await storeFullResponse(spec, result, cache, onProgress, signal);
          break;
        } catch (err) {
          if (signal?.aborted) throw err;
          if (quotaExceeded(err)) throw quotaError(err); // storage pressure is not a network retry
          if (++streamFailures >= 6) throw new Error(`Full-file stream failed after ${streamFailures} attempts: ${err.message}`, { cause: err });
          onRetry?.({ chunk: i + 1, total: n, attempt: streamFailures, maxAttempts: 6, reason: err.message });
          await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** streamFailures));
          i = -1; // completed chunks are kept; retry from the first missing one
          continue;
        }
      }
      try { await cache.put(chunkKey(spec, i), new Response(result)); }
      catch (err) { throw quotaExceeded(err) ? quotaError(err) : err; }
    }
    onProgress?.({ phase: "download", done: i + 1, total: n });
  }
  try { await verifyAndSeal(spec, cache, onProgress); }
  catch (err) { throw quotaExceeded(err) ? quotaError(err) : err; }
}

/** Import a model file picked by the user. `models` = registry to match against. */
export async function importModel(file, models, { onProgress } = {}) {
  const matches = Object.entries(models).filter(([, m]) => m.bytes === file.size);
  if (!matches.length) throw new Error(`"${file.name}" is not a known model file (size ${file.size} bytes)`);
  const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  if (magic !== "GGUF") throw new Error(`"${file.name}" is not a GGUF model file`);
  const [id, spec] = matches.length === 1 ? matches[0] : (matches.find(([, m]) => m.file === file.name) ?? matches[0]);
  const cache = await open();
  const n = chunkCount(spec);
  for (let i = 0; i < n; i++) {
    const part = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
    try { await cache.put(chunkKey(spec, i), new Response(await part.arrayBuffer())); }
    catch (err) { throw quotaExceeded(err) ? quotaError(err) : err; }
    onProgress?.({ phase: "import", done: i + 1, total: n });
  }
  try { await verifyAndSeal(spec, cache, onProgress); }
  catch (err) { throw quotaExceeded(err) ? quotaError(err) : err; }
  return id;
}

/** One Blob backed by the stored chunks. */
export async function modelBlob(spec) {
  const cache = await open();
  const parts = await Promise.all(
    Array.from({ length: chunkCount(spec) }, async (_, i) => {
      const res = await cache.match(chunkKey(spec, i));
      if (!res) throw new Error("Model file is missing from storage (the browser may have cleared it); import or download it again");
      return res.blob();
    }),
  );
  return new Blob(parts);
}

export async function removeModel(spec) {
  const cache = await open();
  await Promise.all([...Array.from({ length: chunkCount(spec) }, (_, i) => cache.delete(chunkKey(spec, i))), cache.delete(doneKey(spec))]);
}
