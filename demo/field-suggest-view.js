import { mountContextWidget } from "../integrations/widget.js";
import { pickStudySummary } from "../integrations/snapshot-context.js";
import { loadPublicDemoStudy } from "../examples/catalogue/public-catalogue-demo.js";

// Two shapes, named for what they are. Routes belong to the caller: the widget keeps none.
const shapes = [
  {
    id: "catalogue",
    label: "Catalogue study",
    endpoint: (id) => `catalog/${encodeURIComponent(id)}`,
    unwrap: (data, { id }) => pickStudySummary(data, id),
  },
  {
    id: "record-editor",
    label: "Record field",
    fieldPath: true,
    endpoint: (id) => `records/json_field/${encodeURIComponent(id)}`,
    params: ({ pointer }) => ({ path: pointer }),
    unwrap: (data, { id, pointer }) => {
      if (data.status !== "success" || !data.found) throw new Error(`Field ${pointer} was not found`);
      return { id, path: pointer, value: data.value };
    },
  },
];

const samples = {
  catalogue: { idno: "TEST-2030", title: "Household Survey", abstract: "The survey collected household data." },
  "record-editor": { idno: "TEST-2030", type: "microdata", identification: { title: "Household Survey" }, description: "Household survey of residents." },
};

export function mountFieldSuggest(root, ai, { embedded = false, source, recordId = "", path, apiBase } = {}) {
  root.replaceChildren();
  if (embedded) {
    const heading = document.createElement("h2");
    heading.textContent = "Metadata suggestion";
    const intro = document.createElement("p");
    intro.textContent = "Read one authorized field/study or paste JSON. Suggestion + reason is this demo's output format, not an app requirement. Inspect before using; nothing is saved.";
    root.append(heading, intro);
  }
  const widget = document.createElement("div");
  widget.id = "context-widget";
  root.append(widget);
  // Offer the host's own API only when this UI is actually mounted inside the host application.
  const hostContext = Boolean(source && recordId);
  return mountContextWidget(widget, ai, {
    shapes,
    shape: source ?? "catalogue",
    recordId: recordId || "TEST-2030",
    path,
    apiBase,
    samples: hostContext ? {} : samples,
    showAppApi: embedded,
    loadSample: () => loadPublicDemoStudy(),
    sampleLabel: "Load a public sample study (online)",
  });
}
