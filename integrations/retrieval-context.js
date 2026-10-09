// Retrieval as the default context provider: fetch a declared corpus, index it once, and answer each
// question from the few chunks that match it instead of pasting the whole document into the prompt.
//
// The shape of the default matters as much as the ranking. BM25 needs no model, so the first question is
// answered from the corpus immediately, on any device, with nothing downloaded. Embeddings arrive when
// they can: if the embedder is already installed it is used, and if it is not, the session keeps working
// from BM25 and the panel says what a download would add. A first visit should never be a 181 MB
// prerequisite for an answer that keyword search could have given.
import { DEFAULTS } from "../src/models.js";
import {
  CHUNKER_VERSION, buildIndex, chunkText, deserializeIndex, indexKey, rankChunks, selectUnderCap, serializeIndex,
} from "../src/retrieval.js";
import { documents, fetchCredentials, retrievalOptions } from "./host-contract.js";

/** One corpus document larger than this is refused: a corpus is indexed, not pasted, so a huge file is a mistake. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** How many chunks are embedded per call. Small enough to keep a tab responsive and to report progress. */
const EMBED_BATCH = 8;

const enc = new TextEncoder();

/** Cache Storage, so an index survives a reload without the corpus being re-embedded. */
export function indexCache(name = "portable-slm-index-v1") {
  return {
    async get(key) {
      const cache = await caches.open(name);
      const hit = await cache.match(key);
      return hit ? await hit.text() : null;
    },
    async put(key, text) {
      const cache = await caches.open(name);
      await cache.put(key, new Response(text, { headers: { "content-type": "application/json" } }));
    },
  };
}

/**
 * Fetch every declared document. Same-origin, text only, capped, and an HTML response is refused for
 * the same reason the context readers refuse one: a login page or an error page is not a corpus, and it
 * would be indexed as though it were.
 */
export async function fetchCorpus(manifest, base, { fetch: request = globalThis.fetch, maxBytes = MAX_DOCUMENT_BYTES } = {}) {
  const origin = new URL(base).origin;
  const corpus = [];
  for (const { url, label } of documents(manifest)) {
    const target = new URL(url, base);
    if (target.origin !== origin) throw new Error(`corpus ${url} left the host origin`);
    const res = await request(target.href, { credentials: fetchCredentials(manifest) });
    if (!res.ok) throw new Error(`corpus ${label}: HTTP ${res.status}`);
    if (/text\/html/i.test(res.headers.get("content-type") || "")) {
      throw new Error(`corpus ${label} returned HTML, expected text`);
    }
    const text = await res.text();
    const bytes = enc.encode(text).length;
    if (bytes > maxBytes) throw new Error(`corpus ${label} is ${Math.round(bytes / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB`);
    corpus.push({ path: label, text });
  }
  return corpus;
}

/** Chunk every document. The label becomes the chunk path, so a hit can be cited back to its file. */
export function corpusChunks(corpus) {
  return corpus.flatMap((doc) => chunkText(doc.text, { path: doc.path }));
}

/**
 * Build the index: a prebuilt artifact if the host ships one, else a cached build, else BM25 now and
 * vectors in the background. Returns the index in use plus a promise for the upgraded one.
 */
export async function buildCorpusIndex({ manifest, base, fetch: request = globalThis.fetch, storage, embedder, modelId = DEFAULTS.embedder, onStatus = () => {} } = {}) {
  const options = retrievalOptions(manifest);
  const dims = options.dims ?? DEFAULTS.retrieval.dims;
  const corpusVersion = options.corpusVersion ?? "0";
  const corpus = await fetchCorpus(manifest, base, { fetch: request });
  const chunks = corpusChunks(corpus);
  if (!chunks.length) return { index: null, upgrade: null, options, dims, chunkerVersion: CHUNKER_VERSION };

  // A prebuilt index is tried first: it needs no embedder, no download and no waiting.
  if (options.index) {
    try {
      const res = await request(new URL(options.index, base).href, { credentials: fetchCredentials(manifest) });
      if (res.ok) {
        const prebuilt = deserializeIndex(await res.text());
        if (prebuilt?.key === indexKey({ corpusVersion, embedderId: prebuilt.embedderId, dims: prebuilt.dims })) {
          // The prebuilt artifact carries its own chunk text, which must still match the corpus on disk:
          // a stale artifact would answer from content the host has since edited.
          const same = prebuilt.chunks.length === chunks.length
            && prebuilt.chunks.every((chunk, i) => chunk.text === chunks[i].text);
          if (same) return { index: prebuilt, upgrade: null, options, dims, source: "prebuilt", chunkerVersion: CHUNKER_VERSION };
          onStatus("prebuilt index does not match the corpus on disk; rebuilding", "warn");
        } else if (prebuilt) {
          onStatus("prebuilt index was built for a different corpus or embedder; rebuilding", "warn");
        }
      }
    } catch (err) {
      onStatus(`prebuilt index unavailable: ${err.message}`, "warn");
    }
  }

  const key = indexKey({ corpusVersion, embedderId: modelId, dims });
  if (storage) {
    try {
      const cached = deserializeIndex(await storage.get(key));
      if (cached && cached.chunks.length === chunks.length) {
        return { index: cached, upgrade: null, options, dims, source: "cache", chunkerVersion: CHUNKER_VERSION };
      }
    } catch { /* a bad cache entry is rebuilt, never fatal */ }
  }

  // BM25 answers now. This is the floor, not a fallback: it needs no model and works offline.
  const lexical = buildIndex({ chunks, embedderId: "bm25", corpusVersion });
  if (!embedder?.status) return { index: lexical, upgrade: null, options, dims, source: "bm25", chunkerVersion: CHUNKER_VERSION };

  return {
    index: lexical,
    source: "bm25",
    options,
    dims,
    chunkerVersion: CHUNKER_VERSION,
    upgrade: (async () => {
      const status = await embedder.status(modelId);
      if (status.state !== "installed") {
        // Not an error: the session is already answering. The panel can offer the download.
        return { index: lexical, source: "bm25", reason: "embedder not installed" };
      }
      await embedder.load(modelId);
      const vectors = new Float32Array(chunks.length * dims);
      for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
        const batch = chunks.slice(start, start + EMBED_BATCH);
        const embedded = await embedder.embed(batch.map((chunk) => chunk.text), {
          kind: "document",
          titles: batch.map((chunk) => chunk.heading),
          dims,
        });
        embedded.forEach((vector, i) => vectors.set(vector, (start + i) * dims));
        onStatus(`indexing ${Math.min(start + EMBED_BATCH, chunks.length)} of ${chunks.length} sections`);
      }
      const index = buildIndex({ chunks, vectors, dims, embedderId: modelId, corpusVersion });
      if (storage) await storage.put(key, serializeIndex(index)).catch(() => {});
      return { index, source: "embedded" };
    })().catch((err) => ({ index: lexical, source: "bm25", reason: err.message })),
  };
}

/**
 * The provider handed to <pslm-chat>. It uses whatever index is current, so a session that starts on
 * BM25 upgrades mid-conversation without the reader doing anything.
 */
export function createRetrievalContext({ manifest, base, fetch: request = globalThis.fetch, storage, embedder, modelId = DEFAULTS.embedder, onStatus = () => {} } = {}) {
  const declared = documents(manifest);
  if (!declared.length) return null;
  const state = { index: null, dims: DEFAULTS.retrieval.dims, options: {}, source: "starting" };
  let pending = null;

  async function prepare() {
    try {
      const built = await buildCorpusIndex({ manifest, base, fetch: request, storage, embedder, modelId, onStatus });
      if (!built.index) return { note: `the declared corpus produced no sections` };
      Object.assign(state, { index: built.index, dims: built.dims, options: built.options, source: built.source });
      if (built.upgrade) {
        built.upgrade.then((upgraded) => {
          if (upgraded.index === state.index) return;
          state.index = upgraded.index;
          state.source = upgraded.source;
          onStatus(upgraded.source === "embedded"
            ? `retrieval upgraded to ${upgraded.index.chunks.length} embedded sections`
            : `retrieval is keyword-only: ${upgraded.reason}`, upgraded.source === "embedded" ? "info" : "warn");
        });
      }
      // Always say what is answering. A caller that only hears about problems cannot tell a working
      // retrieval from an absent one, and the difference decides how much a reader trusts the answer.
      const count = built.index.chunks.length;
      const label = { prebuilt: "prebuilt index", cache: "cached index", bm25: "keyword search only so far" }[built.source] ?? built.source;
      const note = `${label}, ${count} section(s)`;
      // Announced rather than returned only: the caller owns where it is shown, and a status line is the
      // wrong place for it because the model state legitimately overwrites that line.
      onStatus(note, "info");
      return { note, source: built.source };
    } catch (err) {
      // A provider that throws ends the turn. Retrieval is an improvement on no context, so a corpus
      // that cannot be read degrades to no context and says so instead of failing the question.
      onStatus(`retrieval unavailable: ${err.message}`, "warn");
      return { note: null, failed: true };
    }
  }

  return {
    /** Resolves when the first question can be answered; embedding continues after it. */
    ready() { return (pending ??= prepare()); },
    get source() { return state.source; },
    async onContext(question) {
      if (!state.index) await this.ready();
      if (!state.index) return "";
      let queryVector;
      const loaded = embedder?.loaded;
      if (loaded?.dims) {
        try {
          const [vector] = await embedder.embed(question, { kind: "query", dims: state.dims });
          // The query must be truncated to the index width, or every cosine returns 0 for a length mismatch.
          if (vector?.length === state.index.dims) queryVector = vector;
        } catch (err) {
          onStatus(`query embedding failed, answering from keywords: ${err.message}`, "warn");
        }
      }
      const ranked = rankChunks(state.index, question, {
        k: state.options.topK ?? DEFAULTS.retrieval.topK,
        alpha: state.options.alpha ?? DEFAULTS.retrieval.alpha,
        queryVector,
      });
      if (!ranked.length) return "";
      const { text, omitted, truncated } = selectUnderCap(ranked, {
        maxBytes: state.options.maxBytes ?? DEFAULTS.retrieval.maxBytes,
      });
      const notes = [];
      if (omitted.length) notes.push(`${omitted.length} further matching section(s) did not fit`);
      if (truncated) notes.push("the last section was cut to fit");
      if (state.source === "bm25") notes.push("keyword search only: the embedder is not installed on this device");
      return notes.length ? `${text}\n\n[${notes.join("; ")}.]` : text;
    },
  };
}
