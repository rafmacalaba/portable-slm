import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchDatafileContext } from "../integrations/datafile-context.js";
import { fetchCredentials, mountMode, validateManifest, HOST_API_VERSION } from "../integrations/host-contract.js";

const source = () => ({
  url: "/index.php/api/datafiles/assistant_context/{id}/{file_id}?offset={offset}&limit={limit}",
  maxBytes: 10000, pageSize: 75, maxVariables: 300,
});

const page = (offset, rows, total, file = {}) => new Response(JSON.stringify({
  status: "success",
  datafile: { file_id: "F1", file_name: "experts_survey_raw", description: "", producer: "WB",
    source_format: "dta", source_format_version: "15", case_count: 1200, var_count: total, ...file },
  variables: rows,
  total, offset, limit: rows.length,
}), { status: 200, headers: { "content-type": "application/json" } });

const rows = (from, to) => Array.from({ length: to - from }, (_, i) => ({
  name: `v${from + i}`, label: `Variable ${from + i}`, description: "How the variable was derived",
  question: "What is your age?", universe: "All respondents", concepts: ["demographics"],
}));

test("datafile mount mode needs record + declared endpoint + active file", () => {
  const manifest = validateManifest({
    apiVersion: HOST_API_VERSION,
    app: { name: "Example App" },
    context: {
      record: { url: "/api/record/{id}" },
      datafile: { url: "/api/file/{id}/{file_id}" },
    },
  });
  assert.equal(mountMode({ manifest, recordId: "11" }).datafile, true); // declared endpoint; active file is the host's runtime state
  assert.equal(mountMode({ manifest, recordId: "11" }).record, true);
});

test("fetches pages until total and never includes paths or raw rows", async () => {
  const calls = [];
  const fetch_ = async (url) => { calls.push(String(url)); return page(0, rows(0, 3), 3); };
  const { context, truncated } = await fetchDatafileContext({ source: source(), recordId: "11", fileId: "F1", fetch: fetch_ });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /assistant_context\/11\/F1\?offset=0&limit=75/);
  assert.equal(context.datafile.file_name, "experts_survey_raw");
  assert.equal(context.variables.length, 3);
  assert.equal(context.variablesTruncated, false);
  assert.equal(truncated, false);
  const text = JSON.stringify(context);
  assert.ok(!text.includes("file_info") && !text.includes("file_physical_name") && !text.includes("metadata"));
});

test("paginates with offset and stops at maxVariables", async () => {
  const calls = [];
  const small = (from, to) => Array.from({ length: to - from }, (_, i) => ({ name: `v${from + i}`, label: `L${from + i}` }));
  const fetch_ = async (url) => {
    calls.push(String(url));
    const offset = Number(new URL(url).searchParams.get("offset"));
    return page(offset, small(offset, Math.min(offset + 75, 200)), 200);
  };
  const { context } = await fetchDatafileContext({
    source: { ...source(), pageSize: 75, maxVariables: 150, maxBytes: 16000 }, recordId: "11", fileId: "F1", fetch: fetch_,
  });
  assert.equal(calls.length, 2); // 75 + 75, then maxVariables reached
  assert.equal(context.variables.length, 150);
  assert.equal(context.variablesTruncated, true);
  assert.match(calls[1], /offset=75&limit=75/);
});

test("truncates by byte cap, not just row count", async () => {
  const big = rows(0, 30).map((row) => ({ ...row, description: "x".repeat(300) }));
  const { context, truncated } = await fetchDatafileContext({
    source: { ...source(), maxBytes: 2048 }, recordId: "11", fileId: "F1",
    fetch: async () => page(0, big, 30),
  });
  assert.ok(context.variables.length < 30);
  assert.equal(context.variablesTruncated, true);
  assert.equal(truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(context)).length <= 2048);
});

test("rejects a response that does not match the requested file", async () => {
  await assert.rejects(
    fetchDatafileContext({
      source: source(), recordId: "11", fileId: "F2",
      fetch: async () => page(0, rows(0, 1), 1, { file_id: "F1" }),
    }),
    /did not match requested file/,
  );
});

test("declared limits outside contract bounds fail loudly", async () => {
  await assert.rejects(
    fetchDatafileContext({ source: { ...source(), maxVariables: 5000 }, recordId: "11", fileId: "F1", fetch: async () => page(0, [], 0) }),
    /Invalid datafile context limits/,
  );
});

test("a datafile context read sends the credentials the host declared", async () => {
  // Same bug class as the other context reads: the declaration was validated and then ignored, so a public
  // document was read with the user's cookies.
  const calls = [];
  const request = async (url, init) => { calls.push({ url: String(url), credentials: init?.credentials }); return page(0, rows(0, 1), 1); };
  const source = { url: "/api/files/{id}/{file_id}", pageSize: 1, maxBytes: 4096 };
  await fetchDatafileContext({ source, recordId: "1", fileId: "F1", credentials: fetchCredentials({ context: { credentials: "none" } }), fetch: request, origin: "https://app.example" });
  assert.equal(calls[0].credentials, "omit");
  await fetchDatafileContext({ source, recordId: "1", fileId: "F1", fetch: request, origin: "https://app.example" });
  assert.equal(calls[1].credentials, "same-origin", "the page's own session is still the default");
});
