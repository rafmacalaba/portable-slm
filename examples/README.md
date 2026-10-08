# Worked examples: NADA / Metadata Editor consumers

These adapters show two host integrations; Portable SLM is not built exclusively for NADA or
Metadata Editor. The core SDK is host-agnostic, and other browser apps can provide their own bounded
context and task UI.

**Primary NADA laptop workflow is study Q&A at `/nada.html`.** This page is an older generic
metadata-suggestion example, not a requirement of either upstream app.

`integrations/metadata-context.js` fetches authorized metadata from the **current application's
origin**, never from the AI host. It supports:

- NADA `GET /index.php/api/catalog/{IDNo}` → bounded ID, title, abstract.
- Metadata Editor `GET /index.php/api/editor/json_field/{id}?path=<JSON Pointer>` → one field
  (with `exclude_private_fields=1`).

It uses the application's existing same-origin credentials and refuses cross-origin API bases.
These endpoints are documented in the two upstream repositories. The request only happens when
a user clicks **Read from this app's API**; users can inspect/edit the snapshot first.

`examples/metadata-review.js` builds the prompt and validates a small JSON suggestion. This
**suggestion + reason** format is a demo design decision, not a NADA or Editor API field. The
`TEST-2030` data on `/review.html` is a fictional hardcoded input, not a hardcoded model answer.
The model generates the reply on each run (temperature 0 makes repetition likely). The standalone
`/review.html` page uses the same locally installed model as chat. On the public
Hugging Face Space, there is **no private NADA/Editor API** at that origin. The separate
**Load public NADA demo study** button fetches one published Popstan record without credentials;
use pasted-snapshot mode for any private Editor project.
To exercise the API button, host that page/JS under your authenticated NADA or Editor origin, or
mount the reusable widget (`integrations/metadata-widget.js`) inside the existing frontend. The
widget renders a bounded preview, suggestion and reason; it never calls a write API.

```js
import { mountMetadataWidget } from "./integrations/metadata-widget.js";
// ai = one createLocalSLM instance shared by the consuming app. Host bundles wllama
// JS/WASM locally and installs/imports the same pinned GGUF on its own origin.
mountMetadataWidget(document.getElementById("ai-metadata-review"), ai, {
  source: "metadata-editor", recordId: projectId, path: "/identification/title",
});

// Lower-level pieces for a custom Vue/React component:
import { loadMetadataContext } from "./integrations/metadata-context.js";
import { reviewMessages, parseReview } from "./examples/metadata-review.js";

// Inside the authenticated Metadata Editor frontend; ai is an installed/loaded
// createLocalSLM instance, with JS/WASM served from this same origin.
const snapshot = await loadMetadataContext({
  source: "metadata-editor", id: projectId, path: "/identification/title",
});
showSnapshotForReview(snapshot); // explicit user consent before inference
const reply = await ai.generate(reviewMessages("metadata-editor", snapshot), {
  maxTokens: 192, temperature: 0, response_format: { type: "json_object" },
});
const suggestion = parseReview(reply.text);
showSuggestionAndDiff(suggestion); // human approves; NO automatic writeback
```

For NADA use `source: "nada"` and its IDNo. If offline, paste an exported JSON snapshot instead;
these PHP/database-backed applications themselves do not work offline without their own caching.
Suggestions never save, publish or modify a record. `parseReview` checks shape and length, **not
factual correctness**; use app schema validation and human review before manually applying anything.

`npm run e2e` intercepts both same-origin API calls with authorized response fixtures, checks the
bounded snapshots, produces a read-only suggestion, then repeats suggestion offline from a pasted
snapshot. Real authenticated deployments remain to be validated within each upstream application.
