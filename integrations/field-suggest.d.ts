import type { LocalSLM } from "../src/index.js";

/**
 * A short label for whose metadata this is; it is interpolated into the prompt, so the task bounds
 * its shape. Any application may pass its own name — this used to be
 * a fixed union of application names, which made a third host un-callable at the type level.
 */
export type SourceLabel = string;
/** Task id this helper implements; it is what a host manifest allowlists in `tasks`. */
export type SuggestFieldTask = "pslm.suggest-field";
export interface MetadataReviewDraft {
  task: SuggestFieldTask;
  source: SourceLabel;
  modelId: string;
  engine: "cpu" | "webgpu";
  formatValid: true;
  suggestion: string;
  reason: string;
}
export interface InvalidMetadataDraft {
  task: SuggestFieldTask;
  source: SourceLabel;
  modelId: string;
  engine: "cpu" | "webgpu";
  formatValid: false;
  error: string;
  raw: string;
}
export type MetadataReviewResult = MetadataReviewDraft | InvalidMetadataDraft;

export function suggestMessages(
  source: SourceLabel,
  snapshot: Record<string, unknown>,
  task?: SuggestFieldTask,
): Array<{ role: "system" | "user"; content: string }>;
export function parseSuggestion(text: string): { suggestion: string; reason: string };
export function suggestMetadata(
  ai: Pick<LocalSLM, "load" | "generate">,
  request: { task?: SuggestFieldTask; source: SourceLabel; snapshot: Record<string, unknown>; modelId?: string; signal?: AbortSignal },
): Promise<MetadataReviewResult>;
