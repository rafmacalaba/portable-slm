// The context reads are the code path that decides what reaches the model, so they are tested without a
// browser: `fetch`, `origin` and the manifest are all injected. These assertions are why the module exists —
// fetchApp/fetchRecord/fetchField used to live in embed.js, which imports the chat element and cannot be
// imported in Node, and `context.credentials` was consequently ignored by every read with no test to notice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextCredentials, fetchApp, fetchField, fetchJson, fetchRecord } from "../integrations/context-read.js";
import { validateManifest } from "../integrations/host-contract.js";

const ORIGIN = "https://app.example";
const jsonResponse = (body, { status = 200, type = "application/json" } = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });

/** A fetch stub that records what each read was asked for. */
const recorder = (reply) => {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return reply(String(url), init); },
  };
};

const manifest = (overrides = {}) => validateManifest({
  apiVersion: "pslm-host/1",
  app: { name: "App", version: "1.0.0" },
  context: {
    app: { url: "app.md", maxBytes: 8192 },
    record: { url: "/api/record/{id}", maxBytes: 4096 },
    field: { url: "/api/record/{id}/field?path={pointer}", maxBytes: 2048, pointers: [{ pointer: "/title", label: "Title" }] },
    credentials: "same-origin",
    ...overrides,
  },
  writeBack: false,
});

test("the declared credentials are what every context read sends", async () => {
  // The bug this replaces: `credentials: "none"` was validated, honoured for declared tools, and ignored by
  // fetchApp/fetchRecord/fetchField, which hardcoded same-origin. A public document on an authenticated
  // origin was read with the user's cookies.
  const none = manifest({ credentials: "none" });
  // The manifest says "none"; fetch says "omit". Asserting the manifest word would let the throw through.
  assert.equal(contextCredentials(none), "omit");
  assert.ok(["omit", "same-origin", "include"].includes(contextCredentials(none)));
  const app = recorder(() => new Response("# doc", { headers: { "content-type": "text/markdown" } }));
  await fetchApp(none, ORIGIN, { fetch: app.fetch, origin: ORIGIN });
  assert.equal(app.calls[0].init.credentials, "omit");

  const rec = recorder(() => jsonResponse({ id: 1 }));
  await fetchRecord(none, "1", ORIGIN, { fetch: rec.fetch, origin: ORIGIN });
  assert.equal(rec.calls[0].init.credentials, "omit");

  const field = recorder(() => jsonResponse({ status: "success", found: true, value: "T" }));
  await fetchField(none, "1", "/title", ORIGIN, { fetch: field.fetch, origin: ORIGIN });
  assert.equal(field.calls[0].init.credentials, "omit");

  // And the default stays the page's own session, which is the access-control story.
  const own = manifest();
  assert.equal(contextCredentials(own), "same-origin");
  const dflt = recorder(() => jsonResponse({ id: 1 }));
  await fetchRecord(own, "1", ORIGIN, { fetch: dflt.fetch, origin: ORIGIN });
  assert.equal(dflt.calls[0].init.credentials, "same-origin");
});

test("a context URL that leaves the origin is refused before any request", async () => {
  let called = false;
  const fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(
    fetchRecord({ context: { record: { url: "https://evil.example/{id}" } } }, "1", ORIGIN, { fetch, origin: ORIGIN }),
    /must be same-origin/,
  );
  assert.equal(called, false, "no request may be sent for a cross-origin declaration");
});

test("a relative path resolves against the manifest's directory; an absolute one does not", async () => {
  // Relative is what lets a host serve the pack at "/", at "/portable-slm/", or under any nested base.
  const app = recorder(() => new Response("# doc", { headers: { "content-type": "text/markdown" } }));
  await fetchApp(manifest(), "https://app.example/portable-slm/", { fetch: app.fetch, origin: ORIGIN });
  assert.equal(app.calls[0].url, "https://app.example/portable-slm/app.md");

  const rel = manifest();
  rel.context.record.url = "record/{id}";
  const rec = recorder(() => jsonResponse({ id: 1 }));
  await fetchRecord(rel, "7", "https://app.example/deep/base/", { fetch: rec.fetch, origin: ORIGIN });
  assert.equal(rec.calls[0].url, "https://app.example/deep/base/record/7");

  // An absolute path is still absolute — which is what API routes should be.
  const abs = recorder(() => jsonResponse({ id: 1 }));
  await fetchRecord(manifest(), "7", "https://app.example/deep/base/", { fetch: abs.fetch, origin: ORIGIN });
  assert.equal(abs.calls[0].url, "https://app.example/api/record/7");
});

test("each source applies its own byte cap and reports truncation", async () => {
  const big = "x".repeat(20000);
  const app = recorder(() => new Response(big, { headers: { "content-type": "text/markdown" } }));
  const capped = await fetchApp(manifest(), ORIGIN, { fetch: app.fetch, origin: ORIGIN });
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 8192, `app cap not applied: ${capped.text.length}`);

  const field = recorder(() => jsonResponse({ status: "success", found: true, value: big }));
  const small = await fetchField(manifest(), "1", "/title", ORIGIN, { fetch: field.fetch, origin: ORIGIN });
  assert.ok(small.text.length <= 2048, `field cap not applied: ${small.text.length}`);
  // The capped value is the serialized `{pointer, value}` cut to the cap — truncation produces text that is
  // no longer parseable JSON, which is expected: it is prompt input, and the flag is what says so.
  assert.ok(small.text.startsWith('{"pointer":"/title"'), small.text.slice(0, 40));
  assert.equal(small.truncated, true);
});

test("an expired session and an HTML help page are diagnosed, not parsed", async () => {
  const unauthorised = recorder(() => new Response("", { status: 401 }));
  await assert.rejects(fetchRecord(manifest(), "1", ORIGIN, { fetch: unauthorised.fetch, origin: ORIGIN }),
    /sign in as a curator/);

  // HTTP 200 with HTML is how many frameworks serve a login redirect, and pasting a login form into a prompt
  // would be a strange way to describe an application.
  const loginPage = recorder(() => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(fetchRecord(manifest(), "1", ORIGIN, { fetch: loginPage.fetch, origin: ORIGIN }),
    /session has expired/);
  await assert.rejects(fetchApp(manifest(), ORIGIN, { fetch: loginPage.fetch, origin: ORIGIN }),
    /returned HTML, expected text/);
});

test("a missing declaration names the missing key rather than failing later", async () => {
  await assert.rejects(fetchApp({ context: {} }, ORIGIN, { fetch: async () => jsonResponse({}), origin: ORIGIN }),
    /no context\.app\.url/);
  await assert.rejects(fetchJson("/x", "Thing", { fetch: async () => new Response("nope", { headers: { "content-type": "text/plain" } }) }),
    /Thing: received HTML/);
});
