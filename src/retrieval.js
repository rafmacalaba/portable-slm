// Hybrid retrieval over a host's own corpus: BM25 always, embeddings when an embedder is installed.
//
// This module is deliberately pure and dependency-free. It decides what goes into the prompt, so it is
// the part that has to be testable in Node without a browser, a model, or a network. The embedder and
// the download live in embedder.js; storage lives in the store.
//
// The corpus belongs to the host. This module never fetches it and never sees a route.

/**
 * Bump when chunk boundaries change. It is part of the cache key, so an index built by an older
 * chunker is rebuilt rather than silently half-matching the current one.
 */
export const CHUNKER_VERSION = 1;

/** Defaults a manifest may override. Chosen for prose with headings, which is what most corpora are. */
export const RETRIEVAL_DEFAULTS = {
  targetChars: 1200,
  overlapChars: 150,
  maxChunks: 2000,
  // 0.5 is not a compromise between two equal signals: embeddings are the stronger signal on
  // paraphrase and the weaker one on identifiers, which is why both are kept rather than one replaced.
  alpha: 0.5,
  topK: 6,
  maxBytes: 8192,
  k1: 1.2,
  b: 0.75,
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Split a document into chunks a model can be given as context.
 *
 * Headings are the primary boundary, because they are the author's own statement of where one topic
 * ends. A section longer than `targetChars` is split further on paragraph or line boundaries and
 * given `overlapChars` of tail from the previous piece, so a sentence spanning the cut is still
 * reachable from either side. The heading is carried on every chunk: a reader (and the model) needs
 * to know which section an excerpt came from, and it is also what `selectUnderCap` prints.
 */
export function chunkText(text, { targetChars = RETRIEVAL_DEFAULTS.targetChars, overlapChars = RETRIEVAL_DEFAULTS.overlapChars, maxChunks = RETRIEVAL_DEFAULTS.maxChunks, path = "" } = {}) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return [];
  const target = Math.max(200, targetChars);

  // Split on markdown headings, keeping the heading with the section it introduces.
  const sections = [];
  let heading = "";
  let body = [];
  const flush = () => {
    const content = body.join("\n").trim();
    if (content || heading) sections.push({ heading, text: content });
    body = [];
  };
  for (const line of source.split("\n")) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
      continue;
    }
    body.push(line);
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    if (!section.text) {
      // A heading with no body is still a citable location, but it carries nothing to rank on.
      if (section.heading) chunks.push({ heading: section.heading, text: section.heading });
      continue;
    }
    let rest = section.text;
    let carry = "";
    while (rest) {
      const room = target - carry.length;
      let piece = rest.slice(0, room);
      if (rest.length > room) {
        // Prefer a break at a paragraph, then a line, then a word, so a chunk rarely ends mid-word.
        const at = Math.max(piece.lastIndexOf("\n\n"), piece.lastIndexOf("\n"), piece.lastIndexOf(" "));
        if (at > room * 0.5) piece = piece.slice(0, at);
      }
      const merged = (carry + piece).trim();
      if (merged) chunks.push({ heading: section.heading, text: merged });
      rest = rest.slice(piece.length);
      carry = merged.slice(-overlapChars);
      if (chunks.length >= maxChunks) return finalise(chunks, path);
      if (!rest.trim()) break;
    }
  }
  return finalise(chunks, path);
}

function finalise(chunks, path) {
  return chunks.map((chunk, index) => ({
    id: `${path ? `${path}#` : ""}${index}`,
    index,
    path,
    heading: chunk.heading,
    text: chunk.text,
    tokens: tokenize(`${chunk.heading} ${chunk.text}`),
  }));
}

/**
 * Tokens for scoring. Identifiers matter as much as prose in metadata corpora, so `house_hold_id`,
 * `HHID` and `getUserName` are split into parts rather than kept whole or discarded: a field name the
 * user typed verbatim should match with BM25 even when no embedder is installed.
 *
 * English function words are dropped, which is a deliberate retreat from doing this statistically. The
 * corpus-relative rule in `bm25` handles repetition, but on a nine-section corpus "is" appears in two of
 * them and looks as distinctive as a rare noun, so a question the corpus does not cover comes back with
 * real sections attached. No statistic available at that corpus size separates the two, so the closed
 * class is named instead.
 *
 * Two things this list deliberately does not do. It excludes short words that carry meaning in metadata
 * (`id`, `no`, `yr`, `hh`), which is why a minimum-length rule was rejected: it would have discarded
 * exactly the identifiers this ranker is best at. And it is English only, because a stoplist is a
 * language's property and this module has no language; a corpus in another language loses nothing it
 * would otherwise have had from a list of English words, and embeddings are the part that covers it.
 */
const STOPWORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did",
  "do", "does", "for", "from", "had", "has", "have", "he", "her", "his", "how", "if", "in", "into",
  "is", "it", "its", "may", "me", "my", "not", "of", "on", "or", "our", "she", "should", "so",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "to",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would",
  "you", "your",
]);

export function tokenize(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => (token.length > 1 || /[0-9]/.test(token)) && !STOPWORDS.has(token));
}

/**
 * BM25 over chunks. No model, no download, and it works on the phone path where the embedder is
 * deliberately absent.
 *
 * There is no stoplist, because a stoplist is a language's, not a corpus's, and this ranker is used with
 * multilingual corpora. The equivalent job is done per corpus instead: a term present in more than a third
 * of the chunks carries no signal, so it neither scores nor produces a hit. That is a language-independent
 * way to say the same thing, and it adapts to the corpus at hand rather than to English.
 */
export function bm25(chunks, question, { k = RETRIEVAL_DEFAULTS.topK, k1 = RETRIEVAL_DEFAULTS.k1, b = RETRIEVAL_DEFAULTS.b } = {}) {
  const query = [...new Set(tokenize(question))];
  if (!query.length || !chunks.length) return [];
  // Address chunks by their position in this array, never by `chunk.index`. That field is a chunk's position
  // within its own document, so a corpus of several documents collides on it: 37 chunks of this SDK's own
  // documentation share 10 distinct values. Scoring by it attributed every match to whichever chunk happened
  // to be last with that number, which is a wrong answer with no error anywhere. The array is also the
  // address space the vectors use, so both halves now agree by construction.
  const scored = chunks.map((chunk, position) => ({ index: position, score: 0, matched: [] }));
  const lengths = new Map(chunks.map((chunk, position) => [position, chunk.tokens.length]));
  const average = [...lengths.values()].reduce((sum, n) => sum + n, 0) / chunks.length || 1;
  const entries = new Map(scored.map((entry) => [entry.index, entry]));

  for (const term of query) {
    const frequency = new Map();
    chunks.forEach((chunk, position) => {
      let count = 0;
      for (const token of chunk.tokens) if (token === term) count++;
      if (count) frequency.set(position, count);
    });
    if (!frequency.size) continue;
    // A query term has to separate some chunks from others to be evidence of anything. BM25's IDF already
    // prices a ubiquitous term at almost zero, but several near-zero weights still add up to a hit, which is
    // how a question the corpus does not cover comes back with real sections attached: on a nine-section
    // corpus, "what is the capital of Peru" matches on "of", because "of" appears in four of them. Scoring
    // only terms present in at most a third of the chunks removes those matches and leaves the order of
    // every genuinely matched chunk alone. A query with no such term returns nothing, which is the honest
    // answer: keyword search has found no signal, and the embedding half, if it is installed, decides.
    if (frequency.size > Math.max(1, Math.floor(chunks.length / 3))) continue;
    const idf = Math.log(1 + (chunks.length - frequency.size + 0.5) / (frequency.size + 0.5));
    for (const [index, count] of frequency) {
      const length = lengths.get(index) ?? 0;
      entries.get(index).score += idf * ((count * (k1 + 1)) / (count + k1 * (1 - b + (b * length) / average)));
      entries.get(index).matched.push(term);
    }
  }
  return scored.filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, k);
}

/** Cosine similarity for two vectors of equal length. Vectors are expected L2-normalized. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Matryoshka truncation: keep the first `dims` values and re-normalize.
 *
 * EmbeddingGemma is trained so that a prefix of the vector is a usable vector, so this is the intended
 * use rather than a lossy shortcut. Re-normalizing matters: cosine over un-renormalized prefixes is not
 * a cosine, and the error is small enough to look like a quality difference instead of a bug.
 */
export function matryoshka(vector, dims = vector.length) {
  const take = Math.max(1, Math.min(dims, vector.length));
  const out = Float32Array.from(vector.subarray ? vector.subarray(0, take) : vector.slice(0, take));
  return normalize(out);
}

/** L2-normalize in place, so a dot product is a cosine. */
export function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
}

/** Min-max into [0, 1], so two scorers with unrelated units can be added without one swamping the other. */
function scale(scores) {
  if (!scores.size) return new Map();
  const values = [...scores.values()];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const out = new Map();
  for (const [key, value] of scores) out.set(key, span > 0 ? (value - low) / span : 1);
  return out;
}

/**
 * The hybrid rank: BM25 plus, when vectors are present, cosine over the same chunks.
 *
 * `alpha` is the embedding weight, so `alpha: 0` is BM25 alone and `alpha: 1` is embeddings alone.
 * When `queryVector` is missing the semantic half is skipped entirely rather than treated as zeros:
 * a zero vector would otherwise make every chunk look equally distant and depress the BM25 signal it
 * is added to.
 */
export function rankChunks(index, question, { k = RETRIEVAL_DEFAULTS.topK, alpha = RETRIEVAL_DEFAULTS.alpha, queryVector, minSimilarity = 0 } = {}) {
  const chunks = index?.chunks ?? [];
  if (!chunks.length) return [];
  const lexical = new Map(bm25(chunks, question, { k: chunks.length }).map((entry) => [entry.index, entry.score]));
  const semantic = new Map();
  const vectors = index?.vectors;
  if (queryVector && vectors && queryVector.length === index.dims) {
    for (let position = 0; position < chunks.length; position++) {
      const at = position * index.dims;
      if (at + index.dims > vectors.length) break;
      semantic.set(position, cosine(queryVector, vectors.subarray(at, at + index.dims)));
    }
  }
  // A vector match is a candidate for every chunk, so without a floor a question the corpus does not
  // cover still returns its least-bad section, and a section claim is exactly what invites the model to
  // reason over the wrong material. The floor applies only to chunks that no query term matched: a chunk
  // found by a distinctive term is evidence in its own right. It is per model because the similarity
  // scales are not comparable: the best out-of-corpus match measured 0.046 for one embedder and 0.574
  // for the other, so a shared constant would be wrong for at least one of them.
  const floor = Number.isFinite(minSimilarity) ? minSimilarity : 0;
  for (const [chunkIndex, similarity] of semantic) {
    if (similarity < floor && !(lexical.get(chunkIndex) > 0)) semantic.delete(chunkIndex);
  }
  const hasSemantic = semantic.size > 0;
  const weight = hasSemantic ? clamp(alpha, 0, 1) : 0;
  const lexicalScaled = scale(lexical);
  const semanticScaled = scale(semantic);

  return chunks
    .map((chunk, position) => ({
      chunk,
      lexical: lexical.get(position) ?? 0,
      semantic: semantic.get(position) ?? null,
      score: (lexicalScaled.get(position) ?? 0) * (1 - weight) + (semanticScaled.get(position) ?? 0) * weight,
    }))
    .filter((entry) => entry.lexical > 0 || entry.semantic !== null)
    .sort((left, right) => right.score - left.score || left.chunk.index - right.chunk.index)
    .slice(0, Math.max(1, k));
}

/**
 * Turn a ranking into prompt text under a byte cap.
 *
 * The cap is applied here rather than by the caller because a silent cut is the defect the context
 * readers already guard against: whatever is dropped is reported, so a reader can tell the difference
 * between "the corpus does not cover this" and "the corpus covered it and did not fit".
 */
export function selectUnderCap(ranked, { maxBytes = RETRIEVAL_DEFAULTS.maxBytes } = {}) {
  const enc = new TextEncoder();
  const size = (value) => enc.encode(value).length;
  const included = [];
  const omitted = [];
  let used = 0;
  for (const entry of ranked) {
    // Name where the section came from, not only what it is called. A reader looking at the prompt cannot
    // otherwise tell retrieved site content from text baked into the SDK, and a section title can repeat
    // across documents. It also lets the model do what most hosts ask of it: say which page it drew on.
    const heading = (entry.chunk.heading || "").trim();
    const source = (entry.chunk.path || "").trim();
    const label = (heading && source && heading !== source ? `${heading} — ${source}` : (heading || source || `chunk ${entry.chunk.index}`)).slice(0, 120);
    const prefix = `### ${label}\n`;
    const separator = included.length ? 2 : 0;
    const cost = size(prefix) + size(entry.chunk.text) + separator;
    if (used + cost <= maxBytes) {
      included.push({ label, text: entry.chunk.text, truncated: false });
      used += cost;
      continue;
    }
    if (included.length) {
      omitted.push(label);
      continue;
    }
    // The first chunk still has to fit: truncate it, and say so, rather than blowing the cap.
    const marker = "\n[truncated to fit the size limit]";
    const room = maxBytes - size(prefix) - size(marker);
    if (room <= 0) {
      omitted.push(label);
      continue;
    }
    const text = new TextDecoder().decode(enc.encode(entry.chunk.text).slice(0, room));
    included.push({ label, text, truncated: true });
    used = size(prefix) + size(text) + size(marker);
  }
  let text = included
    .map((entry) => `### ${entry.label}\n${entry.text}${entry.truncated ? "\n[truncated to fit the size limit]" : ""}`)
    .join("\n\n");
  // A multi-byte character split by the cut can decode to a replacement that costs more bytes than
  // the slice allowed. The cap is a promise, so it is enforced once more on the finished string.
  if (size(text) > maxBytes) text = new TextDecoder().decode(enc.encode(text).slice(0, maxBytes));
  return { text, hits: included, omitted, bytes: size(text), truncated: included.some((entry) => entry.truncated) || omitted.length > 0 };
}

/**
 * The identity of an index. Change any input and the old vectors are discarded rather than reused:
 * a 768-dim index answering a 256-dim query, or a corpus that has moved on, produces confident
 * nonsense with no error anywhere, which is the failure mode this key exists to make impossible.
 */
export function indexKey({ corpusVersion = "0", embedderId = "bm25", dims = 0, chunkerVersion = CHUNKER_VERSION, chunkChars = 0 } = {}) {
  return `pslm-index/v1/${corpusVersion}/${embedderId}/${dims}/${chunkerVersion}/${chunkChars}`;
}

/** Build the in-memory index `rankChunks` reads. Vectors are flat: chunk i occupies [i*dims, (i+1)*dims). */
export function buildIndex({ chunks, vectors = null, dims = 0, embedderId = "bm25", corpusVersion = "0", chunkChars = 0 }) {
  // The index owns the numbering, and it is positional because the vectors are stored that way. Taking the
  // chunks as given would carry each document's own numbering into a shared address space where it collides.
  const numbered = chunks.map((chunk, position) => (chunk.index === position ? chunk : { ...chunk, index: position }));
  return {
    chunks: numbered,
    vectors: vectors ? Float32Array.from(vectors) : null,
    dims, embedderId, corpusVersion, chunkChars,
    key: indexKey({ corpusVersion, embedderId, dims, chunkChars }),
  };
}

// Base64 over bytes, implemented here rather than via btoa or Buffer so the same code runs in a
// browser, a worker and Node, and so a prebuilt index is one portable artifact.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return Uint8Array.from(input);
}

export function encodeVector(input) {
  const bytes = toBytes(input);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(triple >> 18) & 63] + B64[(triple >> 12) & 63] + (b === undefined ? "=" : B64[(triple >> 6) & 63]) + (c === undefined ? "=" : B64[triple & 63]);
  }
  return out;
}

export function decodeVector(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (buffer >> bits) & 255;
    }
  }
  // A copy of exactly the decoded bytes: a subarray would carry its parent's buffer, and a
  // Float32Array built over that would gain whatever padding the allocation had.
  return bytes.slice(0, at);
}

/** A prebuilt index a host can commit, so a first visit does not have to embed anything. */
export function serializeIndex(index) {
  return JSON.stringify({
    format: "pslm-index/1",
    key: index.key,
    embedderId: index.embedderId,
    dims: index.dims,
    corpusVersion: index.corpusVersion,
    chunkChars: index.chunkChars ?? 0,
    chunkerVersion: CHUNKER_VERSION,
    chunks: index.chunks.map((chunk) => ({ id: chunk.id, index: chunk.index, path: chunk.path || "", heading: chunk.heading || "", text: chunk.text })),
    vectors: index.vectors ? encodeVector(new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength)) : null,
  });
}

/** Returns null when the artifact does not match what this build expects, rather than a half-index. */
export function deserializeIndex(json, { chunkerVersion = CHUNKER_VERSION } = {}) {
  let parsed;
  try { parsed = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  if (!parsed || parsed.format !== "pslm-index/1" || parsed.chunkerVersion !== chunkerVersion) return null;
  if (!Array.isArray(parsed.chunks) || !parsed.chunks.length) return null;
  const vectors = parsed.vectors ? new Float32Array(decodeVector(parsed.vectors).buffer) : null;
  if (vectors && parsed.dims && vectors.length !== parsed.chunks.length * parsed.dims) return null;
  const chunks = parsed.chunks.map((chunk, index) => ({
    id: chunk.id ?? String(index),
    index,
    path: chunk.path || "",
    heading: chunk.heading || "",
    text: chunk.text ?? "",
    tokens: tokenize(`${chunk.heading || ""} ${chunk.text || ""}`),
  }));
  // Every input to the key has to survive the round trip. Dropping one here makes the rebuilt key differ
  // from the key the artifact was written with, so the runtime refuses its own artifact and answers from
  // BM25 instead, with no error anywhere.
  return buildIndex({
    chunks, vectors,
    dims: parsed.dims || 0,
    embedderId: parsed.embedderId || "bm25",
    corpusVersion: parsed.corpusVersion || "0",
    chunkChars: parsed.chunkChars ?? 0,
  });
}
