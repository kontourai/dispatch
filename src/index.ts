export { executionPlanDigest } from "./canonical.js";
export { dispatch } from "./engine.js";
export { withCapabilityEvidence } from "./evidence.js";
export { createDispatchRuntime, DispatchRuntimeError } from "./runtime.js";
export type { DispatchRuntimeOptions, DispatchRuntimePlan } from "./runtime.js";
export type {
  AttemptOutcome, CapabilityEvidence, CapabilityEvidenceSource, DispatchAttemptReceipt, DispatchFailure,
  DispatchOptions, DispatchOutcome, DispatchReceipt, DispatchSuccess,
  DispatchTerminalOutcome, EvidenceLevel, ExecutionBudget, ExecutionCandidate, StructuredToolsFidelity,
  ExecutionPlan, ExecutionPolicy, RuntimeRegistry,
} from "./types.js";
export const DISPATCH_RECEIPT_SCHEMA_VERSION = 1 as const;
