// Turn a document the curator attached into prompt text, in this tab.
//
// The bytes a curator picks already exist on disk; the point of reading them here rather than on a
// server is that nothing is uploaded twice, and nothing is uploaded at all for the sake of a draft.
// The editor's own upload still happens, on the curator's own click, through the editor's own form.
//
// PDF is the case that needs a parser, and pdf.js is the only thing that can read one in a browser.
// It is not imported statically: 448 KB of parser plus a 1.2 MB worker must not sit in the initial
// bundle of a page that mostly never attaches a file. The dynamic import below fires only for a PDF,
// from the host-served path in `embed-assets.json`, the same mechanism that serves the inference wasm.
// What is vendored, and its hash, is recorded in `vendor/pdfjs/manifest.json`.

/** Above this, the file is not a questionnaire or a codebook; it is a scan, a dataset or a mistake. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * The ceiling on what this module will ever hand over. The real limit is the model's context window,
 * which the caller knows and passes as `budgetChars`; this is the backstop for a caller that asks for
 * more than any model in the catalogue can read.
 */
export const MAX_DOCUMENT_CHARS = 12000;

/** Fewer characters than this from a whole PDF means there was no text layer to read. */
const MIN_PDF_CHARS = 40;

const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "text/xml", "application/xml"];
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".log"];

/** `pdf`, `text`, or null when this build cannot read the file at all. */
export function documentKind(file) {
  const type = String(file?.type ?? "").toLowerCase();
  const name = String(file?.name ?? "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (TEXT_TYPES.includes(type) || TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) return "text";
  return null;
}

/**
 * Load pdf.js from the host-served path. Kept behind a parameter so a test can hand in a fake and the
 * real loader stays four lines rather than a mock framework.
 */
export async function loadPdfjs(assets) {
  const source = assets?.pdfjs;
  if (!source) throw new Error("No PDF runtime declared: assets.pdfjs is not set, so this host cannot read PDFs");
  const pdfjs = await import(/* @vite-ignore */ source);
  pdfjs.GlobalWorkerOptions.workerSrc = assets.pdfjsWorker;
  return pdfjs;
}

/** One page of pdf.js text content, with the item gaps that pdftotext renders as columns kept as spaces. */
function pageText(items) {
  return items.map((item) => item.str).join(" ").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Read the attached file into text for the model.
 *
 * Returns `{ kind, text, pages, truncated, note }`. A refusal is a resolved value with a `note`, not
 * a thrown error, because the panel has to say why nothing was suggested and the curator has to be
 * able to act on it: "this PDF is a scan" is advice, "TypeError" is not.
 */
export async function extractDocumentText(file, { assets, budgetChars = MAX_DOCUMENT_CHARS, onStatus = () => {}, loadPdf = loadPdfjs } = {}) {
  if (!file || typeof file.arrayBuffer !== "function") return { note: "No document was attached." };
  const kind = documentKind(file);
  if (!kind) {
    return { note: `${file.name || "That file"} is not a format this assistant reads. Attach a PDF, CSV or text export, or paste the text into the question.` };
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { note: `${file.name} is ${(file.size / 1048576).toFixed(0)} MB, over the ${(MAX_DOCUMENT_BYTES / 1048576).toFixed(0)} MB limit for a draft.` };
  }

  onStatus(`reading ${file.name || "document"}…`);
  const bytes = await file.arrayBuffer();

  if (kind === "text") {
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // A CSV or a text export is read as it is. The model sees the same characters the curator opened.
    return finished(raw, { kind, note: null, budgetChars });
  }

  // A host that never served a parser is a configuration fact, not a crash: it is the same class of
  // answer as "that is a scan", so it comes back as a note the panel can say out loud.
  let pdfjs;
  try {
    pdfjs = await loadPdf(assets);
  } catch (err) {
    return { note: err.message };
  }
  // `disableFontFace` and `isEvalSupported` keep the parser out of the page's fonts and out of eval:
  // only the text layer is wanted, and a draft has no business touching either.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = pageText(content.items);
    if (text) pages.push(text);
    onStatus(`read page ${number} of ${doc.numPages}`);
  }
  const raw = pages.join("\n\n");
  if (raw.length < MIN_PDF_CHARS) {
    return { note: `${file.name} has no text layer — it is a scan or an image. This assistant reads text only; no OCR runs here.` };
  }
  return finished(raw, { kind, pages: doc.numPages, note: null, budgetChars });
}

function finished(raw, { kind, pages = null, note, budgetChars = MAX_DOCUMENT_CHARS }) {
  const text = raw.replace(/\r\n/g, "\n").trim();
  // Budget, not ceiling: a document that fits the module and not the model produces an empty answer
  // with no explanation, because the engine clamps the reply to whatever window the prompt left.
  const budget = Math.max(400, Math.min(MAX_DOCUMENT_CHARS, budgetChars));
  const truncated = text.length > budget;
  return {
    kind,
    pages,
    truncated,
    budget,
    note,
    text: truncated ? `${text.slice(0, budget)}\n[...cut at ${budget} of ${text.length} characters to leave the model room to answer]` : text,
  };
}
