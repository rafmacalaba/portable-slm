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
  assert.equal(requested.url.pathname, "/index.php/api/editor/json-field/TEST-1");
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
