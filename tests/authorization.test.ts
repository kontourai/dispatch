import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { FakeModelRuntime, ModelInvocationError, type ModelRuntime } from "@kontourai/relay";
import {
  AuthorizationPersistenceError,
  FileAuthorizationLedger,
  dispatch,
  type AuthorizationLedger,
  type ExecutionAuthorization,
  type ExecutionPlan,
} from "../src/index.js";

const request = { messages: [{ role: "user" as const, content: "private request content" }] };
const success = {
  provider: "fixture",
  model: "model",
  outputText: "private response content",
  toolCalls: [],
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  latencyMs: 1,
};

describe("durable execution authorization", () => {
  it("reserves before invocation, settles measured usage, and stores content-free mode-0600 state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-authorization-"));
    const ledger = new FileAuthorizationLedger({ root });
    const runtime = new FakeModelRuntime([success], "fixture");
    const outcome = await dispatch(plan("authorization-a", "invocation-a"), { get: () => runtime }, {
      authorizationLedger: ledger,
    });
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.deepEqual(outcome.receipt.authorization, {
      id: "authorization-a",
      invocationId: "invocation-a",
      outcome: "settled",
    });
    assert.equal(outcome.receipt.attempts[0]?.reservationState, "settled");
    assert.equal(runtime.requests.length, 1);

    const file = ledgerFile(root, "authorization-a");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const stored = await readFile(file, "utf8");
    assert.doesNotMatch(stored, /private request content|private response content|credential|api.?key/i);
    const record = JSON.parse(stored);
    const reservation = Object.values(record.reservations)[0] as {
      state: string;
      usage: { totalTokens: number; costUsd: number };
    };
    assert.equal(reservation.state, "settled");
    assert.deepEqual(reservation.usage, { attempts: 1, totalTokens: 5, costUsd: 0.05 });
  });

  it("serializes cross-process reservations so concurrent callers cannot exceed capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-authorization-processes-"));
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      worker(root, `worker-${index}`)));
    assert.equal(results.filter((result) => result === "reserved").length, 2);
    assert.equal(results.filter((result) => result === "AUTHORIZATION_EXHAUSTED").length, 6);
  });

  it("keeps failed or crashed capacity conservative across ledger restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-authorization-restart-"));
    const failing: ModelRuntime = {
      id: "fixture",
      capabilities: () => ({ structuredTools: false, streaming: false, abort: true, usage: true }),
      async invoke() { throw new ModelInvocationError("PROVIDER_UNAVAILABLE", "private diagnostic", true); },
    };
    const first = await dispatch(plan("authorization-b", "invocation-b", { maxAttempts: 1 }), { get: () => failing }, {
      authorizationLedger: new FileAuthorizationLedger({ root }),
    });
    assert.equal(first.receipt.outcome, "exhausted");
    assert.equal(first.receipt.authorization?.outcome, "reserved");

    const replayRuntime = new FakeModelRuntime([success], "fixture");
    await assert.rejects(
      dispatch(plan("authorization-b", "invocation-b", { maxAttempts: 1 }), { get: () => replayRuntime }, {
        authorizationLedger: new FileAuthorizationLedger({ root }),
      }),
      (error: unknown) => error instanceof AuthorizationPersistenceError
        && error.phase === "recovery"
        && error.duplicateInvocationRisk === true,
    );
    assert.equal(replayRuntime.requests.length, 0);

    const secondRuntime = new FakeModelRuntime([success], "fixture");
    const second = await dispatch(plan("authorization-b", "invocation-c", { maxAttempts: 1 }), { get: () => secondRuntime }, {
      authorizationLedger: new FileAuthorizationLedger({ root }),
    });
    assert.equal(second.receipt.outcome, "budget-exceeded");
    assert.equal(second.receipt.authorization?.outcome, "exhausted");
    assert.equal(secondRuntime.requests.length, 0);

    const reservationId = first.receipt.attempts[0]?.reservationId;
    assert.ok(reservationId);
    const recoveredLedger = new FileAuthorizationLedger({ root });
    await recoveredLedger.release({
      authorizationId: "authorization-b",
      reservationId,
      reason: "provider-reconciled",
    });
    const thirdRuntime = new FakeModelRuntime([success], "fixture");
    const third = await dispatch(plan("authorization-b", "invocation-c", { maxAttempts: 1 }), { get: () => thirdRuntime }, {
      authorizationLedger: recoveredLedger,
    });
    assert.equal(third.receipt.outcome, "succeeded");
    assert.equal(thirdRuntime.requests.length, 1);
  });

  it("supports deterministic fallback while retaining unknown failed-attempt capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-authorization-fallback-"));
    const failed: ModelRuntime = {
      id: "failed",
      capabilities: () => ({ structuredTools: false, streaming: false, abort: true, usage: true }),
      async invoke() { throw new ModelInvocationError("RATE_LIMITED", "private diagnostic", true); },
    };
    const fallback = new FakeModelRuntime([success], "fallback");
    const base = plan("authorization-c", "invocation-d", { maxAttempts: 2, maxTotalTokens: 20, maxCostUsd: 2 });
    const outcome = await dispatch({
      ...base,
      candidates: [
        { id: "first", runtimeId: "failed", worstCaseUsage: { maxTokens: 10, maxCostUsd: 1 }, estimatedUsdPer1kTokens: 10 },
        { id: "second", runtimeId: "fallback", worstCaseUsage: { maxTokens: 10, maxCostUsd: 1 }, estimatedUsdPer1kTokens: 10 },
      ],
    }, { get: (id) => id === "failed" ? failed : fallback }, {
      authorizationLedger: new FileAuthorizationLedger({ root }),
    });
    assert.equal(outcome.receipt.outcome, "succeeded");
    assert.deepEqual(outcome.receipt.attempts.map((attempt) => attempt.reservationState), ["reserved", "settled"]);
    assert.equal(outcome.receipt.authorization?.outcome, "reserved");
  });

  it("fails before provider invocation when durable authorization is unavailable", async () => {
    const runtime = new FakeModelRuntime([success], "fixture");
    await assert.rejects(
      dispatch(plan("authorization-d", "invocation-e"), { get: () => runtime }),
      (error: unknown) => error instanceof AuthorizationPersistenceError
        && error.phase === "reserve"
        && error.duplicateInvocationRisk === false,
    );
    assert.equal(runtime.requests.length, 0);
  });

  it("marks settlement persistence failure as a duplicate-invocation risk", async () => {
    const runtime = new FakeModelRuntime([success], "fixture");
    const ledger: AuthorizationLedger = {
      async reserve() { return { status: "reserved" }; },
      async settle() { throw new Error("private storage diagnostic"); },
      async release() {},
    };
    await assert.rejects(
      dispatch(plan("authorization-e", "invocation-f"), { get: () => runtime }, { authorizationLedger: ledger }),
      (error: unknown) => error instanceof AuthorizationPersistenceError
        && error.phase === "settle"
        && error.duplicateInvocationRisk === true
        && !error.message.includes("private storage diagnostic"),
    );
    assert.equal(runtime.requests.length, 1);
  });

  it("releases capacity when cancellation wins after reservation but before provider launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-authorization-cancel-"));
    const fileLedger = new FileAuthorizationLedger({ root });
    const controller = new AbortController();
    const ledger: AuthorizationLedger = {
      async reserve(reservation) {
        const result = await fileLedger.reserve(reservation);
        controller.abort();
        return result;
      },
      settle: (settlement) => fileLedger.settle(settlement),
      release: (release) => fileLedger.release(release),
    };
    const runtime = new FakeModelRuntime([success], "fixture");
    const outcome = await dispatch(plan("authorization-cancel", "invocation-cancel", { maxAttempts: 1 }), {
      get: () => runtime,
    }, { authorizationLedger: ledger, signal: controller.signal });
    assert.equal(outcome.receipt.outcome, "aborted");
    assert.equal(runtime.requests.length, 0);

    const nextRuntime = new FakeModelRuntime([success], "fixture");
    const next = await dispatch(plan("authorization-cancel", "invocation-after-cancel", { maxAttempts: 1 }), {
      get: () => nextRuntime,
    }, { authorizationLedger: fileLedger });
    assert.equal(next.receipt.outcome, "succeeded");
    assert.equal(nextRuntime.requests.length, 1);
  });

  it("settles reservations out of order and rejects malformed persisted state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dispatch-authorization-order-"));
    const ledger = new FileAuthorizationLedger({ root });
    for (const suffix of ["one", "two"]) {
      await ledger.reserve({
        authorizationId: "authorization-f",
        invocationId: `invocation-${suffix}`,
        reservationId: `reservation-${suffix}`,
        limits: { maxAttempts: 2, maxTotalTokens: 20 },
        capacity: { attempts: 1, maxTokens: 10 },
      });
    }
    await ledger.settle({
      authorizationId: "authorization-f",
      reservationId: "reservation-two",
      usage: { attempts: 1, totalTokens: 4, costUsd: 0 },
    });
    await ledger.settle({
      authorizationId: "authorization-f",
      reservationId: "reservation-one",
      usage: { attempts: 1, totalTokens: 3, costUsd: 0 },
    });

    await writeFile(ledgerFile(root, "authorization-f"), "{\"schemaVersion\":1,\"authorizationId\":\"authorization-f\",\"limits\":null}");
    await assert.rejects(
      ledger.reserve({
        authorizationId: "authorization-f",
        invocationId: "invocation-three",
        reservationId: "reservation-three",
        limits: { maxAttempts: 3 },
        capacity: { attempts: 1 },
      }),
      (error: unknown) => error instanceof AuthorizationPersistenceError,
    );
  });
});

function plan(
  authorizationId: string,
  invocationId: string,
  limits: ExecutionAuthorization["limits"] = { maxAttempts: 1, maxTotalTokens: 10, maxCostUsd: 1 },
): ExecutionPlan {
  return {
    schemaVersion: 1,
    role: "extractor",
    request,
    candidates: [{
      id: "primary",
      runtimeId: "fixture",
      estimatedUsdPer1kTokens: 10,
      worstCaseUsage: {
        ...(limits.maxTotalTokens === undefined ? {} : { maxTokens: 10 }),
        ...(limits.maxCostUsd === undefined ? {} : { maxCostUsd: 1 }),
      },
    }],
    budget: {
      maxAttempts: limits.maxAttempts,
      ...(limits.maxTotalTokens === undefined ? {} : { maxTotalTokens: limits.maxTotalTokens }),
      ...(limits.maxCostUsd === undefined ? {} : { maxCostUsd: limits.maxCostUsd }),
    },
    authorization: { schemaVersion: 1, id: authorizationId, invocationId, limits },
  };
}

function ledgerFile(root: string, authorizationId: string): string {
  return join(root, `${createHash("sha256").update(authorizationId).digest("hex")}.json`);
}

function worker(root: string, invocationId: string): Promise<string> {
  const file = resolve("dist/tests/fixtures/ledger-worker.js");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [file, root, "shared-authorization", invocationId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`));
      else resolveResult(stdout.trim());
    });
  });
}
