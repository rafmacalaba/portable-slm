// Pre-`pslm-host/1` context loader, kept for the demo pages and existing clones.
//
// The manifest is the seam now (`docs/HOST_CONTRACT.md`): a host declares its own endpoints and the
// panel reads exactly those. This module therefore takes the route **from the caller** — a module
// that ships one host's API paths and refuses any other name is not an integration, it is a fork
// with an import statement. The two first-party routes survive below as `LEGACY_SOURCES`, clearly
// labelled as demo/compat defaults rather than as an allowlist of permitted hosts.
//
// Call from the host's own origin so existing authentication applies. Nothing here stores
// credentials, and nothing writes metadata.

const validId = (id) => typeof id === "string" && /^[\w.:-]{1,100}$/.test(id);
const POINTER = /^\/(?:[^~]|~[01]){1,200}$/;

export function normalizeNadaStudy(data, id) {
  // NADA's public API wraps the study as { status, dataset }, with DDI metadata nested under
  // dataset.metadata.study_desc. Older/custom catalogs may return the study directly.
  const dataset = data.dataset ?? data;
  const study = dataset.metadata?.study_desc ?? dataset.study_desc ?? dataset;
  return {
    idno: String(dataset.idno ?? id).slice(0, 100),
    title: String(study.title_statement?.title ?? dataset.title ?? "").slice(0, 500),
    abstract: String(study.study_info?.abstract ?? dataset.abstract ?? "").slice(0, 3000),
  };
}

/** Explicit public demo source; no app credentials sent and no arbitrary remote host allowed. */
export async function loadPublicNadaDemoStudy(id = "Test001_OD", { fetch: request = globalThis.fetch } = {}) {
  if (!validId(id)) throw new Error("Invalid NADA study ID");
  const url = `https://nada-demo.ihsn.org/index.php/api/catalog/${encodeURIComponent(id)}`;
  const res = await request(url, { credentials: "omit", mode: "cors" });
  if (!res.ok) throw new Error(`Public NADA demo returned HTTP ${res.status}`);
  return normalizeNadaStudy(await res.json(), id);
}

/**
 * The two first-party routes this module was written against, as **defaults** — not as a set of
 * hosts this code is willing to talk to. A third application passes `endpoint`/`params`/`unwrap`
 * and works identically; nothing checks its name.
 */
export const LEGACY_SOURCES = {
  "metadata-editor": {
    endpoint: (id) => `editor/json_field/${encodeURIComponent(id)}`,
    params: ({ pointer }) => ({ path: pointer, exclude_private_fields: "1" }),
    unwrap: (data, { id, pointer }) => {
      if (data.status !== "success" || !data.found) throw new Error(`Field ${pointer} was not found`);
      // `path` keeps the published shape of this helper; `pointer` is the newer option name.
      return { id, path: pointer, value: data.value };
    },
  },
  nada: {
    endpoint: (id) => `catalog/${encodeURIComponent(id)}`,
    unwrap: (data, { id }) => normalizeNadaStudy(data, id),
  },
};

/**
 * Read one JSON context from the host's own origin.
 *
 * The caller owns the route (`endpoint`), the query string (`params`) and the response envelope
 * (`unwrap`). This module owns only the guards, because those are the parts a host gets wrong:
 * a bounded id, a bounded JSON pointer, same-origin only, and an error that names the cause
 * instead of surfacing a JSON parse failure.
 *
 * `source` is accepted for backward compatibility and as a label; it selects a `LEGACY_SOURCES`
 * default when no `endpoint` is given, and no longer restricts which application may call this.
 */
export async function loadMetadataContext({
  id,
  source,
  pointer,
  path,           // deprecated alias for `pointer`
  endpoint,
  params,
  unwrap,
  apiBase = "/index.php/api/",
  credentials = "same-origin",
  fetch: request = globalThis.fetch,
} = {}) {
  if (!validId(id)) throw new Error("A valid project/study ID is required");
  const routes = endpoint
    ? { endpoint, params, unwrap }
    : LEGACY_SOURCES[source] || null;
  if (!routes) {
    throw new Error(`Unknown source "${source}". Pass endpoint(id) for this application's own route — `
      + "the loader no longer keeps a list of permitted hosts.");
  }
  const requested = pointer ?? path;
  if (requested && !POINTER.test(requested)) {
    throw new Error("Use a short JSON Pointer path such as /identification/title");
  }

  const origin = globalThis.location?.origin ?? "http://localhost";
  const base = new URL(apiBase.endsWith("/") ? apiBase : `${apiBase}/`, origin);
  if (base.origin !== origin) throw new Error("Metadata API must be on the current app's origin");

  const url = new URL(routes.endpoint(id), base);
  const query = typeof routes.params === "function" ? routes.params({ id, pointer: requested }) : routes.params;
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const res = await request(url.href, { credentials });
  if (!res.ok) throw new Error(`Metadata API returned HTTP ${res.status}; check login and record access`);
  const json = await res.json();
  return routes.unwrap ? routes.unwrap(json, { id, pointer: requested }) : json;
}
