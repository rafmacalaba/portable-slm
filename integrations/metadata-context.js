// First-party context loaders for NADA and Metadata Editor. Call from their own origin so
// existing authentication applies; this module never stores credentials or writes metadata.
const validId = (id) => typeof id === "string" && /^[\w.:-]{1,100}$/.test(id);

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

export async function loadMetadataContext({ source, id, path = "/identification/title", apiBase = "/index.php/api/", fetch: request = globalThis.fetch } = {}) {
  if (!["nada", "metadata-editor"].includes(source) || !validId(id)) {
    throw new Error("Choose a source and a valid project/study ID");
  }
  const origin = globalThis.location?.origin ?? "http://localhost";
  const base = new URL(apiBase.endsWith("/") ? apiBase : `${apiBase}/`, origin);
  if (base.origin !== origin) throw new Error("Metadata API must be on the current app's origin");
  if (source === "metadata-editor" && (typeof path !== "string" || !/^\/(?:[^~]|~[01]){1,200}$/.test(path))) {
    throw new Error("Use a short JSON Pointer path such as /identification/title");
  }
  const endpoint = source === "nada" ? `catalog/${encodeURIComponent(id)}` : `editor/json-field/${encodeURIComponent(id)}`;
  const url = new URL(endpoint, base);
  if (source === "metadata-editor") url.searchParams.set("path", path);
  if (source === "metadata-editor") url.searchParams.set("exclude_private_fields", "1");
  const res = await request(url.href, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Metadata API returned HTTP ${res.status}; check login and record access`);
  const data = await res.json();
  if (source === "metadata-editor") {
    if (data.status !== "success" || !data.found) throw new Error(`Field ${path} was not found`);
    return { id, path, value: data.value };
  }
  return normalizeNadaStudy(data, id);
}
