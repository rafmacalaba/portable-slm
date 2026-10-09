import { expand, fetchCredentials } from "./host-contract.js";

function safeText(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function safeFile(file) {
  return {
    file_id: safeText(file.file_id, 50),
    file_name: safeText(file.file_name, 200),
    description: safeText(file.description, 1000),
    producer: safeText(file.producer, 200),
    source_format: safeText(file.source_format, 40),
    source_format_version: safeText(file.source_format_version, 40),
    case_count: Number.isFinite(file.case_count) ? file.case_count : null,
    var_count: Number.isFinite(file.var_count) ? file.var_count : null,
  };
}

function safeVariable(row) {
  const variable = {
    name: safeText(row.name, 100),
    label: safeText(row.label, 240),
    description: safeText(row.description, 360),
    question: safeText(row.question, 240),
    universe: safeText(row.universe, 160),
  };
  if (Array.isArray(row.concepts)) variable.concepts = row.concepts.slice(0, 3).map((v) => safeText(v, 100)).filter(Boolean);
  return variable;
}

const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Read only allowlisted, compact metadata for one host-selected datafile; never includes file paths or rows. */
// `credentials` is a fetch vocabulary value ("same-origin" | "omit"), not the manifest's word — see
// fetchCredentials(). Callers pass the manifest through it rather than forwarding the raw declaration.
export async function fetchDatafileContext({ source, recordId, fileId, credentials = "same-origin",
  fetch: request = globalThis.fetch, origin = globalThis.location?.origin ?? "http://localhost" } = {}) {
  if (!source?.url || !recordId || !fileId) throw new Error("Datafile context needs declared endpoint, project id, and active file id");
  const pageSize = source.pageSize ?? 75;
  const maxVariables = source.maxVariables ?? 300;
  const maxBytes = source.maxBytes ?? 10000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isInteger(maxVariables) || maxVariables < 1 || maxVariables > 2000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65536) {
    throw new Error("Invalid datafile context limits in host manifest");
  }

  let total = 0;
  let offset = 0;
  let truncated = false;
  const context = { target: "datafile.description", datafile: null, totalVariables: 0, variables: [], variablesTruncated: true };
  while (offset < maxVariables) {
    const limit = Math.min(pageSize, maxVariables - offset);
    const url = new URL(expand(source.url, { id: recordId, file_id: fileId, offset, limit }), origin);
    if (url.origin !== origin) throw new Error("context.datafile.url must be same-origin");
    // The host declared whether its context reads may carry the user's session; honour it here too.
    const res = await request(url.href, { credentials });
    if (res.status === 401 || res.status === 403) throw new Error(`Datafile context: HTTP ${res.status} — sign in with access to this project`);
    if (!res.ok) throw new Error(`Datafile context: HTTP ${res.status}`);
    if (!/(?:^|;)\s*application\/json/i.test(res.headers.get("content-type") || "")) {
      throw new Error("Datafile context returned HTML, expected JSON");
    }
    const page = await res.json();
    if (page.status !== "success" || !page.datafile || page.datafile.file_id !== fileId || !Array.isArray(page.variables)) {
      throw new Error("Datafile context response did not match requested file");
    }
    if (offset === 0) {
      context.datafile = safeFile(page.datafile);
      total = Number.isInteger(page.total) ? page.total : page.variables.length;
      context.totalVariables = total;
      if (byteLength(context) > maxBytes) throw new Error("Datafile metadata exceeds context limit");
    }
    if (page.variables.length === 0) break;
    let stoppedForSize = false;
    for (const raw of page.variables) {
      const candidate = { ...context, variables: [...context.variables, safeVariable(raw)], variablesTruncated: true };
      if (byteLength(candidate) > maxBytes) { stoppedForSize = true; truncated = true; break; }
      context.variables.push(candidate.variables.at(-1));
      offset++;
      if (offset >= maxVariables) { truncated = offset < total; break; }
    }
    if (stoppedForSize) break;
    if (offset >= total || page.variables.length < limit) break;
  }
  if (offset < total) truncated = true;
  context.variablesTruncated = truncated;
  return { context, text: JSON.stringify(context), truncated };
}
