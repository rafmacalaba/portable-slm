import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadMetadataContext, loadPublicNadaDemoStudy } from "../integrations/metadata-context.js";

test("Metadata Editor reads one authenticated JSON field, not whole project", async () => {
  let requested;
  const snapshot = await loadMetadataContext({
    source: "metadata-editor", id: "TEST-1", path: "/identification/title",
    apiBase: "http://localhost/index.php/api/",
    fetch: async (url, opts) => {
      requested = { url: new URL(url), opts };
      return new Response(JSON.stringify({ status: "success", found: true, value: "Household Survey" }), { status: 200 });
    },
  });
  assert.equal(requested.url.pathname, "/index.php/api/editor/json_field/TEST-1");
  assert.equal(requested.url.searchParams.get("path"), "/identification/title");
  assert.equal(requested.url.searchParams.get("exclude_private_fields"), "1");
  assert.equal(requested.opts.credentials, "same-origin");
  assert.deepEqual(snapshot, { id: "TEST-1", path: "/identification/title", value: "Household Survey" });
});

test("NADA reads a study, retaining only bounded metadata fields", async () => {
  const snapshot = await loadMetadataContext({
    source: "nada", id: "SURVEY-2020", apiBase: "http://localhost/index.php/api/",
    fetch: async (url) => {
      assert.match(url, /catalog\/SURVEY-2020$/);
      return new Response(JSON.stringify({ idno: "SURVEY-2020", study_desc: { title_statement: { title: "A study" }, study_info: { abstract: "Overview" } }, secret: "omit me" }), { status: 200 });
    },
  });
  assert.deepEqual(snapshot, { idno: "SURVEY-2020", title: "A study", abstract: "Overview" });
});

test("real NADA demo response: dataset wrapper and nested DDI abstract", async () => {
  // Reduced public response from https://nada-demo.ihsn.org/index.php/api/catalog/Test001_OD
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/nada-popstan.json", import.meta.url), "utf8"));
  const snapshot = await loadMetadataContext({
    source: "nada", id: "Test001_OD", apiBase: "http://localhost/index.php/api/",
    fetch: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(snapshot.idno, "Test001_OD");
  assert.equal(snapshot.title, "Popstan Synthetic Household Survey 2023");
  assert.match(snapshot.abstract, /national welfare monitoring survey/);
  assert.equal(Object.keys(snapshot).length, 3); // no unrelated/private API fields
});

test("public NADA demo fetch sends no credentials and normalizes the published study", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/nada-popstan.json", import.meta.url), "utf8"));
  const snapshot = await loadPublicNadaDemoStudy("Test001_OD", { fetch: async (url, options) => {
    assert.equal(url, "https://nada-demo.ihsn.org/index.php/api/catalog/Test001_OD");
    assert.deepEqual(options, { credentials: "omit", mode: "cors" });
    return new Response(JSON.stringify(fixture), { status: 200 });
  } });
  assert.equal(snapshot.title, "Popstan Synthetic Household Survey 2023");
  assert.match(snapshot.abstract, /national welfare monitoring survey/);
});

test("rejects cross-origin metadata APIs and inaccessible records", async () => {
  await assert.rejects(loadMetadataContext({ source: "nada", id: "X", apiBase: "https://other.example/api/" }), /current app's origin/);
  await assert.rejects(loadMetadataContext({ source: "metadata-editor", id: "X", apiBase: "http://localhost/index.php/api/", fetch: async () => new Response("denied", { status: 403 }) }), /HTTP 403/);
});

test("a host the SDK has never heard of supplies its own route and behaves identically", async () => {
  let requested;
  const snapshot = await loadMetadataContext({
    id: "WB-7",
    pointer: "/title",
    endpoint: (id) => `workbench/field/${id}`,
    params: ({ pointer }) => ({ pointer, locale: "en" }),
    unwrap: (data, { id, pointer }) => ({ id, pointer, value: data.result }),
    apiBase: "http://localhost/workbench/api/",
    fetch: async (url, opts) => {
      requested = { url: new URL(url), opts };
      return new Response(JSON.stringify({ result: "Census 2026" }), { status: 200 });
    },
  });
  assert.equal(requested.url.pathname, "/workbench/api/workbench/field/WB-7");
  assert.equal(requested.url.searchParams.get("pointer"), "/title");
  assert.equal(requested.url.searchParams.get("locale"), "en");
  assert.deepEqual(snapshot, { id: "WB-7", pointer: "/title", value: "Census 2026" });
});

test("an unknown source name fails with instructions, not a list of permitted hosts", async () => {
  await assert.rejects(loadMetadataContext({ source: "census-workbench", id: "WB-7" }), /endpoint\(id\)/);
});

test("the guards stay with the SDK even when the host owns the route", async () => {
  await assert.rejects(loadMetadataContext({ id: "", endpoint: (id) => `f/${id}` }), /valid project\/study ID/);
  await assert.rejects(loadMetadataContext({ id: "WB-7", pointer: "/a~zz", endpoint: (id) => `f/${id}` }), /JSON Pointer/);
  await assert.rejects(loadMetadataContext({ id: "WB-7", endpoint: (id) => `f/${id}`, apiBase: "https://other.example/api/" }), /current app's origin/);
});
