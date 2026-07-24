import { createHash } from "node:crypto";
import {
  ModelInvocationError,
  type ModelBatchInvocationOutcome,
  type ModelInvocationResult,
} from "@kontourai/relay";
import { AuthorizationExhaustedError, AuthorizationPersistenceError } from "./authorization.js";
import { executionPlanDigest, invocationDigest } from "./canonical.js";
import type { AuthorizationReservation, DispatchAttemptReceipt, DispatchOptions, DispatchOutcome, DispatchReceipt, EvidenceLevel, ExecutionCandidate, ExecutionPlan, RuntimeRegistry, StructuredToolsFidelity } from "./types.js";

const evidenceRank: Record<EvidenceLevel, number> = { unavailable: 0, declared: 1, confirmed: 2 };
const fidelityRank: Record<StructuredToolsFidelity, number> = { unavailable: 0, prompted: 1, native: 2 };
const invocationErrorCodes = new Set([
  "ABORTED",
  "AUTHENTICATION_FAILED",
  "INVALID_REQUEST",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "RUNTIME_FAILURE",
]);
const authorizationId = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

function eligible(candidate: ExecutionCandidate, plan: ExecutionPlan): boolean {
  const required = plan.policy?.requiredCapabilities ?? [];
  const evidence = candidate.evidence ?? { level: "unavailable" as const, capabilities: [] };
  const minimum = plan.policy?.minimumEvidence ?? "unavailable";
  const requiresStructuredTools = required.includes("structured-tools");
  const minimumFidelity = plan.policy?.minimumStructuredToolsFidelity
    ?? (requiresStructuredTools ? "native" : undefined);
  const fidelity = evidence.structuredToolsFidelity ?? "unavailable";
  const fidelityIsKnown = fidelity === "unavailable" || fidelity === "prompted" || fidelity === "native";
  const fidelityIsConsistent = evidence.capabilities.includes("structured-tools")
    ? fidelity === "prompted" || fidelity === "native"
    : fidelity === "unavailable";
  return evidenceRank[evidence.level] >= evidenceRank[minimum]
    && required.every((capability) => evidence.capabilities.includes(capability))
    && fidelityIsKnown
    && fidelityIsConsistent
    && (minimumFidelity === undefined || fidelityRank[fidelity] >= fidelityRank[minimumFidelity]);
}

function attemptIdentity(candidate: ExecutionCandidate) {
  const fidelity = candidate.evidence?.structuredToolsFidelity;
  return {
    candidateId: candidate.id,
    runtimeId: candidate.runtimeId,
    ...(fidelity === undefined ? {} : { structuredToolsFidelity: fidelity }),
  };
}

function terminalReceipt(
  plan: ExecutionPlan,
  attempts: readonly DispatchAttemptReceipt[],
  outcome: DispatchReceipt["outcome"],
  elapsed: number,
  authorizationOutcome?: "reserved" | "settled" | "exhausted",
  physicalBatch?: DispatchReceipt["physicalBatch"],
): DispatchReceipt {
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
    ...(physicalBatch ? { physicalBatch: Object.freeze({ ...physicalBatch }) } : {}),
    ...(plan.authorization && authorizationOutcome ? {
      authorization: Object.freeze({
        id: plan.authorization.id,
        invocationId: plan.authorization.invocationId,
        outcome: authorizationOutcome,
      }),
    } : {}),
  });
}

export async function dispatch(plan: ExecutionPlan, runtimes: RuntimeRegistry, options: DispatchOptions = {}): Promise<DispatchOutcome> {
  validatePlan(plan);
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
      attempts.push(Object.freeze({ ...attemptIdentity(candidate), outcome: "failed", elapsedMs: 0, errorCode: "RUNTIME_NOT_FOUND", retryable: true }));
      continue;
    }
    const reservation = reservationFor(plan, candidate, attempts.length + 1);
    if (reservation) {
      if (!options.authorizationLedger) {
        throw new AuthorizationPersistenceError("Execution authorization requires an authorization ledger");
      }
      try {
        const reserved = await options.authorizationLedger.reserve(reservation);
        if (reserved.status !== "reserved") {
          throw new AuthorizationPersistenceError(
            "Authorization reservation already exists; automatic provider replay is refused",
            undefined,
            "recovery",
          );
        }
      } catch (error) {
        if (error instanceof AuthorizationExhaustedError) {
          return {
            receipt: terminalReceipt(plan, attempts, "budget-exceeded", elapsedBefore, "exhausted") as DispatchOutcome["receipt"],
          } as DispatchOutcome;
        }
        if (error instanceof AuthorizationPersistenceError) throw error;
        throw new AuthorizationPersistenceError(undefined, error);
      }
      if (options.signal?.aborted) {
        try {
          await options.authorizationLedger.release({
            authorizationId: reservation.authorizationId,
            reservationId: reservation.reservationId,
            reason: "confirmed-not-launched",
          });
        } catch (error) {
          if (error instanceof AuthorizationPersistenceError) throw error;
          throw new AuthorizationPersistenceError(undefined, error);
        }
        return {
          receipt: terminalReceipt(plan, attempts, "aborted", Math.max(0, now() - started)) as DispatchOutcome["receipt"],
        } as DispatchOutcome;
      }
    }
    try {
      const result = await runtime.invoke(plan.request, options.signal ? { signal: options.signal } : undefined);
      const totalTokens = result.usage.totalTokens ?? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      const estimatedCostUsd = candidate.estimatedUsdPer1kTokens === undefined ? undefined : totalTokens * candidate.estimatedUsdPer1kTokens / 1000;
      const attempt: DispatchAttemptReceipt = {
        ...attemptIdentity(candidate), outcome: "succeeded", elapsedMs: Math.max(0, now() - attemptStarted),
        ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
        totalTokens,
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
        ...(reservation ? { reservationId: reservation.reservationId, reservationState: "reserved" as const } : {}),
      };
      if (reservation) {
        try {
          await options.authorizationLedger!.settle({
            authorizationId: reservation.authorizationId,
            reservationId: reservation.reservationId,
            usage: {
              attempts: 1,
              totalTokens,
              costUsd: estimatedCostUsd ?? reservation.capacity.maxCostUsd ?? 0,
            },
          });
          attempt.reservationState = "settled";
        } catch (error) {
          throw new AuthorizationPersistenceError(
            "Provider invocation completed but authorization settlement failed",
            error,
            "settle",
          );
        }
      }
      attempts.push(Object.freeze(attempt));
      const elapsedAfter = Math.max(0, now() - started);
      const tokensAfter = attempts.reduce((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0);
      const costAfter = attempts.reduce((sum, attempt) => sum + (attempt.estimatedCostUsd ?? 0), 0);
      if ((plan.budget.maxElapsedMs !== undefined && elapsedAfter > plan.budget.maxElapsedMs)
        || (plan.budget.maxTotalTokens !== undefined && tokensAfter > plan.budget.maxTotalTokens)
        || (plan.budget.maxCostUsd !== undefined && costAfter > plan.budget.maxCostUsd)) {
        return { receipt: terminalReceipt(plan, attempts, "budget-exceeded", elapsedAfter, authorizationOutcome(attempts)) as DispatchOutcome["receipt"] } as DispatchOutcome;
      }
      const receipt = terminalReceipt(plan, attempts, "succeeded", elapsedAfter, authorizationOutcome(attempts)) as DispatchReceipt & { outcome: "succeeded" };
      return { result, receipt };
    } catch (error) {
      if (error instanceof AuthorizationPersistenceError) throw error;
      const typed = normalizeInvocationError(error);
      attempts.push(Object.freeze({
        ...attemptIdentity(candidate),
        outcome: "failed",
        elapsedMs: Math.max(0, now() - attemptStarted),
        errorCode: typed.code,
        retryable: typed.retryable,
        ...(reservation ? { reservationId: reservation.reservationId, reservationState: "reserved" as const } : {}),
      }));
      if (typed.code === "ABORTED") return { receipt: terminalReceipt(plan, attempts, "aborted", Math.max(0, now() - started), authorizationOutcome(attempts)) as DispatchOutcome["receipt"] } as DispatchOutcome;
      if (!typed.retryable && !plan.policy?.retryRuntimeFailures) break;
    }
  }
  return { receipt: terminalReceipt(plan, attempts, "exhausted", Math.max(0, now() - started), authorizationOutcome(attempts)) as DispatchOutcome["receipt"] } as DispatchOutcome;
}

/**
 * Execute one provider-native physical batch for the first eligible candidate,
 * then route item-local failures through the remaining explicit fallback plan.
 * Every item that enters the physical operation is durably reserved first.
 */
export async function dispatchBatch(
  plans: readonly ExecutionPlan[],
  runtimes: RuntimeRegistry,
  options: DispatchOptions = {},
): Promise<readonly DispatchOutcome[]> {
  if (plans.length === 0) throw new TypeError("Dispatch batch requires at least one execution plan");
  for (const plan of plans) validatePlan(plan);
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (options.signal?.aborted) {
    return plans.map((plan) => ({
      receipt: terminalReceipt(plan, [], "aborted", 0) as DispatchOutcome["receipt"],
    } as DispatchOutcome));
  }

  const selected = plans.map((plan) => plan.candidates.filter((candidate) => eligible(candidate, plan))[0]);
  const outcomes: Array<DispatchOutcome | undefined> = new Array(plans.length);
  for (let index = 0; index < plans.length; index++) {
    if (!selected[index]) {
      outcomes[index] = {
        receipt: terminalReceipt(plans[index]!, [], "no-eligible-candidates", 0) as DispatchOutcome["receipt"],
      } as DispatchOutcome;
    }
  }
  const activeIndexes = plans.map((_, index) => index).filter((index) => selected[index] !== undefined);
  if (activeIndexes.length === 0) return outcomes as DispatchOutcome[];
  const firstActiveIndex = activeIndexes[0]!;
  const runtimeId = selected[firstActiveIndex]!.runtimeId;
  if (activeIndexes.some((index) => selected[index]!.runtimeId !== runtimeId)) {
    throw new ModelInvocationError(
      "INVALID_REQUEST",
      "Dispatch physical batch requires one common primary runtime",
      false,
    );
  }
  const runtime = runtimes.get(runtimeId);
  const capabilities = runtime?.capabilities();
  if (!runtime || capabilities?.physicalBatch !== true || typeof runtime.invokeBatch !== "function"
    || !Number.isInteger(capabilities.maxBatchSize) || capabilities.maxBatchSize! < activeIndexes.length) {
    throw new ModelInvocationError(
      "INVALID_REQUEST",
      "Selected Dispatch runtime cannot preserve the requested physical batch",
      false,
    );
  }

  const reservations = new Map<number, AuthorizationReservation>();
  const launchIndexes: number[] = [];
  for (const index of activeIndexes) {
    const plan = plans[index]!;
    const candidate = selected[index]!;
    const reservation = reservationFor(plan, candidate, 1);
    if (reservation) {
      if (!options.authorizationLedger) {
        await releaseReservations(reservations, options.authorizationLedger);
        throw new AuthorizationPersistenceError("Execution authorization requires an authorization ledger");
      }
      try {
        const reserved = await options.authorizationLedger.reserve(reservation);
        if (reserved.status !== "reserved") {
          throw new AuthorizationPersistenceError(
            "Authorization reservation already exists; automatic provider replay is refused",
            undefined,
            "recovery",
          );
        }
        reservations.set(index, reservation);
      } catch (error) {
        if (error instanceof AuthorizationExhaustedError) {
          outcomes[index] = {
            receipt: terminalReceipt(plan, [], "budget-exceeded", Math.max(0, now() - started), "exhausted") as DispatchOutcome["receipt"],
          } as DispatchOutcome;
          continue;
        }
        await releaseReservations(reservations, options.authorizationLedger);
        if (error instanceof AuthorizationPersistenceError) throw error;
        throw new AuthorizationPersistenceError(undefined, error);
      }
    }
    launchIndexes.push(index);
  }
  if (launchIndexes.length === 0) return outcomes as DispatchOutcome[];
  if (options.signal?.aborted) {
    await releaseReservations(reservations, options.authorizationLedger);
    for (const index of launchIndexes) {
      outcomes[index] = {
        receipt: terminalReceipt(plans[index]!, [], "aborted", Math.max(0, now() - started)) as DispatchOutcome["receipt"],
      } as DispatchOutcome;
    }
    return outcomes as DispatchOutcome[];
  }

  const physicalStarted = now();
  let nativeOutcomes: readonly ModelBatchInvocationOutcome[];
  try {
    nativeOutcomes = await runtime.invokeBatch(
      launchIndexes.map((index) => plans[index]!.request),
      options.signal ? { signal: options.signal } : undefined,
    );
    if (!Array.isArray(nativeOutcomes) || nativeOutcomes.length !== launchIndexes.length) {
      throw new ModelInvocationError(
        "RUNTIME_FAILURE",
        "Physical runtime returned an invalid batch outcome count",
        false,
      );
    }
  } catch (error) {
    const typed = normalizeInvocationError(error);
    nativeOutcomes = launchIndexes.map(() => ({
      status: "rejected" as const,
      reason: { code: typed.code, message: typed.message, retryable: typed.retryable },
    }));
  }
  const physicalElapsed = Math.max(0, now() - physicalStarted);
  const operationId = `batch_${createHash("sha256").update([
    "dispatch:physical-batch:v1",
    runtimeId,
    ...launchIndexes.map((index) => invocationDigest(plans[index]!.request)),
  ].join("\0")).digest("hex")}`;

  await Promise.all(launchIndexes.map(async (index, nativeIndex) => {
    const plan = plans[index]!;
    const candidate = selected[index]!;
    const reservation = reservations.get(index);
    const native = nativeOutcomes[nativeIndex]!;
    const physicalBatch = { operationId, itemIndex: nativeIndex, itemCount: launchIndexes.length };
    if (native.status === "fulfilled") {
      const attempt = successfulAttempt(candidate, native.value, physicalElapsed, reservation);
      if (reservation) {
        await settleReservation(options.authorizationLedger!, reservation, attempt);
        attempt.reservationState = "settled";
      }
      if ((plan.budget.maxElapsedMs !== undefined && Math.max(0, now() - started) > plan.budget.maxElapsedMs)
        || (plan.budget.maxTotalTokens !== undefined && (attempt.totalTokens ?? 0) > plan.budget.maxTotalTokens)
        || (plan.budget.maxCostUsd !== undefined && (attempt.estimatedCostUsd ?? 0) > plan.budget.maxCostUsd)) {
        outcomes[index] = {
          receipt: terminalReceipt(
            plan,
            [Object.freeze(attempt)],
            "budget-exceeded",
            Math.max(0, now() - started),
            authorizationOutcome([attempt]),
            physicalBatch,
          ) as DispatchOutcome["receipt"],
        } as DispatchOutcome;
        return;
      }
      const receipt = terminalReceipt(
        plan,
        [Object.freeze(attempt)],
        "succeeded",
        Math.max(0, now() - started),
        authorizationOutcome([attempt]),
        physicalBatch,
      ) as DispatchReceipt & { outcome: "succeeded" };
      outcomes[index] = { result: native.value, receipt };
      return;
    }

    const typed = normalizeInvocationError(native.reason);
    const primaryAttempt = Object.freeze({
      ...attemptIdentity(candidate),
      outcome: "failed" as const,
      elapsedMs: physicalElapsed,
      errorCode: typed.code,
      retryable: typed.retryable,
      ...(reservation ? { reservationId: reservation.reservationId, reservationState: "reserved" as const } : {}),
    });
    const fallbackCandidates = plan.candidates
      .filter((candidate) => eligible(candidate, plan))
      .slice(1);
    const canFallback = fallbackCandidates.length > 0
      && plan.budget.maxAttempts > 1
      && typed.code !== "ABORTED"
      && (typed.retryable || plan.policy?.retryRuntimeFailures === true);
    if (!canFallback) {
      const terminal = typed.code === "ABORTED" ? "aborted" : "exhausted";
      outcomes[index] = {
        receipt: terminalReceipt(
          plan,
          [primaryAttempt],
          terminal,
          Math.max(0, now() - started),
          authorizationOutcome([primaryAttempt]),
          physicalBatch,
        ) as DispatchOutcome["receipt"],
      } as DispatchOutcome;
      return;
    }
    const remainingElapsed = plan.budget.maxElapsedMs === undefined
      ? undefined
      : Math.max(1, plan.budget.maxElapsedMs - Math.max(0, now() - started));
    const fallback = await dispatch({
      ...plan,
      candidates: fallbackCandidates,
      budget: {
        ...plan.budget,
        maxAttempts: plan.budget.maxAttempts - 1,
        ...(remainingElapsed === undefined ? {} : { maxElapsedMs: remainingElapsed }),
      },
    }, runtimes, options);
    const attempts = [primaryAttempt, ...fallback.receipt.attempts];
    const receipt = terminalReceipt(
      plan,
      attempts,
      fallback.receipt.outcome,
      Math.max(0, now() - started),
      authorizationOutcome(attempts),
      physicalBatch,
    );
    outcomes[index] = "result" in fallback
      ? { result: fallback.result, receipt: receipt as DispatchReceipt & { outcome: "succeeded" } }
      : { receipt: receipt as DispatchOutcome["receipt"] } as DispatchOutcome;
  }));
  return outcomes as DispatchOutcome[];
}

function validatePlan(plan: ExecutionPlan): void {
  if (plan.schemaVersion !== 1 || !plan.role || plan.budget.maxAttempts < 1) {
    throw new TypeError("Invalid execution plan");
  }
  validateAuthorizationPlan(plan);
}

function successfulAttempt(
  candidate: ExecutionCandidate,
  result: ModelInvocationResult,
  elapsedMs: number,
  reservation: AuthorizationReservation | undefined,
): DispatchAttemptReceipt {
  const totalTokens = result.usage.totalTokens
    ?? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
  const estimatedCostUsd = candidate.estimatedUsdPer1kTokens === undefined
    ? undefined
    : totalTokens * candidate.estimatedUsdPer1kTokens / 1_000;
  return {
    ...attemptIdentity(candidate),
    outcome: "succeeded",
    elapsedMs,
    ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
    ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
    totalTokens,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(reservation ? { reservationId: reservation.reservationId, reservationState: "reserved" } : {}),
  };
}

async function settleReservation(
  ledger: NonNullable<DispatchOptions["authorizationLedger"]>,
  reservation: AuthorizationReservation,
  attempt: DispatchAttemptReceipt,
): Promise<void> {
  try {
    await ledger.settle({
      authorizationId: reservation.authorizationId,
      reservationId: reservation.reservationId,
      usage: {
        attempts: 1,
        totalTokens: attempt.totalTokens ?? 0,
        costUsd: attempt.estimatedCostUsd ?? reservation.capacity.maxCostUsd ?? 0,
      },
    });
  } catch (error) {
    throw new AuthorizationPersistenceError(
      "Provider invocation completed but authorization settlement failed",
      error,
      "settle",
    );
  }
}

async function releaseReservations(
  reservations: ReadonlyMap<number, AuthorizationReservation>,
  ledger: DispatchOptions["authorizationLedger"],
): Promise<void> {
  if (!ledger) return;
  await Promise.all([...reservations.values()].map((reservation) => ledger.release({
    authorizationId: reservation.authorizationId,
    reservationId: reservation.reservationId,
    reason: "confirmed-not-launched",
  })));
}

function validateAuthorizationPlan(plan: ExecutionPlan): void {
  for (const candidate of plan.candidates) {
    if (candidate.worstCaseUsage?.maxTokens !== undefined
      && (!Number.isSafeInteger(candidate.worstCaseUsage.maxTokens) || candidate.worstCaseUsage.maxTokens < 1)) {
      throw new TypeError("Invalid candidate worst-case token capacity");
    }
    if (candidate.worstCaseUsage?.maxCostUsd !== undefined
      && (!Number.isFinite(candidate.worstCaseUsage.maxCostUsd) || candidate.worstCaseUsage.maxCostUsd <= 0)) {
      throw new TypeError("Invalid candidate worst-case cost capacity");
    }
  }
  const authorization = plan.authorization;
  if (!authorization) return;
  if (authorization.schemaVersion !== 1 || !authorizationId.test(authorization.id)
    || !authorizationId.test(authorization.invocationId)
    || !Number.isSafeInteger(authorization.limits.maxAttempts) || authorization.limits.maxAttempts < 1
    || (authorization.limits.maxTotalTokens !== undefined
      && (!Number.isSafeInteger(authorization.limits.maxTotalTokens) || authorization.limits.maxTotalTokens < 1))
    || (authorization.limits.maxCostUsd !== undefined
      && (!Number.isFinite(authorization.limits.maxCostUsd) || authorization.limits.maxCostUsd <= 0))) {
    throw new TypeError("Invalid execution authorization");
  }
  if (authorization.limits.maxTotalTokens !== undefined
    && plan.candidates.some((candidate) => candidate.worstCaseUsage?.maxTokens === undefined)) {
    throw new TypeError("Token-bounded authorization requires candidate worst-case token capacity");
  }
  if (authorization.limits.maxCostUsd !== undefined
    && plan.candidates.some((candidate) => candidate.worstCaseUsage?.maxCostUsd === undefined)) {
    throw new TypeError("Cost-bounded authorization requires candidate worst-case cost capacity");
  }
}

function reservationFor(plan: ExecutionPlan, candidate: ExecutionCandidate, attempt: number): AuthorizationReservation | undefined {
  const authorization = plan.authorization;
  if (!authorization) return undefined;
  return {
    authorizationId: authorization.id,
    invocationId: authorization.invocationId,
    reservationId: `rsv_${createHash("sha256").update(`${authorization.id}\0${authorization.invocationId}\0${attempt}\0${candidate.id}`).digest("hex")}`,
    limits: authorization.limits,
    capacity: {
      attempts: 1,
      ...(candidate.worstCaseUsage?.maxTokens === undefined ? {} : { maxTokens: candidate.worstCaseUsage.maxTokens }),
      ...(candidate.worstCaseUsage?.maxCostUsd === undefined ? {} : { maxCostUsd: candidate.worstCaseUsage.maxCostUsd }),
    },
  };
}

function authorizationOutcome(attempts: readonly DispatchAttemptReceipt[]): "reserved" | "settled" | undefined {
  const reservations = attempts.filter((attempt) => attempt.reservationState !== undefined);
  if (reservations.length === 0) return undefined;
  return reservations.every((attempt) => attempt.reservationState === "settled") ? "settled" : "reserved";
}

function normalizeInvocationError(error: unknown): ModelInvocationError {
  if (error instanceof ModelInvocationError) return error;
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; retryable?: unknown };
    if (typeof candidate.code === "string"
      && invocationErrorCodes.has(candidate.code)
      && typeof candidate.retryable === "boolean") {
      return new ModelInvocationError(
        candidate.code as ModelInvocationError["code"],
        "Model invocation failed",
        candidate.retryable,
      );
    }
  }
  return new ModelInvocationError("RUNTIME_FAILURE", "Model invocation failed", false);
}
