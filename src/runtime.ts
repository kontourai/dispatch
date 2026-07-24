import {
  ModelInvocationError,
  type ModelBatchInvocationOutcome,
  type ModelInvocationOptions,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelRuntime,
  type ModelRuntimeCapabilities,
} from "@kontourai/relay";
import { dispatch, dispatchBatch } from "./engine.js";
import type { AuthorizationLedger, DispatchReceipt, ExecutionPlan, RuntimeRegistry } from "./types.js";

export type DispatchRuntimePlan = Omit<ExecutionPlan, "request">;
export type ReceiptDeliveryFailureMode = "fail-closed" | "best-effort";

export interface DispatchRuntimeOptions {
  id: string;
  capabilities: ModelRuntimeCapabilities;
  plan: DispatchRuntimePlan | ((request: ModelInvocationRequest) => DispatchRuntimePlan | Promise<DispatchRuntimePlan>);
  runtimes: RuntimeRegistry;
  authorizationLedger?: AuthorizationLedger;
  onReceipt?: (receipt: DispatchReceipt) => void | Promise<void>;
  /** Defaults to fail-closed so successful execution cannot silently lose its receipt. */
  receiptDeliveryFailureMode?: ReceiptDeliveryFailureMode;
  onReceiptDeliveryFailure?: (error: ReceiptDeliveryError) => void | Promise<void>;
}

export class DispatchRuntimeError extends ModelInvocationError {
  constructor(readonly receipt: DispatchReceipt) {
    const aborted = receipt.outcome === "aborted";
    super(aborted ? "ABORTED" : receipt.outcome === "exhausted" || receipt.outcome === "no-eligible-candidates" ? "PROVIDER_UNAVAILABLE" : "RUNTIME_FAILURE",
      `Dispatch invocation ended with ${receipt.outcome}`, false);
    this.name = "DispatchRuntimeError";
  }
}

/**
 * Receipt persistence failed after Dispatch had already reached a terminal
 * outcome. This is not an invocation failure and is deliberately non-retryable.
 */
export class ReceiptDeliveryError extends ModelInvocationError {
  readonly duplicateInvocationRisk: boolean;

  constructor(
    readonly receipt: DispatchReceipt,
    readonly modelResult?: ModelInvocationResult,
  ) {
    super("RUNTIME_FAILURE", "Dispatch reached a terminal outcome but its receipt could not be delivered", false);
    this.name = "ReceiptDeliveryError";
    this.duplicateInvocationRisk = modelResult !== undefined;
  }
}

/** Expose explicit Dispatch policy through Relay's semantically inert runtime port. */
export function createDispatchRuntime(options: DispatchRuntimeOptions): ModelRuntime {
  const physicalBatch = options.capabilities.physicalBatch === true
    && Number.isInteger(options.capabilities.maxBatchSize)
    && options.capabilities.maxBatchSize! > 0;
  const maxBatchSize = physicalBatch ? options.capabilities.maxBatchSize! : undefined;
  const { physicalBatch: _physicalBatch, maxBatchSize: _maxBatchSize, ...baseCapabilities } = options.capabilities;
  const projectedCapabilities: ModelRuntimeCapabilities = physicalBatch
    ? { ...baseCapabilities, physicalBatch: true, maxBatchSize: maxBatchSize! }
    : baseCapabilities;
  const runtime: ModelRuntime = {
    id: options.id,
    capabilities: () => projectedCapabilities,
    async invoke(request: ModelInvocationRequest, invocationOptions?: ModelInvocationOptions): Promise<ModelInvocationResult> {
      const template = typeof options.plan === "function" ? await options.plan(request) : options.plan;
      const outcome = await dispatch(
        { ...template, request },
        options.runtimes,
        {
          ...(invocationOptions?.signal ? { signal: invocationOptions.signal } : {}),
          ...(options.authorizationLedger ? { authorizationLedger: options.authorizationLedger } : {}),
        },
      );
      await deliverReceipt(options, outcome.receipt, "result" in outcome ? outcome.result : undefined);
      if ("result" in outcome) return outcome.result;
      throw new DispatchRuntimeError(outcome.receipt);
    },
  };
  if (physicalBatch) {
    runtime.invokeBatch = async (
      requests: readonly ModelInvocationRequest[],
      invocationOptions?: ModelInvocationOptions,
    ): Promise<readonly ModelBatchInvocationOutcome[]> => {
      if (requests.length === 0 || requests.length > projectedCapabilities.maxBatchSize!) {
        throw new ModelInvocationError(
          "INVALID_REQUEST",
          `Dispatch batch size must be between 1 and ${String(projectedCapabilities.maxBatchSize)}`,
          false,
        );
      }
      const templates: DispatchRuntimePlan[] = [];
      for (const request of requests) {
        templates.push(typeof options.plan === "function" ? await options.plan(request) : options.plan);
      }
      const outcomes = await dispatchBatch(
        templates.map((template, index) => ({ ...template, request: requests[index]! })),
        options.runtimes,
        {
          ...(invocationOptions?.signal ? { signal: invocationOptions.signal } : {}),
          ...(options.authorizationLedger ? { authorizationLedger: options.authorizationLedger } : {}),
        },
      );
      let deliveryFailure: unknown;
      for (const outcome of outcomes) {
        try {
          await deliverReceipt(options, outcome.receipt, "result" in outcome ? outcome.result : undefined);
        } catch (error) {
          deliveryFailure ??= error;
        }
      }
      if (deliveryFailure) throw deliveryFailure;
      return outcomes.map((outcome) => {
        if ("result" in outcome) return { status: "fulfilled" as const, value: outcome.result };
        const error = new DispatchRuntimeError(outcome.receipt);
        return {
          status: "rejected" as const,
          reason: { code: error.code, message: error.message, retryable: error.retryable },
        };
      });
    };
  }
  return runtime;
}

async function deliverReceipt(
  options: DispatchRuntimeOptions,
  receipt: DispatchReceipt,
  result?: ModelInvocationResult,
): Promise<void> {
  try {
    await options.onReceipt?.(receipt);
  } catch {
    const deliveryError = new ReceiptDeliveryError(receipt, result);
    try {
      await options.onReceiptDeliveryFailure?.(deliveryError);
    } catch {
      // The diagnostic observer is best-effort and must not replace the
      // typed delivery outcome with an unrelated callback failure.
    }
    if ((options.receiptDeliveryFailureMode ?? "fail-closed") === "fail-closed") {
      throw deliveryError;
    }
  }
}
