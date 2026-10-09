# Tools: defaults, policy, authoring

A tool is a plain object the model may request. Execution happens in the browser tab, the result
goes back into the conversation, and the model writes the answer. Tools never widen what the page
can already do; they are functions the host chose to expose.

## Defaults

`defaultTools()` from `portable-slm/tools`:

| Tool | Network | What it does |
|---|---|---|
| `get_datetime` | no | device clock in UTC |
| `calculate` | no | arithmetic expression: a real parser, no `eval`, bounded magnitude |
| `wiki_search` | **yes** | Wikipedia search, 3 titles plus 300-character snippets |

The split matters: the offline tools are safe on a machine holding unreleased statistics, the
online one is not, because a search query can carry whatever the model was reading.

## Policy

Three independent gates, all required before bytes leave the device:

1. `tools` names the tool, `offline` (default) excludes anything marked `network: true`.
2. `allow-network` is set on the element, or `allowNetwork: true` passed to `runAgent`.
3. **Per-call approval of the exact arguments.** Every online call shows
   `Allow this online tool call? wiki_search` with the literal JSON arguments and Allow once / Deny.
   Enabling online mode does not imply approval of the next query.

Hard limits that stay in force regardless of configuration:

- **at most 5 tool calls execute in one turn** (`MAX_TOOL_CALLS`), counted across rounds and including
  calls that failed. A failed call that is retried is still work the user waited for
- `maxRounds` is capped at 5, so a runaway loop cannot keep fetching. The default is also 5: the
  ceiling exists to stop a runaway, not to stop work, and a turn that finishes early still ends on the
  first round that returns an answer instead of a call
- tool results are capped at 2048 bytes by default and **trimmed, not rejected**, when a tool exceeds
  its declared `maxResultBytes`; a tool may set `digest: true` to have an oversized result distilled by
  an isolated turn instead of carried in the conversation
- at most `MAX_CALLS_PER_ROUND` (4) calls run per round; surplus calls that a small model smears
  into one tool block are dropped with a `stage: "capped"` event, never a failed turn
- the same tool with the same arguments is not run twice in one turn; the model gets the first result
  back with a `TOOL CONTROLLER:` line instead
- arguments are validated against the declared JSON Schema before `run()` is called; a model
  requesting an unknown tool gets `Tool not permitted`
- each call runs under a timeout and the AbortSignal, so Stop actually stops

## Writing a tool

```js
import { PslmChat } from "portable-slm/chat";

chat.tools = [
  ...defaultTools(),
  {
    name: "days_between",
    description: "Days between two ISO dates. Use for duration questions.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
    network: false,
    run: ({ from, to }) => ({
      days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000),
    }),
  },
];
```

Rules for the `run` function:

- return something JSON-serialisable and small. The cap is not a suggestion
- honour the `signal`: `run(args, { signal })`, and pass it to `fetch`
- throw with a user-readable message; it lands in the status line, not a stack trace
- never read beyond what the arguments specify. A tool that takes a field name and returns
  "related records" is how an assistant ends up reading files it should not see.

### A search tool that is not Wikipedia

Point a search tool at whatever the institution trusts, and keep approval mandatory:

```js
{
  name: "catalog_search",
  description: "Search the internal catalogue for public dataset descriptions.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  network: true,
  async run({ q }, { signal }) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal, credentials: "same-origin" });
    if (!res.ok) throw new Error(`Catalogue returned HTTP ${res.status}`);
    const { results } = await res.json();
    return { results: results.slice(0, 3).map(({ title, summary }) => ({ title, summary })) };
  },
}
```

Cross-origin endpoints must send CORS headers; a browser cannot bypass that, and the SDK will not
try. Same-origin is the easier path. A host route already enforces the curator's permissions.

## Replacing the approval dialog

```js
chat.approveTool = async ({ name, args }) =>
  hostConfirm(`Allow ${name} to send: ${JSON.stringify(args)}`);
```

Return `true` to run, `false` to refuse. Refusal is a normal outcome. The model is told the tool
was not approved and answers with what it has.

## Testing

`test/agent.test.js` covers the loop: model tool call → validated execution → final answer,
argument-schema rejection, unapproved online calls, and the result-size cap. A new tool should get
one test for its happy path and one for a bad argument. The interesting failure is a model that
supplies a plausible but wrong argument.
