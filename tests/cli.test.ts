import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invocationDigest } from "@kontourai/relay";
import { describe, it } from "node:test";

const request = { messages: [{ role: "user" as const, content: "fixture request" }] };
const plan = { schemaVersion: 1, role: "worker", request, candidates: [{ id: "one", runtimeId: "runtime" }], budget: { maxAttempts: 1 } };
const result = { provider: "fixture", model: "m", outputText: "ok", toolCalls: [], usage: { totalTokens: 2 }, latencyMs: 0 };

function run(command: "fixture" | "replay", payloadName: string, payload: unknown, planInput: unknown = plan) {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cli-"));
  const planPath = join(root, "plan.json");
  const payloadPath = join(root, `${payloadName}.json`);
  writeFileSync(planPath, JSON.stringify(planInput));
  writeFileSync(payloadPath, JSON.stringify(payload));
  return spawnSync(process.execPath, ["bin/dispatch.mjs", command, "--plan", planPath, `--${payloadName}`, payloadPath], { cwd: process.cwd(), encoding: "utf8" });
}

describe("Dispatch CLI", () => {
  it("runs deterministic fixture runtimes", () => {
    const completed = run("fixture", "fixtures", { runtimes: { runtime: [result] } });
    assert.equal(completed.status, 0, completed.stderr);
    const output = JSON.parse(completed.stdout);
    assert.equal(output.schemaVersion, "dispatch.cli.result/v1");
    assert.equal(output.receipt.outcome, "succeeded");
  });

  it("replays Relay invocation records", () => {
    const completed = run("replay", "records", [{ schemaVersion: 1, requestDigest: invocationDigest(request), request, result }]);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).result.outputText, "ok");
  });

  it("refuses an invalid budget with the field name and exit 1", () => {
    const completed = run("fixture", "fixtures", { runtimes: { runtime: [result] } }, { ...plan, budget: { maxAttempts: 1.5 } });
    assert.equal(completed.status, 1, completed.stdout);
    assert.equal(completed.stdout, "");
    assert.match(completed.stderr, /^dispatch: Invalid execution plan: budget\.maxAttempts must be an integer of at least 1\n$/);
  });

  it("records a missing runtime as non-retryable and still falls back to the next candidate", () => {
    const fallbackPlan = { ...plan, candidates: [{ id: "missing", runtimeId: "missing" }, { id: "one", runtimeId: "runtime" }], budget: { maxAttempts: 2 } };
    const completed = run("fixture", "fixtures", { runtimes: { runtime: [result] } }, fallbackPlan);
    assert.equal(completed.status, 0, completed.stderr);
    const { receipt } = JSON.parse(completed.stdout);
    assert.equal(receipt.outcome, "succeeded");
    assert.deepEqual(receipt.attempts.map((attempt: { candidateId: string; errorCode?: string; retryable?: boolean }) =>
      [attempt.candidateId, attempt.errorCode, attempt.retryable]), [["missing", "RUNTIME_NOT_FOUND", false], ["one", undefined, undefined]]);
  });
});
