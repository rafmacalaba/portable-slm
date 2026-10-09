// The manifest-declared context reads: one function per `context.*` source.
//
// DOM-free, with `fetch` and `origin` injectable, so the properties that decide what actually reaches the
// model — same-origin enforcement, the byte cap, JSON-versus-HTML diagnosis, and the credentials the host
// declared — are unit-testable without a browser. These lived in `embed.js`, which imports the chat
// element and therefore cannot be imported in Node at all; that is why `context.credentials` was validated,
// honoured for declared tools, and silently ignored by every context read for as long as it has existed.
import { byteCap, expand, fetchCredentials } from "./host-contract.js";

const pageOrigin = () => globalThis.location?.origin ?? "http://localhost";

/**
 * The credentials a declared context read may use: the host's declaration, translated into the word
 * `fetch()` accepts. A host that says `"credentials": "none"` is saying its document is public and should
 * not carry the user's cookies; inheriting the page's session is the default, because the alternative — a
 * second credential — is what `CONTEXT_PROVIDERS.md` forbids.
 */
export { fetchCredentials as contextCredentials };

// Host APIs commonly redirect an expired session to the login page with HTTP 200 and HTML, which would
// otherwise surface as a JSON parse error.
export async function fetchJson(url, label, { fetch: request = globalThis.fetch, credentials = "same-origin" } = {}) {
  const res = await request(url, { credentials });
  // Named before the content-type check, because "HTTP 401" is the actionable diagnosis and a redirect
  // body would otherwise be reported as an expired session even in a fresh browser.
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${label}: HTTP ${res.status} — sign in as a curator with access to this project`);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  if (!/(?:^|;)\s*application\/json/i.test(res.headers.get("content-type") || "")) {
    throw new Error(`${label}: received HTML — your host session has expired, sign in again`);
  }
  return res.json();
}

/** The record snapshot for one object, refetched every question. `{id}` is substituted and URI-encoded. */
export async function fetchRecord(manifest, recordId, base = pageOrigin(), options = {}) {
  const record = manifest.context?.record;
  if (!record?.url) throw new Error("Manifest has no context.record.url");
  const url = new URL(expand(record.url, { id: recordId }), base);
  if (url.origin !== (options.origin ?? pageOrigin())) throw new Error("context.record.url must be same-origin");
  const json = await fetchJson(url.href, "Project metadata", { ...options, credentials: fetchCredentials(manifest) });
  const body = json.dataset ?? json.metadata ?? json;
  return byteCap(body, record.maxBytes || 12288);
}

/** One declared field, so improving a single value never ships the whole record. */
export async function fetchField(manifest, recordId, pointer, base = pageOrigin(), options = {}) {
  const field = manifest.context?.field;
  if (!field?.url) throw new Error("Manifest has no context.field.url");
  const url = new URL(expand(field.url, { id: recordId, pointer }), base);
  if (url.origin !== (options.origin ?? pageOrigin())) throw new Error("context.field.url must be same-origin");
  const data = await fetchJson(url.href, "Field request", { ...options, credentials: fetchCredentials(manifest) });
  if (data.status !== "success" || !data.found) throw new Error(`Field ${pointer} was not found`);
  return byteCap({ pointer, value: data.value }, field.maxBytes || 4096);
}

/**
 * The application-level document, for a page that is not about one record. Text, not JSON: a help page or
 * a content digest is a document, and HTML here means a login or error page rather than the document.
 */
export async function fetchApp(manifest, base = pageOrigin(), options = {}) {
  const app = manifest.context?.app;
  if (!app?.url) throw new Error("Manifest has no context.app.url");
  const url = new URL(expand(app.url, {}), base);
  if (url.origin !== (options.origin ?? pageOrigin())) throw new Error("context.app.url must be same-origin");
  const request = options.fetch ?? globalThis.fetch;
  const res = await request(url.href, { credentials: fetchCredentials(manifest) });
  if (!res.ok) throw new Error(`App context: HTTP ${res.status}`);
  if (/text\/html/i.test(res.headers.get("content-type") || "")) {
    throw new Error(`App context: ${url.pathname} returned HTML, expected text`);
  }
  return byteCap(await res.text(), app.maxBytes || 8192);
}
