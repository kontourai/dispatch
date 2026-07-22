import type { ModelInvocationRequest, ModelInvocationResult, ModelRuntime } from "@kontourai/relay";

export type EvidenceLevel = "unavailable" | "declared" | "confirmed";

export interface CapabilityEvidence {
  level: EvidenceLevel;
  capabilities: readonly string[];
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
  retryRuntimeFailures?: boolean;
}

export interface ExecutionPlan {
  schemaVersion: 1;
  role: string;
  request: ModelInvocationRequest;
  candidates: readonly ExecutionCandidate[];
  budget: ExecutionBudget;
  policy?: ExecutionPolicy;
}

export type AttemptOutcome = "succeeded" | "failed";

export interface DispatchAttemptReceipt {
  candidateId: string;
  runtimeId: string;
  outcome: AttemptOutcome;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  errorCode?: string;
  retryable?: boolean;
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
}
