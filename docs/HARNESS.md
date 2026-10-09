# The assistant harness: how the prompt is assembled, and where to tune it

This is the working guide for improving how the panel assistant behaves on the record editor:
its system prompt, tool calling, context feeds and response rules. Everything here is data and
configuration, never model weights.

## The four layers, in the order the model sees them

| # | Layer | Source file | Owned by | Role |
|---|---|---|---|---|
| 1 | Shipped description | `integrations/chat-core.js` → `DEFAULT_CONTEXT` | portable-slm | What the assistant is, its limits, network honesty. Append-only; a host cannot remove it. |
| 2 | Host mode prompt | `chat-core.js` → `assistantSystemPrompt({ app, context })` | portable-slm API, chosen by embed | Per-page behavior: `record` (grounded in the open project), `app` (help text only), `none`. |
| 3 | Tool rules | `chat-core.js` → `toolInstructions(tools, { lfm })` | portable-slm | When a tool may be called; lists names + descriptions; the LFM `<|tool_call_start|>…` output format for ONNX models. |
| 4 | Context data | manifest `context.*` endpoints + tools | **the host** (`portable-slm.host.json`) | The record snapshot, datafile context, app help. Data, not instructions. |

Assembly (per chat turn, `integrations/chat.js#send`):

```
system  = assistantSystemPrompt(...) + "\n\n" + toolInstructions(...)
context = DEFAULT_CONTEXT + "\n--- context supplied by this application ---\n" + hostContext
messages = [ {system: system + context}, ...last 6 turns, {user: question} ]
tools    = [] if routesDirect(question) else resolveTools(...)   # deterministic guard
path     = tools.length ? runAgent (per-call approval) : generate (streams)
```

Verify any turn yourself: **"What was sent to the model"** in the panel shows layers 1, 4 verbatim.

## Deterministic behavior guards (code, not prompts)

Small models ignore prose rules; anything critical is enforced in code:

| Guard | File | What it does |
|---|---|---|
| `routesDirect(question)` | `chat-core.js` | Identity/capability/greeting turns skip the tool loop entirely. |
| `checkArgs` schema check | `src/agent.js` | Tool arguments validated against the manifest schema; unknown keys/pointers rejected. |
| `buildHostTools` guards | `integrations/host-contract.js` | GET-only, same-origin, `{id}` never from the model, pointer enum from declared labels. |
| Approval gate | `src/agent.js` | Every network tool call waits for an explicit Allow with exact arguments. |
| Byte caps + truncation flag | `host-contract.js → byteCap` | Contexts are capped and truncation is shown, never silent. |
| Prompt-size guard | `src/transformers-engine.js` | A turn that exceeds the window drops its oldest exchanges: announced to the model, and only refuses when one single message is larger than the whole window. |
| Controller lines | `src/agent.js` | A repeated tool call is not rerun and a failed tool is reported back instead of killing the turn; both return as one short `TOOL CONTROLLER:` line. |

Rule of thumb: **if a rule matters, it lives in code; prompts only advise.**

## Context feeds (what the model can know)

| Feed | Endpoint | Cap | Refresh |
|---|---|---|---|
| Record snapshot | `GET /index.php/api/editor/json/{id}?exclude_private_fields=1` | 24 KB | Every question |
| Datafile context | `GET /index.php/api/datafiles/assistant_context/{id}/{file_id}` | 16 KB, 500 vars | Every question on datafile pages |
| App help | `app.md` | 8 KB | Every question on pages with no record |
| `read_project_field` | `json_field/{id}?path={pointer}` | 4 KB | On approved tool call |

Caps live in the host's manifest. Raise them only with a reason: bigger
context = slower prefill, and small models degrade on long prompts even inside the window.

## The shipped help text (layer 4, app mode + grounding)

The host's application-level document is what grounds a record-less page, and
home page, and the reference for what it claims about itself. Keep it truthful to the current build:
model sizes, the tools and their approval flow, what Fill does. It is data, descriptions, never
instructions ("the assistant cannot save", not "never claim to save").

## Iteration loop

1. Change one layer (prompt text, guard, cap, or help doc).
2. `npm test` in `portable-slm/`, prompt-shape and guard tests must pass.
3. `npm run build:embed`, hard-refresh the record editor, rebuild the record editor image only if host PHP changed.
4. Exercise: identity question (no tool), field question (tool + approval), datafile suggestion
   (Suggest tab → Fill), general knowledge question (direct, no refusal).
5. Read **What was sent** for the final assembled prompt before judging the answer.

## Model-specific notes (LFM2.5)

- ONNX models emit tool calls as text markers; parsed by `src/lfm-output.js` (never eval).
- The chat template replays tool calls from marker content, OpenAI `tool_calls` metadata must be
  stripped before the next turn (`lfmTemplateMessages`).
- Tool turns run greedy (temperature 0) for reproducibility; prose turns use Liquid's recommended
  sampling (temperature 0.1, top_k 50, repeat penalty 1.05).
- Context windows are per model spec: 32K for 350M/1.2B, 128K for 2.6B (`ctx` in `src/models.js`).
- Keep the system prompt compact: the template injects the tool list a second time, and redundant
  instructions dilute attention at this scale.
