# Context providers — how a host feeds the assistant

`<pslm-chat>` has no idea what a survey, a study or a metadata field is. Everything it knows about
the record on screen comes from one async callback:

```js
chat.onContext = async (question) => {
  // return the text to place in the system message, or throw
};
```

That single seam is what keeps the component general and the host in charge of its own permissions.

It is called **once per question**, with that question as its argument, and the turn is aborted if it
throws. Ignoring the argument is fine — a host that returns the same snapshot every turn is a correct
provider — but the argument is what makes *retrieval* possible instead of corpus-dumping. What to do
with that freedom, and what not to do with it, is
[`ANSWER_QUALITY.md`](ANSWER_QUALITY.md).

## Division of labour

The seam is one function, so it is worth being exact about which side of it each responsibility
sits on. A host that understands this row list can build a provider for any web application; the
left column is fixed, the right column is entirely the host's.

| Concern | `<pslm-chat>` (fixed) | The host (yours) |
|---|---|---|
| when context is read | once per question, at send time | — |
| where it comes from | does not know, cannot look | route, query, filters |
| who is allowed to see it | never decides | session, ACL, `exclude_private_fields`-style flags |
| size limit | applies none | byte cap, stated in the returned text |
| prompt shape | system + context → one system message, then trimmed history, then the question | may set `system`, not the assembly |
| what the model is told about itself | `system` attribute is passed through verbatim | writes it |
| sampling, history depth, caps | owns them | should not override per question |
| disclosure | shows the exact string sent | must not lie about it |
| grounding check | compares answer to the string it sent | — |
| failure handling | aborts the turn, prints the message | message must say what to do |
| writes | none, structurally | owns save, review, publish |

Two rows are the ones hosts most often get wrong. **Size**: the component will happily send a 400 KB
string into an 8 K-token window and the engine will fail opaquely — the cap is yours. **Failure
message**: "HTTP 401" is a symptom; "sign in as a curator with access to this project" is a
diagnosis, and the component prints whatever you throw at it.

**No provider is a supported mode, not a failure.** A host that attaches nothing still gets
Portable SLM's own shipped description in the context — append-only, so nothing a host does can delete
it — and the provenance then reads `no host context — answered from Portable SLM's own description
only`, with no grounding claim about the user's data. That is what makes the component droppable into
a page it knows nothing about, and it is why the bundled panel (`embed.js`) mounts happily with no
manifest at all rather than erroring for lack of one.

Between "nothing" and "one record" there is a third thing a host can supply: **application-level
text** — help pages, a glossary, a list of things the user is looking at. The bundled panel reads it
from a declared `context.app` URL, same-origin and byte-capped like any other source. It grounds
answers *about the application*, never about the user's data, and the panel says which on screen.
Because a static file cannot check who is asking, that source must hold documentation and nothing
else — see [`HOST_CONTRACT.md` §3c](HOST_CONTRACT.md#3c-context-composition-shipped-first-appended-after).

## The rules

**The host owns its routes.** The SDK contains no endpoint paths. A host manifest or adapter says
which endpoint supplies context; the component receives a string.

**Inherit the user's authority, never bypass it.** Fetch with the session the page already has:

```js
const res = await fetch(url, { credentials: "same-origin" });
```

The assistant then sees exactly what the curator sees — no more. This is the whole access-control
story: signed out, the request fails and the panel says so; a project the user cannot open yields
403 and no metadata. There is no second credential to leak, and no service account sitting between
the browser and the host API.

**Cap it.** The context is re-sent on every question, so a cap is a correctness control, not a
hint. Truncate in bytes and say so inside the text, so both the disclosure and the model see it:

```js
const { text, truncated } = byteCap(body, 12288);
return truncated ? `${text}\n… truncated to fit the byte cap` : text;
```

**Expect an expired session as HTML.** Many server frameworks redirect to a login page with HTTP
200 and `text/html`. Checking the content type is what turns that into "sign in again" instead of a
JSON parse error.

**Refetch every turn.** Do not cache the record in the component. Curators edit while they ask, and
a stale snapshot produces confident advice about a field that no longer says that.

**No writes.** There is no path from the component to a host write API. Suggestions are copied by
the user; the host application's own save, review and publish flow stays the only way anything
changes.

## Worked example: Metadata Editor

The host adapter lives in `integrations/embed.js`, the manifest in the host repository:

```json
{
  "apiVersion": "pslm-host/1",
  "context": {
    "record": { "url": "/index.php/api/editor/json/{id}?exclude_private_fields=1", "maxBytes": 12288 },
    "field":  { "url": "/index.php/api/editor/json_field/{id}?path={pointer}", "maxBytes": 4096,
                "pointers": [ { "pointer": "/study_desc/study_info/abstract", "label": "Abstract" } ] },
    "credentials": "same-origin"
  },
  "models": { "mirror": "/pslm-models/" },
  "writeBack": false
}
```

```js
chat.ai = ai;                       // one engine shared with the field-suggest tab
chat.model = state.model;
chat.system = "Answer using only the snapshot… never claim to save or publish.";
chat.onContext = async () => {
  const record = await fetchRecord(manifest, root.dataset.recordId);   // {id} substituted, encoded
  return record.truncated ? `${record.text}\n… truncated to fit the byte cap` : record.text;
};
```

Only `{id}` and `{pointer}` are substituted, and they are URI-encoded, so a manifest cannot smuggle
a dynamic segment into a request. The URL's origin is checked against the page before any fetch.

What the model receives for a microdata project (measured): 7 618 bytes — `doc_desc`, `study_desc`,
`tags`, `data_files`, `variables`, `variable_groups`. Descriptive metadata and the data dictionary.
Not observation rows, which this endpoint never returns.

The field-suggest tab deliberately uses the narrower `field.url` so that improving one abstract
ships `{ pointer, value }` — never the whole record.

## Sketch: a catalogue host

```js
chat.onContext = async () => {
  const res = await fetch(`/index.php/api/dataset/${encodeURIComponent(idno)}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Catalogue returned HTTP ${res.status}`);
  const { doc_desc, study_desc, var_desc } = await res.json();
  return JSON.stringify(byteCap({ doc_desc, study_desc, var_desc }, 12288).text);
};
```

Same component, same rules, different vocabulary — that is the point.

## Checklist before shipping a provider

- [ ] endpoint is the same one the host UI uses, with the user's own session
- [ ] byte cap applied, truncation stated in the returned text
- [ ] failure message says what to do (sign in again, open the record, check access)
- [ ] `writeBack` stays false; nothing in the panel can mutate the record
- [ ] "What was sent to the model" inspected by a human on a real record — it is the audit artefact
- [ ] tested signed out, on a record the user cannot open, and on a record that trips the cap

A worked host, in the host's own repository rather than here: the Metadata Editor's side of this
division is documented in `metadata-editor-docker` → *Companion assistant → Who owns the prompt*.
