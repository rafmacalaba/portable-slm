# Chat — the vanilla distribution

`<pslm-chat>` is Portable SLM's primary surface: a framework-free custom element that installs,
loads and talks to a verified local model in the browser tab. It knows nothing about any host
application. Context arrives through one callback; inference never leaves the device; nothing it
renders can write to a host.

Ships as:

| Artifact | Use |
|---|---|
| `dist/chat.js` | self-contained ES module, no bundler, no dependencies at runtime |
| `dist/chat.html` | the standalone page — 40 lines of markup, proof that no host is needed |
| `dist/embed-assets.json` + `dist/embed-assets/` | wasm and worker URLs, resolved next to the script |
| `portable-slm/chat` | npm export for bundled hosts (`import "portable-slm/chat"`) |
| `portable-slm/chat-core` | pure logic (tool policy, message assembly, grounding) without DOM |

```sh
npm run build:embed        # builds embed.js + chat.js + chat.html + assets into dist/
npx serve dist             # then open /chat.html
```

## Mount it

```html
<pslm-chat model="lfm2.5-350m-q4km" tools="offline"
           system="Say when you are unsure."></pslm-chat>
<script type="module" src="/portable-slm/chat.js"></script>
```

That is a working product: install button, resumable SHA-256-verified download, optional import
from a local `.gguf`, model loading, streaming answers, Stop, tool approval, transcript, and a
provenance line under every answer.

The **panel** (`embed.js`, the tabbed surface hosts embed) inherits the same property: with no
manifest and no record it mounts as a plain assistant, still carrying Portable SLM's own shipped
description, rather than refusing because it was never told what the page is about. A host that wants
more than that on a record-less page can declare `context.app` — help text the assistant is then
grounded in. See
[`HOST_CONTRACT.md` §1b](HOST_CONTRACT.md#1b-the-panel-degrades-it-does-not-refuse).

Asked *"shouldn't this be built in React / Vue / lit?"* — open `framework-options.html` in the
bundle. It compares the six realistic options against the requirement that actually decides it: the
widget has to mount in hosts it did not choose. Short answer: the widget stays a custom element, and
each host wraps it in about ten lines of its own idiom.

## Attributes

| Attribute | Default | Meaning |
|---|---|---|
| `model` | `lfm2.5-350m-q4km` | id from the pinned model registry |
| `system` | — | system instruction, prepended to every request |
| `tools` | `offline` | `none` \| `offline` \| `all` \| comma-separated tool names |
| `allow-network` | absent | required in addition to `tools="all"` before any online tool is offered |
| `ctx` | `32768` | context window, applied when the element creates its own engine |
| `max-tokens` | `256` | generation cap |
| `max-history` | `6` | prior messages kept (3 exchanges) |
| `placeholder` | `Ask the model…` | composer placeholder |
| `no-model-bar` | absent | hide install/import/status chrome — the host renders its own |

On the **mount element** a host may also ask the bundle for the panel chrome, so it does not have to
write the launcher and the dock resize itself (see HOST_CONTRACT.md §"What a host does not write"):

| Mount attribute | Default | Meaning |
|---|---|---|
| `data-launcher` | absent | create a launcher button with this label and start the panel hidden; it becomes `part="launcher"` |
| `data-launcher-hide` | `Hide assistant` | the label while the panel is open |
| `data-resize` | absent | create the dock resize handles, `part="resize-left"` and `part="resize-corner"` |
| `data-dock` | `right` | `right` \| `left` — which edge the panel is anchored to, so a drag grows the right way |
| `data-persist-key` | `pslm-panel-size` | localStorage key for the remembered size |

Both are opt-in, so a bare `<div data-pslm>` behaves exactly as before. The host keeps geometry and
palette in its own CSS; the bundle owns only the behaviour.

## Properties

```js
const chat = document.querySelector("pslm-chat");

chat.ai = myExistingEngine;                 // share one loaded model across surfaces
chat.model = "lfm2.5-230m-q4km";            // reflected to the attribute
chat.system = "Answer only from the context.";
chat.tools = myOwnTools;                    // replaces defaultTools()
chat.onContext = async (question) => await snapshotFor(question);  // seam, see CONTEXT_PROVIDERS.md
chat.onAnswer = ({ text, context, grounding }) => …;
chat.approveTool = async ({ name, args }) => myUi.confirm(name, args);  // replaces the built-in dialog
chat.clear();
chat.history;                               // read-only transcript messages
```

Setting `chat.ai` is how a host with several surfaces avoids loading the model twice — the
Metadata Editor panel does exactly this, sharing one engine between chat and field suggestion.

## Events

The complete host-facing surface. Everything here is app-agnostic and stable; `completeness` and the
`pslm-tool` stages are what a host should log or act on when a turn does not finish the way it should.

| event | fires | detail |
|---|---|---|
| `pslm-answer` | a turn finished | `question`, `text`, `context`, `sources`, `engine`, `ms`, `grounding`, `tools`, `completeness`, `usage` |
| `pslm-error` | the turn threw | `message` |
| `pslm-tool` | every tool stage | `stage`, `name`, `args`, `network`, plus per-stage `dropped` / `cap` / `bytes` / `digest` / `reason` / `message` |
| `pslm-suggest` | a Suggest-tab draft resolved | `task`, `model`, `engine`, `pointer`, `label`, `fileId`, `formatValid`, `suggestion`, `reason`, `error`, `raw` |
| `pslm-state` | any status line | `text`, `tone` (`""`, `warn`, `err`) |
| `pslm-fill-request` | *cancelable* — a field draft is offered to the host | `recordId`, `pointer`, `label`, `suggestion` |
| `pslm-datafile-fill` | a data-file description draft is offered | `fileId`, `suggestion`, accept/deny callbacks |
| `pslm-route-change` | **host → SDK**: what the reader is looking at | `section`, `fileId` |

`pslm-tool` stages, in the order a turn can produce them: `call` → `result`, or `repeat` (identical call
already run), `refused` (valid call, but the turn had spent its `MAX_TOOL_CALLS` budget), `capped`
(surplus calls in a one round, over `MAX_CALLS_PER_ROUND`), `failed` (the tool threw; the error goes back
to the model), `truncated` (result cut to `maxResultBytes`), `digested` (oversized result replaced by an
isolated summariser turn).

**`completeness` is the answer to "did it finish?"** — `{ ok, reason, evidence }` from
`src/completeness.js`, where `ok: false` with `reason` `empty` | `plan-shaped` | `truncated` means the
text is *not* an answer. A plan-shaped reply is the observed case: the model's next step presented as
the answer. The panel prints a ⚠ note for it, and a host that logs gets `complete` / `completeReason` /
`completeEvidence` from `integrations/logging.js` for free.

**`usage`** is `{ peakPromptTokens, promptTokens, generatedTokens, trimmed, rounds, toolRounds }`.
`peakPromptTokens` is the largest prompt any round carried — the real pressure on the context window —
because every round re-sends the whole history while the KV cache saves only the prefill compute. See
[ANSWER_QUALITY.md](ANSWER_QUALITY.md) for the measured arithmetic.

```js
document.addEventListener("pslm-answer", ({ detail }) => {
  if (!detail.completeness.ok) log.warn(`not an answer: ${detail.completeness.reason}`);
  log.info(`${detail.usage.peakPromptTokens} of ${detail.usage.windowSize} tok · ${detail.toolRounds} rounds`);
});
document.addEventListener("pslm-error", ({ detail }) => …);   // { message }
```

Errors surface in the status line too, so a page with no listeners still tells the user what
happened instead of failing silently.

### Logging a host's own debug trail

Do not write this by hand. [`integrations/logging.js`](../integrations/logging.js) attaches to the
panel and forwards every event above to an endpoint of yours, one JSON line per event, with the field
selection and bounds already decided:

```js
import { attachAssistantLog } from "/portable-slm/logging.js";
attachAssistantLog(document.querySelector("[data-pslm]"), {
  url: "/index.php/api/editor/pslm-log",       // the only required option
  extra: () => ({ app: "metadata-editor" }),   // host context, reserved keys stripped
});
```

The endpoint you implement is specified in
[HOST_CONTRACT.md §logging](HOST_CONTRACT.md#logging): it owns identity and time, bounds the body, and
appends the line. Offline note: the URL and the endpoint are same-origin, and a failed log never
surfaces in the conversation.

## Theming

Everything is exposed as CSS parts, so a host styles the component instead of forking it:

```css
pslm-chat::part(bubble)     { border-radius: 4px; }
pslm-chat::part(send)       { background: #0b5394; }
pslm-chat::part(prov)       { font-variant-numeric: tabular-nums; }
```

Parts: `bar`, `state`, `model`, `install`, `import`, `stop`, `log`, `bubble`, `prov`, `sent`,
`composer`, `input`, `send`, `approve`, `approve-title`, `approve-args`, `approve-yes`,
`approve-no`.

## Install is not load

Two steps, two costs:

- **install / import** — bytes into the Cache API, verified against the pinned SHA-256. Resumable,
  survives reloads, per browser origin.
- **load** — the model into engine memory. Lazy, on first send, and a no-op afterwards.

A panel that says `ready` has the bytes, not the model. The status line shows both:
`LFM2.5-350M (Q4_K_M) · webgpu · single-thread`. `single-thread` is expected on origins without
COOP/COEP headers — adding those headers to an existing host application can break its other
assets, so it is a host decision, not a component default.

## How a string becomes a prompt

`onContext` returns a string. What the model is actually shown is assembled here, in the component,
and a host does not get to change that shape — which is what makes behaviour comparable across
hosts. One turn:

```
send(question)
  ├─ host = await onContext(question)     refetched every turn; a throw aborts the turn
  ├─ { text } = composeContext(host)      shipped description, then the host's text appended
  ├─ disclosure = text                    shown verbatim, before generation
  ├─ buildMessages({ system, context: text, history, question, maxHistory })
  │     instructions = [system, "Context from the host application:\n" + text]
  │                      .filter(Boolean).join("\n\n")
  │     messages = [{role:system, content:instructions},
  │                 ...history.slice(-maxHistory),
  │                 {role:user, content:question}]
  ├─ tools = resolveTools(...)            [] ⇒ generate(); non-empty ⇒ runAgent()
  └─ ai.generate | ai.runAgent(messages, { signal, onToken, maxTokens, tools, … })
```

The instruction and the context are **one** system message, not two. That is deliberate: history
trimming drops old turns, and the context must survive it. A host that passed the snapshot as a
second system message, or as the first user turn, would find it evicted after `maxHistory` messages.

### The description Portable SLM ships with

`composeContext()` puts a short description of the assistant itself at the top of the context, on
every surface, whether or not a host exists — and then appends whatever `onContext` returned under a
`--- context supplied by this application ---` marker. It is **append-only**: no attribute, option or
return value replaces or removes the shipped block.

That exists because "what are you?", "did you read my screen?" and "can you save this?" have to be
answered from somewhere, and a host that forgot to say them would leave a few hundred million
parameters to guess. Two effects:

- with no host, provenance reads `no host context — answered from Portable SLM's own description
  only`, and the disclosure shows the shipped block instead of an apologetic empty box;
- an answer lifted from the shipped block — *"I cannot save or publish anything"* — now grounds as
  quoted rather than being flagged as invented.

A host with nothing to say still gets a working assistant; a host with something to say **adds** it.
See [`HOST_CONTRACT.md` §3c](HOST_CONTRACT.md#3c-context-composition-shipped-first-appended-after).

| What | Default | Set by |
|---|---|---|
| history kept | 6 messages (3 exchanges) | `max-history` |
| answer cap | 256 tokens | `max-tokens` |
| context window | 32768 tokens | `ctx` (only when the element builds its own engine) |
| sampling | `temperature 0.1, top_k 50, penalty_repeat 1.05` | `DEFAULTS.sampling` in `src/models.js` — not exposed on the element |
| tool schema in prompt | none when `tools="none"` | `tools` / `allow-network` |

Never in the prompt, whatever a host does: the page DOM, the component's own history of other
records, any credential, and anything fetched by the component itself — it has no path to fetch host
data. `onContext` is the only door.

## The grounding stamp

Under every answer: `grounded 5/7` or
`not in provided context (current, population, approximately, 1.2, million) — verify`.

It compares the answer's content words against the exact context string the component sent. It
catches invented facts and numbers, which is what a 350M model does wrong most often. It cannot
catch a real field used to answer the wrong question — that is a reasoning failure, invisible to
string overlap. Answers produced with tools skip the check and say so, because tool output is not
part of the host context.

## "What was sent to the model"

The disclosure is visible as soon as a host attaches `onContext` — before the first question, not
after it. Until something is actually sent it reads `Nothing sent yet — the host context is fetched
when you ask.`; afterwards it holds the exact string placed in the prompt. With no context provider
at all (the vanilla page) the section stays hidden: there is nothing to disclose.

A trust affordance you have to use before you can find is not one.

## How an answer is formatted

A small model answers in markdown, and raw `**` and backticks in a bubble look broken. The element
formats the answer itself, so no host has to and no host can do it differently: streamed as plain
text, formatted once when the answer completes, into DOM created with `createElement` +
`textContent` — never `innerHTML`.

`**strong**`, `*em*`, `` `code` ``, fenced blocks, bullet and numbered lists, `#` headings. Links
render as `text (url)` and stay inert, `_emphasis_` is unsupported so `snake_case` survives, and an
unmatched `**` stays on screen exactly as written. User text is never formatted, and the disclosure
above always shows raw bytes. Full rules and the reasoning: [`HOST_CONTRACT.md` §4b](HOST_CONTRACT.md#4b-how-an-answer-is-formatted).

## What it never does

- fetches host data itself — only `onContext` supplies it
- renders model output as HTML. Markup in an answer arrives as visible text and executes nothing
- calls a host write API, or claims to have saved, published or changed anything
- offers an online tool without `allow-network`, and never runs one without approving the exact
  arguments on screen
- sends anything to a server: no telemetry, no pings beyond the model download itself

## What survives, and where

Four lifetimes get conflated here, and only one of them is shared.

| Thing | Scope | Where it lives | Two windows | Reload / new page |
|---|---|---|---|---|
| conversation | per element | memory | invisible to each other | **lost** — nothing persists it |
| host context | per question | nowhere — refetched on every send | each reads independently | refetched on the next question |
| model bytes | per origin | Cache API, `portable-slm-models` | **shared**: install once | survives |
| engine | per document | WASM memory | **two copies resident** | reloaded into memory |
| tool approvals | per question | memory | n/a | not remembered, on purpose |

Nothing here is in `localStorage` or `sessionStorage`. The omission is deliberate: a stored
transcript on a shared statistics workstation is user data at rest in a browser other people use, and
persistence needs its own consent story before it can exist.

**Hash navigation keeps the transcript; a full page load drops it.** Inside one document the host's
router never touches the element, so `#/study/1` → `#/publish` preserves the exchange. A new page is a
new element and a new conversation.

**Context is never cached, so it cannot go stale — and it never sees unsaved edits.** The provider
hits the host's endpoint on every question, so a value saved in another window is visible here on the
next question, while a half-typed field in *this* window is invisible. Context is the record, not the
screen. See [`HOST_CONTRACT.md` §3](HOST_CONTRACT.md#3-context-not-scraping).

**Two windows can install the same model at once, with no lock** — no `BroadcastChannel`, no storage
event, no in-flight claim. It is safe because the store is idempotent and verified: chunks are keyed by
index and written only when absent, `cache.put` replaces a whole entry so a reader never sees a partial
write, and the final SHA-256 over every stored chunk is the arbiter, with a mismatch removing the
pieces. The cost of the overlap is duplicate bandwidth, not correctness. Removing a model another
window has loaded is equally benign: that window keeps running from memory and finds itself
uninstalled on its next load.

**One engine per document means two windows cost two copies of the model in RAM.** Sharing one engine
across surfaces *within* a page is supported — set `chat.ai` — and there is no browser mechanism to
make cross-tab sharing cheap. Hosts usually assume one mount per page too: the Metadata Editor's fill
listener binds the first mount it finds and refuses a fill it cannot attribute, rather than guessing
at the wrong form.

## Sizing and scrolling

The element fills the box you give it and scrolls its own transcript. Give it a **bounded** height —
a fixed pixel height, a viewport unit, or a flex parent that can shrink:

```css
#my-panel { position:fixed; width:390px; height:70vh; }   /* host owns geometry */
pslm-chat { width:100%; flex:1 1 auto; min-height:0; }    /* min-height:0 is not optional */
```

Without a bound the transcript grows instead of scrolling, which looks fine at three messages and
strands the composer off-screen at twenty. The chain is `bounded ancestor → min-height:0 →
overflow-y:auto` on the log; a flex item's default `min-height:auto` silently breaks it, because
`min-height:0` on the ancestor alone is not enough.

The transcript deliberately has no `content-visibility`. It looks like a free win and it is not:
contained subtrees report a wrong `scrollHeight`, so the transcript stops being scrollable while
still looking correct.

## Accessibility and keyboard

`Enter` sends, `Shift+Enter` newline. The transcript is `role="log" aria-live="polite"`; the
approval dialog states the tool name and its exact arguments before any network call; Stop is a
button, not a hidden gesture; `prefers-reduced-motion` is respected.
