import type { LocalSLM } from "./index.js";

export interface EvidenceSnapshot {
  idno: string;
  title: string;
  abstract: string;
}

export type StudyAnswerStatus = "quoted" | "answer-in-source" | "not-stated" | "unverified";
export type StudyAnswerResult =
  | { modelId: string; engine: "cpu" | "webgpu"; answer: string; evidence: string; status: StudyAnswerStatus }
  | { modelId: string; engine: "cpu" | "webgpu"; answer: ""; evidence: ""; status: "invalid"; error: string; raw: string };

export const EVIDENCE_SNAPSHOT_KEY: string;
export const answerFormat: { type: "json_schema"; json_schema: { name: string; strict: true; schema: unknown } };
export function validateSnapshot(study: unknown): EvidenceSnapshot;
export function saveSnapshot(study: EvidenceSnapshot, storage?: Pick<Storage, "setItem">): void;
export function loadSnapshot(storage?: Pick<Storage, "getItem">): EvidenceSnapshot | null;
export function evidenceMessages(study: EvidenceSnapshot, question: string): Array<{ role: "system" | "user"; content: string }>;
export function assessAnswer(raw: string, study: EvidenceSnapshot): Omit<Extract<StudyAnswerResult, { status: StudyAnswerStatus }>, "modelId" | "engine">;
export function answerFromEvidence(
  ai: Pick<LocalSLM, "load" | "generate">,
  study: EvidenceSnapshot,
  question: string,
  options?: { modelId?: string; signal?: AbortSignal },
): Promise<StudyAnswerResult>;
