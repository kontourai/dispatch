# Reference

This page lists the public surface of `@kontourai/dispatch`: its package
entrypoints, the exports of each, the plan and receipt types, and the
`dispatch` CLI. For how the pieces work together, read
[Concepts](concepts.md).

## Entrypoints

| Import path | Exports | Optional peer dependency |
| --- | --- | --- |
| `@kontourai/dispatch` | The core API, listed below | none |
| `@kontourai/dispatch/datum` | `bindDatumResolvedRef` | `@kontourai/datum` |
| `@kontourai/dispatch/bearing` | `capabilityEvidenceFromBearing` | `@kontourai/bearing` |
| `@kontourai/dispatch/ai-sdk` | `createAiSdkDispatchModel` | `@ai-sdk/provider` |

The package also exports `./package.json` and installs one binary,
`dispatch`.

## Core API

### dispatch

```ts
dispatch(plan: ExecutionPlan, runtimes: RuntimeRegistry, options?: DispatchOptions): Promise<DispatchOutcome>
```

Runs one plan. It resolves to `{ result, receipt }` when the outcome is
`succeeded` and to `{ receipt }` otherwise. It throws `TypeError` for an
invalid plan or authorization, and `AuthorizationPersistenceError` when an
authorization reservation cannot be recorded safely.

`DispatchOptions`:

| Field | Meaning |
| --- | --- |
| `signal` | An `AbortSignal`. It is checked before each attempt and passed to the runtime. |
| `authorizationLedger` | Required when the plan has an `authorization`. |
| `now` | Clock in milliseconds used for elapsed time. Defaults to `performance.now()`. |

### dispatchBatch

```ts
dispatchBatch(plans: readonly ExecutionPlan[], runtimes: RuntimeRegistry, options?: DispatchOptions): Promise<readonly DispatchOutcome[]>
```

Runs the plans as one provider-native physical batch and returns one outcome
per plan, in input order. It throws `TypeError` for an empty list, and a Relay
`ModelInvocationError` with code `INVALID_REQUEST` when the plans' first
eligible candidates do not share one runtime, or that runtime cannot run a
physical batch of this size. See [physical batches](concepts.md#physical-batches).

### createDispatchRuntime

```ts
createDispatchRuntime(options: DispatchRuntimeOptions): ModelRuntime
```

Returns a Relay `ModelRuntime` whose `invoke()` runs `dispatch()` with the
request it receives.

`DispatchRuntimeOptions`:

| Field | Meaning |
| --- | --- |
| `id` | The runtime id. |
| `capabilities` | The Relay capabilities this runtime declares. `physicalBatch` and `maxBatchSize` are kept only when `physicalBatch` is `true` and `maxBatchSize` is a positive integer; only then does the runtime have `invokeBatch()`. |
| `plan` | A `DispatchRuntimePlan` (an `ExecutionPlan` without `request`), or a function from the request to one, which may be async. |
| `runtimes` | The `RuntimeRegistry` for the plan's candidates. |
| `authorizationLedger` | Passed to `dispatch()`. |
| `onReceipt` | Called with every terminal receipt. |
| `receiptDeliveryFailureMode` | `"fail-closed"` (default) or `"best-effort"`. |
| `onReceiptDeliveryFailure` | Called with the `ReceiptDeliveryError` when `onReceipt` throws. Errors from this callback are ignored. |

`invokeBatch()` accepts between 1 and `maxBatchSize` requests and runs
`dispatchBatch()`. Every receipt is delivered. In `fail-closed` mode, if any
delivery fails, the first `ReceiptDeliveryError` is thrown after all of them
have been attempted; in `best-effort` mode the outcomes are returned
normally.

When an invocation ends without a result, `invoke()` throws
`DispatchRuntimeError`. Its `code` and `retryable` depend on the receipt's
outcome:

| Outcome | `code` | `retryable` |
| --- | --- | --- |
| `aborted` | `ABORTED` | `false` |
| `exhausted` | From the first non-retryable failed attempt, or the last failed attempt when all were retryable | `true` only if every failed attempt was retryable |
| `no-eligible-candidates` | `PROVIDER_UNAVAILABLE` | `false` |
| `budget-exceeded` | `RUNTIME_FAILURE` | `false` |

For `exhausted`, a failed attempt whose code is Dispatch's own, such as
`RUNTIME_NOT_FOUND`, counts as non-retryable and surfaces as
`PROVIDER_UNAVAILABLE`, because a missing runtime is a configuration error
that an outer retry would meet again. The receipt records that attempt with
`retryable: false` as well; `dispatch()` moves on to the next candidate after
a missing runtime regardless of that flag. An `exhausted` receipt with no failed
attempts maps to `PROVIDER_UNAVAILABLE`, non-retryable. Batch items rejected
by Dispatch carry the same `code` and `retryable`.

### Errors

| Class | Extends | Key fields |
| --- | --- | --- |
| `DispatchRuntimeError` | Relay `ModelInvocationError` | `receipt`, `code`, `retryable` |
| `ReceiptDeliveryError` | Relay `ModelInvocationError` | `receipt`, `modelResult` (set after success), `duplicateInvocationRisk` (`true` when `modelResult` is set); `code` is `RUNTIME_FAILURE`, never retryable |
| `AuthorizationPersistenceError` | `Error` | `code: "AUTHORIZATION_PERSISTENCE_FAILED"`, `phase` (`reserve`, `settle`, or `recovery`), `duplicateInvocationRisk` |
| `AuthorizationExhaustedError` | `Error` | `code: "AUTHORIZATION_EXHAUSTED"`, `authorizationId` |

With `receiptDeliveryFailureMode: "fail-closed"`, a failure in `onReceipt`
throws `ReceiptDeliveryError`, even when the model call succeeded. With
`"best-effort"`, `invoke()` returns the model result, or throws the original
`DispatchRuntimeError`, and the delivery failure is reported only through
`onReceiptDeliveryFailure`. Text from the callback's error is never copied
into the error or the receipt.

### FileAuthorizationLedger

```ts
new FileAuthorizationLedger(options: FileAuthorizationLedgerOptions)
```

A file-backed `AuthorizationLedger` that is safe across processes. Options
are `root` (required), `lockTimeoutMs` (default `5000`), and `now`. See
[Durable authorization](guides/durable-authorization.md).

### withCapabilityEvidence

```ts
withCapabilityEvidence(candidates: readonly ExecutionCandidate[], source: CapabilityEvidenceSource): Promise<readonly ExecutionCandidate[]>
```

Calls `source.evidenceFor(candidate)` for each candidate that has no
`evidence`, and attaches what it returns. Candidates that already have
evidence, or for which the source returns `undefined`, are returned
unchanged. The order is preserved.

### executionPlanDigest

```ts
executionPlanDigest(plan: ExecutionPlan): string
```

Returns the hex SHA-256 used as the receipt's `planDigest`. It hashes the
prefix `dispatch:execution-plan:v1` and a NUL byte, followed by canonical JSON
of `schemaVersion`, `role`, the request's digest (not the request itself),
`candidates`, `budget`, `policy`, and `authorization`.

### DISPATCH_RECEIPT_SCHEMA_VERSION

The constant `1`, the current `DispatchReceipt` schema version.

## Types

### ExecutionPlan

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `role` | `string` | Must not be empty. |
| `request` | Relay `ModelInvocationRequest` | |
| `candidates` | `ExecutionCandidate[]` | Tried in this order. |
| `budget` | `ExecutionBudget` | |
| `policy` | `ExecutionPolicy` | Optional. |
| `authorization` | `ExecutionAuthorization` | Optional. |

### ExecutionCandidate

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | |
| `runtimeId` | `string` | Looked up in the `RuntimeRegistry`. |
| `evidence` | `CapabilityEvidence` | Optional. Missing evidence counts as `unavailable` with no capabilities. |
| `estimatedUsdPer1kTokens` | `number` | Optional. Used for `estimatedCostUsd`. |
| `worstCaseUsage` | `{ maxTokens?: number; maxCostUsd?: number }` | Optional. Reserved before the attempt under an authorization. `maxTokens` must be a positive integer and `maxCostUsd` a positive number. |

### ExecutionBudget

| Field | Type | Notes |
| --- | --- | --- |
| `maxAttempts` | `number` | An integer of at least `1`. The most candidates tried. |
| `maxElapsedMs` | `number` | Optional. A finite number of at least `0`. |
| `maxTotalTokens` | `number` | Optional. An integer of at least `0`. Measured across attempts. |
| `maxCostUsd` | `number` | Optional. A finite number of at least `0`. Estimated across attempts. |

Any other value, including `NaN`, `Infinity`, a string, or a negative number,
makes `dispatch()` and `dispatchBatch()` throw
`TypeError("Invalid execution plan: budget.<field> must be ...")` before any
runtime is invoked. Omit a limit to leave it unbounded; `Infinity`, which
earlier versions accepted as "unbounded", is now refused. See
[execution plans](concepts.md#execution-plan) for migrating other values that
earlier versions accepted.

### ExecutionPolicy

| Field | Type | Notes |
| --- | --- | --- |
| `requiredCapabilities` | `string[]` | Every one must appear in the candidate's evidence. |
| `minimumEvidence` | `"unavailable" \| "declared" \| "confirmed"` | Defaults to `unavailable`. |
| `minimumStructuredToolsFidelity` | `"prompted" \| "native"` | Defaults to `native` when `structured-tools` is required. |
| `retryRuntimeFailures` | `boolean` | When `true`, non-retryable failures also fall back to the next candidate. |

### CapabilityEvidence

| Field | Type |
| --- | --- |
| `level` | `"unavailable" \| "declared" \| "confirmed"` |
| `capabilities` | `string[]` |
| `structuredToolsFidelity` | `"unavailable" \| "prompted" \| "native"` (optional) |
| `source` | `string` (optional) |

A `CapabilityEvidenceSource` has one method,
`evidenceFor(candidate): Promise<CapabilityEvidence | undefined>`.

### ExecutionAuthorization

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `id` | `string` | Shared by every invocation drawing on this capacity. |
| `invocationId` | `string` | Unique per invocation within the authorization. |
| `limits` | `{ maxAttempts: number; maxTotalTokens?: number; maxCostUsd?: number }` | |

### DispatchReceipt

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `planDigest` | `string` | See `executionPlanDigest`. |
| `requestDigest` | `string` | Relay's request digest. |
| `role` | `string` | |
| `outcome` | `"succeeded" \| "aborted" \| "exhausted" \| "budget-exceeded" \| "no-eligible-candidates"` | |
| `attempts` | `DispatchAttemptReceipt[]` | In order. |
| `totalElapsedMs` | `number` | |
| `totalTokens` | `number` | Sum over attempts. |
| `estimatedCostUsd` | `number` | Sum over attempts. |
| `physicalBatch` | `{ operationId; itemIndex; itemCount }` | Only for items of a physical batch. `itemIndex` is the position in the native call, not in the caller's array. |
| `authorization` | `{ id; invocationId; outcome: "reserved" \| "settled" \| "exhausted" }` | Set only when the run ends because of an attempt: after an attempt's result or error, when the candidates run out, or when the ledger refuses a reservation (`outcome: "exhausted"`). It is then present if any attempt holds a reservation. A run that ends at a check rather than at an attempt has no `authorization` field, even when an earlier attempt holds a reservation. There are two such checks. Before each attempt, the run stops if the abort signal has fired or a budget limit is already reached. After a successful reservation and before the call, the run stops if the abort signal has fired, and that new reservation is released. A physical-batch item has the field whenever any of its attempts holds a reservation or its reservation was refused. |

### DispatchAttemptReceipt

| Field | Notes |
| --- | --- |
| `candidateId`, `runtimeId` | The candidate tried. |
| `outcome` | `"succeeded"` or `"failed"`. |
| `elapsedMs` | |
| `structuredToolsFidelity` | Present when the candidate's evidence sets it. |
| `model`, `modelSource` | Successful attempts only, copied from the runtime's result. `modelSource` is `"provider-reported"` or `"configured"`, or absent. |
| `inputTokens`, `outputTokens`, `totalTokens` | Successful attempts. |
| `estimatedCostUsd` | Successful attempts whose candidate has `estimatedUsdPer1kTokens`. |
| `errorCode`, `retryable` | Failed attempts. |
| `reservationId`, `reservationState` | Under an authorization. `reservationState` is `"reserved"` or `"settled"`. |

### AuthorizationLedger

The port that `FileAuthorizationLedger` implements. A host can supply its own.

| Method | Purpose |
| --- | --- |
| `reserve(reservation)` | Hold capacity. Resolves to a status of `reserved`, `already-reserved`, `already-settled`, or `already-released`. Throws `AuthorizationExhaustedError` when capacity is exhausted. |
| `settle(settlement)` | Replace a reservation's worst case with measured usage. |
| `release(release)` | Free a reservation, with a reason of `confirmed-not-launched`, `provider-reconciled`, or `operator-reconciled`. |

Dispatch invokes the provider only when `reserve()` resolves to `reserved`.

## Datum entrypoint

```ts
import { bindDatumResolvedRef } from "@kontourai/dispatch/datum";

bindDatumResolvedRef(role: string, resolved: ResolvedRef, options?: DatumCandidateOptions): DatumCandidateBinding
```

Maps the output of Datum's `resolveRef()` to `{ candidate, target }`:

- `candidate` is an `ExecutionCandidate` whose `id` defaults to `role`.
- `target` describes the runtime for the host to build: `runtimeId`,
  `provider`, `kind`, `model`, `baseUrl` when set, and `auth` with the auth
  `kind`, `ref`, and `available` flag. It never holds a credential value.

The `runtimeId` defaults to `datum:<provider>:<model>:<digest>`, where
`<digest>` is the first 12 hex characters of a SHA-256 of the `baseUrl` (or
of `default` when there is none). `options` can set `id`, `runtimeId`,
`evidence`, `estimatedUsdPer1kTokens`, and `worstCaseUsage`. Datum's
`ResolvedRef` carries no token or cost limits, so `worstCaseUsage` is never
derived; pass it when the candidate runs under an authorization with token or
cost limits. Without it, `dispatch()` throws a `TypeError` that names the
candidate and the missing `worstCaseUsage` field. An empty `role` throws
`TypeError`. The function does not create or invoke a runtime.

## Bearing entrypoint

```ts
import { capabilityEvidenceFromBearing } from "@kontourai/dispatch/bearing";

capabilityEvidenceFromBearing(candidate: RankedCandidate | RankedCandidateV2, catalogDigest: string): CapabilityEvidence
```

Projects a Bearing ranked candidate into `CapabilityEvidence`:

- `capabilities` are the distinct, sorted `measurementKey`s of the
  candidate's reasons with code `REQUIREMENT_MET`.
- `level` is `confirmed` when there is at least one capability and each has
  an evidence entry with evidence ids, `declared` when there are capabilities
  but not all are backed that way, and `unavailable` when there are none.
- `source` is `bearing:catalog:<catalogDigest>`.

The projection does not set `structuredToolsFidelity`.

## AI SDK entrypoint

```ts
import { createAiSdkDispatchModel } from "@kontourai/dispatch/ai-sdk";

createAiSdkDispatchModel(options: AiSdkDispatchModelOptions): LanguageModelV3
```

Wraps AI SDK v3 language models as Relay runtimes, routes between them with
`createDispatchRuntime()`, and returns one AI SDK v3 model.

| Field | Meaning |
| --- | --- |
| `id`, `capabilities`, `plan` | As in `createDispatchRuntime`. |
| `models` | AI SDK models keyed by runtime id. Plan candidates refer to these keys through `runtimeId`. |
| `provider`, `modelId` | Optional identity for the returned model. They default to `"relay"` and to `id`. |
| `onReceipt`, `authorizationLedger`, `receiptDeliveryFailureMode`, `onReceiptDeliveryFailure` | As in `createDispatchRuntime`. |

If a plan names a `runtimeId` that is not a key of `models`, the invocation
fails with a non-retryable `INVALID_REQUEST` error that lists the missing ids.

## CLI

```text
dispatch <fixture|replay> --plan <file> (--fixtures <file>|--records <file>) [--authorization-root <dir>]
```

The CLI runs one plan without provider credentials. It does not build live
runtimes.

| Command | Runtimes |
| --- | --- |
| `fixture --plan <file> --fixtures <file>` | The fixtures file is `{ "runtimes": { "<runtimeId>": [ ... ] } }`. Each runtime returns its queued entries in order, one per invocation. An entry is a Relay `ModelInvocationResult`, or a failure `{ "code", "message", "retryable" }`. A candidate whose `runtimeId` has no entry gets `RUNTIME_NOT_FOUND`, and a runtime whose queue is empty fails with a non-retryable `RUNTIME_FAILURE`. |
| `replay --plan <file> --records <file>` | The records file is an array of Relay `InvocationReplayRecord`s (`schemaVersion`, `requestDigest`, `request`, `result`). Every candidate resolves to the same replay runtime, which returns the result of the record whose `requestDigest` equals Relay's digest of the plan's request, and fails with a non-retryable `INVALID_REQUEST` when no record matches. |

`--authorization-root <dir>` runs with a `FileAuthorizationLedger` rooted at
`<dir>`.

Each input file may be at most 2 MiB. The CLI writes one JSON document to
standard output: `{ "schemaVersion": "dispatch.cli.result/v1", "result"?, "receipt" }`.

| Exit code | Meaning |
| --- | --- |
| `0` | The outcome is `succeeded`. |
| `1` | A usage error, invalid JSON, an unreadable or oversized file, an invalid plan, or another error. The message is written to standard error with the prefix `dispatch:`. |
| `2` | A valid run ended with any other outcome. |
