import type { LocalSLM } from "../src/index.js";
import type { MetadataSource } from "./metadata-review.js";

export interface MetadataWidgetOptions {
  modelId?: string;
  source?: MetadataSource;
  recordId?: string;
  path?: string;
  apiBase?: string;
  samples?: Partial<Record<MetadataSource, Record<string, unknown>>>;
  showAppApi?: boolean;
}
export function mountMetadataWidget(
  root: HTMLElement,
  ai: Pick<LocalSLM, "models" | "status" | "load" | "generate">,
  options?: MetadataWidgetOptions,
): { busy: () => boolean };
