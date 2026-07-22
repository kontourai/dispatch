import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, type ModelRuntimeCapabilities } from "@kontourai/relay";
import { createDispatchRuntime, DispatchRuntimeError, type DispatchReceipt } from "../src/index.js";

const capabilities: ModelRuntimeCapabilities = { structuredTools: true, streaming: false, abort: true, usage: true };
const result = { provider: "fixture", model: "m", outputText: "ok", toolCalls: [], usage: { totalTokens: 2 }, latencyMs: 0 };

describe("Dispatch Relay runtime", () => {
  it("routes a Relay invocation and emits the receipt to the host", async () => {
    let receipt: DispatchReceipt | undefined;
    const runtime = createDispatchRuntime({
      id: "dispatch:worker", capabilities,
      plan: { schemaVersion: 1, role: "worker", candidates: [{ id: "one", runtimeId: "one" }], budget: { maxAttempts: 1 } },
      runtimes: { get: (id) => id === "one" ? new FakeModelRuntime([result]) : undefined },
      onReceipt: (value) => { receipt = value; },
    });
    assert.deepEqual(await runtime.invoke({ messages: [{ role: "user", content: "work" }] }), result);
    assert.equal(receipt?.outcome, "succeeded");
  });

  it("maps an aborted Dispatch outcome back to Relay's typed error", async () => {
    const runtime = createDispatchRuntime({
      id: "dispatch:worker", capabilities,
      plan: { schemaVersion: 1, role: "worker", candidates: [{ id: "one", runtimeId: "one" }], budget: { maxAttempts: 1 } },
      runtimes: { get: () => new FakeModelRuntime([result]) },
    });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => runtime.invoke({ messages: [{ role: "user", content: "work" }] }, { signal: controller.signal }),
      (error: unknown) => error instanceof DispatchRuntimeError && error.code === "ABORTED" && error.receipt.outcome === "aborted");
  });
});
