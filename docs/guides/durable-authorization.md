# Durable authorization

A plan's `budget` limits a single `dispatch()` call. When a host needs one hard
ceiling across many calls, including concurrent calls and calls made after a
process restart, it adds an `authorization` to each plan and passes an
`AuthorizationLedger`. This guide covers the file-backed ledger that Dispatch
ships, how reservations move through their states, and how to recover when a
call's outcome is uncertain.

## Set up a file ledger

```ts
import { FileAuthorizationLedger, dispatch } from "@kontourai/dispatch";

const ledger = new FileAuthorizationLedger({
  root: "/application-owned/private/dispatch-authorizations",
});

const outcome = await dispatch({
  schemaVersion: 1,
  role: "structured-worker",
  request,
  candidates: [{
    id: "primary",
    runtimeId: runtime.id,
    worstCaseUsage: { maxTokens: 2_000, maxCostUsd: 0.20 },
  }],
  budget: { maxAttempts: 1, maxTotalTokens: 2_000, maxCostUsd: 0.20 },
  authorization: {
    schemaVersion: 1,
    id: "authorized-run-2026-07-23",
    invocationId: "document-17-chunk-4",
    limits: { maxAttempts: 20, maxTotalTokens: 40_000, maxCostUsd: 4 },
  },
}, { get: (id) => id === runtime.id ? runtime : undefined }, {
  authorizationLedger: ledger,
});
```

Every call that should draw on the same capacity uses the same
`authorization.id` and the same `limits`. Each call needs its own
`invocationId`.

`FileAuthorizationLedger` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory for ledger files. It is created if missing and its mode is set to `0700`, also when it already exists. It must be a real directory, not a symbolic link. |
| `lockTimeoutMs` | `5000` | How long to wait for another process's lock before failing. |
| `now` | `() => new Date()` | Clock used for the timestamps in ledger records. |

The `dispatch fixture` and `dispatch replay` CLI commands accept
`--authorization-root <dir>` to run with a file ledger at that directory.

## Plan requirements

Dispatch validates the authorization before any attempt and throws a
`TypeError` if it is invalid:

- `schemaVersion` is `1`.
- `id` and `invocationId` start with a letter or digit and contain only
  letters, digits, and `. _ : @ / -`, up to 256 characters.
- `limits.maxAttempts` is a positive integer. `limits.maxTotalTokens`, when
  set, is a positive integer, and `limits.maxCostUsd`, when set, is a positive
  number.
- If the limits include `maxTotalTokens`, every candidate must set
  `worstCaseUsage.maxTokens`. If they include `maxCostUsd`, every candidate
  must set `worstCaseUsage.maxCostUsd`.

A plan with an `authorization` needs an `authorizationLedger` in the options.
Without one, `dispatch()` throws `AuthorizationPersistenceError` when it
reaches the first candidate it would invoke, before calling it. A run that
never reaches such a candidate, for example because no candidate is eligible
or no runtime is registered, ends with its ordinary receipt instead.

## How capacity is counted

For each attempt, Dispatch asks the ledger to reserve one attempt plus the
candidate's `worstCaseUsage`. The ledger adds up every reservation for that
authorization id:

- A **reserved** entry counts its full worst case.
- A **settled** entry counts its measured usage.
- A **released** entry counts nothing.

If adding the new reservation would exceed any limit, the ledger refuses it.
Dispatch then ends the run with outcome `budget-exceeded`, the receipt's
`authorization.outcome` is `exhausted`, and no provider call is made.

After a successful attempt, Dispatch settles the reservation with the
measured tokens and the estimated cost. When the candidate has no
`estimatedUsdPer1kTokens`, the settled cost is the reserved
`worstCaseUsage.maxCostUsd`, or `0` when that is not set either.

A failed attempt is not settled. Its reservation stays at the full worst case,
because the provider may have done the work before failing. The same applies
to attempts that were interrupted or whose result is otherwise unknown.

The receipt's `authorization.outcome` is `settled` when every reserved attempt
was settled and `reserved` when at least one is still held. Each attempt
records its `reservationId` and `reservationState`.

## Replays are refused

A reservation id is derived from the authorization id, the invocation id, the
attempt number, and the candidate id. Running the same plan again with the
same `invocationId` therefore asks for a reservation that already exists. The
ledger reports it as already reserved, settled, or released, and Dispatch
throws `AuthorizationPersistenceError` instead of calling the provider again,
because the earlier call may already have happened.

The reservation id does not include the candidate's `worstCaseUsage`. If the
same invocation is run again with a different worst case, the ledger refuses
it with `Reservation id was reused with different capacity`.

If your host retries a failed call from outside Dispatch, give each retry a
fresh `invocationId`. This matters most with `createDispatchRuntime()`, where
a fixed `plan.authorization` reuses the same invocation id for every call.

## Releasing held capacity

Capacity held by a failed or uncertain attempt is released only when the host
calls `ledger.release()` after it has reconciled what happened:

```ts
await ledger.release({
  authorizationId: "authorized-run-2026-07-23",
  reservationId: attempt.reservationId,
  reason: "provider-reconciled",
});
```

The reason must be one of:

| Reason | Meaning |
| --- | --- |
| `confirmed-not-launched` | The provider call never started. Dispatch itself uses this when the abort signal fires after a reservation and before the call. |
| `provider-reconciled` | The host checked with the provider. |
| `operator-reconciled` | An operator resolved the reservation. |

The reason stays in the ledger record. A settled reservation cannot be
released, and a released reservation cannot be settled. Releasing the same
reservation again with the same reason is a no-op.

## What the file ledger stores

The ledger keeps one JSON file per authorization id, named by a SHA-256 of
the id. Each file:

- is written with mode `0600`, through a temporary file that is synced and
  renamed into place;
- carries a SHA-256 integrity digest that is checked on every read;
- holds at most 8,192 reservations and 1 MiB;
- records the limits, and each reservation's invocation id, state, reserved
  capacity, measured usage, release reason, and timestamps.

It never stores requests, responses, credentials, or diagnostics.

Writers are serialized across processes with a lock file created next to the
ledger file. A process that cannot take the lock within `lockTimeoutMs`
fails. The ledger does not remove a lock left behind by a crashed process; an
operator must inspect and remove it.

## Errors

`AuthorizationExhaustedError` (`code: "AUTHORIZATION_EXHAUSTED"`) is what a
ledger throws when capacity runs out. `dispatch()` catches it and returns a
`budget-exceeded` receipt, so callers of `dispatch()` see a receipt rather
than this error.

`AuthorizationPersistenceError` (`code: "AUTHORIZATION_PERSISTENCE_FAILED"`)
means the ledger could not record a reservation safely. `dispatch()` throws
it rather than returning a receipt. It has a `phase` of `reserve`, `settle`,
or `recovery`, and `duplicateInvocationRisk` is `true` for `settle` and
`recovery`, where a provider call may already have completed.

| Message | Phase | Cause |
| --- | --- | --- |
| `Execution authorization requires an authorization ledger` | `reserve` | The plan has an `authorization` but no ledger was passed. |
| `Reservation id was reused with different capacity` | `reserve` | The same `invocationId` was run again with a different `worstCaseUsage`. |
| `Authorization reservation already exists; automatic provider replay is refused` | `recovery` | The same `invocationId` was run again. Use a fresh one, or reconcile and release. |
| `Provider invocation completed but authorization settlement failed` | `settle` | The provider returned a result but the ledger could not settle it, for example because measured usage exceeded the reserved worst case. Do not repeat the call blindly. |
| `Authorization ledger lock timed out` | `reserve` | Another process held the lock longer than `lockTimeoutMs`, or a stale lock file remains. |
| `Authorization ledger is malformed or tampered` | `reserve` | The ledger file failed its integrity or schema check. |
| `Authorization limits changed for an existing ledger` | `reserve` | A plan used an existing authorization id with different `limits`. |
| `Authorization ledger record limit reached` | `reserve` | The authorization already holds 8,192 reservations. |
| `Authorization ledger exceeds its size bound` | `reserve` | Writing the ledger would exceed 1 MiB. Every write checks this, so a settle or release can hit it too. |
| `Authorization ledger root must be a real directory` | `reserve` | Thrown by the `FileAuthorizationLedger` constructor when `root` is a symbolic link to a directory. If `root` is a regular file, or a link to one, the constructor throws the filesystem's raw `EEXIST` error instead. |

The phases above are for errors raised while reserving. The record limit is
checked only when a new reservation is added. Any ledger error raised while
settling a successful attempt, including a lock timeout, a malformed ledger,
or the size bound, reaches the caller as `Provider invocation completed but
authorization settlement failed` with phase `settle`.
