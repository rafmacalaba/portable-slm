// LFM2.5 ONNX tool calls are emitted as text markers, not ONNX/Transformers tool-call objects:
// <|tool_call_start|>[name(key='value')]<|tool_call_end|>. Parse a tiny literal grammar; never eval.
const START = "<|tool_call_start|>";
const END = "<|tool_call_end|>";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}/;

function parseSingle(source) {
  // Parses exactly one `name(key='value', …)` starting at index 0; returns its end offset.
  let i = 0;
  const ws = () => { while (/\s/.test(source[i] || "")) i++; };
  const identifier = () => {
    const match = IDENT.exec(source.slice(i));
    if (!match) throw new Error("Expected a tool name or argument name");
    i += match[0].length;
    return match[0];
  };
  const quoted = () => {
    const quote = source[i++];
    let value = "";
    while (i < source.length) {
      const ch = source[i++];
      if (ch === quote) return value;
      if (ch !== "\\") { value += ch; continue; }
      const escaped = source[i++];
      const values = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"' };
      if (Object.hasOwn(values, escaped)) value += values[escaped];
      else if (escaped === "u") {
        const hex = source.slice(i, i + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("Invalid unicode escape in tool argument");
        value += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else throw new Error("Invalid escape in tool argument");
    }
    throw new Error("Unclosed string in tool call");
  };
  const literal = () => {
    if (source[i] === "'" || source[i] === '"') return quoted();
    const rest = source.slice(i);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { i += number[0].length; return Number(number[0]); }
    for (const [word, value] of [["true", true], ["false", false], ["None", null], ["null", null]]) {
      if (rest.startsWith(word) && !/[A-Za-z0-9_]/.test(rest[word.length] || "")) { i += word.length; return value; }
    }
    throw new Error("Tool arguments must be quoted strings, numbers, booleans or null");
  };

  ws();
  const name = identifier();
  ws();
  if (source[i++] !== "(") throw new Error("Expected ( after tool name");
  const args = {};
  ws();
  while (source[i] !== ")") {
    if (i >= source.length) throw new Error("Unclosed tool call");
    if (Object.keys(args).length >= 16) throw new Error("Too many tool arguments");
    const key = identifier();
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate tool argument: ${key}`);
    ws();
    if (source[i++] !== "=") throw new Error(`Expected = after tool argument ${key}`);
    ws();
    args[key] = literal();
    ws();
    if (source[i] === ",") { i++; ws(); continue; }
    if (source[i] !== ")") throw new Error("Expected , or ) after tool argument");
  }
  i++;
  return { name, args, end: i };
}

/**
 * Parse the block between tool-call markers. Lenient by design: brackets, commas and any prose
 * the model writes between calls are skipped, and a malformed call resyncs at the next closing
 * parenthesis instead of killing the turn. Small models smear prose into tool blocks constantly.
 */
function parseCalls(block) {
  const calls = [];
  let i = 0;
  let guard = 0;
  while (i < block.length && guard++ < 64) {
    while (/\s|[\[,\]]/.test(block[i] || "")) i++;
    if (i >= block.length) break;
    if (!/[A-Za-z_]/.test(block[i])) { i++; continue; } // prose between calls
    const start = i;
    try {
      const { name, args, end } = parseSingle(block.slice(i));
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error("Invalid tool name");
      calls.push({ name, args });
      i += end;
    } catch {
      // Resync: skip the junk word (not the next parenthesis — that could jump a good call) and
      // keep scanning; a malformed call is dropped, not fatal.
      i = start;
      while (i < block.length && !/\s/.test(block[i])) i++;
    }
  }
  return calls;
}

/** LFM's template replays calls from assistant content markers, not OpenAI `tool_calls` metadata. */
export function lfmTemplateMessages(messages) {
  return messages.map(({ role, content }) => ({ role, content }));
}

/**
 * Fit a conversation into a token budget by dropping its oldest exchanges.
 *
 * A window overrun used to reject the turn, which turns "this session got long" into "the assistant
 * stopped working" — and the longer someone works, the more likely it is. Dropping the oldest turns
 * and answering from what remains degrades instead; the caller reports the drop so the model can say
 * so rather than quietly implying it still remembers.
 *
 * `count(list) -> tokens` is injected because only the engine has the tokenizer; this stays pure.
 * The system prompt and the newest message are never dropped. A tool call takes its results with it,
 * so the transcript never begins with an orphan result.
 *
 * Returns `{ messages, tokens, dropped }`; `messages` is a new array, the input is untouched.
 */
export function fitMessages(messages, count, budget) {
  let list = messages;
  let dropped = 0;
  let tokens = count(list);
  // Keep at least a system prompt plus one exchange: below that there is nothing left to answer from
  // and the caller's single-message cut takes over.
  while (tokens > budget && list.length > 3) {
    const head = list[1];
    let remove = 2;
    // An assistant turn that requested tools owns the results that follow it.
    if (head?.tool_calls) while (list[remove]?.role === "tool") remove++;
    list = [...list.slice(0, 1), ...list.slice(remove)];
    dropped++;
    tokens = count(list);
  }
  return { messages: list, tokens, dropped };
}

const PARTIAL_MARKER = /<\|[^<>|]*$/;

/**
 * What of an accumulated raw stream is safe to show right now: hidden reasoning is suppressed
 * until its close, tool-call markers and anything after them are suppressed, and a marker cut in
 * half by a token boundary stays invisible until it resolves into a marker or plain text.
 * `forceThink` is for generations that were seeded with a `<think>` opener: everything before
 * `</think>` is reasoning by construction, tags or no tags.
 */
export function splitLfmStream(raw, { forceThink = false } = {}) {
  const text = String(raw ?? "");
  const openThink = text.indexOf("<think>");
  const closeThink = text.indexOf("</think>");
  let reasoning = "";
  let content = text;
  if (closeThink >= 0) {
    reasoning = openThink >= 0 ? text.slice(openThink + 7, closeThink) : text.slice(0, closeThink);
    content = text.slice(closeThink + 8);
  } else if (openThink >= 0 || forceThink) {
    return { reasoning: openThink >= 0 ? text.slice(openThink + 7) : text, content: "" };
  }
  const toolStart = content.indexOf("<|tool_call_start|>");
  if (toolStart >= 0) content = content.slice(0, toolStart);
  const partial = PARTIAL_MARKER.exec(content);
  if (partial) content = content.slice(0, content.length - partial[0].length);
  return { reasoning, content };
}

export function displayableStream(raw, options = {}) {
  return splitLfmStream(raw, options).content;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Control tokens the surface must never display. `im_end`/`fim_suffix`/`endoftext` also *end* the
// turn: anything after them is padding, not output. The decoder runs with skip_special_tokens off
// so the think and tool markers survive, which is exactly why these have to be filtered here.
const STOP_TOKENS = new Set(["<|im_end|>", "<|fim_suffix|>", "<|endoftext|>"]);

/**
 * Incremental, stateful parser for LFM output: hidden reasoning, the displayable answer, and tool
 * calls, split as tokens arrive. Ported from Liquid's own Thinking Space parser
 * (`src/utils/think-parser.ts`), with tool markers and control tokens added.
 *
 * The point of holding state is that **attribution is decided once**. Re-splitting the accumulated
 * text from scratch on every token can disagree with what was already streamed — announcing prose
 * as content, then finding a later unclosed `<think>` and re-reading the whole output as
 * reasoning — which leaves reasoning sitting under an answer, discards a reply already on screen, or
 * truncates it at the wrong marker. Here text outside a think block is content when it is emitted
 * and stays content, and a tail that could still turn into a marker is held back so no `</thi`
 * fragment flashes. `startInThink` covers a decode whose prompt ended with the opener (a seeded
 * think block has no opening tag in the generated text).
 */
export class LfmStreamParser {
  constructor({ startInThink = false } = {}) {
    this.reasoning = "";
    this.content = "";
    /** Marker spans exactly as emitted, so they can be replayed into the next prompt turn. */
    this.toolText = "";
    this.inThink = Boolean(startInThink);
    this.inTool = false;
    /** A stop token was seen: the turn is over and nothing further is output. */
    this.ended = false;
    /** Text not yet attributable: it could still be the start of a marker. */
    this.buf = "";
    this.segments = [];
  }

  #emit(out, type, text) {
    if (!text) return;
    this.segments.push({ type, text });
    if (type === "tool") { this.toolText += text; return; }
    if (type === "reasoning") this.reasoning += text;
    else this.content += text;
    out.push({ type, text });
  }

  #current() { return this.inTool ? "tool" : this.inThink ? "reasoning" : "content"; }

  /** Feed one streamed chunk; returns the `reasoning`/`content` deltas it completed. */
  push(chunk) {
    const out = [];
    if (this.ended) return out;
    this.buf += String(chunk ?? "");
    for (;;) {
      let thinkAt = -1;
      let thinkHit = null;
      if (!this.inTool) {
        for (const marker of [THINK_OPEN, THINK_CLOSE]) {
          const index = this.buf.indexOf(marker);
          if (index >= 0 && (thinkAt < 0 || index < thinkAt)) { thinkAt = index; thinkHit = marker; }
        }
      }
      const ctrlAt = this.buf.indexOf("<|");
      if (thinkAt < 0 && ctrlAt < 0) break;
      const controlFirst = ctrlAt >= 0 && (thinkAt < 0 || ctrlAt < thinkAt);
      if (!controlFirst) {
        // Text before a marker belongs to the state we are in *now*: inside a think block that is
        // reasoning, even when what follows is a tool call.
        this.#emit(out, this.#current(), this.buf.slice(0, thinkAt));
        this.buf = this.buf.slice(thinkAt + thinkHit.length);
        this.inThink = thinkHit === THINK_OPEN;
        continue;
      }
      this.#emit(out, this.#current(), this.buf.slice(0, ctrlAt));
      this.buf = this.buf.slice(ctrlAt);
      const close = this.buf.indexOf("|>");
      if (close < 0) break; // incomplete control token: hold the whole tail
      const token = this.buf.slice(0, close + 2);
      this.buf = this.buf.slice(close + 2);
      if (token === START) { this.#emit(out, "tool", token); this.inTool = true; continue; }
      if (token === END) { this.#emit(out, "tool", token); this.inTool = false; continue; }
      if (STOP_TOKENS.has(token)) {
        this.ended = true;
        this.buf = "";
        return out;
      }
      // Any other control token is never shown on the surface. Drop it and keep reading.
    }
    // Hold back a tail that could still become a marker.
    let hold = 0;
    const ctrlStart = this.buf.lastIndexOf("<|");
    if (ctrlStart >= 0 && this.buf.indexOf("|>", ctrlStart) < 0) {
      hold = this.buf.length - ctrlStart;
    } else if (!this.inTool) {
      for (const marker of [THINK_OPEN, THINK_CLOSE]) {
        for (let k = Math.min(this.buf.length, marker.length - 1); k > hold; k--) {
          if (this.buf.endsWith(marker.slice(0, k))) { hold = k; break; }
        }
      }
      // A lone `<` may still become a control token or a think marker.
      if (this.buf.endsWith("<")) hold = Math.max(hold, 1);
    }
    this.#emit(out, this.#current(), this.buf.slice(0, this.buf.length - hold));
    this.buf = this.buf.slice(this.buf.length - hold);
    return out;
  }

  /** Generation ended: the held tail can no longer become a marker, so attribute it. */
  flush() {
    const out = [];
    if (!this.ended) this.#emit(out, this.#current(), this.buf);
    this.buf = "";
    return out;
  }

  /** Everything that is not hidden reasoning, in order — what the next prompt turn replays. */
  get transcript() {
    return this.segments.filter((s) => s.type !== "reasoning").map((s) => s.text).join("");
  }
}

/**
 * Normalized tool calls from marker spans. Deliberately lenient about a **cut-off** final span: a
 * generation truncated mid-call is a dropped call, not a failed turn (the grammar inside a complete
 * span is still strict). `parseLfmOutput` keeps its stricter, throwing behaviour for callers that
 * want to hear about a malformed marker.
 */
export function parseLfmToolCalls(text) {
  const calls = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(START, cursor);
    if (start < 0) break;
    const bodyStart = start + START.length;
    const end = text.indexOf(END, bodyStart);
    if (end < 0) break; // truncated mid-call
    const body = text.slice(bodyStart, end).trim();
    if (body.length <= 2048) {
      for (const { name, args } of parseCalls(body)) {
        calls.push({
          id: `lfm_${calls.length + 1}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        });
      }
    }
    cursor = end + END.length;
  }
  return calls;
}

/** Remove hidden reasoning and return ordinary content plus normalized OpenAI-style tool calls. */
export function parseLfmOutput(output) {
  let text = String(output ?? "");
  const endThink = text.lastIndexOf("</think>");
  if (text.includes("<think>") || endThink >= 0) {
    if (endThink < 0) return { transcript: "", content: "", tool_calls: [] }; // never expose truncated reasoning
    text = text.slice(endThink + "</think>".length);
  }
  text = text.replace(/(?:<\|im_end\|>|<\|fim_suffix\|>)\s*$/g, "").trim();
  const tool_calls = [];
  let content = "";
  let cursor = 0;
  while (true) {
    const start = text.indexOf(START, cursor);
    if (start < 0) { content += text.slice(cursor); break; }
    content += text.slice(cursor, start);
    const bodyStart = start + START.length;
    const end = text.indexOf(END, bodyStart);
    if (end < 0) throw new Error("Unclosed LFM tool-call marker");
    const body = text.slice(bodyStart, end).trim();
    if (body.length > 2048) throw new Error("LFM tool call exceeded 2048 characters");
    for (const { name, args } of parseCalls(body)) {
      tool_calls.push({
        id: `lfm_${tool_calls.length + 1}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    cursor = end + END.length;
  }
  return { transcript: text, content: content.trim(), tool_calls };
}
