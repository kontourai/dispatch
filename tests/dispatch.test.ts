import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createClaudeCodeRuntime } from "@kontourai/relay/claude-code";
import { createCodexRuntime } from "@kontourai/relay/codex";
import { FakeModelRuntime, ModelInvocationError, type ModelInvocationResult, type ModelRuntime } from "@kontourai/relay";
import { dispatch, dispatchBatch, executionPlanDigest, type DispatchReceipt, type ExecutionPlan, type RuntimeRegistry } from "../src/index.js";

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

  it("preserves typed Relay failure shape across an isolated package copy", async () => {
    const foreignRuntime: ModelRuntime = {
      id: "foreign",
      capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }),
      async invoke() {
        throw Object.assign(new Error("foreign Relay copy"), {
          name: "ModelInvocationError",
          code: "RATE_LIMITED",
          retryable: true,
        });
      },
    };
    const fallback = new FakeModelRuntime([success], "fallback");
    const outcome = await dispatch({
      ...basePlan,
      candidates: [
        { id: "foreign", runtimeId: "foreign", evidence: { level: "confirmed", capabilities: ["tools"] } },
        { id: "fallback", runtimeId: "fallback", evidence: { level: "confirmed", capabilities: ["tools"] } },
      ],
      budget: { maxAttempts: 2 },
    }, {
      get: (id) => id === "foreign" ? foreignRuntime : id === "fallback" ? fallback : undefined,
    });
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.equal(outcome.receipt.attempts[0]!.errorCode, "RATE_LIMITED");
    assert.equal(outcome.receipt.attempts[0]!.retryable, true);
    assert.equal(outcome.receipt.attempts[1]!.outcome, "succeeded");
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

describe("attempt model identity", () => {
  const reported = { ...success, model: "served-x", modelSource: "provider-reported" as const };
  const withoutSource = { ...success, model: "served-x" };
  const plan: ExecutionPlan = {
    ...basePlan,
    candidates: [{ id: "requested-y", runtimeId: "requested-y", evidence: { level: "confirmed", capabilities: ["tools"] } }],
  };

  it("records the model and modelSource the runtime reported on a dispatch attempt", async () => {
    const outcome = await dispatch(plan, registry({ "requested-y": new FakeModelRuntime([reported], "requested-y") }));
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.equal(outcome.receipt.attempts[0]!.model, "served-x");
    assert.equal(outcome.receipt.attempts[0]!.modelSource, "provider-reported");
  });

  it("records the model and modelSource the runtime reported on a physical batch attempt", async () => {
    const outcomes = await dispatchBatch([plan, plan], registry({ "requested-y": new FakeModelRuntime([reported, withoutSource], "requested-y") }));
    assert.deepEqual(outcomes.map(({ receipt }) => receipt.outcome), ["succeeded", "succeeded"]);
    assert.equal(outcomes[0]!.receipt.attempts[0]!.model, "served-x");
    assert.equal(outcomes[0]!.receipt.attempts[0]!.modelSource, "provider-reported");
    assert.equal(outcomes[1]!.receipt.attempts[0]!.model, "served-x");
    assert.equal("modelSource" in outcomes[1]!.receipt.attempts[0]!, false);
  });

  it("records the model without guessing a source when the runtime does not report one", async () => {
    const outcome = await dispatch(plan, registry({ "requested-y": new FakeModelRuntime([withoutSource], "requested-y") }));
    assert.equal(outcome.receipt.attempts[0]!.model, "served-x");
    assert.equal("modelSource" in outcome.receipt.attempts[0]!, false);
    // A third-party runtime is not bound by Relay's types at runtime.
    const unknown = { ...success, modelSource: "guessed" } as unknown as ModelInvocationResult;
    const unrecognised = await dispatch(plan, registry({ "requested-y": new FakeModelRuntime([unknown], "requested-y") }));
    assert.equal(unrecognised.receipt.attempts[0]!.model, "m1");
    assert.equal("modelSource" in unrecognised.receipt.attempts[0]!, false);
  });

  it("leaves failed attempts without a model identity", async () => {
    const failing = new FakeModelRuntime([{ code: "RATE_LIMITED", message: "rate limited", retryable: true }], "requested-y");
    const outcome = await dispatch({ ...plan, budget: { maxAttempts: 1 } }, registry({ "requested-y": failing }));
    assert.equal(outcome.receipt.outcome, "exhausted");
    assert.equal("model" in outcome.receipt.attempts[0]!, false);
    assert.equal("modelSource" in outcome.receipt.attempts[0]!, false);
  });

  it("keeps receipts written before the model fields existed valid", () => {
    // Dispatch has no runtime receipt validator; the contract is the type. This
    // literal is a schemaVersion 1 receipt as written before the fields existed,
    // so `npm run typecheck` fails if either field stops being optional.
    const stored: DispatchReceipt = {
      schemaVersion: 1, planDigest: "p", requestDigest: "r", role: "extractor", outcome: "succeeded",
      attempts: [{ candidateId: "c", runtimeId: "r", outcome: "succeeded", elapsedMs: 1, totalTokens: 5 }],
      totalElapsedMs: 1, totalTokens: 5, estimatedCostUsd: 0,
    };
    assert.equal(stored.attempts[0]!.model, undefined);
    assert.equal(stored.attempts[0]!.modelSource, undefined);
  });
});

describe("fallback from a Relay CLI runtime that hit a usage limit", () => {
  // Fixture executables stand in for the real CLIs and print what each one
  // reports when its usage limit is reached: Claude Code an error result on
  // stdout (stderr empty), Codex `error` and `turn.failed` JSON events. Relay's
  // own codecs classify the output, so the error reaching the engine is
  // whatever Relay decides, not a hand-built one.
  let fixtures: string;
  const executable = async (name: string, stdout: string): Promise<string> => {
    const file = join(fixtures, name);
    await writeFile(`${file}.stdout`, `${stdout}\n`);
    await writeFile(file, `#!/bin/sh\ncat >/dev/null\ncat "${file}.stdout"\nexit 1\n`);
    await chmod(file, 0o755);
    return file;
  };
  before(async () => { fixtures = await mkdtemp(join(tmpdir(), "dispatch-cli-limit-")); });
  after(async () => { await rm(fixtures, { recursive: true, force: true }); });

  const cases: readonly { label: string; runtime: () => Promise<ModelRuntime> }[] = [
    {
      label: "Claude Code",
      runtime: async () => createClaudeCodeRuntime({
        model: "fixture-model",
        executable: await executable("claude", JSON.stringify({
          type: "result", subtype: "success", is_error: true, api_error_status: 429,
          result: "You've hit your session limit · resets 3pm",
        })),
      }),
    },
    {
      label: "Codex",
      runtime: async () => createCodexRuntime({
        model: "fixture-model",
        executable: await executable("codex", [
          JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again in 2 hours." }),
          JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 2 hours." } }),
        ].join("\n")),
      }),
    },
  ];

  for (const { label, runtime } of cases) {
    it(`falls back to the next candidate under the default policy after ${label} reports a usage limit`, async () => {
      const plan: ExecutionPlan = {
        ...basePlan,
        candidates: [
          { id: "cli", runtimeId: "cli", evidence: { level: "confirmed", capabilities: ["tools"] } },
          { id: "fallback", runtimeId: "fallback", evidence: { level: "confirmed", capabilities: ["tools"] } },
        ],
      };
      assert.equal(plan.policy?.retryRuntimeFailures, undefined);
      const outcome = await dispatch(plan, registry({ cli: await runtime(), fallback: new FakeModelRuntime([success], "fallback") }));
      assert.deepEqual(
        outcome.receipt.attempts.map(({ candidateId, outcome, errorCode, retryable }) => ({ candidateId, outcome, errorCode, retryable })),
        [
          { candidateId: "cli", outcome: "failed", errorCode: "RATE_LIMITED", retryable: true },
          { candidateId: "fallback", outcome: "succeeded", errorCode: undefined, retryable: undefined },
        ],
      );
      assert.equal(outcome.receipt.outcome, "succeeded");
      assert.equal("result" in outcome && outcome.result.outputText, "ok");
    });
  }
});
