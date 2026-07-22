import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FakeModelRuntime, ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import { dispatch, executionPlanDigest, type ExecutionPlan, type RuntimeRegistry } from "../src/index.js";

const request = { messages: [{ role: "user" as const, content: "structured work" }] };
const basePlan: ExecutionPlan = {
  schemaVersion: 1,
  role: "extractor",
  request,
  candidates: [{ id: "primary", runtimeId: "primary", evidence: { level: "confirmed", capabilities: ["tools"] } }],
  budget: { maxAttempts: 2, maxTotalTokens: 20 },
  policy: { requiredCapabilities: ["tools"], minimumEvidence: "confirmed" },
};

const registry = (entries: Record<string, ModelRuntime>): RuntimeRegistry => ({ get: (id) => entries[id] });
const success = { provider: "fixture", model: "m1", outputText: "ok", toolCalls: [], usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, latencyMs: 1 };

describe("dispatch", () => {
  it("executes through Relay and emits a request-content-free receipt", async () => {
    const ticks = [0, 0, 1, 2];
    const outcome = await dispatch(basePlan, registry({ primary: new FakeModelRuntime([success]) }), { now: () => ticks.shift()! });
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.equal(outcome.receipt.totalTokens, 5);
    assert.equal("result" in outcome && outcome.result.outputText, "ok");
    assert.doesNotMatch(JSON.stringify(outcome.receipt), /structured work/);
    assert.match(executionPlanDigest(basePlan), /^[a-f0-9]{64}$/);
  });

  it("records retryable failure and deterministic fallback", async () => {
    const failing: ModelRuntime = {
      id: "fail", capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }),
      async invoke() { throw new ModelInvocationError("RATE_LIMITED", "rate limited", true); },
    };
    const plan = { ...basePlan, candidates: [
      { id: "first", runtimeId: "fail", evidence: { level: "confirmed" as const, capabilities: ["tools"] } },
      { id: "second", runtimeId: "ok", evidence: { level: "confirmed" as const, capabilities: ["tools"] } },
    ] };
    const ticks = [0, 0, 1, 2, 3, 4];
    const outcome = await dispatch(plan, registry({ fail: failing, ok: new FakeModelRuntime([success]) }), { now: () => ticks.shift()! });
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.deepEqual(outcome.receipt.attempts.map(({ candidateId, outcome }) => [candidateId, outcome]), [["first", "failed"], ["second", "succeeded"]]);
  });

  it("rejects candidates below the evidence threshold", async () => {
    const plan = { ...basePlan, candidates: [{ id: "declared", runtimeId: "x", evidence: { level: "declared" as const, capabilities: ["tools"] } }] };
    const outcome = await dispatch(plan, registry({}));
    assert.equal(outcome.receipt.outcome, "no-eligible-candidates");
    assert.deepEqual(outcome.receipt.attempts, []);
  });

  it("records a terminal budget violation after measured usage", async () => {
    const plan = { ...basePlan, budget: { maxAttempts: 1, maxTotalTokens: 4 } };
    const ticks = [0, 0, 1, 2];
    const outcome = await dispatch(plan, registry({ primary: new FakeModelRuntime([success]) }), { now: () => ticks.shift()! });
    assert.equal(outcome.receipt.outcome, "budget-exceeded");
    assert.equal(outcome.receipt.totalTokens, 5);
    assert.equal("result" in outcome, false);
  });

  it("reports cancellation as a distinct terminal outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await dispatch(basePlan, registry({ primary: new FakeModelRuntime([success]) }), { signal: controller.signal });
    assert.equal(outcome.receipt.outcome, "aborted");
    assert.deepEqual(outcome.receipt.attempts, []);
  });

  it("defaults structured-tool work to native fidelity and skips prompted candidates", async () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      candidates: [
        { id: "prompted", runtimeId: "prompted", evidence: { level: "confirmed", capabilities: ["structured-tools"], structuredToolsFidelity: "prompted" } },
        { id: "native", runtimeId: "native", evidence: { level: "confirmed", capabilities: ["structured-tools"], structuredToolsFidelity: "native" } },
      ],
      policy: { requiredCapabilities: ["structured-tools"], minimumEvidence: "confirmed" },
    };
    const outcome = await dispatch(plan, registry({
      prompted: new FakeModelRuntime([success]),
      native: new FakeModelRuntime([success]),
    }));
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.deepEqual(outcome.receipt.attempts.map(({ candidateId, structuredToolsFidelity }) => [candidateId, structuredToolsFidelity]), [["native", "native"]]);
  });

  it("selects prompted structured output only when policy explicitly permits it", async () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      candidates: [{
        id: "prompted",
        runtimeId: "prompted",
        evidence: { level: "confirmed", capabilities: ["structured-tools"], structuredToolsFidelity: "prompted" },
      }],
      policy: {
        requiredCapabilities: ["structured-tools"],
        minimumEvidence: "confirmed",
        minimumStructuredToolsFidelity: "prompted",
      },
    };
    const outcome = await dispatch(plan, registry({ prompted: new FakeModelRuntime([success]) }));
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.equal(outcome.receipt.attempts[0]?.structuredToolsFidelity, "prompted");
  });

  it("fails closed on contradictory structured-tool evidence", async () => {
    const plan: ExecutionPlan = {
      ...basePlan,
      candidates: [{
        id: "contradictory",
        runtimeId: "contradictory",
        evidence: { level: "confirmed", capabilities: ["structured-tools"], structuredToolsFidelity: "unavailable" },
      }],
      policy: { requiredCapabilities: ["structured-tools"], minimumEvidence: "confirmed" },
    };
    const outcome = await dispatch(plan, registry({ contradictory: new FakeModelRuntime([success]) }));
    assert.equal(outcome.receipt.outcome, "no-eligible-candidates");
  });
});
