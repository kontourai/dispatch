import type { ModelInvocationRequest, ModelInvocationResult, ModelRuntime } from "@kontourai/relay";

export type EvidenceLevel = "unavailable" | "declared" | "confirmed";
export type StructuredToolsFidelity = "unavailable" | "prompted" | "native";

export interface CapabilityEvidence {
  level: EvidenceLevel;
  capabilities: readonly string[];
  structuredToolsFidelity?: StructuredToolsFidelity;
  source?: string;
}

export interface CapabilityEvidenceSource {
  evidenceFor(candidate: ExecutionCandidate): Promise<CapabilityEvidence | undefined>;
}

export interface ExecutionCandidate {
  id: string;
  runtimeId: string;
  evidence?: CapabilityEvidence;
  estimatedUsdPer1kTokens?: number;
  /** Caller-supplied worst-case capacity reserved before this candidate runs. */
  worstCaseUsage?: {
    maxTokens?: number;
    maxCostUsd?: number;
  };
}

export interface ExecutionBudget {
  maxAttempts: number;
  maxElapsedMs?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
}

export interface ExecutionPolicy {
  requiredCapabilities?: readonly string[];
  minimumEvidence?: EvidenceLevel;
  /** Defaults to native when `structured-tools` is required. */
  minimumStructuredToolsFidelity?: Exclude<StructuredToolsFidelity, "unavailable">;
  retryRuntimeFailures?: boolean;
}

export interface ExecutionPlan {
  schemaVersion: 1;
  role: string;
  request: ModelInvocationRequest;
  candidates: readonly ExecutionCandidate[];
  budget: ExecutionBudget;
  policy?: ExecutionPolicy;
  /**
   * Durable capacity shared by every invocation carrying the same authorization
   * id. The invocation id must be unique within that authorization.
   */
  authorization?: ExecutionAuthorization;
}

export interface ExecutionAuthorization {
  schemaVersion: 1;
  id: string;
  invocationId: string;
  limits: {
    maxAttempts: number;
    maxTotalTokens?: number;
    maxCostUsd?: number;
  };
}

export type AttemptOutcome = "succeeded" | "failed";

export interface DispatchAttemptReceipt {
  candidateId: string;
  runtimeId: string;
  outcome: AttemptOutcome;
  structuredToolsFidelity?: StructuredToolsFidelity;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  errorCode?: string;
  retryable?: boolean;
  reservationId?: string;
  reservationState?: "reserved" | "settled";
}

export type DispatchTerminalOutcome = "succeeded" | "aborted" | "exhausted" | "budget-exceeded" | "no-eligible-candidates";

export interface DispatchReceipt {
  schemaVersion: 1;
  planDigest: string;
  requestDigest: string;
  role: string;
  outcome: DispatchTerminalOutcome;
  attempts: readonly DispatchAttemptReceipt[];
  totalElapsedMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
  authorization?: {
    id: string;
    invocationId: string;
    outcome: "reserved" | "settled" | "exhausted";
  };
}

export interface DispatchSuccess {
  result: ModelInvocationResult;
  receipt: DispatchReceipt & { outcome: "succeeded" };
}

export interface DispatchFailure {
  result?: never;
  receipt: DispatchReceipt & { outcome: Exclude<DispatchTerminalOutcome, "succeeded"> };
}

export type DispatchOutcome = DispatchSuccess | DispatchFailure;

export interface RuntimeRegistry {
  get(runtimeId: string): ModelRuntime | undefined;
}

export interface DispatchOptions {
  now?: () => number;
  signal?: AbortSignal;
  authorizationLedger?: AuthorizationLedger;
}

export interface AuthorizationReservation {
  authorizationId: string;
  invocationId: string;
  reservationId: string;
  limits: ExecutionAuthorization["limits"];
  capacity: {
    attempts: 1;
    maxTokens?: number;
    maxCostUsd?: number;
  };
}

export interface AuthorizationSettlement {
  authorizationId: string;
  reservationId: string;
  usage: {
    attempts: 1;
    totalTokens: number;
    costUsd: number;
  };
}

export interface AuthorizationRelease {
  authorizationId: string;
  reservationId: string;
  reason: "confirmed-not-launched" | "provider-reconciled" | "operator-reconciled";
}

export interface AuthorizationLedger {
  reserve(reservation: AuthorizationReservation): Promise<{
    status: "reserved" | "already-reserved" | "already-settled" | "already-released";
  }>;
  settle(settlement: AuthorizationSettlement): Promise<void>;
  release(release: AuthorizationRelease): Promise<void>;
}
