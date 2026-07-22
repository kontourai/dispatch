import { ModelInvocationError } from "@kontourai/relay";
import { executionPlanDigest, invocationDigest } from "./canonical.js";
import type { DispatchAttemptReceipt, DispatchOptions, DispatchOutcome, DispatchReceipt, EvidenceLevel, ExecutionCandidate, ExecutionPlan, RuntimeRegistry } from "./types.js";

const evidenceRank: Record<EvidenceLevel, number> = { unavailable: 0, declared: 1, confirmed: 2 };

function eligible(candidate: ExecutionCandidate, plan: ExecutionPlan): boolean {
  const required = plan.policy?.requiredCapabilities ?? [];
  const evidence = candidate.evidence ?? { level: "unavailable" as const, capabilities: [] };
  const minimum = plan.policy?.minimumEvidence ?? "unavailable";
  return evidenceRank[evidence.level] >= evidenceRank[minimum]
    && required.every((capability) => evidence.capabilities.includes(capability));
}

function terminalReceipt(plan: ExecutionPlan, attempts: readonly DispatchAttemptReceipt[], outcome: DispatchReceipt["outcome"], elapsed: number): DispatchReceipt {
  return Object.freeze({
    schemaVersion: 1,
    planDigest: executionPlanDigest(plan),
    requestDigest: invocationDigest(plan.request),
    role: plan.role,
    outcome,
    attempts: Object.freeze([...attempts]),
    totalElapsedMs: elapsed,
    totalTokens: attempts.reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0),
    estimatedCostUsd: attempts.reduce((sum, attempt) => sum + (attempt.estimatedCostUsd ?? 0), 0),
  });
}

export async function dispatch(plan: ExecutionPlan, runtimes: RuntimeRegistry, options: DispatchOptions = {}): Promise<DispatchOutcome> {
  if (plan.schemaVersion !== 1 || !plan.role || plan.budget.maxAttempts < 1) throw new TypeError("Invalid execution plan");
  const candidates = plan.candidates.filter((candidate) => eligible(candidate, plan));
  const now = options.now ?? (() => performance.now());
  const started = now();
  const attempts: DispatchAttemptReceipt[] = [];
  if (options.signal?.aborted) return { receipt: terminalReceipt(plan, attempts, "aborted", 0) as DispatchOutcome["receipt"] } as DispatchOutcome;
  if (candidates.length === 0) return { receipt: terminalReceipt(plan, attempts, "no-eligible-candidates", 0) as DispatchOutcome["receipt"] } as DispatchOutcome;

  for (const candidate of candidates.slice(0, plan.budget.maxAttempts)) {
    if (options.signal?.aborted) return { receipt: terminalReceipt(plan, attempts, "aborted", Math.max(0, now() - started)) as DispatchOutcome["receipt"] } as DispatchOutcome;
    const elapsedBefore = Math.max(0, now() - started);
    const tokensBefore = attempts.reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0);
    const costBefore = attempts.reduce((sum, attempt) => sum + (attempt.estimatedCostUsd ?? 0), 0);
    if ((plan.budget.maxElapsedMs !== undefined && elapsedBefore >= plan.budget.maxElapsedMs)
      || (plan.budget.maxTotalTokens !== undefined && tokensBefore >= plan.budget.maxTotalTokens)
      || (plan.budget.maxCostUsd !== undefined && costBefore >= plan.budget.maxCostUsd)) {
      return { receipt: terminalReceipt(plan, attempts, "budget-exceeded", elapsedBefore) as DispatchOutcome["receipt"] } as DispatchOutcome;
    }

    const runtime = runtimes.get(candidate.runtimeId);
    const attemptStarted = now();
    if (!runtime) {
      attempts.push(Object.freeze({ candidateId: candidate.id, runtimeId: candidate.runtimeId, outcome: "failed", elapsedMs: 0, errorCode: "RUNTIME_NOT_FOUND", retryable: true }));
      continue;
    }
    try {
      const result = await runtime.invoke(plan.request, options.signal ? { signal: options.signal } : undefined);
      const totalTokens = result.usage.totalTokens ?? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      const estimatedCostUsd = candidate.estimatedUsdPer1kTokens === undefined ? undefined : totalTokens * candidate.estimatedUsdPer1kTokens / 1000;
      attempts.push(Object.freeze({
        candidateId: candidate.id, runtimeId: candidate.runtimeId, outcome: "succeeded", elapsedMs: Math.max(0, now() - attemptStarted),
        ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
        totalTokens,
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      }));
      const elapsedAfter = Math.max(0, now() - started);
      const tokensAfter = attempts.reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0);
      const costAfter = attempts.reduce((sum, attempt) => sum + (attempt.estimatedCostUsd ?? 0), 0);
      if ((plan.budget.maxElapsedMs !== undefined && elapsedAfter > plan.budget.maxElapsedMs)
        || (plan.budget.maxTotalTokens !== undefined && tokensAfter > plan.budget.maxTotalTokens)
        || (plan.budget.maxCostUsd !== undefined && costAfter > plan.budget.maxCostUsd)) {
        return { receipt: terminalReceipt(plan, attempts, "budget-exceeded", elapsedAfter) as DispatchOutcome["receipt"] } as DispatchOutcome;
      }
      const receipt = terminalReceipt(plan, attempts, "succeeded", elapsedAfter) as DispatchReceipt & { outcome: "succeeded" };
      return { result, receipt };
    } catch (error) {
      const typed = error instanceof ModelInvocationError ? error : new ModelInvocationError("RUNTIME_FAILURE", "Model invocation failed", false);
      attempts.push(Object.freeze({ candidateId: candidate.id, runtimeId: candidate.runtimeId, outcome: "failed", elapsedMs: Math.max(0, now() - attemptStarted), errorCode: typed.code, retryable: typed.retryable }));
      if (typed.code === "ABORTED") return { receipt: terminalReceipt(plan, attempts, "aborted", Math.max(0, now() - started)) as DispatchOutcome["receipt"] } as DispatchOutcome;
      if (!typed.retryable && !plan.policy?.retryRuntimeFailures) break;
    }
  }
  return { receipt: terminalReceipt(plan, attempts, "exhausted", Math.max(0, now() - started)) as DispatchOutcome["receipt"] } as DispatchOutcome;
}
