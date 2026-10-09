# Agent modes in the record editor

Decisions taken 2026-10-07, with the facts they rest on. This is the plan the following stages are
measured against; `docs/HOST_CONTRACT.md` §4d is the normative contract for the `tools` key.

## Decisions

| | |
|---|---|
| **Engine** | transformers.js + WebGPU for ONNX models from now on. wllama stays the engine for GGUF models and for phones. |
| **Model** | LFM2.5-1.2B, **both formats**, measured head to head on the benchmark laptop (16 GB RAM) before anything is promoted. |
| **Tool host** | the host application's own backend. MCP clients and search API keys live there, never in the page. |
| **First version** | S0 declared tools + S2 backend review job + S1 web search + S3 transformers.js engine. |

## Why the engine choice is not the interesting part

wllama 3 already ships WebGPU and native tool calling, and this SDK already uses both:
`complete()` passes `tools`/`tool_choice` (`src/index.js:71`), `runAgent` runs the loop
(`src/agent.js`), and `<pslm-chat>` renders a for each call approval. So "an agent" was never blocked on
the engine. What transformers.js actually buys is `LFM2.5-1.2B-Instruct-ONNX`, a first-party ONNX
export documented for WebGPU. What it costs:

- **Tool calling is newer and shakier.** `tools` on `TextGenerationPipeline` landed in v4.2; the
  release notes and ecosystem docs both warn that small models struggle. wllama's is native.
- **No resumable chunked download.** `store.js` is built on wllama's chunking plus SHA-256
  verification; ORT fetches whole files, so the multi-file layout below has to be handled explicitly.
- **A second model pipeline**: tokenizer, chat template, sampling defaults, pins, cache, import path.

Both engines therefore sit behind `createLocalSLM` (`load / status / generate / complete`), so the
panel, grounding, *What was sent*, approval and the offline shell are written once.

## Pins: sizes and hashes read from the Hugging Face API, not the model card

| id | file(s) | bytes | sha256 |
|---|---|---|---|
| `lfm2.5-1.2b-q4km` (wllama) | `LFM2.5-1.2B-Instruct-Q4_K_M.gguf` | 730,895,168 | `b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5` |
| `lfm2.5-1.2b-qad-q4_0` (wllama) | `LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf` | 695,755,488 | `bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1` |
| `lfm2.5-1.2b-onnx-q4f16` (transformers.js) | `onnx/model_q4f16.onnx` + `_data` | 182,795 + 760,279,040 | `46cfacc12941150620a3f644a5269e9baebd75d681cfa09cadeef71b8ed64ac2` |
| `lfm2.5-1.2b-onnx-q4` (transformers.js) | `onnx/model_q4.onnx` + `_data` | 183,173 + 850,059,264 | `d9666c44e2acc32f06c9351f9e7c4fd66bc060d88ca8e7f954e836c6845f7488` |

Two consequences that are easy to miss:

- The real Q4 ONNX is **~850 MB**, not the "~1.2 GB" the model card advertises. `q4f16` is smaller
  still (~760 MB) and is the one to try first on WebGPU.
- ONNX ships as **two files** (graph + weights) where GGUF is one. `store.js` verifies and chunks a
  single object today, so a model needs to become a *set* of parts, pin per part, verify per part,
  install atomically or not at all.

`LFM2.5-2.6B` is the more capable agentic release but is **GGUF-only as far as can be found**, and
unverified on wllama 3.6.1. It stays out of the registry until it is pinned, hashed and actually run
on the target laptop.

## Browser ceiling on a 16 GB laptop

WASM linear memory is 32-bit addressed, so **4 GB per heap** (Memory64 is changing this). WebGPU
buffers are separate but not unlimited, and transformers.js issues are full of
`Failed to allocate a buffer` on modest GPUs at 1, 2 B scale. So the benchmark must record, not
assume: peak tab memory, tokens/second prefill and decode, `webgpu` vs `cpu` fallback, and whether
the model even loads on the low end of the target fleet. `benchmark.html` and `bench/tasks.js`
already exist; they need the two engines and the two model formats as rows.

## Boundaries that do not move

1. **No credential in the page.** The browser authenticates with the host's own session, and
   `pslm-host/1` has no field to put a key in. Search keys and MCP server credentials therefore live
   in the FastAPI sidecar. This is not conservatism: it is what lets the panel say "nothing you type
   leaves this machine" *and* "here is exactly what was sent".
2. **Declared, same-origin, GET-only tools.** A tool must be a path starting with `/`, must be GET,
   and must be declared in the manifest. `pslm-host/1` has no write path, and a declared POST would
   be write-back wearing a different hat.
3. **Two options plus a click per call.** The manifest declares the tool, the mount element carries
   `data-tools` and a record id, and every call shows its exact arguments and needs
   **Allow** (`src/agent.js:60`: network tools need `allowNetwork` *and* `approveTool`). A tool the
   model can name but not reach is worse than none, so `host-check.html` calls each declared tool.
4. **`id` is not a model argument.** Tool arguments fill `{placeholders}` from the declared schema
   only, and never `id`, otherwise one declared tool reads any curator's project through the page
   of one project. Tested.
5. **Applying a draft stays human, in the app's own form.** `pslm-fill-request` → the app's
   `v-model` → an unsaved edit. `writeBack: true` still fails the manifest.

## The host tool surface the record editor already has

A host's backend is not a place to hide a second prompt: it validates, applies and audits, while the model stays in the tab.
LLM-backed metadata reviewer with providers **openai · azure · ollama · anthropic**, a job queue
(`REVIEWER_CONCURRENCY`, `REVIEWER_MAX_INFLIGHT`, `REVIEWER_JOB_TIMEOUT_SEC`), `POST /review/jobs`
and `GET /jobs`. So "suggest through the backend" is one declared tool, not a new service, and with
`REVIEWER_PROVIDER=ollama` that path is local too, which is a privacy statement worth writing into
the UI rather than leaving implied.

## Stages

| stage | what ships | new dependency | acceptance |
|---|---|---|---|
| **S0 ✅** | `tools` in `pslm-host/1`; `hostTools()` + `buildHostTools()`; `read_project_field` on the record editor; `data-tools` on the mount; acceptance row | none | unit tests for validation, id-spoof guard, origin guard; `declared tools answer` PASS on the live editor |
| **S1** | web search. First `wiki_search` behind `allow-network` (no key). Then a FastAPI-proxied search declared as a tool | none | search call appears in *What was sent*; a denial is reported as a refusal, not a silence |
| **S2** | `review_job` tool → `POST /review/jobs`, poll `GET /jobs`, offer the result as a fill draft. Needs a POST, so it needs the contract discussion below | none | a draft produced by the reviewer, applied through the form, never saved by the assistant |
| **S3** | transformers.js engine behind `createLocalSLM`; 1.2B ONNX pinned, mirrored to a host-relative path, multi-file install | `@huggingface/transformers` | both engines answer the same `bench/tasks.js` tasks on the 16 GB laptop; numbers recorded here |
| **S4** | MCP client in FastAPI; servers and tools declared per host | python mcp sdk | an MCP tool appears in the panel's approval prompt with its real arguments; no credential in the page |

## One contract question S2 forces

`review_job` is a POST. The honest options are: (a) admit a narrow `write: false` mutation class,
GET-or-POST with a declared idempotent read-only guarantee, which is a promise about someone else's
endpoint; or (b) model the job as two declared GETs, submit via a query-parameterised endpoint and
poll, which keeps the contract's word. Prefer (b): it keeps "no write path" true in the only sense
that can be checked mechanically, and the FastAPI side can expose a GET submit for this purpose.
