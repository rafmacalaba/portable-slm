import type { LocalSLM } from "../src/index.js";

export type MetadataSource = "nada" | "metadata-editor";
export interface MetadataReviewDraft {
  source: MetadataSource;
  modelId: string;
  engine: "cpu" | "webgpu";
  formatValid: true;
  suggestion: string;
  reason: string;
}
export interface InvalidMetadataDraft {
  source: MetadataSource;
  modelId: string;
  engine: "cpu" | "webgpu";
  formatValid: false;
  error: string;
  raw: string;
}
export type MetadataReviewResult = MetadataReviewDraft | InvalidMetadataDraft;

export function reviewMessages(source: MetadataSource, snapshot: Record<string, unknown>): Array<{ role: "system" | "user"; content: string }>;
export function parseReview(text: string): { suggestion: string; reason: string };
export function suggestMetadata(
  ai: Pick<LocalSLM, "load" | "generate">,
  request: { source: MetadataSource; snapshot: Record<string, unknown>; modelId?: string; signal?: AbortSignal },
): Promise<MetadataReviewResult>;
