// Model store: keeps model files as 16 MB chunks, OPFS-first with Cache Storage fallback.
// - Download: Range requests, each chunk retried; an interrupted download resumes.
// - Import: a user-picked file (from USB / SD card / Files) is copied in chunk by chunk.
// - Every model is sha256-verified before it is marked installed (files are parsed by native code).
// - Reading returns one Blob made of the chunk Blobs; wllama reads it in small slices, so the model
//   is never copied whole into memory. This layout is the one proven on iOS Safari (phone-test).
//
// Why OPFS first: desktop Chrome has been observed refusing Cache Storage writes with
// QuotaExceededError around ~350 MB per origin even with gigabytes of free disk (QuotaManager
// miscounting). OPFS has separate, correct quota accounting and holds multi-GB files. Existing
// Cache-Storage installs stay readable (legacy), so no one re-downloads a verified model.
import { createSha256 } from "./sha256.js";

export const CHUNK = 16 * 2 ** 20;
const CACHE_NAME = "portable-slm-models";
const OPFS_DIR = "portable-slm-models";
const chunkCount = (spec) => Math.ceil(spec.bytes / CHUNK);
const partsOf = (spec) => spec.files?.length ? spec.files : [spec];
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
const notFound = (err) => err?.name === "NotFoundError" || err?.name === "TypeMismatchError";

async function quotaError(err, spec, phase) {
  let estimate = null;
  try { estimate = await globalThis.navigator?.storage?.estimate?.(); } catch { /* estimate is best-effort */ }
  const format = (bytes) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;
  const storage = estimate?.quota
    ? ` Origin usage ${format(estimate.usage || 0)} / ${format(estimate.quota)} (${format(Math.max(0, estimate.quota - (estimate.usage || 0)))} available).`
    : " Browser did not provide a storage estimate.";
  const file = spec.path || spec.file || "model file";
  return new Error(`Browser storage quota exceeded during ${phase} for ${file} (${format(spec.bytes)}).${storage} Cached files are on disk, not RAM; Delete cached files frees them, Unload from memory does not.`, { cause: err });
}

// --- OPFS backend -----------------------------------------------------------------------

let opfsRootPromise = null;
function opfsRoot() {
  opfsRootPromise ??= globalThis.navigator.storage.getDirectory();
  return opfsRootPromise;
}

const opfsSupported = () => typeof globalThis.navigator?.storage?.getDirectory === "function";

async function opfsFile(spec, name, create) {
  const root = await opfsRoot();
  const baseDir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  const modelDir = await baseDir.getDirectoryHandle(spec.sha256, { create });
  return modelDir.getFileHandle(name, { create });
}

async function opfsWrite(spec, name, data) {
  const handle = await opfsFile(spec, name, true);
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (err) {
    await writable.abort?.().catch(() => {});
    throw err;
  }
}

async function opfsReadBlob(spec, name) {
  const handle = await opfsFile(spec, name, false);
  return handle.getFile(); // File is a Blob; lazy — bytes are not in memory until sliced.
}

async function opfsRemoveModel(spec) {
  if (!opfsSupported()) return;
  const root = await opfsRoot();
  const baseDir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  await baseDir.removeEntry(spec.sha256, { recursive: true });
}

// --- unified chunk/seal operations ------------------------------------------------------

/** Store one chunk. OPFS first; Cache Storage is the fallback (and the legacy home). */
async function writeChunk(spec, i, data) {
  if (opfsSupported()) {
    try {
      await opfsWrite(spec, `chunk-${i}`, data);
      return;
    } catch (err) {
      if (quotaExceeded(err)) throw err; // real storage pressure: report it, don't hide it in Cache
      console.warn(`OPFS chunk write failed (chunk ${i}); falling back to Cache Storage`, err);
    }
  }
  const cache = await open();
  await cache.put(chunkKey(spec, i), new Response(data));
}

/** One chunk as a Blob, or null. Reads OPFS, then legacy Cache Storage installs. */
async function readChunkBlob(spec, i) {
  if (opfsSupported()) {
    try { return await opfsReadBlob(spec, `chunk-${i}`); }
    catch (err) { if (!notFound(err)) console.warn(`OPFS chunk read failed (chunk ${i}); trying Cache Storage`, err); }
  }
  const cache = await open();
  const res = await cache.match(chunkKey(spec, i));
  return res ? res.blob() : null;
}

async function hasChunk(spec, i) {
  if (opfsSupported()) {
    try { await opfsFile(spec, `chunk-${i}`, false); return true; }
    catch (err) { if (!notFound(err)) console.warn(`OPFS chunk check failed (chunk ${i}); trying Cache Storage`, err); }
  }
  const cache = await open();
  return Boolean(await cache.match(chunkKey(spec, i)));
}

async function readSeal(spec) {
  if (opfsSupported()) {
    try {
      const file = await opfsReadBlob(spec, "verified");
      return JSON.parse(await file.text());
    } catch (err) { if (!notFound(err)) console.warn("OPFS seal read failed; trying Cache Storage", err); }
  }
  const cache = await open();
  const res = await cache.match(doneKey(spec));
  return res ? res.json() : null;
}

async function writeSeal(spec, payload) {
  if (opfsSupported()) {
    try {
      await opfsWrite(spec, "verified", new Blob([JSON.stringify(payload)], { type: "application/json" }));
      return;
    } catch (err) {
      if (quotaExceeded(err)) throw err;
      console.warn("OPFS seal write failed; falling back to Cache Storage", err);
    }
  }
  const cache = await open();
  await cache.put(doneKey(spec), new Response(JSON.stringify(payload)));
}

/** @returns {Promise<"installed" | "partial" | "missing">} */
async function fileStatus(spec) {
  const results = await Promise.all(
    Array.from({ length: chunkCount(spec) }, (_, i) => hasChunk(spec, i)),
  );
  const have = results.filter(Boolean).length;
  if (have === results.length && (await readSeal(spec))) return "installed";
  return have ? "partial" : "missing";
}

/** All parts of a multi-file model must be verified before it is installed. */
export async function modelStatus(spec) {
  const states = await Promise.all(partsOf(spec).map(fileStatus));
  if (states.every((state) => state === "installed")) return "installed";
  return states.some((state) => state !== "missing") ? "partial" : "missing";
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
async function storeFullResponse(spec, response, onProgress, signal) {
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
          if (!(await hasChunk(spec, i))) await writeChunk(spec, i, chunk);
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

async function verifyAndSeal(spec, onProgress) {
  const hash = createSha256();
  const n = chunkCount(spec);
  for (let i = 0; i < n; i++) {
    const blob = await readChunkBlob(spec, i);
    if (!blob) throw new Error(`Model file ${spec.path || spec.file} lost chunk ${i} before verification; install again`);
    hash.update(new Uint8Array(await blob.arrayBuffer()));
    onProgress?.({ phase: "verify", done: i + 1, total: n });
  }
  if (hash.hex() !== spec.sha256) {
    await removeModel(spec);
    throw new Error("Model file failed its integrity check (sha256 mismatch) and was removed");
  }
  await writeSeal(spec, { sha256: spec.sha256, at: Date.now() });
}

/** Download (or resume) a registry model. */
async function downloadFile(spec, { sources = [spec.url], onProgress, onRetry, onFallback, signal, fetch = globalThis.fetch, retryDelayMs = 500 } = {}) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 3) throw new Error("Choose 1–3 model sources");
  for (const source of sources) {
    const u = new URL(source);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) {
      throw new Error("Model sources must use HTTPS (or localhost for development)");
    }
  }
  const n = chunkCount(spec);
  let streamFailures = 0;
  for (let i = 0; i < n; i++) {
    if (!(await hasChunk(spec, i))) {
      signal?.throwIfAborted();
      const result = await fetchChunk(spec, i, { fetch, sources: [...sources.slice(streamFailures % sources.length), ...sources.slice(0, streamFailures % sources.length)], signal, retryDelayMs, onRetry });
      if (result instanceof Response) {
        onFallback?.({ chunk: i + 1, total: n });
        try {
          await storeFullResponse(spec, result, onProgress, signal);
          break;
        } catch (err) {
          if (signal?.aborted) throw err;
          if (quotaExceeded(err)) throw await quotaError(err, spec, "download"); // storage pressure is not a network retry
          if (++streamFailures >= 6) throw new Error(`Full-file stream failed after ${streamFailures} attempts: ${err.message}`, { cause: err });
          onRetry?.({ chunk: i + 1, total: n, attempt: streamFailures, maxAttempts: 6, reason: err.message });
          await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** streamFailures));
          i = -1; // completed chunks are kept; retry from the first missing one
          continue;
        }
      }
      try { await writeChunk(spec, i, result); }
      catch (err) { throw quotaExceeded(err) ? await quotaError(err, spec, "download") : err; }
    }
    onProgress?.({ phase: "download", done: i + 1, total: n });
  }
  try { await verifyAndSeal(spec, onProgress); }
  catch (err) { throw quotaExceeded(err) ? await quotaError(err, spec, "verification") : err; }
}

/** Download every verified file in a model. `sourceForFile` supplies host mirror + pinned URLs. */
export async function downloadModel(spec, options = {}) {
  const parts = partsOf(spec);
  for (const part of parts) {
    const sources = options.sourceForFile
      ? options.sourceForFile(part)
      : parts.length === 1 ? (options.sources ?? [part.url]) : [part.url];
    await downloadFile(part, {
      ...options, sources,
      onProgress: (progress) => options.onProgress?.({ ...progress, file: part.path || part.file }),
    });
  }
}

/** Import a model file picked by the user. `models` = registry to match against. */
export async function importModel(file, models, { onProgress } = {}) {
  const matches = Object.entries(models).filter(([, m]) => !m.files?.length && m.bytes === file.size);
  if (!matches.length) throw new Error(`"${file.name}" is not a known model file (size ${file.size} bytes)`);
  const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
  if (magic !== "GGUF") throw new Error(`"${file.name}" is not a GGUF model file`);
  const [id, spec] = matches.length === 1 ? matches[0] : (matches.find(([, m]) => m.file === file.name) ?? matches[0]);
  const n = chunkCount(spec);
  for (let i = 0; i < n; i++) {
    const part = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
    try { await writeChunk(spec, i, await part.arrayBuffer()); }
    catch (err) { throw quotaExceeded(err) ? await quotaError(err, spec, "import") : err; }
    onProgress?.({ phase: "import", done: i + 1, total: n });
  }
  try { await verifyAndSeal(spec, onProgress); }
  catch (err) { throw quotaExceeded(err) ? await quotaError(err, spec, "verification") : err; }
  return id;
}

/** One Blob backed by the stored chunks for a file part. */
export async function modelFileBlob(fileSpec) {
  const chunks = await Promise.all(
    Array.from({ length: chunkCount(fileSpec) }, async (_, i) => {
      const blob = await readChunkBlob(fileSpec, i);
      if (!blob) throw new Error(`Model file ${fileSpec.path || fileSpec.file} is missing from storage; download it again`);
      return blob;
    }),
  );
  return new Blob(chunks);
}

/** GGUF consumer helper. Multi-file models must address a specific part via modelFileBlob(). */
export async function modelBlob(spec) {
  if (spec.files?.length) throw new Error("modelBlob only supports single-file models");
  return modelFileBlob(spec);
}

export async function removeModel(spec) {
  // Both backends, deliberately: a legacy Cache-Storage install must be fully removable.
  let failed;
  try { await opfsRemoveModel(spec); } catch (err) { if (!notFound(err)) failed = err; }
  const cache = await open();
  await Promise.all(partsOf(spec).flatMap((part) => [
    ...Array.from({ length: chunkCount(part) }, (_, i) => cache.delete(chunkKey(part, i))),
    cache.delete(doneKey(part)),
  ]));
  if (failed) throw failed;
}

/** Delete every model chunk managed by this SDK, including entries from older registry versions. */
export async function clearModelFiles() {
  let removed = 0;
  if (opfsSupported()) {
    try {
      const root = await opfsRoot();
      const baseDir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      for await (const [name] of baseDir.entries()) {
        await baseDir.removeEntry(name, { recursive: true }).catch(() => {});
        removed++;
      }
    } catch (err) { console.warn("OPFS sweep failed; Cache Storage sweep continues", err); }
  }
  const cache = await open();
  const keys = await cache.keys();
  const modelKeys = keys.filter((request) => {
    try { return new URL(typeof request === "string" ? request : request.url).pathname.startsWith("/__models__/"); }
    catch { return false; }
  });
  await Promise.all(modelKeys.map((request) => cache.delete(request)));
  return removed + modelKeys.length;
}
