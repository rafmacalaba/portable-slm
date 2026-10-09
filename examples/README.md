# Worked integrations

Two host applications shaped this SDK, and this directory is where everything about them lives. The core
documentation names no application: the contract is host-agnostic, and a host-specific detail belongs here
or in the runnable code beside this file.

Both hosts are open-source web applications with their own databases, sessions and access rules:

| host | what it is | shape it uses |
|---|---|---|
| **Metadata Editor** | a PHP record editor: projects, form templates, a curator ACL, a FastAPI worker for file processing | rung 2 + 3 — a record snapshot and one declared field, plus two suggestion tasks |
| **NADA** | a data catalogue: studies, collections, access policy, a public catalog API | rung 1 — application help text — plus one evidence-checked Q&A task |

Neither is a requirement of the SDK, and neither is special-cased in `src/`: everything they need is a
manifest, a task id, and their own endpoints.

## What a host of each shape has to supply

| | Metadata Editor | NADA |
|---|---|---|
| what it may read | `GET /index.php/api/editor/json/{id}?exclude_private_fields=1` — the export document, 24 KB cap, never observation rows | `GET /index.php/api/catalog/{id}` — one published study |
| narrowed read | `GET /index.php/api/editor/json_field/{id}?path={pointer}` — one field, 4 KB cap | the same route, trimmed to `{idno, title, abstract}` |
| session | the curator's own, via same-origin cookies | public demo sends no credentials at all |
| tasks | `pslm.chat`, `pslm.suggest-field`, `pslm.suggest-datafile-description` | `pslm.chat` |
| the write path | none: a draft reaches a form only through a human click, via `pslm-fill-request` | none: answers are read-only, with an evidence check |

The Metadata Editor manifest, as it actually ships:

```json
{
  "apiVersion": "pslm-host/1",
  "model": "lfm2.5-2.6b-onnx-q4f16",
  "context": {
    "app":    { "url": "/pslm-help.md", "maxBytes": 8192 },
    "record": { "url": "/index.php/api/editor/json/{id}?exclude_private_fields=1", "maxBytes": 24576 },
    "field":  { "url": "/index.php/api/editor/json_field/{id}?path={pointer}&exclude_private_fields=1",
                "maxBytes": 4096,
                "pointers": [ { "pointer": "/study_desc/study_info/abstract", "label": "Abstract" } ] },
    "credentials": "same-origin"
  },
  "models": { "mirror": "/pslm-models/", "available": ["lfm2.5-350m-onnx-q4f16"] },
  "tasks": ["pslm.chat", "pslm.suggest-field"],
  "writeBack": false
}
```

Everything in it is a declaration, not code: `context` says what may be read, `pointers` is the allowlist
the suggest tab and the tool enum draw from, `maxBytes` is the cap, and `writeBack: false` is the contract.

## What these hosts changed in the SDK

Both were built by reading the same documents a new host reads, and each one found something the contract
did not yet say. What was learned went upstream; what was specific stayed here.

| found by building a host | where it ended up |
|---|---|
| a tool result larger than its declared budget killed the turn | `fitToolResult` in the SDK, and a measured fit rather than a character count |
| the model's reasoning reached the reader on a retry round | every round is seeded; a repair that narrates the prompt is discarded |
| a bundle with a fixed name and no `Cache-Control` served stale after a deploy | the pack stamps `version.json`'s revision into the acceptance page; hosts bust the entry |
| context URLs were resolved against the page, so a nested base broke | manifest-relative resolution, in the SDK |
| `context.credentials` was validated and then ignored by every read | honoured, with one translation into the vocabulary `fetch()` accepts |
| an application-level document was assumed to be help text | `context.app.kind: "help" \| "content"` |
| a formless host could not offer a ranked read of a bigger corpus | the context ladder rung 4, documented rather than coded |
| one host's routes shipped as SDK defaults | removed: the caller declares its route, and the loader keeps none |

That last row is the rule these examples exist to demonstrate: **the SDK never learns an application's
routes, and an application never learns the SDK's prompt template.**

## How one host wired it, in files

The whole change in the record editor was a route and a view, not new business logic: its API already
exposed what the panel needed, with `exclude_private_fields=1` doing the hiding, so the manifest just named
the two endpoints.

```
portable-slm/                                      # L0: dist/ copied or bind-mounted
portable-slm/portable-slm.host.json                # L1: the manifest above
application/views/metadata_editor/pslm_panel.php   # L2: ~10 lines of markup, plus geometry and palette
vue-app/assets/pslm-fill.js                        # L2: the "Fill this field" listener
```

It is switched off unless the host turns it on:

```php
$config['editor']['portable_slm_enabled'] = (getenv('EDITOR_PORTABLE_SLM') === '1');
```

An integration a host can switch off is one a host will accept.

Two things it learned that are worth copying:

- **A route can be documented in a spelling the framework does not accept.** The published specification
  used `json-field`, and the framework handed that literal word to the controller as an id, so every field
  read failed with `IDNO-NOT-FOUND: json-field`. The manifest had inherited the specification's spelling,
  and nothing noticed until the acceptance page fetched a declared pointer end to end. A route mapping made
  both spellings work. The guard against the class is the acceptance page's `context.field resolves for a
  declared pointer` row: a declared endpoint must answer before a host is accepted.
- **A view that reads an id from its parent view silently renders nothing.** The framework gives each loaded
  view its own scope, so the record id had to be passed down explicitly. The symptom was an empty
  `data-record-id`, which looks like a missing record rather than a missing argument.

The deployment note: the bundle, the manifest and any model mirror are separate read-only mounts rather than
nested paths, because a container runtime cannot create a mount point inside a read-only bind mount.

## Running what is here

```sh
npm run dev        # /                    chat and model manager
                   # /catalogue-qa.html   catalogue Q&A, evidence-checked
                   # /field-suggest.html  snapshot → local suggestion draft
                   # /benchmark.html      12 authored general-task cases
```

- `catalogue/public-catalogue-demo.js` — reads one study from a public catalogue demo host, with no
  credentials, and trims it to `{idno, title, abstract}`. This is the one file here that names a specific
  host, because a caller has to: the SDK takes the route **from the caller**.
- `../demo/field-suggest-view.js` — mounts `mountContextWidget` with two shapes (a catalogue study and a
  record field), which is the smallest honest example of a host declaring what it can read.
- `../demo/catalogue-qa-view.js` — the evidence-checked Q&A view: it asks the model for a verbatim quote
  and checks that the quote occurs in the snapshot it sent.

## Running these integrations

Two paths, and the first needs no extension:

**Path A — browser only.** Open the app once while online so the shell and model are cached. Load one
published study from the public catalogue demo, inspect the title and abstract, then ask about it. The model
runs locally and the app checks whether the model's evidence quote appears in the source; an unverified
answer is marked as such and has to be checked by a person. Turn off the network and reopen the same origin:
the saved snapshot and the cached model still answer. Opening a new catalogue page still needs the
catalogue's server — local inference does not make a server-backed application offline.

**Path B — Chrome side panel.** Only where an organization's extension policy allows it, and never by
switching to a different Chrome build to evade that policy. It runs the same SDK in its own page, and
`activeTab` grants temporary access to the page the user is on.

For a record editor, the honest trial is a **sanitized snapshot**: export a bounded field or record through
the organization's own approved workflow, paste it, and ask for a suggestion locally. Do not paste
credentials or restricted data into a page hosted elsewhere, and note that this does not exercise the
host's live authentication.

## Honest limits of these two

- A suggestion is a draft with a reason. It is not schema-validated against the host's template, and it is
  not a factual claim: the host validates, a human approves, and only then does anything change.
- The evidence check proves a quote occurs in the snapshot. It does not prove the interpretation is right.
- Both hosts were exercised on a laptop and a phone. Anything else is unverified until it is run — see
  [`../docs/DEVICE_VALIDATION.md`](../docs/DEVICE_VALIDATION.md).
- The metadata editor's live authenticated API was exercised against a local deployment, with fixtures in
  the automated tests. A private deployment with different access rules should be re-checked, which is what
  [`../portable-slm/host-check.html`](../integrations/host-check.html) is for.
