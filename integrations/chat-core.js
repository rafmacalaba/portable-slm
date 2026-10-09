// Pure logic behind <pslm-chat>: tool policy, message assembly and the grounding stamp.
// Kept DOM-free so hosts and tests can exercise it without a browser.

const STOPWORDS = new Set(("the this that these those with from about into over under and or not you your "
  + "our their its his her have has had was were are been being will would could should can may do does did "
  + "what which who whom when where why how there here them they what's please tell give based given provided "
  + "information question answer answer's metadata snapshot survey dataset record field value values using only "
  + "according according if of in on to for a an as is it at by be").split(/\s+/));

// tools="none" | "offline" | "all" | "calculate,get_datetime" — network tools are never implicit:
// "all" still requires the host to pass allowNetwork, and every online call needs approveTool.
// The context Portable SLM always supplies about itself, before anything a host appends. It exists
// because the honest answers to "what are you?", "did you read my screen?" and "can you save this?"
// have to come from somewhere, and a host that forgot to say them would leave the model to guess.
// Treat it as part of the prompt contract: it is disclosed and grounded like any other context.
export const DEFAULT_CONTEXT = `About this assistant
- This assistant runs a quantized language model entirely inside this browser tab. The model can be
  wrong: answer clearly, and say when you are unsure.
- Answer general questions from your own knowledge. Do not refuse just because the supplied text does
  not cover it.
- Facts about this application come from the supplied text or from a tool's result. If neither has the
  fact, say you cannot verify it rather than inventing a value.
- You cannot inspect the page, screen, selection, other tabs, or unsaved form values unless they are
  supplied here. You cannot save, publish, delete, or change anything; never claim that you did.`;

/**
 * Compose the context a turn is grounded in: the SDK's own description first, then whatever the host
 * declares. **Append-only by construction** — there is no option to replace, reorder or drop the
 * default, because the default is what keeps the assistant honest about its own limits, and a host
 * that could delete it could also make it claim things it cannot do.
 *
 * Returns the sources it actually used so the panel can say where an answer came from.
 */
export function assistantSystemPrompt({ app = "this application", context = "none", kind = "help" } = {}) {
  const opening = `You are a helpful general-purpose assistant inside ${app}. Answer general questions normally from your knowledge; be clear about uncertainty.`;
  if (context === "record") return `${opening} For facts about the open project's saved metadata, use the supplied snapshot or a relevant available tool. Never guess a project value. If it is absent or a read is denied, say you cannot verify it. General advice is allowed but distinguish it from facts about this project. Never claim to save, publish, or change anything.`;
  // `kind: "content"` is the other shape of an application-level document: not instructions for using the
  // application, but the material to answer questions about. The difference matters most in what happens
  // when the answer is absent — help text invites general guidance, content should be answered from the
  // document or plainly declined. Without it the model offers to help, which reads as a deflection.
  if (context === "app" && kind === "content") return `${opening} The supplied text is the material to answer from: answer the question that was asked, using it, and do not end by asking the user what they want or offering to help. If it does not cover the answer, say that plainly rather than filling the gap from general knowledge. Name the document or section you drew on. You have read nothing beyond the supplied text, and you cannot open, save, publish, or change anything.`;
  if (context === "app") return `${opening} For questions about how to use ${app}, use the supplied help text; if it does not cover the answer, say so, then offer general guidance clearly labeled as such. You have not read a project or user data. Never claim to open, save, publish, or change a record.`;
  return `${opening} You have not read this application's page or any project data. Do not claim to have opened, saved, published, or changed anything.`;
}

// Identity, capability and greeting turns never need host data, and small models over-trigger
// tools on exactly these questions ("what can you do?" used to fire read_project_field). Routing
// them away from the tool loop is deterministic — no sampling luck involved.
const DIRECT_PATTERN = /(^|\b)(hi+|hello|henlo|hallo|helo|heya|hiya|hey|yo|sup|good\s(morning|afternoon|evening))\b|(what|who)\s+(are|r)\s+(you|u)\b|what\s+can\s+(you|u)\s+do|what\s+do\s+(you|u)\s+do|(your|ur)\s+name\b|what\s+are\s+(your|ur)\s+(capabilities|tools|limits)|can\s+(you|u)\s+(save|edit|write|publish|delete|modify)/i;

export function routesDirect(question) {
  const text = String(question ?? "").trim();
  return text.length > 0 && text.length <= 120 && DIRECT_PATTERN.test(text);
}

/** Direct-route turns get a brief reply; the context is there if asked, not to be recited. */
export const DIRECT_REPLY_NOTE = `The user greeted you or asked about your identity or capabilities. Reply in one or two short sentences and invite their question. Do not enumerate, list or summarize the supplied context (projects, fields, records) unless they explicitly ask.`;

const BUILTIN_UTILITIES = new Set(["get_datetime", "calculate", "wiki_search"]);

export function toolInstructions(tools, { lfm = false } = {}) {
  if (!tools?.length) return "";
  const list = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  const protocol = lfm
    ? "To call one, output exactly <|tool_call_start|>[tool_name(parameter='value')]<|tool_call_end|> and no prose. After the result, answer normally."
    : "Use the tool-call format required by the model when a tool is needed, then answer after its result.";
  // A host-read tool is the case the strict rule exists for: reading a saved value the user did not ask
  // for, or reading the wrong record, is the failure it prevents. Offline utilities alone need none of
  // that, so a general-purpose host is not charged 270 tokens a turn for rules about data it never reads.
  // Anything that is not one of the built-in utilities is a host's own tool, and a host's own tool reads
  // something the user did not ask about if it misfires. Keying only on `network` was fragile: a declared
  // tool is marked networked by buildHostTools today, but a host that writes its own tool need not know.
  const readsHostData = tools.some((tool) => tool.network || !BUILTIN_UTILITIES.has(tool.name));
  const network = readsHostData
    ? " A networked tool contacts its declared endpoint, so do not claim that no network activity occurred."
    : "";
  const rules = readsHostData
    ? "Call a tool ONLY when the user explicitly asks for the exact current value of specific saved data (a named field, a count, a date/time) or asks for a calculation. Greetings, identity questions, capability questions, opinions and general-knowledge questions never need one. When in doubt, do not call a tool."
    : "Call a tool only when the answer needs one: a current date or time, or a calculation.";
  return `Tool rules. ${rules} Check the supplied text first: if the answer is already in it, answer directly. Never invent a tool result, and never claim a request succeeded unless it returned one.${network}\nAvailable tools:\n${list}\n${protocol}`;
}

export function composeContext(hostText) {
  const host = (hostText ?? "").trim();
  if (!host) return { text: DEFAULT_CONTEXT, sources: ["portable-slm"] };
  return {
    text: `${DEFAULT_CONTEXT}\n\n--- context supplied by this application ---\n${host}`,
    sources: ["portable-slm", "host"],
  };
}

/**
 * A deliberately small markdown subset, as data — no DOM here, so it is testable without a browser.
 *
 * Only what a small local model actually emits: fenced code, bullet/numbered lists, `#` headings,
 * `**strong**`, `*em*`, `_em_` and `code` spans. Everything else stays literal text. In
 * particular:
 *
 * - **links are never clickable.** `[text](url)` becomes `text (url)`. A model this size invents
 *   URLs, and a hallucinated link the user can click is worse than one they cannot.
 * - **no `_emphasis_`.** `snake_case` and `house_hold` are ordinary metadata vocabulary; an
 *   identifier mangled into italics is a worse defect than an unrendered underscore.
 * - **unmatched markers stay literal.** `**half a bold` is what the model meant, and swallowing the
 *   asterisks would silently change the sentence.
 * - an unterminated fence is still rendered as code, because dumping half a JSON block as prose is
 *   harder to read than a code block that never closed.
 */
export function parseInline(text) {
  const runs = [];
  const push = (t, v) => { if (v) runs.push({ t, v }); };
  // Backticks first: markup inside a code span is literal, not markup.
  for (const part of String(text ?? "").split(/(`[^`\n]+`)/)) {
    if (/^`[^`\n]+`$/.test(part)) { push("code", part.slice(1, -1)); continue; }
    const rest = part.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
    // Only `**strong**` and `*em*`, and only when the content is flush against the delimiters and
    // contains no `*`. `_emphasis_` is deliberately unsupported: metadata prose is full of
    // `snake_case` identifiers, and mangling those is worse than leaving one italic unrendered.
    // Requiring non-space content is what keeps `2 * 3 * 4` literal — that is arithmetic — and
    // keeps an unpaired `**half a bold` from quietly losing its asterisks.
    const re = /(\*\*[^*\s](?:[^*\n]*[^*\s])?\*\*|\*[^*\s](?:[^*\n]*[^*\s])?\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(rest))) {
      push("text", rest.slice(last, m.index));
      const token = m[0];
      if (token.startsWith("**")) push("strong", token.slice(2, -2));
      else push("em", token.slice(1, -1));
      last = m.index + token.length;
    }
    push("text", rest.slice(last));
  }
  return runs;
}

const FENCE = /^\s*```(\S*)\s*$/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^(#{1,6})\s+(.*)$/;

export function parseMarkdown(text) {
  const blocks = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let para = [];
  let list = null;
  let fence = null;
  const flushPara = () => { if (para.length) blocks.push({ type: "p", runs: parseInline(para.join("\n")) }); para = []; };
  const flushList = () => { if (list) blocks.push(list); list = null; };

  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_SEP = /^\s*\|?(\s*:?-{3,}\s*\|)+\s*:?-{3,}\s*\|?\s*$/;
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => parseInline(cell.trim()));

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenced = line.match(FENCE);
    if (fenced) {
      if (fence) { blocks.push({ type: "code", lang: fence.lang, text: fence.lines.join("\n") }); fence = null; }
      else { flushPara(); flushList(); fence = { lang: fenced[1], lines: [] }; }
      continue;
    }
    if (fence) { fence.lines.push(line); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }

    // Pipe tables: header row, then a |---|---| separator, then rows. Cells go through the same
    // inline parser as prose; the model emits tables for inventories, so they must render, not leak.
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SEP.test(lines[index + 1])) {
      flushPara(); flushList();
      const header = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index++;
      }
      index--;
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushPara(); flushList();
      blocks.push({ type: "heading", level: heading[1].length, runs: parseInline(heading[2]) });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) { flushList(); list = { type: "list", ordered, items: [] }; }
      list.items.push(parseInline(line.replace(bullet ? BULLET : NUMBERED, "")));
      continue;
    }
    flushList();
    para.push(line);
  }
  if (fence) blocks.push({ type: "code", lang: fence.lang, text: fence.lines.join("\n") });
  flushPara(); flushList();
  return blocks;
}

/**
 * Strip markdown decoration from a value that is about to go into a **data field**.
 *
 * A chat bubble can render `**National**`; a metadata field cannot hold it, and a model asked for
 * "one clear improvement" will sometimes decorate one anyway. This is deliberately narrower than the
 * parser: paired `**`/`__`/backticks, leading `#` and leading list bullets. Single `*emphasis*` is
 * left alone, because in prose an asterisk is more often a footnote marker or a multiplication than
 * markup. Pairs are the only thing removed, so an unpaired asterisk survives: losing a character the
 * curator typed is worse than leaving one decoration behind.
 */
export function stripDecorativeMarkdown(value) {
  return String(value ?? "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .trim();
}

export function resolveTools(names, { tools = [], allowNetwork = false } = {}) {
  const spec = (names ?? "offline").trim();
  if (!spec || spec === "none") return [];
  let selected = tools;
  if (spec === "offline") selected = tools.filter((t) => !t.network);
  else if (spec !== "all") {
    const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
    selected = tools.filter((t) => wanted.includes(t.name));
  }
  return selected.filter((t) => !t.network || allowNetwork);
}

// The context is host-supplied text, injected into the system message so it survives history
// trimming. Returning it separately is what makes the disclosure and the grounding stamp honest.
export function buildMessages({ system, context, history = [], question, maxHistory = 6 }) {
  const instructions = [system, context ? `Context from the host application:\n${context}` : null]
    .filter(Boolean).join("\n\n");
  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...history.slice(-maxHistory), { role: "user", content: question });
  return messages;
}

function contentWords(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9_'-]{3,}|\d[\d.,]*/g) ?? [])
    .map((w) => w.replace(/[.,]+$/, ""))
    .filter((w) => !STOPWORDS.has(w));
}

// Lexical grounding: which answer tokens are absent from the context the host supplied.
// It catches invented facts and numbers. It cannot catch a real field used to answer the wrong
// question — that is a reasoning failure, invisible to string overlap. ponytail: ceiling of a
// string check; upgrade path is a larger model or an explicit citation-per-claim format.
export function lexicalGrounding(answer, context) {
  const words = [...new Set(contentWords(answer))];
  if (!words.length) return { checked: 0, matched: 0, grounded: true, missing: [] };
  const haystack = (context ?? "").toLowerCase();
  const missing = words.filter((w) => !haystack.includes(w.replace(/'/g, "\u2019")) && !haystack.includes(w));
  const matched = words.length - missing.length;
  return {
    checked: words.length,
    matched,
    grounded: matched / words.length >= 0.6,
    missing: missing.slice(0, 6),
  };
}

export function formatGrounding({ grounded, checked, matched, missing }) {
  if (!checked) return "no checkable terms";
  return grounded
    ? `grounded ${matched}/${checked}`
    : `not in provided context (${missing.join(", ")}) — verify`;
}
