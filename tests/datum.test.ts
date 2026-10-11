import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelRuntime } from "@kontourai/relay";
import { bindDatumResolvedRef } from "../src/datum.js";
import { FileAuthorizationLedger, dispatch, type ExecutionPlan } from "../src/index.js";

const resolved = {
  provider: "compatible", kind: "anthropic-compatible" as const, model: "model-1",
  auth: { kind: "env" as const, ref: "MODEL_API_KEY", available: true }, apiKeySet: true,
};
const request = { messages: [{ role: "user" as const, content: "request" }] };
const success = { provider: "fixture", model: "model-1", outputText: "ok", toolCalls: [], usage: { totalTokens: 5 }, latencyMs: 0 };
const authorization = {
  schemaVersion: 1 as const, id: "datum-auth", invocationId: "inv-1",
  limits: { maxAttempts: 5, maxTotalTokens: 1_000, maxCostUsd: 1 },
};
function counting() {
  const runtime = {
    invocations: 0,
    id: "datum",
    capabilities: () => ({ structuredTools: false, streaming: false, abort: true, usage: true }),
    async invoke() { runtime.invocations++; return success; },
  };
  return runtime as ModelRuntime & { invocations: number };
}

describe("Datum binding", () => {
  it("maps a non-materialized reference without credential values", () => {
    const binding = bindDatumResolvedRef("extractor", {
      provider: "compatible", kind: "anthropic-compatible", model: "model-1",
      baseUrl: "https://models.example.test",
      auth: { kind: "env", ref: "MODEL_API_KEY", envVar: "MODEL_API_KEY", available: true },
      apiKeyEnv: "MODEL_API_KEY", apiKeySet: true,
    }, { evidence: { level: "declared", capabilities: ["tools"] } });
    assert.equal(binding.candidate.id, "extractor");
    assert.match(binding.candidate.runtimeId, /^datum:compatible:model-1:[a-f0-9]{12}$/);
    assert.equal(binding.target.auth.ref, "MODEL_API_KEY");
    assert.doesNotMatch(JSON.stringify(binding), /apiKey\":|secret-value/);
  });

  it("does not expose the endpoint in the receipt identity", () => {
    const binding = bindDatumResolvedRef("worker", {
      provider: "local", kind: "openai-compatible", model: "m",
      baseUrl: "http://private-host.example.test/v1",
      auth: { kind: "env", ref: "LOCAL_KEY", available: true }, apiKeySet: true,
    });
    assert.doesNotMatch(binding.candidate.runtimeId, /private-host/);
  });

  it("carries a host-supplied worstCaseUsage through a token- and cost-bounded authorization", async () => {
    const { candidate, target } = bindDatumResolvedRef("worker", resolved, {
      worstCaseUsage: { maxTokens: 200, maxCostUsd: 0.1 },
    });
    assert.deepEqual(candidate.worstCaseUsage, { maxTokens: 200, maxCostUsd: 0.1 });
    const runtime = counting();
    const ledger = new FileAuthorizationLedger({ root: await mkdtemp(join(tmpdir(), "dispatch-datum-")) });
    const plan: ExecutionPlan = { schemaVersion: 1, role: "worker", request, candidates: [candidate], budget: { maxAttempts: 1 }, authorization };
    const outcome = await dispatch(plan, { get: (id) => id === target.runtimeId ? runtime : undefined }, { authorizationLedger: ledger });
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.equal(outcome.receipt.authorization?.outcome, "settled");
    assert.equal(runtime.invocations, 1);
  });

  it("names the Datum candidate and the field to set when worstCaseUsage is missing", async () => {
    const { candidate, target } = bindDatumResolvedRef("worker", resolved);
    const runtime = counting();
    const ledger = new FileAuthorizationLedger({ root: await mkdtemp(join(tmpdir(), "dispatch-datum-")) });
    const registry = { get: (id: string) => id === target.runtimeId ? runtime : undefined };
    const plan: ExecutionPlan = { schemaVersion: 1, role: "worker", request, candidates: [candidate], budget: { maxAttempts: 1 }, authorization };
    await assert.rejects(dispatch(plan, registry, { authorizationLedger: ledger }), {
      name: "TypeError",
      message: 'Token-bounded authorization requires candidate worst-case token capacity: set worstCaseUsage.maxTokens on candidate "worker"',
    });
    const tokensOnly = bindDatumResolvedRef("worker", resolved, { worstCaseUsage: { maxTokens: 200 } }).candidate;
    await assert.rejects(dispatch({ ...plan, candidates: [tokensOnly] }, registry, { authorizationLedger: ledger }), {
      name: "TypeError",
      message: 'Cost-bounded authorization requires candidate worst-case cost capacity: set worstCaseUsage.maxCostUsd on candidate "worker"',
    });
    assert.equal(runtime.invocations, 0);
  });
});
