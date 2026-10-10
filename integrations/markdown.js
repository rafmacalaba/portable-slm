// Spec markdown, our block model, our DOM policy.
//
// The bespoke parser this replaces rendered well under half of CommonMark's in-scope cases, and the defects
// that reached a reader were the common shapes: a wrapped list item splitting a list, a nested bullet
// flattening, a `---` swallowing the line after it. markdown-it is CommonMark, so those come from the spec
// rather than from a patch list. Measured on the spec's own 652 cases, in-scope visible text went from 48% to
// 93%, and both parse in single-digit microseconds per answer.
//
// Two things are deliberately NOT delegated to the library:
//
// 1. **The DOM.** markdown-it can render HTML, and that is the one thing this SDK must never do with model
//    output: no innerHTML, so a model emitting `<img onerror=...>` has nothing to land on, and no sanitiser
//    dependency to keep current. This module converts the token stream into the same block and run objects the
//    renderer already understood, so the renderer is unchanged.
// 2. **Links.** markdown-it would make `[text](url)` clickable. A model this size invents URLs, and a
//    hallucinated link a reader can click is worse than one they cannot, so a link becomes `text (url)` as
//    plain text, which is what the bespoke parser did.
//
// It is imported on demand. A static import would add ~43 KB gzipped to the panel's critical path for every
// mount, including mounts that never render an answer; dynamically it is fetched once, when there is something
// to render.

let engine = null;

/** The parser, once. `html: false` is the safety property, not a preference. */
async function load() {
  if (!engine) {
    const { default: MarkdownIt } = await import("markdown-it");
    engine = new MarkdownIt({ html: false, linkify: false, breaks: false });
  }
  return engine;
}

/** Inline tokens to runs, in the shape the renderer already takes. */
export function runsFromInline(children = []) {
  const runs = [];
  const push = (t, v) => { if (v) runs.push({ t, v }); };
  let emphasis = 0;
  let strong = 0;
  let link = null;
  let buffer = "";
  const flush = () => { if (buffer) { push(link ? "text" : emphasis ? "em" : strong ? "strong" : "text", buffer); buffer = ""; } };

  for (const token of children) {
    switch (token.type) {
      case "text": buffer += token.content; break;
      case "code_inline": flush(); push("code", token.content); break;
      case "softbreak": buffer += " "; break;
      case "hardbreak": buffer += "\n"; break;
      case "strong_open": flush(); strong++; break;
      case "strong_close": flush(); strong = Math.max(0, strong - 1); break;
      case "em_open": flush(); emphasis++; break;
      case "em_close": flush(); emphasis = Math.max(0, emphasis - 1); break;
      case "link_open": flush(); link = token.attrGet("href") || ""; break;
      case "link_close":
        // The URL joins the label as text, so nothing here can be clicked.
        flush();
        if (link) { push("text", ` (${link})`); link = null; }
        break;
      case "image": {
        // An image cannot be loaded (no network for assets) and alt text is what the model meant.
        flush();
        const alt = token.children ? runsFromInline(token.children).map((r) => r.v).join("") : token.content;
        push("text", alt ? `${alt} (${token.attrGet("src") || "image"})` : token.attrGet("src") || "image");
        break;
      }
      default:
        if (token.children) for (const run of runsFromInline(token.children)) runs.push(run);
        else if (token.content) buffer += token.content;
    }
  }
  flush();
  return runs;
}

/**
 * The token stream to blocks, which is the only part the library does not do for us.
 *
 * Nesting stops at one level because the block model stops there: a sub-point is another line under its parent
 * item, and a third level appends to the same list rather than pretending to an indentation the renderer cannot
 * show. A list inside a callout contributes its text to the callout, because a callout is runs in this model.
 */
export function blocksFromTokens(tokens) {
  const blocks = [];
  let quote = null;
  let pending = null;
  let table = null;
  let row = null;
  let cell = null;
  const frames = [];

  const frame = () => frames[frames.length - 1] ?? null;
  const sink = (runs) => {
    if (!runs.length) return;
    if (cell) return void cell.push(...runs);
    if (pending) return void pending.runs.push(...runs);
    if (table) return;
    const top = frame();
    if (top?.nested) {
      // Inside a nested list: one entry per nested item, which is what a sub-point is.
      if (top.entry) top.entry.push(...runs);
      else if (top.parent) top.parent.sub.push(runs);
      else if (quote) quote.runs.push(...runs);
      return;
    }
    if (top?.item) return void top.item.runs.push(...runs);
    if (quote) return void quote.runs.push(...runs);
    blocks.push({ type: "p", runs });
  };

  for (const token of tokens) {
    switch (token.type) {
      case "heading_open":
        pending = { type: "heading", level: Number(token.tag.slice(1)) || 1, runs: [] };
        break;
      case "heading_close":
        if (pending) { blocks.push(pending); pending = null; }
        break;

      case "paragraph_open":
        // A tight list item hides its paragraph, so its inline token belongs to the item itself.
        if (!token.hidden) pending = { type: "p", runs: [] };
        break;
      case "paragraph_close": {
        if (!pending) break;
        // Resolve the destination before clearing, or sink() finds the paragraph still pending and pushes the
        // runs into it a second time while the container they belong to stays empty.
        const block = pending;
        pending = null;
        if (!frame()?.item && !frame()?.nested && !quote) blocks.push(block);
        else sink(block.runs);
        break;
      }

      case "blockquote_open":
        quote = { type: "quote", runs: [] };
        break;
      case "blockquote_close":
        if (quote) { blocks.push(quote); quote = null; }
        break;

      case "bullet_list_open":
      case "ordered_list_open": {
        const ordered = token.type === "ordered_list_open";
        if (!frames.length && !quote) {
          blocks.push({ type: "list", ordered, items: [] });
          frames.push({ list: blocks[blocks.length - 1], ordered });
        } else {
          // Nested, or inside a callout. Either way its items become sub-points of the item above.
          frames.push({ nested: true, parent: frame()?.item ?? null, ordered });
        }
        break;
      }
      case "bullet_list_close":
      case "ordered_list_close":
        frames.pop();
        break;

      case "list_item_open": {
        const top = frame();
        if (!top) break;
        if (top.nested) {
          top.entry = [];
          if (top.parent) top.parent.sub.push(top.entry);
          else if (quote) quote.runs.push(...[]); // handled by sink once text arrives
        } else {
          top.item = { runs: [], sub: [] };
          top.list.items.push(top.item);
        }
        break;
      }
      case "list_item_close":
        if (frame() && !frame().nested) frame().item = null;
        else if (frame()) frame().entry = null;
        break;

      case "hr":
        blocks.push({ type: "rule" });
        break;

      case "fence":
      case "code_block":
        blocks.push({ type: "code", lang: (token.info || "").trim().split(/\s+/)[0] || "", text: token.content.replace(/\n$/, "") });
        break;

      case "table_open":
        table = { type: "table", header: [], rows: [] };
        break;
      case "table_close":
        if (table) { blocks.push(table); table = null; }
        break;
      case "tr_open":
        row = [];
        break;
      case "tr_close":
        if (row) {
          if (!table.header.length) table.header = row;
          else table.rows.push(row);
          row = null;
        }
        break;
      case "th_open":
      case "td_open":
        cell = [];
        break;
      case "th_close":
      case "td_close":
        if (row && cell) row.push(cell);
        cell = null;
        break;

      case "inline":
        sink(runsFromInline(token.children ?? []));
        break;

      default:
        break;
    }
  }
  return blocks;
}

/** The public entry: markdown text to blocks. Async because the parser arrives on demand. */
export async function blocksFromMarkdown(text) {
  const parser = await load();
  return blocksFromTokens(parser.parse(String(text ?? ""), {}));
}
