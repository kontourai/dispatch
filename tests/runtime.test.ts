import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FakeModelRuntime,
  type ModelBatchInvocationOutcome,
  type ModelInvocationRequest,
  type ModelRuntime,
  type ModelRuntimeCapabilities,
} from "@kontourai/relay";
import {
  createDispatchRuntime,
  AuthorizationExhaustedError,
  DispatchRuntimeError,
  FileAuthorizationLedger,
  ReceiptDeliveryError,
  type AuthorizationLedger,
  type DispatchReceipt,
} from "../src/index.js";

const capabilities: ModelRuntimeCapabilities = { structuredTools: true, streaming: false, abort: true, usage: true };
const result = { provider: "fixture", model: "m", outputText: "ok", toolCalls: [], usage: { totalTokens: 2 }, latencyMs: 0 };

describe("Dispatch Relay runtime", () => {
  it("installs one Relay contract compatible with Dispatch runtime fidelity", () => {
    const installed = JSON.parse(execFileSync("npm", ["ls", "@kontourai/relay", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })) as { dependencies?: Record<string, { version?: string; dependencies?: Record<string, unknown> }> };
    const direct = installed.dependencies?.["@kontourai/relay"];
    assert.equal(direct?.version, "0.6.0");
    assert.equal(direct?.dependencies?.["@kontourai/relay"], undefined);
    const capabilities: ModelRuntimeCapabilities = {
      structuredTools: true,
      structuredToolsFidelity: "native",
      outputTokenLimitFidelity: "native",
      streaming: false,
      abort: true,
      usage: true,
    };
    assert.equal(capabilities.structuredToolsFidelity, "native");
  });
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

  it("forwards durable authorization through the Relay runtime facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-runtime-authorization-"));
    let receipt: DispatchReceipt | undefined;
    const runtime = createDispatchRuntime({
      id: "dispatch:authorized-worker",
      capabilities,
      plan: {
        schemaVersion: 1,
        role: "worker",
        candidates: [{ id: "one", runtimeId: "one", worstCaseUsage: { maxTokens: 10 } }],
        budget: { maxAttempts: 1, maxTotalTokens: 10 },
        authorization: {
          schemaVersion: 1,
          id: "runtime-authorization",
          invocationId: "runtime-invocation",
          limits: { maxAttempts: 1, maxTotalTokens: 10 },
        },
      },
      runtimes: { get: () => new FakeModelRuntime([result]) },
      authorizationLedger: new FileAuthorizationLedger({ root }),
      onReceipt: (value) => { receipt = value; },
    });
    assert.deepEqual(await runtime.invoke({ messages: [{ role: "user", content: "work" }] }), result);
    assert.equal(receipt?.authorization?.outcome, "settled");
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

  it("preserves one physical call, positional outcomes, and item-local fallback receipts", async () => {
    const value = (text: string) => ({
      ...result,
      outputText: text,
      usage: { totalTokens: text.length },
    });
    const primary = new FakeModelRuntime([
      value("first"),
      { code: "RATE_LIMITED", message: "content-free limit", retryable: true },
      value("third"),
    ], "primary");
    const fallback = new FakeModelRuntime([value("second")], "fallback");
    const receipts: DispatchReceipt[] = [];
    const runtime = createDispatchRuntime({
      id: "dispatch:batch",
      capabilities: {
        ...capabilities,
        physicalBatch: true,
        maxBatchSize: 8,
      },
      plan: {
        schemaVersion: 1,
        role: "extractor",
        candidates: [
          { id: "primary", runtimeId: "primary" },
          { id: "fallback", runtimeId: "fallback" },
        ],
        budget: { maxAttempts: 2 },
      },
      runtimes: {
        get: (id) => id === "primary" ? primary : id === "fallback" ? fallback : undefined,
      },
      onReceipt: (receipt) => { receipts.push(receipt); },
    });
    const outcomes = await runtime.invokeBatch!([
      { messages: [{ role: "user", content: "private first" }] },
      { messages: [{ role: "user", content: "private second" }] },
      { messages: [{ role: "user", content: "private third" }] },
    ]);
    assert.equal(primary.physicalInvocationCount, 1);
    assert.equal(fallback.physicalInvocationCount, 1);
    assert.deepEqual(outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value.outputText : outcome.reason.code),
    ["first", "second", "third"]);
    assert.deepEqual(receipts.map((receipt) => receipt.attempts.length), [1, 2, 1]);
    assert.equal(new Set(receipts.map((receipt) => receipt.physicalBatch?.operationId)).size, 1);
    assert.deepEqual(receipts.map((receipt) => receipt.physicalBatch?.itemIndex), [0, 1, 2]);
    assert.ok(receipts.every((receipt) => receipt.physicalBatch?.itemCount === 3));
    assert.deepEqual(
      receipts[1]?.attempts.map((attempt) => [attempt.candidateId, attempt.outcome]),
      [["primary", "failed"], ["fallback", "succeeded"]],
    );
    assert.doesNotMatch(JSON.stringify(receipts), /private first|private second|private third/);
  });

  it("reserves every launched item before the physical operation and excludes exhausted capacity", async () => {
    let reservations = 0;
    const ledger: AuthorizationLedger = {
      async reserve() {
        reservations++;
        if (reservations > 2) throw new AuthorizationExhaustedError("shared-batch");
        return { status: "reserved" };
      },
      async settle() {},
      async release() {},
    };
    let requestsAtLaunch = 0;
    const physical: ModelRuntime = {
      id: "physical",
      capabilities: () => ({
        ...capabilities,
        physicalBatch: true,
        maxBatchSize: 8,
      }),
      async invoke() { throw new Error("single invocation was not expected"); },
      async invokeBatch(requests): Promise<readonly ModelBatchInvocationOutcome[]> {
        requestsAtLaunch = reservations;
        return requests.map((_, index) => ({
          status: "fulfilled",
          value: { ...result, outputText: `item-${index}` },
        }));
      },
    };
    let invocation = 0;
    const receipts: DispatchReceipt[] = [];
    const runtime = createDispatchRuntime({
      id: "dispatch:authorized-batch",
      capabilities: { ...capabilities, physicalBatch: true, maxBatchSize: 8 },
      plan: () => ({
        schemaVersion: 1,
        role: "extractor",
        candidates: [{
          id: "physical",
          runtimeId: "physical",
          worstCaseUsage: { maxTokens: 10 },
        }],
        budget: { maxAttempts: 1, maxTotalTokens: 10 },
        authorization: {
          schemaVersion: 1,
          id: "shared-batch",
          invocationId: `item-${++invocation}`,
          limits: { maxAttempts: 2, maxTotalTokens: 20 },
        },
      }),
      runtimes: { get: () => physical },
      authorizationLedger: ledger,
      onReceipt: (receipt) => { receipts.push(receipt); },
    });
    const outcomes = await runtime.invokeBatch!([
      request("one"),
      request("two"),
      request("three"),
    ]);
    assert.equal(requestsAtLaunch, 3, "all reservations resolve before the physical call");
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled", "rejected"]);
    assert.deepEqual(receipts.map((receipt) => receipt.outcome), ["succeeded", "succeeded", "budget-exceeded"]);
  });

  it("keeps physical-batch authorization capacity exhausted across runtime restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-runtime-batch-restart-"));
    const ledger = new FileAuthorizationLedger({ root });
    let invocation = 0;
    const plan = () => ({
      schemaVersion: 1 as const,
      role: "extractor",
      candidates: [{ id: "physical", runtimeId: "physical" }],
      budget: { maxAttempts: 1 },
      authorization: {
        schemaVersion: 1 as const,
        id: "batch-restart",
        invocationId: `item-${++invocation}`,
        limits: { maxAttempts: 2 },
      },
    });
    const firstPhysical = new FakeModelRuntime([result, result], "physical");
    const first = createDispatchRuntime({
      id: "dispatch:first",
      capabilities: { ...capabilities, physicalBatch: true, maxBatchSize: 8 },
      plan,
      runtimes: { get: () => firstPhysical },
      authorizationLedger: ledger,
    });
    assert.deepEqual(
      (await first.invokeBatch!([request("one"), request("two")])).map((outcome) => outcome.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(firstPhysical.physicalInvocationCount, 1);

    const restartedPhysical = new FakeModelRuntime([result], "physical");
    const restarted = createDispatchRuntime({
      id: "dispatch:restarted",
      capabilities: { ...capabilities, physicalBatch: true, maxBatchSize: 8 },
      plan,
      runtimes: { get: () => restartedPhysical },
      authorizationLedger: new FileAuthorizationLedger({ root }),
    });
    const afterRestart = await restarted.invokeBatch!([request("three")]);
    assert.equal(afterRestart[0]?.status, "rejected");
    assert.equal(restartedPhysical.physicalInvocationCount, 0);
  });

  it("suppresses a physical-batch item result that exceeds its measured budget", async () => {
    const physical = new FakeModelRuntime([{
      ...result,
      usage: { totalTokens: 11 },
    }], "physical");
    let receipt: DispatchReceipt | undefined;
    const runtime = createDispatchRuntime({
      id: "dispatch:measured-batch-budget",
      capabilities: { ...capabilities, physicalBatch: true, maxBatchSize: 8 },
      plan: {
        schemaVersion: 1,
        role: "extractor",
        candidates: [{ id: "physical", runtimeId: "physical" }],
        budget: { maxAttempts: 1, maxTotalTokens: 10 },
      },
      runtimes: { get: () => physical },
      onReceipt: (value) => { receipt = value; },
    });
    const outcomes = await runtime.invokeBatch!([request("over budget")]);
    assert.equal(outcomes[0]?.status, "rejected");
    assert.equal(receipt?.outcome, "budget-exceeded");
    assert.equal(receipt?.attempts[0]?.totalTokens, 11);
  });

  it("strips an inconsistent batch declaration instead of exposing a simulated seam", () => {
    const runtime = createDispatchRuntime({
      id: "dispatch:single",
      capabilities: { ...capabilities, physicalBatch: false, maxBatchSize: 8 },
      plan: {
        schemaVersion: 1,
        role: "worker",
        candidates: [{ id: "one", runtimeId: "one" }],
        budget: { maxAttempts: 1 },
      },
      runtimes: { get: () => new FakeModelRuntime([result]) },
    });
    assert.equal(runtime.invokeBatch, undefined);
    assert.equal(runtime.capabilities().physicalBatch, undefined);
    assert.equal(runtime.capabilities().maxBatchSize, undefined);
  });
});

function request(content: string): ModelInvocationRequest {
  return { messages: [{ role: "user", content }] };
}
