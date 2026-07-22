import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { ModelInvocationError } from "@kontourai/relay";
import { createAiSdkDispatchModel } from "../src/ai-sdk.js";

function model(id: string, text: string, fail = false): LanguageModelV3 {
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
