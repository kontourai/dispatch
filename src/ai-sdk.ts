import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createAiSdkModel, createAiSdkRuntime } from "@kontourai/relay/ai-sdk";
import { ModelInvocationError, type ModelInvocationRequest, type ModelRuntimeCapabilities } from "@kontourai/relay";
import { createDispatchRuntime, type ReceiptDeliveryError, type ReceiptDeliveryFailureMode } from "./runtime.js";
import type { DispatchReceipt } from "./types.js";
import type { DispatchRuntimePlan } from "./runtime.js";

export interface AiSdkDispatchModelOptions {
  id: string;
  capabilities: ModelRuntimeCapabilities;
  models: Readonly<Record<string, LanguageModelV3>>;
  plan: DispatchRuntimePlan | ((request: ModelInvocationRequest) => DispatchRuntimePlan | Promise<DispatchRuntimePlan>);
  provider?: string;
  modelId?: string;
  onReceipt?: (receipt: DispatchReceipt) => void | Promise<void>;
  receiptDeliveryFailureMode?: ReceiptDeliveryFailureMode;
  onReceiptDeliveryFailure?: (error: ReceiptDeliveryError) => void | Promise<void>;
}

/** Compose AI SDK provider models through Dispatch and return one AI SDK v3 model. */
export function createAiSdkDispatchModel(options: AiSdkDispatchModelOptions): LanguageModelV3 {
  const runtimes = new Map(Object.entries(options.models).map(([id, model]) => [id, createAiSdkRuntime({ id, model })]));
  const resolvePlan = async (request: ModelInvocationRequest): Promise<DispatchRuntimePlan> => {
    const plan = typeof options.plan === "function" ? await options.plan(request) : options.plan;
    const missing = plan.candidates.filter((candidate) => !runtimes.has(candidate.runtimeId)).map((candidate) => candidate.runtimeId);
    if (missing.length) throw new ModelInvocationError("INVALID_REQUEST", `Dispatch plan references unavailable AI SDK runtimes: ${[...new Set(missing)].join(", ")}`, false);
    return plan;
  };
  const runtime = createDispatchRuntime({
    id: options.id,
    capabilities: options.capabilities,
    plan: resolvePlan,
    runtimes,
    ...(options.onReceipt ? { onReceipt: options.onReceipt } : {}),
    ...(options.receiptDeliveryFailureMode ? { receiptDeliveryFailureMode: options.receiptDeliveryFailureMode } : {}),
    ...(options.onReceiptDeliveryFailure ? { onReceiptDeliveryFailure: options.onReceiptDeliveryFailure } : {}),
  });
  return createAiSdkModel({ runtime, ...(options.provider ? { provider: options.provider } : {}), ...(options.modelId ? { modelId: options.modelId } : {}) });
}
