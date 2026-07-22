import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, type ModelRuntimeCapabilities } from "@kontourai/relay";
import { createDispatchRuntime, DispatchRuntimeError, ReceiptDeliveryError, type DispatchReceipt } from "../src/index.js";

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

  it("preserves a successful result and receipt when fail-closed delivery fails", async () => {
    const runtime = createDispatchRuntime({
      id: "dispatch:worker", capabilities,
      plan: { schemaVersion: 1, role: "worker", candidates: [{ id: "one", runtimeId: "one" }], budget: { maxAttempts: 1 } },
      runtimes: { get: () => new FakeModelRuntime([result]) },
      onReceipt: () => { throw new Error("storage details must not escape"); },
    });
    await assert.rejects(
      () => runtime.invoke({ messages: [{ role: "user", content: "work" }] }),
      (error: unknown) => error instanceof ReceiptDeliveryError
        && error.retryable === false
        && error.duplicateInvocationRisk
        && error.receipt.outcome === "succeeded"
        && error.modelResult?.outputText === result.outputText
        && !error.message.includes("storage details"),
    );
  });

  it("reports delivery failure after a terminal invocation failure without implying duplicate cost", async () => {
    const observed: ReceiptDeliveryError[] = [];
    const runtime = createDispatchRuntime({
      id: "dispatch:worker", capabilities,
      plan: { schemaVersion: 1, role: "worker", candidates: [], budget: { maxAttempts: 1 } },
      runtimes: { get: () => undefined },
      onReceipt: () => Promise.reject(new Error("offline")),
      onReceiptDeliveryFailure: (error) => { observed.push(error); },
    });
    await assert.rejects(
      () => runtime.invoke({ messages: [{ role: "user", content: "work" }] }),
      (error: unknown) => error instanceof ReceiptDeliveryError
        && !error.duplicateInvocationRisk
        && error.modelResult === undefined
        && error.receipt.outcome === "no-eligible-candidates",
    );
    assert.equal(observed.length, 1);
  });

  it("allows explicit best-effort delivery while surfacing the typed failure to an observer", async () => {
    let observed: ReceiptDeliveryError | undefined;
    const runtime = createDispatchRuntime({
      id: "dispatch:worker", capabilities,
      plan: { schemaVersion: 1, role: "worker", candidates: [{ id: "one", runtimeId: "one" }], budget: { maxAttempts: 1 } },
      runtimes: { get: () => new FakeModelRuntime([result]) },
      onReceipt: () => { throw new Error("offline"); },
      receiptDeliveryFailureMode: "best-effort",
      onReceiptDeliveryFailure: (error) => { observed = error; },
    });
    assert.deepEqual(await runtime.invoke({ messages: [{ role: "user", content: "work" }] }), result);
    assert.equal(observed?.receipt.outcome, "succeeded");
    assert.equal(observed?.duplicateInvocationRisk, true);
  });
});
