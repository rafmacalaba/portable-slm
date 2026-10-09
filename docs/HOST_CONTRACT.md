# Host integration contract (draft `pslm-host/1`)

Goal: an arbitrary web app can integrate Portable SLM with **one optional JSON file and two lines
of markup**, without a JS bundler, without new backend endpoints, and without ever holding a
credential the SDK can see. Two worked hosts are documented in `examples/README.md`.

Design rule: every obligation we add to a host must pay for itself. Compliance cost is the
product's adoption rate, so the default path must be copy-and-open, not read-and-code.

## 1. Integration levels

| Level | Host does | Gets | Requires |
|---|---|---|---|
| **L0 drop-in** | copy `dist/` to `<docroot>/portable-slm/`, link `field-suggest.html#sid=<id>` | standalone assistant page, user pastes JSON | nothing else |
| **L1 manifest** | + serve `portable-slm/portable-slm.host.json` | auto same-origin context reads, task list, limits: no hardcoded paths in the bundle | L0 |
| **L2a embed, no context** | `<div data-pslm>` + one `<script src="portable-slm/embed.js">` | the panel in the page: chat, install, import, build stamp: and an explicit statement that it is ungrounded | nothing else |
| **L2b embed, record-scoped** | + `data-manifest` (or the default file) and `data-record-id` | grounded chat + field suggestor + Fill | L1 |
| **L3 owned UI** | host imports the npm ESM API | custom component, custom tools | bundler, `@wllama/*` asset imports |

All five exist today. L0 and L3 shipped first; **L1 and L2 are what turned "a fork per host" into
"an external component"**, because they are the levels where the bundle stops knowing the host.

### 1b. The panel degrades, it does not refuse

The two things a host can declare on the mount element are a manifest and a record id. Every
combination is a supported mode, and the ladder runs **down to a working chat** rather than up to an
error. A page that knows nothing about Portable SLM except how to include one script tag still gets
a usable assistant:

```
 manifest        record id →  chat         field suggest   fill        title
 ✗                ✗            self (a)       ✗              ✗          "Portable SLM · local assistant"
 ✓                ✗            self (a)       ✗              ✗          "{app.name} · local assistant"
 ✓ + context.app  ✗            app help (b)   ✗              ✗          "{app.name} · local assistant"
 ✓                ✓            record (c)     ✓              host opt-in "{app.name} · local assistant"
 ✗                ✓            refused — an id with no endpoint to resolve it is a misconfiguration
```

**(a) self**: no host source is attached. The assistant still carries Portable SLM's own shipped
context (§3c), so it knows what it is, and its provenance says
`no host context — answered from Portable SLM's own description only`.

**(b) app help**: the page is grounded in the application's own help text, and the on-screen notice
says *"answering from this application's help text, not from your project data"*. Useful on a page
that is a list of things rather than one thing.

**(c) record**: grounded in one record's saved metadata, read with the curator's own session.

Each mode carries its own system instruction (§3b), because each is a different claim about what the
model can see: an assistant with no snapshot told to answer "only from the snapshot" refuses every
question, and a grounded one told it may use general knowledge invents metadata.

The policy lives in one pure function, `mountMode()` in `host-contract.js`, so the tabs, the fill
button, the notice and the system prompt cannot disagree about what the mount is allowed to do.
Absent manifest = HTTP 404; **present-but-invalid is a hard stop**. A manifest that exists and does
not match `pslm-host/1` must never be silently ignored.

Nothing above L0 is mandatory. A host that only ships `dist/` still works.

### What a host does not write

The seams are generic; only the bindings are a host's. Before writing any of the following by hand, check
this list, each one is harness that ships with the SDK, and a second copy of it is a second thing to get
wrong:

| Need | Already provided | Host supplies |
|---|---|---|
| Mount the panel on a page | `embed.js` + `<div data-pslm>` | the div, its geometry and palette |
| Launcher button, dock resize handles, remembered panel size | `embed.js` (`data-launcher`, `data-resize`, `data-dock`, `data-persist-key`): created as `part="launcher"`, `part="resize-left"`, `part="resize-corner"` | where they sit and how they look, in CSS |
| Tell the assistant what the reader is looking at | `pslm-route-change` (host dispatches, SDK consumes) | one line in the router's `afterEach` |
| Authorized reads | `host-contract.js` from the manifest, incl. `fitToolResult` bounding | the endpoints, their ACL, the byte caps |
| Put a draft into a form | cancelable `pslm-fill-request` / `pslm-datafile-fill` | the form binding (the SDK never writes) |
| One line of feedback to the curator | `[data-pslm-note]` element | the element and its styling |
| A debug trail | `logging.js` + `buildLogPayload`/`logFieldsFor` | the endpoint ([§logging](#logging)) |
| Verify the integration | `host-check.html` | running it and pasting the report |
| Answer-quality signals | `completeness.js` (finished?), `byteCap`, `lexicalGrounding` | acting on them |

Nothing in that table is application-specific, which is the test: if a host finds itself writing
event forwarding, pointer maths, or a "did the model finish?" rule, it belongs upstream instead.

## 2. Host manifest (L1)

Served at `./portable-slm.host.json`, i.e. next to the bundle, the bundle discovers it by
relative URL, so the SDK never needs to know host routes. A host that keeps the manifest outside
the bundle (separate file in its own docroot, e.g. a Docker bind mount) points at it with
`data-manifest="<absolute path>"` on the mount element; `data-record-id` supplies the record.

```json
{
  "apiVersion": "pslm-host/1",
  "app": { "name": "Example App", "version": "1.0.0" },
  "context": {
    "app": {
      "url": "app.md",
      "maxBytes": 8192
    },
    "record": {
      "url": "/index.php/api/editor/json/{id}?exclude_private_fields=1",
      "maxBytes": 12288,
      "truncate": "tail"
    },
    "field": {
      "url": "/index.php/api/editor/json_field/{id}?path={pointer}",
      "pointers": [
        { "pointer": "/identification/title", "label": "Title" },
        { "pointer": "/study_info/abstract", "label": "Abstract" }
      ]
    },
    "credentials": "same-origin"
  },
  "tools": [ /* §4d: GET, same-origin, declared, approved per call. Absent = no tools. */ ],
  "models": { "mirror": "/models/" },
  "tasks": ["pslm.chat", "pslm.suggest-field"],
  "writeBack": false
}
```

Rules:

- `url` templates accept `{id}` and `{pointer}`; the SDK substitutes and nothing else. Absolute
  cross-origin `url` is rejected as today.
- **A manifest must declare at least one source**: `record`, `app`, or both. A manifest that declares
  neither is a config file that changes nothing, so it is rejected rather than silently mounting an
  assistant with no context. `app` is what a page that is *not about one record* can declare, help
  text, a glossary, a list. When both are declared and a `data-record-id` is present, the record
  wins.
- `credentials` is `same-origin` (send the browser's own cookies) or `none`. **There is no field
  for tokens or keys.** A host cannot pass a credential even if it wants to; that removes the
  single worst integration mistake.
- `maxBytes` is enforced by the SDK *and* recommended in the host endpoint. Truncation is reported
  in the UI, never silent.
- `writeBack: false` is the only accepted value in `pslm-host/1`. Omitting it means `false`.
- Unknown `apiVersion` → the bundle shows "this page targets pslm-host/1" and stops. No guessing.
- Unknown `tasks` id → the manifest is rejected outright. A typo such as `pslm.suggest` would
  otherwise read as "no tasks enabled" while the host believed it had switched one on. Omitting
  `tasks` means every task this build ships; naming the subset is how a host disables one, and a
  task that is not allowlisted gets **no tab**, not a disabled one.
- Missing manifest → L0 behaviour, everything still works.
- `models.mirror` is an optional same-origin directory holding the pinned GGUF files. Install tries
  the mirror first, then the upstream URL; SHA-256 verification stays client-side either way, so a
  mirror cannot substitute different bytes. The mirror needs HTTP range requests (the store
  downloads in 16 MB chunks).
- Host APIs that redirect an expired session to a login page with HTTP 200 and HTML are detected
  by content type and reported as "your host session has expired", not as a JSON parse error.

## 3. Context, not scraping

The SDK fetches only what the manifest lists, only after a user action, only with the host's own
session. No DOM scraping, no passive reads, no background refresh.

- **chat context**: the shipped description (§3c), plus one `context.record` or `context.app` fetch,
  capped, plus the conversation so far.
- **suggest-field context**: one `context.field` fetch for the chosen pointer.
- The UI always shows the exact snapshot sent (collapsible "What was sent"). Compliance and
  debugging are the same feature.
- **Record values are out of scope for `pslm-host/1`.** Metadata fields only: no case data, no
  variable values, no attachments. Microdata rows are the one thing a browser model must never see.

### 3b. What the bridge puts in the prompt

Three instructions, one per context mode, because each is a different claim about what the model can
see. `{app.name}` comes from the manifest and falls back to "this application"; nothing else is
dynamic:

| mode | when it applies | instruction |
|---|---|---|
| **record** | `data-record-id` + `context.record.url` | read-only assistant; answer using only the metadata snapshot; not in it → "not in the record"; never claim to save, publish or change anything |
| **app** | no record, `context.app.url` declared | answer using only the application help text; not in it → say so and name the page or field that would hold it; never claim to have opened, saved, published or changed a record |
| **none** | nothing declared | answer from what it knows and say when unsure; never claim to have read anything from the application |

Telling an assistant with no snapshot to answer "only from the snapshot" makes it refuse every
question; telling a grounded one that it may use general knowledge makes it invent metadata. The one
sentence per mode is the whole difference, and it is why "ungrounded" is a mode rather than an error.

That sentence, a blank line, and `Context from the host application:\n` + the composed context
(§3c) become **one** system message, see
[`CHAT.md` → How a string becomes a prompt](CHAT.md#how-a-string-becomes-a-prompt) for the assembly
and the numbers. A host that builds its own surface (L3) replaces the instruction by setting `system`
on `<pslm-chat>`; the assembly order is not host-configurable, on purpose, so results stay
comparable between hosts.

How to make the answers better, corpus shape, retrieval, evaluation, and why fine-tuning is the wrong
tool for "know our documentation", is [`ANSWER_QUALITY.md`](ANSWER_QUALITY.md).

The suggest tab does **not** use this text. It runs the separate `metadata-review` prompt with a
strict JSON schema, because a chat answer and a field draft are different contracts (see §4).

### 3c. Context composition: shipped first, appended after

Portable SLM ships its own context, `DEFAULT_CONTEXT` in `integrations/chat-core.js`, and puts it
at the top of every prompt on every surface, plain `<pslm-chat>` included:

```text
<the shipped description>

--- context supplied by this application ---
<whatever the host's onContext returned>
```

It states what the assistant is, that it runs inside the tab, that it cannot read the page or the
screen, that it cannot save or publish, that installing costs roughly 150, 230 MB of browser storage,
and that "not in the supplied context" is a correct answer. Those answers have to come from
somewhere, and leaving them to a few-hundred-million-parameter guess is how an assistant ends up
promising to save a draft.

**`composeContext()` is append-only by construction.** There is no option to replace, reorder or
drop the shipped block, because a host that could delete it could also delete the sentence that stops
the assistant claiming it wrote to your database.

Two consequences:

- **Grounding becomes honest about itself.** "I cannot save anything" is now *in* the context, so it
  reads as quoted rather than flagged as invented.
- **No host context is stated, not implied.** The provenance line reads
  `no host context — answered from Portable SLM's own description only`.

> **`context.app` carries no access control.** It is fetched under the same same-origin and byte cap
> rules as everything else, but a static file cannot check who is asking: **anything at that URL is
> readable by anyone who can reach the URL, and it goes into a prompt.** Put application
> documentation there, never user data, record identifiers, or anything you would not print in a
> public manual. Data belongs behind `context.record`, which is the endpoint that enforces the
> session.

## 4. Tasks

| id | input | output | notes |
|---|---|---|---|
| `pslm.chat` | record snapshot + user message | streamed prose | formatted by the SDK into DOM, never into HTML: see §4b |
| `pslm.suggest-field` | `{pointer, label, value}` + record snapshot | `{suggestion, reason}` JSON | `metadata-review` prompt, shape-checked, **decoration stripped**: see §4c |

Both keep today's fail-closed behaviour: unknown task id, malformed JSON, or oversized context is
an error shown to the user, not a silent retry. These ids are the code-level identifiers now
(`TASKS` in `integrations/host-contract.js`): `validateManifest` rejects a manifest that names a
task this build does not ship, and the panel builds its tabs from `allowsTask()`. A host's `tasks`
list has teeth, before this, it was a comment.

Adding a task is a portable-slm change, not a host change. Hosts only *allowlist* task ids.

### 4b. How an answer is formatted

A small model emits markdown, and a `<div>` that shows it raw is unreadable. The SDK formats answers
itself. A host never has to, and never gets to do it differently:

- **streamed as plain text, formatted once at the end.** Markup is not parseable until its pair
  closes in the middle of a token, and rendering again the DOM on every token makes the answer flicker
  and fights the scroll. The text you watch appear is the same text that later gets its bold.
- **a deliberately small subset:** fenced code, bullet and numbered lists, `#` headings, `**strong**`,
  `*em*`, `` `code` ``. `parseMarkdown` and `parseInline` in `chat-core.js` are pure functions
  returning data, so they are tested without a browser.
- **links are never clickable.** `[text](url)` renders as `text (url)`. A model this size invents
  URLs, and a hallucinated link the user can click is worse than one they cannot.
- **no `_emphasis_`.** `snake_case` and `house_hold` are ordinary metadata vocabulary; mangling an
  identifier is a worse defect than an unrendered underscore. Same reason `2 * 3 * 4` stays literal,
  emphasis requires content flush against both delimiters.
- **unmatched markers stay literal.** `**half a bold` is what the model wrote; swallowing the
  asterisks would silently edit the sentence.
- **model output never becomes HTML.** The renderer creates elements and sets `textContent`; there
  is no `innerHTML` in the path. An answer containing `<img onerror=…>` renders it as visible text
  and executes nothing, verified in Chrome, which is the only real defence when the *model* is the
  one producing markup.
- **user text is never formatted.** It is data. Formatting it would let a pasted `**` masquerade as
  the assistant's own emphasis.
- **the "what was sent" disclosure stays raw, always.** Audit output shows bytes that went in,
  markers included. Formatting an audit view defeats it.

### 4c. A suggestion is data, not prose

`pslm.suggest-field` output is destined for a metadata field, and a field cannot hold
`**National**`. Two layers protect it:

1. the system instruction says *"Write both values as plain text with no markdown: no asterisks,
   backticks or heading markers"*;
2. `parseSuggestion()` then runs `stripDecorativeMarkdown()` on both values, so a small model that
   ignores the instruction still cannot put decoration into a curator's record.

It removes **paired** markers only, `**x**`, `` `x` ``, a leading `#`, a leading list bullet, and
never an unpaired character. Losing one character the curator meant is worse than leaving one
asterisk behind. It happens in the shared parser rather than in each host's UI, so the value a host
receives is the value that will be typed into the field, and what the panel displays is what Fill
inserts.

### 4d. Declared tools (`tools`)

A tool is one **GET, same-origin** endpoint the model may ask for by name, the only way this
contract lets the assistant reach past the context it was handed.

```json
"tools": [{
  "id": "read_project_field",
  "label": "Read one declared field",
  "description": "Read one declared metadata field of the project currently open, as JSON.",
  "endpoint": "/index.php/api/editor/json_field/{id}?path={pointer}&exclude_private_fields=1",
  "maxBytes": 4096,
  "parameters": {
    "type": "object",
    "properties": { "pointer": { "type": "string", "enum": "$declaredPointers" } },
    "required": ["pointer"]
  }
}]
```

Rules, all enforced in `host-contract.js` at **mount** time. A typo in a tool declaration would
otherwise surface mid-conversation as a failed tool call the curator cannot interpret:

- `id` must be `lower_snake_case`, 2, 64 characters, because `runAgent` rejects anything else and the
  model would have spent a round to find out.
- `method` must be GET (default). This contract has no write path; a declared POST would be
  write-back (§6) wearing a different hat. See `docs/AGENT.md` for the contract question a
  job-submission tool raises.
- `endpoint` must start with `/`, and the built URL must still be same-origin when it is made.
- `{id}` is filled from the mount element's `data-record-id` and **never** from model output: a
  model-invented `id` must not read another curator's project through a tool declared for the record
  on screen. Arguments fill placeholders only for names in the declared `parameters`.
- `"enum": "$declaredPointers"` expands to this manifest's own `context.field.pointers`, so the
  model can ask only for a field the host declared without the host listing it twice.
- `maxBytes` caps the result before it reaches the prompt (default 4096).

Enabling is three things, not one: the manifest declares the tool, the mount element carries
`data-tools` **and** a `data-record-id`, and every single call shows its exact arguments and needs
**Allow**: tools are `network: true`, so `runAgent` drops them without `allow-network` and asks
`approveTool` before each call (`src/agent.js`). `host-check.html` calls each declared tool for the
same reason §7 checks the other endpoints: a tool the model can name but not reach is worse than no
tool.

## 5. Result envelope

```json
{
  "task": "pslm.suggest-field",
  "source": "Example App",
  "recordId": "6",
  "pointer": "/study_info/abstract",
  "suggestion": "…",
  "reason": "…",
  "formatValid": true,
  "model": "lfm2.5-350m-q4km",
  "modelSha256": "…",
  "engine": "webgpu",
  "latencyMs": 1840,
  "truncated": false
}
```

`formatValid` means JSON shape only. `model` + `modelSha256` make a draft auditable after the fact;
the pinned hashes already exist in `src/models.js`, so this is free provenance. `source` is the
host's declared `app.name`. A label saying whose metadata was read, never a gate: the SDK holds no
list of permitted hosts.

## 6. Applying a suggestion

Implemented: two paths, both human-triggered, both leaving the write to the host.

- **Copy**: always available. Puts the draft on the clipboard; the curator pastes it.
- **Fill this field**: offered only when the mount element carries `data-fill`, so a host that
  never listens is not shown a button that can only fail. One click dispatches a cancelable
  `pslm-fill-request` from the mount element and nothing else:

  ```js
  document.addEventListener("pslm-fill-request", (event) => {
    // detail: { task, recordId, pointer, label, suggestion, reason }
    const input = findMyOwnInput(event.detail.pointer);
    if (!input) return;                       // refuse, and say why
    input.value = event.detail.suggestion;
    input.dispatchEvent(new Event("input", { bubbles: true }));  // the host's own v-model path
    event.preventDefault();                   // acceptance: the panel reports "Filled"
  });
  ```

  `dispatchEvent()` returning `true` means nobody accepted, and the button says **Host did not
  accept** rather than implying success. The SDK never queries a host write API, never touches the
  host's store, and never saves: the text lands in an input as an unsaved edit, so `writeBack` is
  still `false` and host-side diff/review/save stays exactly as it is.

a host's listener is a few dozen lines with no build step, and it is worth a runnable fixture: one that
mounts a real form control and drives the handshake through the host's own model binding, asserting the
cases below. It refuses, loudly, in a host-styled note, when the pointer's field is not on the
current route, when the control is a controlled list or read-only, and when `recordId` is not the
project the panel opened.
A host whose form keys happen to match its JSON pointers (`/a/b` and `a.b`) needs no mapping file, which
is the case this contract was first written against; a host with different names maps them in its own fill
listener, where the CustomEvent arrives.

## 7. Acceptance page

Run it with `?manifest=<path>&sid=<record>` and, if this host logs the assistant, `&log=<path>`: the log
check has no default, because the endpoint is the host's own and a guessed route would report a 404 as a
result. A check whose source is not declared is reported as **skip**, never pass, an acceptance page that
certifies checks which never ran is worse than no page.

`portable-slm/host-check.html` runs what can be automated and prints the rest as a checklist:

```
build stamp ........................ PASS 0.1.0+08d8517 built 2026-10-05T23:48:17Z
apiVersion match ................... PASS pslm-host/1
read-only contract ................. PASS writeBack false, credentials same-origin
tasks allowlist .................... PASS pslm.chat, pslm.suggest-field
context.record same-origin ......... PASS /index.php/api/editor/json/1
cross-origin record url rejected ... PASS guard fired, no request sent
context.record within maxBytes ..... FAIL Project metadata: HTTP 401 — sign in as a curator
model mirror serves ranges ......... PASS /models/model-file.gguf 206
model installed (lfm2.5-350m-q4km) . WARN missing — install it once in the panel, then re-run
app shell cached offline ........... SKIP no shell cache — open /portable-slm/ once first
```

Run it **on the host origin, signed in as a curator**, with the record the test may read:
`…/portable-slm/host-check.html?manifest=/portable-slm.host.json&sid=6`. Without `manifest` it
looks beside the bundle, which is where an L1 host keeps it. It reports pass / warn / fail / skip,
warn is for a state that is legitimate today (no mirror declared, model not yet installed) and fail
for a contract violation, so a first run on a fresh host is expected to warn, not fail.

Two things about its design matter more than the list:

- Every guard is **imported from `embed.js`**, the file the panel actually loads. A second
  implementation of the same-origin check would only prove this page's copy passes.
- The checks that cannot be automated are printed as four numbered boxes at the bottom (inference
  with the network off, nothing left the origin, an expired session reads as an expired session, a
  filled field is not saved). **Copy report** puts the whole thing on the clipboard for the ticket.

### 7b. Upgrading a host

The bundle is a directory and the host is a manifest. That is what makes an upgrade small, and also
what makes an unsafe upgrade **invisible**, because a stale `dist/` looks exactly like a working one
until somebody asks a question that now behaves differently. So the procedure is a gate, not advice.

1. **Diff three files, not the codebase:** `integrations/host-contract.js`, this document's §3b/§3c,
   and `src/models.js`. A breaking change is only ever visible in those three, what the bridge puts
   in the prompt, and which model bytes are pinned.
2. `npm ci && npm run build:embed && node --test test/`. The unit suite needs no browser.
3. Replace `dist/` (bind mount in development, baked into the image in production), then **read the
   build stamp** in the panel bar: `0.1.0+<git sha>` is the only proof the bundle being served is the
   one just built. A stale mount is the most common failure this feature has, which is why the stamp
   is on screen rather than in a log. The same staleness bites the other way for files that are
   **baked** rather than mounted: a container image that copies the host's application code at build time
   will not pick up a view edit, and restarting the container cannot fix it. Rebuild, or copy the single
   file in and restart. This was found the
   hard way: a panel with a new `data-tools` attribute rendered without it.
4. Run §7 on the host origin, signed in as a curator, with a real record id. Every row PASS, or a
   named skip you can justify out loud.
5. Manual pass, five minutes: one chat question, one Suggest, one Fill, one install/remove cycle,
   then confirm the record did not change.
6. **If the pinned model or its `sha256` changed:** refresh the mirror and say so in the release note.
   Verification is by checksum, so a new pin against an unchanged mirror means every browser
   redownloads the file and every curator waits for it.

| SDK change | Host action |
|---|---|
| prompt assembly, sampling, grounding, answer formatting | none: rerun one chat answer and one suggestion |
| new manifest key, additive | optional; adopt when it buys a named behaviour |
| new task id | name it in the manifest's `tasks` |
| new pinned model, or a new `sha256` | refresh the mirror; curators redownload once |
| `apiVersion` bump | breaking by definition: adopt deliberately |

Additive keys stay compatible in both directions, and `context.app` is the evidence: it landed with no
version bump, an older bundle ignores it, a newer bundle works without it, and every manifest written
before it still validates.

Rollback is one directory. The host keeps nothing the bundle owns, no transcripts, no settings, no
state, except cached model bytes, which are content-addressed and survive either way.

This replaces the manual six-item list in `examples/README.md`, which stays as the definition of
"accepted". The page removes the recomputation per host, not the judgement.

## 8. Reference integration

One host's wiring, in files, is in [`../examples/README.md`](../examples/README.md): the endpoints it
declares, the panel view it mounts, the flag that switches the whole feature off, and the two gotchas it hit.
This document stays host-agnostic, so nothing here depends on reading that.

## 8b. CSS ownership and cache policy

The bundle styles its own structure with `:where()`-wrapped rules, **zero specificity**, so a host
stylesheet overrides any of it without `!important`. In exchange, the host keeps geometry and palette:

| Owned by | What |
|---|---|
| bundle (`embed.js`, `chat.js`) | tabs, panes, scrolling, transcript, composer, `part=` names, keyboard behaviour |
| host | position, width, height, z-index, palette, responsive breakpoints |

Two host rules, both found the hard way:

- **Never put geometry inline on the mount element.** `style="width:390px"` beats every stylesheet,
  including the host's own, so the host loses the ability to restyle its own panel. Put the size in a
  stylesheet.
- **Bust the bundle URL.** The built files ship without `Cache-Control`, so browsers apply heuristic
  freshness from `Last-Modified` and can serve a stale `embed.js` after a deploy without revalidating.
  Append a version query; `version.json`'s revision is the value that changes when the SDK does
  (`tools/site-pack.mjs` shows one implementation).

A size that survives real content, rather than a screenshot at the default height, is the thing to check:
a panel that fits an empty transcript and clips a long answer is the usual first defect.

## 8c. Logging

Optional, and the only thing in `pslm-host/1` that accepts a write, so it is specified separately and
narrowly. It is **not** part of the assistant's context and not reachable from the model: the bundle
never calls it. The host's own page listener does
([`integrations/logging.js`](../integrations/logging.js)), and the endpoint belongs to the host.

**Request.** `POST`, same-origin, one event per request, `application/json`:

```json
{"event":"answer","sid":"11","section":"Project overview","fileId":"",
 "q":"what is the title?","a":"Yearbook 2025","engine":"webgpu","ms":4210,
 "tools":["read_project_field"],"grounding":null,
 "complete":false,"completeReason":"plan-shaped","completeEvidence":"Let me check the next field as well.",
 "peakPrompt":9010,"window":65536,"generated":1205,"trimmed":0,"toolRounds":2,
"app":"example-app"}
```

`event` is one of `answer` · `error` · `state` · `suggest` · `tool` · `fill` · `fill_result` (the field
sets are `logFieldsFor()` in `integrations/logging.js`, and the events themselves are in
[CHAT.md](CHAT.md)). `sid`/`section`/`fileId` say what the reader was looking at, never what they may
read.

**The endpoint owns these, and must ignore them in the body:**

| key | why the client may not set it |
|---|---|
| `ts` | a body that timestamps itself can rewrite history |
| `user_id`, `user` | it comes from the host's own session; a forgeable one is not an audit trail |
| `sess` | ditto: hash the session id, do not store it whole |
| `ip` | take it from the connection |
| `event` | the endpoint's own validation decides what is a recordable event |

**Requirements.** Authenticate it (a curator session; unauthenticated requests are refused, not dropped
silently). Bound the body again. The client is not a trust boundary, and `MAX_FIELD_CHARS` only keeps
requests small. Fix the file path server-side; never from the body. Rotate at a size you choose. Keep the
file out of the web root or deny it there. Treat the content as curator text, not telemetry: it holds
questions, answers and draft metadata.

**Not required.** A log viewer, a database, retention policy, or any of it being enabled: logging is
off by default, and with no `url` the helper is inert so the panel mounts as usual.

## 9. Where FastAPI fits (and does not)

Decision for `pslm-host/1`: **FastAPI is not in the inference path.** The SDK is browser-only;
routing browser inference through the Python service would add a network hop, leak context to the
server, and destroy the offline property that justifies the project.

| Option | Verdict | Why |
|---|---|---|
| FastAPI as inference proxy for the browser | **reject** | breaks offline, moves context off the device, no benefit |
| FastAPI/PHP serving pinned GGUF as a LAN mirror (`download(model,{sources:[...]})`) | **adopt later, no FastAPI needed** | a static path under the host's own document root is same-origin and needs no new service; SHA-256 verification stays client-side |
| FastAPI `submit_metadata_review` as a *large-model* comparator for the same task ids | **adopt for benchmarking** | measures whether the 350M model is good enough; same prompts, two executors, curator-visible diff |
| Server-side task/prompt registry the bundle calls | **reject** | couples browser to server, kills offline, doubles the trust surface |
| Feeding DuckDB/variable statistics into the browser model | **reject for now** | crosses the "metadata only, never record values" line |

Net: FastAPI stays a *quality baseline* tool, not an integration dependency. Nothing in
`pslm-host/1` requires it.

## 10. Implementation status

Per-piece status, and what has and has not been run, is in [`STATUS.md`](STATUS.md) so that it has one home
instead of drifting into a contract document. This contract describes what must be true, not what is
currently built.

## 11. Open questions

- Does L2 need its own model setup, or may it reuse the model installed on the same origin?
  Same origin ⇒ same Cache storage, so reuse is free; document it.
- Multi-field suggestions (whole section at once) is the first thing hosts will ask for; it breaks
  the byte cap for 350M context. Needs a measured decision, not a guess.
- Whether `pslm-host/1` should allow a host-declared *read-only* tool. Tempting, and it reopens
  the whole tool-permission surface, default is no.
