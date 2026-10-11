# Concepts

Dispatch is a policy and execution layer for model calls. A host hands it an
explicit plan and the runtimes that plan may use; Dispatch decides which
candidates are eligible, invokes them in order within the budget, and records
every decision in a receipt. The terms below are defined in
[CONTEXT.md](../CONTEXT.md); this page explains how they fit together.

## Ownership boundaries

Dispatch owns deterministic policy evaluation, budgets, fallback, the
mechanics of authorization reservations, and receipts. Everything else stays
with other parts of the system:

| Concern | Owner |
| --- | --- |
| Configuration sources and credential resolution | The host application |
| Capability evidence and its confidence | The capability source (for example Bearing) |
| Provider and framework invocation mechanics | The model runtime (a Relay `ModelRuntime`) |
| Prompts, tools, schemas, and interpreting responses | The domain application |
| Who may issue or reconcile an authorization | The host application |

Dispatch never accepts credential values. Plans, candidates, and receipts are
secret-free by design.

## Execution plan

An `ExecutionPlan` is the immutable input to one run:

- `schemaVersion`: always `1`.
- `role`: a non-empty name for the work, copied into the receipt.
- `request`: the Relay `ModelInvocationRequest` (messages, and optionally
  tools, tool choice, `maxOutputTokens`, and metadata).
- `candidates`: the ordered runtimes Dispatch may try.
- `budget`: the limits for this run.
- `policy` (optional): the eligibility and retry rules.
- `authorization` (optional): durable capacity shared with other runs. See
  [execution authorization](#execution-authorization).

A plan with a `schemaVersion` other than `1`, an empty `role`, or
`budget.maxAttempts` below `1` is rejected with
`TypeError("Invalid execution plan")` before anything runs.

## Candidates and the runtime registry

An `ExecutionCandidate` names one runtime target and carries what routing
needs to know about it:

- `id`: the candidate's identity in receipts.
- `runtimeId`: the key Dispatch looks up in the `RuntimeRegistry`.
- `evidence` (optional): the candidate's `CapabilityEvidence`.
- `estimatedUsdPer1kTokens` (optional): used to estimate cost from measured
  tokens.
- `worstCaseUsage` (optional): the `maxTokens` and `maxCostUsd` to reserve
  before the candidate runs under an authorization.

The `RuntimeRegistry` is any object with `get(runtimeId)`. It returns a Relay
`ModelRuntime`, or `undefined` when the host has no runtime for that id.
Dispatch does not construct runtimes; the host does.

## Capability evidence and eligibility

`CapabilityEvidence` states what a candidate can do and how sure the host is:

- `level`: `unavailable`, `declared`, or `confirmed`, in increasing order.
- `capabilities`: capability names, such as `tools` or `structured-tools`.
- `structuredToolsFidelity` (optional): `unavailable`, `prompted`, or
  `native`.
- `source` (optional): where the evidence came from.

A candidate with no `evidence` is treated as level `unavailable` with no
capabilities.

Before the first attempt, Dispatch filters the candidates. A candidate is
eligible only when all of the following hold:

1. Its evidence level is at least `policy.minimumEvidence` (default
   `unavailable`).
2. Its capabilities include every entry in `policy.requiredCapabilities`.
3. Its structured-tools fidelity is consistent: if `capabilities` includes
   `structured-tools`, `structuredToolsFidelity` must be `prompted` or
   `native`; otherwise it must be absent or `unavailable`. Inconsistent
   evidence is never eligible, whatever the policy requires.
4. Its fidelity meets the minimum. The minimum is
   `policy.minimumStructuredToolsFidelity` when set. When it is not set and
   `requiredCapabilities` contains `structured-tools`, the minimum is
   `native`. A host can set it to `prompted` to admit runtimes that produce
   schema-shaped output by prompting.

If no candidate is eligible, the run ends at once with outcome
`no-eligible-candidates` and no attempts.

Evidence can come from the plan itself or from a `CapabilityEvidenceSource`.
`withCapabilityEvidence()` fills in evidence only for candidates that have
none, and keeps the input order. The optional Bearing entrypoint projects a
Bearing ranked candidate into this evidence shape; see
[integrations](#integrations).

## How a run proceeds

`dispatch()` walks the eligible candidates in plan order. It tries at most
`budget.maxAttempts` of them, and each candidate at most once: a fallback
always moves to the next candidate, never back to the same one. For each
candidate:

1. **Abort check.** If the caller's `AbortSignal` has fired, the run ends
   `aborted`.
2. **Budget check.** If elapsed time has reached `maxElapsedMs`, or the
   measured tokens or estimated cost so far have reached `maxTotalTokens` or
   `maxCostUsd`, the run ends `budget-exceeded`.
3. **Runtime lookup.** If the registry has no runtime for `runtimeId`, the
   attempt is recorded as failed with `errorCode: "RUNTIME_NOT_FOUND"` and
   Dispatch moves on. This uses one of the `maxAttempts`.
4. **Reservation.** With an `authorization`, Dispatch reserves the
   candidate's worst case in the ledger first. See
   [execution authorization](#execution-authorization).
5. **Invoke.** Dispatch calls `runtime.invoke(request)` once.
6. **On success**, Dispatch measures usage. Total tokens are the runtime's
   `totalTokens`, or input plus output tokens when that is missing. The
   estimated cost is `totalTokens * estimatedUsdPer1kTokens / 1000` when the
   candidate sets a rate. If the run is now over any budget limit, it ends
   `budget-exceeded` and the model result is not returned, though the attempt
   stays in the receipt. Otherwise it ends `succeeded`.
7. **On failure**, the attempt records the error code and whether it is
   retryable. An `ABORTED` error ends the run `aborted`. A non-retryable error
   ends the run unless `policy.retryRuntimeFailures` is `true`. A retryable
   error moves on to the next candidate.

When the candidates or attempts run out, the outcome is `exhausted`.

Errors that a runtime throws are normalized to Relay's codes: `ABORTED`,
`AUTHENTICATION_FAILED`, `INVALID_REQUEST`, `PROVIDER_UNAVAILABLE`,
`RATE_LIMITED`, and `RUNTIME_FAILURE`. An error that does not carry one of
these codes and a boolean `retryable` becomes a non-retryable
`RUNTIME_FAILURE`.

Dispatch adds no retries of its own to a single candidate. Retrying one
candidate on transient failures is the runtime's job; Relay's
Anthropic-compatible runtime, for example, retries only when you pass it
`maxRetries`.

## Receipts

Every run produces a `DispatchReceipt`, whatever the outcome. It records:

- `schemaVersion` (`1`), `role`, and the terminal `outcome`: `succeeded`,
  `aborted`, `exhausted`, `budget-exceeded`, or `no-eligible-candidates`.
- `planDigest`: a SHA-256 over the plan with the request replaced by its
  digest. `executionPlanDigest()` computes the same value.
- `requestDigest`: Relay's digest of the request.
- `attempts`: one entry per attempt, in order.
- `totalElapsedMs`, `totalTokens`, and `estimatedCostUsd` for the run.
- `authorization` and `physicalBatch`, when they apply.

Each attempt records its `candidateId`, `runtimeId`, `outcome`, and
`elapsedMs`, plus the candidate's `structuredToolsFidelity` when its evidence
sets one. A successful attempt adds its
token counts, estimated cost, and the `model` and `modelSource` that the
runtime reported. A failed attempt adds `errorCode` and `retryable`.

`model` is the runtime's report, copied as is. Only
`modelSource: "provider-reported"` identifies the model that served the
request; `configured` means the runtime echoed its configured model, and an
absent `modelSource` means the runtime did not say.

Receipts contain digests and measurements. They never contain prompt text,
response text, or credentials.

## Execution authorization

A budget limits one `dispatch()` call. An `ExecutionAuthorization` limits many
calls at once, including concurrent ones and ones that run after a process
restart. It has an `id` shared by every call drawing on the same capacity, an
`invocationId` unique to this call, and `limits` for attempts, tokens, and
cost.

With an authorization, each attempt first reserves its candidate's
`worstCaseUsage` in an `AuthorizationLedger`. If the reservation would exceed
the limits, the run ends `budget-exceeded` with authorization outcome
`exhausted`, and nothing is invoked. After a successful attempt Dispatch
settles the reservation with the measured usage. A failed or interrupted
attempt stays reserved, because the provider may have done the work.

Dispatch ships `FileAuthorizationLedger`, a file-backed ledger that works
across processes. The [durable authorization guide](guides/durable-authorization.md)
covers setup, recovery, and errors.

## Using Dispatch as a runtime

`createDispatchRuntime()` wraps a plan template and a runtime registry as a
Relay `ModelRuntime`. Code that depends only on Relay can then call it like
any other runtime, while the host decides the routing and receives each
receipt through `onReceipt`. The template is a plan without its `request`, or
a function that builds one from each request.

When the runtime cannot produce a result, it throws a `DispatchRuntimeError`
that carries the receipt. Its `code` and `retryable` summarize the attempts so
that an outer retry is attempted only when every failure was retryable. A
failure inside `onReceipt` is a separate `ReceiptDeliveryError`; by default it
is thrown even after a successful model call, so a receipt is never lost
silently. The [reference](reference.md#createdispatchruntime) gives the exact
mapping.

## Physical batches

A physical batch is one provider-native operation that carries several
requests. It is not the same as running several `invoke()` calls
concurrently.

`dispatchBatch(plans, runtimes)` sends a list of plans as one physical batch.
The first eligible candidate of every plan must use the same runtime, and that
runtime must declare `physicalBatch: true`, implement `invokeBatch()`, and
have a `maxBatchSize` at least as large as the batch. Otherwise
`dispatchBatch()` throws an `INVALID_REQUEST` error without invoking anything.

Each item is reserved before the call, and an item whose authorization is
exhausted is left out of the call with outcome `budget-exceeded`. If any other
reservation fails, or the abort signal fires before the call, the reservations
already made are released with reason `confirmed-not-launched`. After the
call, each item is handled on its own: successful items settle independently,
and a failed item continues through its plan's remaining eligible candidates
as single invocations, under the same retry rules as `dispatch()`. If the
whole native operation fails, the failure is applied to every item that was
in it. Each item's receipt records the shared, content-free `operationId`, its
position in the native call, and the call's item count.

`createDispatchRuntime()` exposes `invokeBatch()` only when its declared
capabilities include `physicalBatch: true` and a positive integer
`maxBatchSize`. Otherwise it strips those fields and omits the method.

## Integrations

Dispatch is useful without any other Kontour product. Each integration below
is an optional entrypoint behind an optional peer dependency.

- **Relay** is the one required dependency. Its `ModelRuntime` is the runtime
  contract, and Dispatch's request and result types are Relay's.
- **Datum**: `bindDatumResolvedRef()` in `@kontourai/dispatch/datum` turns
  Datum's `resolveRef()` output into a candidate and a host-facing runtime
  target. It reads auth references and availability, never credential values,
  and it does not create a runtime. Datum resolves no token or cost limits, so
  under a token- or cost-bounded authorization the host passes
  `worstCaseUsage` when binding.
- **Bearing**: `capabilityEvidenceFromBearing()` in
  `@kontourai/dispatch/bearing` projects a Bearing ranked candidate into
  `confirmed`, `declared`, or `unavailable` evidence. Bearing remains the
  authority for the underlying observations.
- **AI SDK**: `createAiSdkDispatchModel()` in `@kontourai/dispatch/ai-sdk`
  routes between AI SDK v3 language models and returns one AI SDK v3 model.
