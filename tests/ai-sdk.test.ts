import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { ModelInvocationError } from "@kontourai/relay";
import { createAiSdkDispatchModel } from "../src/ai-sdk.js";
import type { DispatchReceipt } from "../src/index.js";

function model(id: string, text: string, fail = false, servedModelId?: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: id,
    supportedUrls: {},
    async doGenerate() {
      if (fail) throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "unavailable", true);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
        ...(servedModelId ? { response: { modelId: servedModelId } } : {}),
      };
    },
    async doStream() { throw new Error("not used"); },
  };
}

const plan = {
  schemaVersion: 1 as const,
  role: "station-agent",
  candidates: [{ id: "primary", runtimeId: "primary" }, { id: "fallback", runtimeId: "fallback" }],
  budget: { maxAttempts: 2 },
};

describe("Dispatch AI SDK composition", () => {
  it("falls back across AI SDK models and delivers a secret-free receipt", async () => {
    let outcome: string | undefined;
    const composed = createAiSdkDispatchModel({
      id: "dispatch:station",
      capabilities: { structuredTools: true, streaming: false, abort: true, usage: true },
      models: { primary: model("a", "", true), fallback: model("b", "ok") },
      plan,
      onReceipt: (receipt) => { outcome = receipt.outcome; },
    });
    const result = await composed.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    assert.equal(result.content[0]?.type, "text");
    assert.equal(outcome, "succeeded");
  });

  it("records on the receipt whether the AI SDK provider reported the served model", async () => {
    const attempts: DispatchReceipt["attempts"][number][] = [];
    const composed = createAiSdkDispatchModel({
      id: "dispatch:model-source",
      capabilities: { structuredTools: true, streaming: false, abort: true, usage: true },
      models: { primary: model("alias", "ok", false, "served-snapshot"), fallback: model("configured-b", "ok") },
      plan: (request) => ({ ...plan, candidates: [plan.candidates[request.messages.length === 1 ? 0 : 1]!] }),
      onReceipt: (receipt) => { attempts.push(receipt.attempts[0]!); },
    });
    await composed.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    await composed.doGenerate({ prompt: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ] });
    assert.deepEqual(attempts.map(({ model, modelSource }) => ({ model, modelSource })), [
      { model: "served-snapshot", modelSource: "provider-reported" },
      { model: "configured-b", modelSource: "configured" },
    ]);
  });

  it("rejects plans that reference models the host did not supply", async () => {
    const composed = createAiSdkDispatchModel({
      id: "dispatch:invalid",
      capabilities: { structuredTools: true, streaming: false, abort: true, usage: true },
      models: { primary: model("a", "ok") },
      plan,
    });
    await assert.rejects(async () => await composed.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
      (error: unknown) => error instanceof ModelInvocationError && error.code === "INVALID_REQUEST");
  });
});
