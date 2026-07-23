import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelRuntimeCapabilities } from "@kontourai/relay";
import { dispatch } from "./engine.js";
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
  return {
    id: options.id,
    capabilities: () => options.capabilities,
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
      try {
        await options.onReceipt?.(outcome.receipt);
      } catch {
        const deliveryError = new ReceiptDeliveryError(outcome.receipt, "result" in outcome ? outcome.result : undefined);
        try {
          await options.onReceiptDeliveryFailure?.(deliveryError);
        } catch {
          // The diagnostic observer is best-effort and must not replace the
          // typed delivery outcome with an unrelated callback failure.
        }
        if ((options.receiptDeliveryFailureMode ?? "fail-closed") === "fail-closed") throw deliveryError;
      }
      if ("result" in outcome) return outcome.result;
      throw new DispatchRuntimeError(outcome.receipt);
    },
  };
}
