import { mountMetadataWidget } from "../integrations/metadata-widget.js";

const samples = {
  nada: { idno: "TEST-2030", title: "Household Survey", abstract: "The survey collected household data." },
  "metadata-editor": { idno: "TEST-2030", type: "microdata", identification: { title: "Household Survey" }, description: "Household survey of residents." },
};

export function mountReview(root, ai, { embedded = false, source, recordId = "", path, apiBase } = {}) {
  root.replaceChildren();
  if (embedded) {
    const heading = document.createElement("h2");
    heading.textContent = "Metadata suggestion";
    const intro = document.createElement("p");
    intro.textContent = "Read one authorized field/study or paste JSON. Suggestion + reason is this demo's output format, not an app requirement. Inspect before using; nothing is saved.";
    root.append(heading, intro);
  }
  const widget = document.createElement("div");
  widget.id = "metadata-widget";
  root.append(widget);
  const hfHosted = /\.static\.hf\.space$/.test(location.hostname);
  const hostContext = Boolean(source && recordId);
  return mountMetadataWidget(widget, ai, {
    source: source ?? "nada",
    recordId: recordId || "TEST-2030",
    path,
    apiBase,
    samples: hostContext ? {} : samples,
    showAppApi: !hfHosted,
  });
}
