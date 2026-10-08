/**
 * Generic host-side logging: forward the events the assistant already emits to an endpoint of the
 * host's own, one JSON line per event. See docs/HOST_CONTRACT.md §logging for the endpoint contract
 * (the host stamps identity and time; this module never invents them).
 */

/** Per-field bound applied here; the endpoint must bound the body again, as the client is untrusted. */
export declare const MAX_FIELD_CHARS = 4000;

/** Keys the host endpoint owns and the client may not set. */
export declare const RESERVED_LOG_KEYS: readonly string[];

export interface LogContext {
  recordId?: string;
  section?: string;
  dataFileId?: string;
}

export interface AttachLogOptions {
  /** Host endpoint that accepts one JSON event per request. The only required option. */
  url: string;
  /** Extra host context, merged into the payload before reserved keys are stripped. */
  extra?: (event: string, detail: unknown) => Record<string, unknown> | null;
  /** Observe each payload as it is sent (a local mirror, a test). */
  onSend?: (payload: Record<string, unknown>) => void;
  maxFieldChars?: number;
}

/**
 * Attach the forwarder to the mounted assistant. Returns a detach function.
 * With no `url` it is inert, so a host that has not built an endpoint can still mount.
 */
export declare function attachAssistantLog(
  root: Element & { dataset: DOMStringMap },
  options: AttachLogOptions,
): () => void;

/** One event's fields, or null when the event is not worth recording. Pure. */
export declare function logFieldsFor(event: string, detail?: Record<string, unknown>): Record<string, unknown> | null;

/** The request body for one event. Pure, so the contract a host implements is testable. */
export declare function buildLogPayload(
  event: string,
  detail?: Record<string, unknown>,
  context?: LogContext,
  options?: { maxFieldChars?: number },
): Record<string, unknown>;
