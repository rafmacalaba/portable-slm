// Read one bounded context snapshot from a host's own origin, for hosts that predate the manifest.
//
// The manifest is the seam now (`docs/HOST_CONTRACT.md`): a host declares its endpoints and the panel reads
// exactly those. This module predates it and takes the route **from the caller** for the same reason — a
// module that ships one application's API paths and refuses any other name is not an integration, it is a
// fork with an import statement.
//
// Call from the host's own origin so the host's own authentication applies. Nothing here stores
// credentials, and nothing writes anything.

const validId = (id) => typeof id === "string" && /^[\w.:-]{1,100}$/.test(id);
const POINTER = /^\/(?:[^~]|~[01]){1,200}$/;

export function pickStudySummary(data, id) {
  // A catalogue API may wrap the study as { status, dataset } with the DDI metadata under
  // dataset.metadata.study_desc; older or custom catalogues return the study directly.
  const dataset = data.dataset ?? data;
  const study = dataset.metadata?.study_desc ?? dataset.study_desc ?? dataset;
  return {
    idno: String(dataset.idno ?? id).slice(0, 100),
    title: String(study.title_statement?.title ?? dataset.title ?? "").slice(0, 500),
    abstract: String(study.study_info?.abstract ?? dataset.abstract ?? "").slice(0, 3000),
  };
}

/**
 * Read one JSON context from the host's own origin.
 *
 * The caller owns the route (`endpoint`), the query string (`params`) and the response envelope
 * (`unwrap`). This module owns only the guards, because those are the parts a host gets wrong:
 * a bounded id, a bounded JSON pointer, same-origin only, and an error that names the cause
 * instead of surfacing a JSON parse failure.
 *
 * `source` is a label for what was read, nothing more: it no longer selects a route, because a table of
 * known routes is a list of known hosts, and this loader has none.
 */
export async function loadContextSnapshot({
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
  const routes = { endpoint, params, unwrap };
  if (typeof routes.endpoint !== "function") {
    throw new Error("Pass endpoint(id) for this application's own route; this loader keeps no routes of its own");
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
