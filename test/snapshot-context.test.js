import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadContextSnapshot, pickStudySummary } from "../integrations/snapshot-context.js";

// The loader owns no routes: the caller supplies the endpoint, the query and the unwrapping, and the loader
// owns the guards. These tests therefore declare a route, which is what a host does.
const fieldRoute = {
  endpoint: (id) => `records/json_field/${encodeURIComponent(id)}`,
  params: ({ pointer }) => ({ path: pointer }),
  unwrap: (data, { id, pointer }) => {
    if (data.status !== "success" || !data.found) throw new Error(`Field ${pointer} was not found`);
    return { id, path: pointer, value: data.value };
  },
};

test("reads one field through the caller's route, query and unwrapping", async () => {
  let requested;
  const snapshot = await loadContextSnapshot({
    id: "TEST-1", pointer: "/identification/title", apiBase: "http://localhost/index.php/api/",
    ...fieldRoute,
    fetch: async (url, opts) => {
      requested = { url: new URL(url), opts };
      return new Response(JSON.stringify({ status: "success", found: true, value: "Household Survey" }), { status: 200 });
    },
  });
  assert.equal(requested.url.pathname, "/index.php/api/records/json_field/TEST-1");
  assert.equal(requested.url.searchParams.get("path"), "/identification/title");
  assert.equal(requested.opts.credentials, "same-origin");
  assert.deepEqual(snapshot, { id: "TEST-1", path: "/identification/title", value: "Household Survey" });
});

test("a catalogue route keeps only the bounded summary fields", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/catalogue-study.json", import.meta.url), "utf8"));
  const snapshot = await loadContextSnapshot({
    id: "Test001_OD", apiBase: "http://localhost/index.php/api/",
    endpoint: (id) => `catalog/${encodeURIComponent(id)}`,
    unwrap: (data, { id }) => pickStudySummary(data, id),
    fetch: async (url) => {
      assert.match(url, /catalog\/Test001_OD$/);
      return new Response(JSON.stringify(fixture), { status: 200 });
    },
  });
  // Three fields, whatever else the API returned: the summary is what reaches the model.
  assert.deepEqual(Object.keys(snapshot), ["idno", "title", "abstract"]);
  assert.equal(snapshot.idno, "Test001_OD");  // the response carries its own id, which wins
  assert.match(snapshot.title, /Popstan/);
  assert.match(snapshot.abstract, /national welfare monitoring survey/);
});

test("refuses a route on another origin, and reports an inaccessible record", async () => {
  await assert.rejects(
    loadContextSnapshot({ id: "X", apiBase: "https://other.example/api/", ...fieldRoute }),
    /current app's origin/,
  );
  await assert.rejects(
    loadContextSnapshot({ id: "X", apiBase: "http://localhost/index.php/api/", ...fieldRoute, fetch: async () => new Response("denied", { status: 403 }) }),
    /HTTP 403/,
  );
});

test("requires the caller to supply the route", async () => {
  // A loader with a table of routes is a loader with a list of known applications, which is what this one
  // deliberately does not have.
  await assert.rejects(loadContextSnapshot({ id: "X" }), /Pass endpoint\(id\)/);
});

test("bounds the id and the JSON pointer before any request", async () => {
  await assert.rejects(loadContextSnapshot({ id: "", ...fieldRoute }), /valid project\/study ID/);
  await assert.rejects(loadContextSnapshot({ id: "X", pointer: "not-a-pointer", ...fieldRoute }), /JSON Pointer/);
});
