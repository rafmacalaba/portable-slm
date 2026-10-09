import type { LocalSLM } from "../src/index.js";

/**
 * One shape of snapshot a host can read: a label, the route builder, an optional query builder, and how to
 * unwrap the response. The widget knows no routes of its own; it offers one option per shape.
 */
export interface WidgetShape {
  id: string;
  label: string;
  endpoint: (id: string) => string;
  params?: (context: { id: string; pointer?: string }) => Record<string, string> | undefined;
  unwrap?: (data: unknown, context: { id: string; pointer?: string }) => unknown;
  /** Show a JSON Pointer input for this shape. */
  fieldPath?: boolean;
}

export interface ContextWidgetOptions {
  modelId?: string;
  /** Required: what this application can read. See the worked examples for two shapes. */
  shapes: WidgetShape[];
  /** Selected shape id; defaults to the first. */
  shape?: string;
  recordId?: string;
  path?: string;
  apiBase?: string;
  /** Sample snapshots by shape id, for a demo that has no API behind it. */
  samples?: Record<string, Record<string, unknown>>;
  showAppApi?: boolean;
  /** Optional caller-supplied loader for a sample record button. */
  loadSample?: () => Promise<Record<string, unknown>>;
  sampleLabel?: string;
}

export function mountContextWidget(
  root: HTMLElement,
  ai: Pick<LocalSLM, "models" | "status" | "load" | "generate">,
  options: ContextWidgetOptions,
): { busy: () => boolean };
