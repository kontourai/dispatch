import { ModelInvocationError, type ModelInvocationOptions, type ModelInvocationRequest, type ModelInvocationResult, type ModelRuntime, type ModelRuntimeCapabilities } from "@kontourai/relay";
import { dispatch } from "./engine.js";
import type { DispatchReceipt, ExecutionPlan, RuntimeRegistry } from "./types.js";

export type DispatchRuntimePlan = Omit<ExecutionPlan, "request">;

export interface DispatchRuntimeOptions {
  id: string;
  capabilities: ModelRuntimeCapabilities;
  plan: DispatchRuntimePlan | ((request: ModelInvocationRequest) => DispatchRuntimePlan | Promise<DispatchRuntimePlan>);
  runtimes: RuntimeRegistry;
  onReceipt?: (receipt: DispatchReceipt) => void | Promise<void>;
}

export class DispatchRuntimeError extends ModelInvocationError {
  constructor(readonly receipt: DispatchReceipt) {
    const aborted = receipt.outcome === "aborted";
    super(aborted ? "ABORTED" : receipt.outcome === "exhausted" || receipt.outcome === "no-eligible-candidates" ? "PROVIDER_UNAVAILABLE" : "RUNTIME_FAILURE",
      `Dispatch invocation ended with ${receipt.outcome}`, false);
    this.name = "DispatchRuntimeError";
  }
}

/** Expose explicit Dispatch policy through Relay's semantically inert runtime port. */
export function createDispatchRuntime(options: DispatchRuntimeOptions): ModelRuntime {
  return {
    id: options.id,
    capabilities: () => options.capabilities,
    async invoke(request: ModelInvocationRequest, invocationOptions?: ModelInvocationOptions): Promise<ModelInvocationResult> {
      const template = typeof options.plan === "function" ? await options.plan(request) : options.plan;
      const outcome = await dispatch({ ...template, request }, options.runtimes, invocationOptions?.signal ? { signal: invocationOptions.signal } : {});
      await options.onReceipt?.(outcome.receipt);
      if ("result" in outcome) return outcome.result;
      throw new DispatchRuntimeError(outcome.receipt);
    },
  };
}
