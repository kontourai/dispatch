export { executionPlanDigest } from "./canonical.js";
export { dispatch } from "./engine.js";
export {
  AuthorizationExhaustedError,
  AuthorizationPersistenceError,
  FileAuthorizationLedger,
} from "./authorization.js";
export type { FileAuthorizationLedgerOptions } from "./authorization.js";
export { withCapabilityEvidence } from "./evidence.js";
export { createDispatchRuntime, DispatchRuntimeError, ReceiptDeliveryError } from "./runtime.js";
export type { DispatchRuntimeOptions, DispatchRuntimePlan, ReceiptDeliveryFailureMode } from "./runtime.js";
export type {
  AttemptOutcome, CapabilityEvidence, CapabilityEvidenceSource, DispatchAttemptReceipt, DispatchFailure,
  DispatchOptions, DispatchOutcome, DispatchReceipt, DispatchSuccess,
  DispatchTerminalOutcome, EvidenceLevel, ExecutionAuthorization, ExecutionBudget, ExecutionCandidate,
  StructuredToolsFidelity, ExecutionPlan, ExecutionPolicy, RuntimeRegistry,
  AuthorizationLedger, AuthorizationRelease, AuthorizationReservation, AuthorizationSettlement,
} from "./types.js";
export const DISPATCH_RECEIPT_SCHEMA_VERSION = 1 as const;
