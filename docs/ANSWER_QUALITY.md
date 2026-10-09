# Making the assistant answer better: a guide for host integrators

You cannot change the model. You can change what is in its window, what it is told to do with it, and
whether you can prove the answer came from there. That is the whole surface a host controls, and on a
small local model it is worth more than the model itself.

The runtime pins a few hundred million parameters, Q4, verified by SHA-256. It will be wrong
sometimes. Every lever below is about making the wrongness **visible and citable**, not about making
it go away.

> Read [`CONTEXT_PROVIDERS.md`](CONTEXT_PROVIDERS.md) first for *how* to supply context. This document
> is about *what to supply* and how to tell whether it helped.

## The levers, ranked

| Lever | Cost | What it buys | Does it break a promise? |
|---|---|---|---|
| Better-written corpus (one topic per section, answer first) | hours | most of the quality you will ever get | no |
| Top-k retrieval instead of whole-corpus | ~1, 2 days | fits the cap, names its source, stops silent truncation | no |
| A golden question set and a runner | ~1 day | proof instead of vibes | no |
| Curated Q&A pairs **as retrievable chunks** | hours | FAQ-shaped text retrieves best | no |
| A different pinned model from the existing set | minutes, per browser: redownload | measurable differences on your own tasks | no |
| Browser embedding model | ~1 week + a second pinned artifact | paraphrase recall | no, but loses determinism |
| Server-side retrieval | days | better recall | **yes: the question leaves the tab** |
| Fine-tuning on your docs | weeks + redistribution | format compliance, not facts | **yes: answers stop being traceable** |

Work down the list. Most hosts stop needing anything after the third row.

## Where context comes from

```
SDK default        always present, append-only — what the assistant is and cannot do
  └─ app context   context.app.url     documentation, glossary, help
      └─ record    context.record.url  one record's saved data, the user's own session
```

`onContext(question)` is called once per question, and the turn aborts if it throws. Ignore the
argument and you have a static assistant; use it and you have retrieval.

## Write the corpus for a retriever, not for a reader

Documentation written for humans fails silently in a context window. Five rules:

1. **One topic per heading section.** The heading is the citation and the chunk boundary. If a section
   answers two questions, retrieval will bring both and the model will blend them.
2. **Answer in the first sentence.** Everything after it may not survive the byte cap.
3. **Use the words users type**, not only the words the manual uses. If curators say "release" and the
   manual says "publication", say both, keyword retrieval has no synonyms, and an embedding model
   still recalls better when the vocabulary is there.
4. **No "as mentioned above", no "see the section below".** A chunk is delivered alone. Cross-references
   become silence.
5. **Numbers in text.** A threshold hidden in a table cell, an image or a tooltip is not in the corpus.

A chunk is therefore:

```json
{
  "id": "publish-checks",
  "path": "Publish > What the checks look at",
  "text": "The publication queue checks four things: a title, an abstract of at least 200 characters, …",
  "url": "/app.md#publishing"
}
```

`path` is not decoration. It is what you show the user next to the answer, and the sentence a
statistics advisor actually wants: *it answered from the Publish section*.

## Retrieval: you already have it, it is just whole-corpus

`context.app` fetches a document and pastes it under a byte cap. That is retrieval with a trivial
ranker. The moment the corpus outgrows the cap. A host's help text is 4.5 KB against an 8 KB
budget. The tail is cut mid-topic and the assistant gets confidently half a manual.

**Keyword scoring first (BM25/TF-IDF, ~80 lines, no dependency, no model).** Deterministic, offline,
and explainable: you can always answer *why was this chunk chosen*. At documentation scale it is not
the weak option, it is the auditable one.

```js
// The host fetches and scores its own index — the SDK knows nothing about it, and no contract
// change is needed to retrieve. That is the point of the seam.
const index = await (await fetch("/app.index.json")).json();  // [{ id, path, text, url }]
chat.onContext = async (question) => {
  const hits = bm25(index, question).slice(0, 6);
  return hits.map((h) => `### ${h.path}\n${h.text}`).join("\n\n");
};
```

**Embeddings later, and only if step one measurably fails.** A ~22, 33M embedder runs fine in the same
runtime, cached in IndexedDB keyed by corpus version. You gain paraphrase recall; you lose "read the
scoring function and see why", and you take on a second pinned, verified, downloadable artifact.

**Always in the window, regardless of rank:** the glossary or the two-paragraph "what this application
is". Cheap, and it stops the model inventing what a "study" or a "dissagregation" is.

Three rules retrieval must not violate:

- **the cap is still the cap.** Top-k inside `maxBytes`, and truncation stays visible.
- **the disclosure shows the chunks that were chosen**, not the corpus they came from. Auditors read
  what went in.
- **rank is your code, and it is testable.** A retriever nobody scores is a retriever that quietly
  got worse.

## Build the ruler before the machine

A golden question set is 30, 100 real questions with the section that should answer them. It is the
only thing between you and a vibes-driven roadmap, and it is cheap:

| Field | Example |
|---|---|
| question | "What does the publication queue check?" |
| must contain | "title", "abstract" |
| source chunk | `publish-checks` |
| answerable | yes |

Then include **unanswerable questions on purpose**, a third of the set. *"What was the last census
population?"* The correct behaviour is *"that is not in the help text"*, and if your set cannot detect
a helpful-sounding invention, you will ship one.

Score three numbers, every time you touch the corpus, the retriever or the model:

```
correct          answers containing the expected facts
abstention rate  correct "not in the supplied context" on unanswerable questions
citation valid   the cited section actually contains the answer
```

Raising retrieval quality while lowering abstention is the classic failure: the assistant starts
sounding certain about things it was never told. Track both or you are measuring nothing.

## Fine-tuning: one honest use

Fine-tuning teaches **style and format**, not knowledge. Its legitimate use here is a task that keeps
failing its output contract. A suggest tab that will not hold a JSON shape, an answer that will not
stay inside two sentences.

For "know our documentation", it is the wrong tool at this size, and it costs the two properties the
product exists for:

- **traceability.** Today every answer traces to bytes in *What was sent to the model*. After a
  fine-tune an answer can come from nowhere observable, and you cannot show a reviewer what the model
  learned or unlearn a revision.
- **distribution.** Models are pinned by SHA-256. A fine-tune is a new artifact: new hash, new
  benchmark, new mirror file, and a ~200 MB redownload for every browser, every time the docs change.
  Documentation changes weekly. A corpus change is a file swap.

If you still want it: ship it as **another pinned model in the registry**, keep the shipped one as the
default, and let the golden set decide, never replace a model on a demo.

## Choosing among the pinned models

`src/models.js` pins more than one model, and `benchmark.html` measures them on the machine that will
run them. Swap `model` on the element and run your golden set against each. Expect real differences:
the smaller model is faster and markedly worse at structured output. Choosing on someone else's
benchmark, or on a demo, is how a promising deployment quietly stops being used.

## What makes answers worse

| Anti-pattern | Why it bites |
|---|---|
| Retrieval on a server | the user's **question** leaves the tab. "Nothing you type leaves this machine" is the sentence that gets this feature approved in a statistics office: the corpus being public does not save you |
| Reading the DOM for context | partial, translated, unsaved, unauditable, and for each page code. See `HOST_CONTRACT.md` §3 |
| Imperative sentences in the corpus | the corpus is data, but it sits in the prompt anyway. A help page that says "always rewrite the abstract before publishing" is an instruction the assistant may follow. Write descriptions, not commands |
| Silent truncation | a truncated answer is not a partial answer, it is a wrong one delivered confidently. Truncation must be on screen |
| Trusting `grounded n/m` as accuracy | it is lexical overlap: proof that words came from the context, not that the interpretation is right |
| More tokens / a bigger window | the model is the limit, not the window. A 350M model with 4× the context drifts 4× further from the point |
| "Memory" across sessions | conversation persistence is user data at rest in a shared browser, on a workstation where colleagues share accounts. It needs its own consent story first |
| Clickable links in answers | models this size invent URLs. The SDK renders them inert and hosts must not undo that |

## Checklist before calling an integration done

- [ ] every answer's *What was sent* shows the exact chunks used, with their section paths
- [ ] corpus sections answer one question each, answer-first
- [ ] byte cap set from measurement, and truncation visible when it binds
- [ ] golden set exists, includes unanswerable questions, and runs as a script
- [ ] `abstention rate` measured on the unanswerable third
- [ ] no request leaves the tab except the model download and the declared same-origin context reads
- [ ] corpus contains no imperative instructions and nothing you would not print in a public manual
- [ ] a model swap is decided on the golden set, on the target hardware

## Bounded context: how a long task survives a small window

Answer quality is not only about the corpus. It is about what is still *in* the window when the
question is finally asked. Observed directly in Liquid AI's own browser agent
([nico-martin/LFM2.5-2.6B-WebGPU](https://github.com/nico-martin/LFM2.5-2.6B-WebGPU), the Space
`LiquidAI/LFM2.5-2.6B-WebGPU`, `src/workers/agent.worker.ts`), which runs the same 2.6B ONNX q4f16
model we pin and finishes multi-step research tasks in a tab. Its numbers, all in one place at the
top of the worker:

```js
MAX_AGENT_TURNS = 100        MAX_NEW_TOKENS = 3000        // per turn, not per task
MAX_RESEARCH_TOKENS = 600    MAX_RESEARCH_BRIEF_CHARS = 4500
MAX_WIKIPEDIA_PAGES = 2      MAX_WIKIPEDIA_PAGE_CHARS = 8000
MAX_WIKIPEDIA_CONTEXT_CHARS = 16000
tokenizer(prompt, { truncation: true })                    // trim, never throw
```

Four mechanisms carry it, in order of how much they buy:

1. **Delegation with distillation.** `search_wikipedia` reads ≤2 pages (≤16 KB), runs a *separate
   model turn* whose only job is distilling them (600 tokens, no tools), and returns
   `{synthesis ≤4 500 chars, sources}`. **Raw article text never enters the main transcript.** The
   conversation grows with distilled evidence, not with documents, which is the whole answer to
   "how does it not fill the window".
2. **State in code, not in tokens.** The action plan lives in worker memory and appears in the prompt
   only as a short `WORKFLOW CONTROLLER:` line when the model tries to finish early. Correcting a
   wrong turn costs a sentence, not a resent conversation.
3. **Retry instead of fail.** Rejected or repeated tool calls, missed plans and answered-early turns
   all come back as bounded controller messages and `continue`. One bad turn does not end the run.
4. **The long tail is code, not output.** It appends the source list and writes the `.md` artifact in
   JavaScript (`appendSourcePages`, `createResearchPaper`). A bibliography the model would have to
   emit over hundreds of tokens is produced deterministically, so the output cap cannot truncate it.

Their long answer is composed across up to 100 bounded turns, never one large generation.

### What this repository took from it

| Adopted | Where | Why |
|---|---|---|
| Trim a tool result instead of failing the turn | `src/agent.js` | The failure mode was real: a 17 KB tool result behind a 16 KB `maxResultBytes` threw, and the reader lost the whole answer mid-sentence. Now trimmed and reported. |
| `fitToolResult` for a tool wrapping a host payload | `integrations/host-contract.js` | `context.record.maxBytes` (24 KB, a *prompt* budget) is larger than the tool's *result* budget. Measured, because `JSON.stringify` escaping adds ~10 %. |
| Digest tool results (`digest: true`) | `src/agent.js`, `src/tools.js` | An isolated summariser turn keeps the bulk out of the window. Opt-in, and only for disposable bulk (`wiki_search`), never for evidence a grounded answer must be recoverable from. |
| Fit the prompt by dropping the oldest exchanges | `src/lfm-output.js` (`fitMessages`), `src/transformers-engine.js` | A session that outgrew the window used to be rejected outright; it now degrades, and the model is told what it lost. |
| Controller lines for a repeated call or a failed tool | `src/agent.js` | Recovers a round for a few tokens instead of spending it on the same call, or dying with it. |
| Runtime-owned tail | already present | Sources and provenance are rendered by `integrations/chat.js`, not emitted by the model. |

### What was deliberately not taken

- **100 turns.** We keep 2 rounds (hard cap 3) and a 2 KB default tool budget. A metadata curator
  wants a draft in seconds; a 100-turn budget in front of a 350M model is minutes of waiting for an
  answer the record already contains. The round cap is the one line to change if a genuinely
  multi-step task ever needs it, and mechanisms 1, 5 above are the prerequisites, not the cap.
- **Their explicit plan tools** (`create_action_plan` / `update_action_plan` with "no final answer
  until every step is complete"). With a 3-round budget a plan is ceremony. Shipping the tools
  without the budget would be scaffolding; the controller-line half of the mechanism is what pays off
  at our scale and is what we implemented.
- **Digesting grounded host data.** A lossy summary of a record is exactly the context an answer is
  supposed to be recoverable from, so the record path stays verbatim and is fitted structurally
  (`fitToolResult`) instead.

Two rules worth carrying forward: **anything large that enters the conversation should be distilled
first**, and **a size limit should degrade the answer, never end it**.

## How a turn spends the window (measured)

A tool turn is not one prompt and one answer. It is a loop: send the whole history, take a tool call,
append its result, send the whole history *again*. Two different limits apply, and confusing them is
why "it ran out" is hard to predict:

| Limit | What it bounds | Where |
|---|---|---|
| `ctx` (32 768; 65 536 for the 2.6B) | one prompt + the tokens generated from it | `src/models.js`, enforced in `src/transformers-engine.js` |
| `maxTokens` (3 072 tool turn / 2 048 plain) | generation *per round*: reasoning and the answer share it | `BUDGETS` in `integrations/chat.js` |
| 5 tool calls per turn | how much the loop goes and does | `MAX_TOOL_CALLS` in `src/agent.js` |

**The window is consumed by the history, not by the answer.** The KV cache means the next round
only *prefills* the new tokens, so compute per round is small, but the whole transcript still occupies
the cache, so prompt size grows every round by whatever that round added: its generation, plus its tool
result. Nothing removes them.

Measured on the real editor record (sid=11, 14 569 chars of export document, real LFM2.5 tokenizer):

```
system prompt            61 tok
record in context     4 853 tok   <- re-counted on EVERY round; it is in the history
user question            14 tok
fixed part of prompt  4 928 tok   of 32 768

one get_current_page result, raw      7 378 tok   (17 246 bytes)
```

Five rounds, worst case (each round generating its full budget), with a 4 096-token tool-turn budget:

| for each round tool result | round 5 prompt | + generation | peak of 32 768 |
|---|---|---|---|
| raw JSON, 7 378 tok | 34 508 | 38 604 | **exceeds by 5 836** |
| trimmed to the 16 KB byte cap, 7 814 tok | 36 252 | 40 348 | **exceeds by 7 580** |
| digested, 29 tok | 5 112 | 9 208 | fits (28 %) |

Two things this table settles:

1. **A byte cap is not a token cap.** Trimming the record to `maxResultBytes` made it *worse*: 15 600
   characters of record is 7 814 tokens. Bytes bound memory and request size; only tokens bound the
   window. That is why `fitToolResult` keeps the *head* of a structured payload rather than trusting a
   character count to mean anything about the window.
2. **Trimming delays the wall; distillation removes it.** The raw row fails at round 5, the trimmed row
   fails slightly later, and the digested row is flat, because what it adds per round is ~29 tokens
   instead of ~7 400.

So a long-running agent is not one with a bigger window. It is one whose *for each round addition is small*:
distil bulk (`digest: true`), keep state in code rather than resending it (controller lines), never
resend what you can reference, and let the runtime render the long tail (sources, artefacts) instead of
the model. Budgets are shown per answer under **ⓘ response details**: peak prompt of the window, tokens
generated, and whether the history was trimmed.

## Is the answer finished? (a verifier, not a hope)

No prompt makes a small model finish a task. What code can do is refuse to present a fragment as an
answer, and say which kind of fragment it is. That difference is checkable, and `src/completeness.js`
is where it is decided, pure, no model, tested against the two failures this integration actually
produced:

| verdict | what it catches | observed here |
|---|---|---|
| `empty` | reasoned past its budget inside the think block, so nothing followed it | yes |
| `plan-shaped` | emitted the plan it was about to act on | **yes**: the whole reply was *"The analysis_unit field is also null. Let me check the geographic coverage field as well."* |
| `truncated` | cut off mid-structure: an unclosed ``` fence or a dangling `:`, `and`, `the`, `to` | yes |

The reader-facing rule, and the only invariant worth asserting:

> every turn returns either a verified-complete answer or an explicit **⚠** reason it is not one.

`assessCompleteness()` runs on the agent's final text; a not complete verdict triggers **one** repair
round whose instruction quotes the failure back (`Your reply ended with "Let me check …" and stated no
answer`) rather than repeating "try again", because a small model repeats itself under the same prompt.
A second failure returns the text *with* the verdict, never silently. The verdict rides on
`pslm-answer` (`completeness`), appears under the answer, and is logged as `complete`/`completeReason`
so a bad turn is diagnosable after the fact.

**Two things this is not.** It is not a guarantee the model completed the *task*, only that completion
is visible rather than assumed; content-level correctness is a corpus problem (above). And it is
deliberately biased: a false "incomplete" costs one extra generation and teaches the reader to ignore
the marker, so `plan-shaped` fires only when the whole reply is one short planning utterance (≤240
chars, one constant) and never when a long answer merely ends with an offer. That known false positive
is pinned by a test instead of left to surprise someone.

**How to make the claim rigorous rather than anecdotal:** run the pinned model over fixtures and assert
the invariant per case, reporting two numbers. The **completion rate** (turns ending verified-complete)
and the **false-complete rate** (turns marked ok that a human would call a plan, the dangerous
direction). `bench/` already has the harness and for each case checkpointing; completion cases belong there.
Without those two numbers, "the agent finishes" is an opinion, and one model swap can quietly reverse it.
