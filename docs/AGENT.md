# Agent modes: tools, engines and model choices

What changes when the model may call a tool, which engine runs it, and where the boundaries are.
[`HOST_CONTRACT.md` §4](HOST_CONTRACT.md) is the normative contract for the `tools` key; this page is the
reasoning behind it.

## The engine is chosen by the model, not by the caller

A host picks a model id; the SDK picks the runtime for it:

| model format | runtime | why |
|---|---|---|
| ONNX (`q4f16`) | `@huggingface/transformers` + ONNX Runtime Web, WebGPU with a WASM fallback | first-party exports, one pipeline for tokenizer, template and sampling |
| GGUF | `wllama` | native tool calling, native WebGPU, and the tier that runs on a phone |

Both sit behind the same `createLocalSLM` contract (`status`, `download`, `importModel`, `load`,
`generate`, `runAgent`, `unload`), so the panel, the grounding stamp, *What was sent to the model*, the
approval prompt and the offline shell are written once. The differences that leak through are honest ones:
ONNX downloads arrive as several files that must be verified as a set, and GGUF is a single hashed object.
[`../src/models.js`](../src/models.js) is the pinned catalogue, and [`../README.md`](../README.md#models)
lists the tiers.

Tool calling through ONNX is the newer path: `tools` on `TextGenerationPipeline` is recent, and a small
model can emit a call that does not parse. The loop therefore treats a marker as a proposal: unparseable
calls are dropped rather than fatal, and an answer that arrives with no tool call is still an answer. See
[`../src/lfm-output.js`](../src/lfm-output.js).

## Boundaries that do not move

These are enforced in code, not asked for in a prompt, which is what makes them checkable.

1. **No credential in the page.** The browser authenticates with the host's own session, and
   `pslm-host/1` has no field to put a key in. Anything that needs a secret, such as a search provider or
   an MCP server, lives in the host's backend and is reached as a declared tool. This is what lets the
   panel say "nothing you type leaves this machine" *and* "here is exactly what was sent".
2. **Declared, same-origin, GET-only tools.** A tool endpoint must be a path starting with `/`, must be
   GET, and must appear in the manifest. There is no write path, and a declared POST would be write-back
   wearing a different hat.
3. **A declared tool, an opt-in mount, and approval per call.** The manifest declares the tool, the mount
   element carries `data-tools` and a record id, and every call shows its exact arguments and needs the
   user to allow it (`allowNetwork` **and** `approveTool`). A tool the model can name but not reach is
   worse than none, so `host-check.html` calls every declared tool and reports what came back.
4. **The record id is never a model argument.** Tool arguments fill `{placeholders}` from the declared
   schema only, never the record id, so one declared tool cannot read a different record through the page
   it was opened on. Tested.
5. **Applying a draft stays human, in the host's own form.** `pslm-fill-request` reaches the host's input
   and becomes an unsaved edit. `writeBack: true` fails the mount.

## What a host backend is for

A backend is not a place to hide a second prompt. It validates, applies and audits; the model stays in the
tab. A host that already has an LLM-backed review queue can expose it as one declared tool and get a draft
through the same approval path, and a host whose provider is itself local can say so in the interface rather
than implying it.

Two tool shapes are worth knowing:

- **A read tool** — a same-origin GET that returns a bounded slice. This is the common case, and
  `enum: "$declaredPointers"` keeps its arguments to what the manifest declared.
- **A long-running job** — if a review job needs a POST, there is no place for it in `pslm-host/1`. The
  honest options are to admit a narrow mutation class with a declared read-only guarantee, which is a
  promise about someone else's endpoint, or to model the job as two declared GETs, submitting through a
  query-parameterised route and polling it. The second keeps "no write path" true in the only sense that
  can be checked mechanically, so prefer it.

## Choosing between models

The trade is answer quality against download size and device headroom, and it is measurable rather than
arguable: `benchmark.html` runs twelve authored cases per model and compares what is installed on the device
in front of you. The catalogue's tiers are in the [README](../README.md#models); a host declares what it
offers in `models.available` and which one it starts from in `model`, and a reader can switch in the panel.

Two practical notes:

- **A bigger model is not automatically better on a weak device.** WASM linear memory is 32-bit addressed
  and GPU buffers are finite, so the honest measurement is whether it loads at all, at what tokens per
  second, and on which engine it fell back. Record it; do not assume it.
- **Phone rules differ.** iOS Safari has the tightest tab budget, so the app defaults to CPU and shorter
  replies there, and the largest tier can kill the tab. `DEVICE_VALIDATION.md` records what has been run.
