import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  FileAuthorizationLedger,
  type AuthorizationReservation,
  type AuthorizationRecoveryAdmission,
} from "../src/index.js";

const reserved = (): AuthorizationReservation => ({
  authorizationId: "original-authority", invocationId: "original-invocation", reservationId: "actual-reservation",
  limits: { maxAttempts: 1, maxTotalTokens: 100, maxCostUsd: 1 },
  capacity: { attempts: 1, maxTokens: 100, maxCostUsd: 1 },
});
const usage = { attempts: 1 as const, totalTokens: 12, costUsd: 0.2 };
const admission: AuthorizationRecoveryAdmission = { async acquire() { return { assertCurrent() {}, release() {} }; } };

it("inspects only existing reservations, returns detached evidence, and recovers exact usage after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-recovery-"));
  const ledger = new FileAuthorizationLedger({ root });
  const reservation = reserved();
  assert.deepEqual(await ledger.inspectInvocation(reservation), []);
  assert.deepEqual(await readdir(root), []);
  await ledger.reserve(reservation);
  const [observed] = await ledger.inspectInvocation(reservation);
  assert.equal(observed?.state, "reserved");
  observed!.capacity.maxTokens = 1;
  observed!.limits.maxAttempts = 99;
  const reopened = new FileAuthorizationLedger({ root });
  assert.equal((await reopened.inspectInvocation(reservation))[0]?.capacity.maxTokens, 100);
  const settled = await reopened.settleChecked({ reservation, usage, admission });
  assert.equal(settled.state, "settled");
  assert.deepEqual(settled.usage, usage);
  assert.deepEqual(await reopened.settleChecked({ reservation, usage, admission }), settled);
  await assert.rejects(reopened.settleChecked({ reservation, usage: { ...usage, totalTokens: 13 }, admission }));
  assert.deepEqual((await reopened.inspectInvocation(reservation))[0], settled);
});

it("checked settlement refuses foreign reservation identity and capacity without changing the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-recovery-binding-"));
  const ledger = new FileAuthorizationLedger({ root });
  const reservation = reserved();
  await ledger.reserve(reservation);
  const before = await ledger.inspectInvocation(reservation);
  for (const wrong of [
    { ...reservation, invocationId: "foreign-invocation" },
    { ...reservation, authorizationId: "foreign-authority" },
    { ...reservation, reservationId: "foreign-reservation" },
    { ...reservation, capacity: { ...reservation.capacity, maxTokens: 99 } },
    { ...reservation, limits: { ...reservation.limits, maxAttempts: 2 } },
  ]) {
    await assert.rejects(ledger.settleChecked({ reservation: wrong, usage, admission }));
    assert.deepEqual(await ledger.inspectInvocation(reservation), before);
  }
});

it("captures recovery input before lease acquisition and refuses revoked publication without changing ledger bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-recovery-lease-"));
  let current = true;
  let revokeAtSettlement = false;
  const ledger = new FileAuthorizationLedger({ root, now: () => {
    if (revokeAtSettlement) current = false;
    return new Date();
  } });
  const reservation = reserved();
  await ledger.reserve(reservation);
  const files = await readdir(root);
  const file = join(root, files[0]!);
  const before = await readFile(file, "utf8");
  let released = 0;
  revokeAtSettlement = true;
  await assert.rejects(ledger.settleChecked({ reservation, usage, admission: { async acquire() { return {
    assertCurrent() { if (!current) throw new Error("authority revoked"); },
    release() { assert.ok(!readdirSync(root).some(name => name.endsWith(".lock"))); released++; },
  }; } } }));
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(released, 1);
  current = true;
  revokeAtSettlement = false;
  const input = { reservation: structuredClone(reservation), usage: { ...usage }, admission: {
    async acquire() {
      input.reservation.invocationId = "substituted";
      input.usage.totalTokens = 99;
      return { assertCurrent(): undefined {}, release() { released++; } };
    },
  } };
  const settled = await ledger.settleChecked(input);
  assert.equal(settled.invocationId, reservation.invocationId);
  assert.deepEqual(settled.usage, usage);
  assert.equal(released, 2);
});
