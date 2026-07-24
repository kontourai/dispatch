# Dispatch

Dispatch executes model work through explicit, portable policy. It resolves a
role into candidate runtimes, applies capability constraints and budgets,
invokes through a provider-neutral runtime contract, and returns an auditable
receipt for every routing decision and attempt.

Dispatch is useful on its own. Hosts may supply configuration, capability
evidence, and model runtimes from any implementation. Optional adapters can
connect those ports to Datum, Bearing, and Relay without making suite-specific
configuration part of the public contract.

## Product boundary

Dispatch owns execution planning, routing, budgets, retries, fallbacks, and
receipts. It does not own credentials, provider SDKs, model capability claims,
domain prompts, response interpretation, review policy, or workflow semantics.

See [CONTEXT.md](CONTEXT.md) for the domain language and boundaries.

## SDK sketch

```ts
import { dispatch } from "@kontourai/dispatch";
import { createAnthropicRuntime } from "@kontourai/relay/anthropic";

const runtime = createAnthropicRuntime({ model: "configured-model" });
const outcome = await dispatch({
  schemaVersion: 1,
  role: "structured-worker",
  request: { messages: [{ role: "user", content: "Return structured output." }] },
  candidates: [{
    id: "primary",
    runtimeId: runtime.id,
    evidence: { level: "declared", capabilities: ["tools"] },
  }],
  budget: { maxAttempts: 1, maxTotalTokens: 2_000 },
  policy: { requiredCapabilities: ["tools"], minimumEvidence: "declared" },
}, { get: (id) => id === runtime.id ? runtime : undefined });

console.log(outcome.receipt);
```

Receipts include digests and measured outcomes, not prompt content or credential
values. Budget overruns discovered from measured usage are terminal and suppress
the model result while preserving the attempt in the receipt.

## Durable execution authorization

Per-invocation budgets are measured from one Dispatch call. Hosts that need a
hard ceiling shared by concurrent calls or preserved across process restarts can
add an `authorization` to the execution plan and provide an
`AuthorizationLedger`.

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

The file ledger serializes reservations across processes, stores bounded
schema-versioned and integrity-checked records in mode-0600 files, and never
stores requests, responses, credentials, or raw diagnostics. It reserves each
candidate's declared worst case before invocation and settles successful
attempts afterward. Failed, aborted-after-launch, interrupted, and otherwise
uncertain attempts remain conservatively reserved across restarts.

Replaying an existing reservation is refused because the prior provider call
may already have happened. A host may release that capacity only after explicit
reconciliation through `ledger.release(...)`; the release reason is a bounded
enum and remains in the audit record. An orphaned lock fails closed after the
configured timeout and requires operator inspection rather than unsafe automatic
lock stealing.

Authorization persistence errors are typed
`AuthorizationPersistenceError`s. `duplicateInvocationRisk` is true when a
provider may already have completed or an existing reservation makes replay
ambiguous. Capacity exhaustion remains a content-free
`budget-exceeded` Dispatch receipt with authorization outcome `exhausted`.

When `requiredCapabilities` contains `structured-tools`, routing defaults to
native structured-output fidelity. Candidate evidence must declare
`structuredToolsFidelity: "native"`; missing or contradictory fidelity fails
closed. A host may explicitly set `minimumStructuredToolsFidelity: "prompted"`
to admit a runtime that produces schema-shaped output through prompting rather
than native enforcement. Attempt receipts record the selected fidelity.

## Optional Datum binding

The `/datum` entrypoint maps Datum's non-materializing `resolveRef()` output to
a candidate plus host-facing runtime target. It accepts auth references and
availability only—never credential values—and does not create or invoke a model
runtime.

```ts
import { resolveRef } from "@kontourai/datum";
import { bindDatumResolvedRef } from "@kontourai/dispatch/datum";

const binding = bindDatumResolvedRef("structured-worker", resolveRef("structured-worker"));
```

## Credential-free CLI

Use fixture runtimes or Relay replay records to test complete routing and receipt
behavior without a provider account:

```bash
dispatch fixture --plan plan.json --fixtures fixtures.json
dispatch replay --plan plan.json --records records.json
```

The CLI emits `dispatch.cli.result/v1` JSON and exits `2` for a valid run with a
non-success terminal outcome. Live runtime construction remains an application
responsibility rather than a hidden CLI configuration path.
Credential-free authorization fixtures may add
`--authorization-root <application-owned-private-directory>`.

## Optional capability evidence

`withCapabilityEvidence()` accepts any evidence source and enriches candidates
that do not already carry explicit evidence. The optional `/bearing` entrypoint
projects a Bearing ranked candidate into Dispatch's smaller `confirmed`,
`declared`, or `unavailable` routing input. Bearing remains the authority for the
underlying observations; Dispatch only consumes the projection.

## Relay runtime facade

`createDispatchRuntime()` exposes a configured Dispatch policy as a Relay
`ModelRuntime`. Domain libraries can depend only on Relay while their host opts
into Dispatch routing and receives each terminal receipt through `onReceipt`.
This is the composition path for workflow hosts and domain adapters; it does not
move their prompts, schemas, or interpretation into Dispatch.

When the facade declares Relay's `physicalBatch` capability with a positive
`maxBatchSize`, `invokeBatch()` resolves every item plan in input order and
requires one common primary runtime that exposes a real provider-native batch
operation. Dispatch reserves durable worst-case capacity for every item that
will launch before making the one physical call. Capacity-exhausted items remain
positional failures and are excluded from that call. Successful siblings settle
independently; failed items retain their conservative reservation and may
continue through the remaining explicit fallback candidates as single
invocations. Receipts preserve the physical primary attempt plus any later
fallback attempt without storing request content. Every launched item records
the same content-free physical operation id plus its native item index and
count, while retaining its own request digest and authorization identity.

The facade strips inconsistent batch declarations and omits `invokeBatch()`.
Concurrent `invoke()` calls, wrappers that do not preserve the native method,
and heterogeneous primary runtimes are never described as physical batching.
One batch has one cancellation signal. A complete native-operation failure is
projected to every launched item before ordinary item-local fallback policy is
evaluated.

Framework hosts using the AI SDK v3 model contract can compose their provider
models through the optional `/ai-sdk` entrypoint:

```ts
import { createAiSdkDispatchModel } from "@kontourai/dispatch/ai-sdk";

const model = createAiSdkDispatchModel({
  id: "dispatch:host",
  capabilities: { structuredTools: true, streaming: false, abort: true, usage: true },
  models: { primary, fallback },
  plan,
  onReceipt,
});
```

The host still owns candidate configuration and receipt persistence. Relay
v0.2 buffers this model's compatibility stream; it is not live token streaming.

### Receipt delivery failures

`onReceipt` runs only after Dispatch has reached a terminal model outcome. Its
failure is therefore not an invocation failure. The default fail-closed policy
throws a non-retryable `ReceiptDeliveryError` containing the terminal receipt
and, after success, the already-produced model result. Its
`duplicateInvocationRisk` flag is `true` in that case so framework hosts do not
blindly repeat a paid invocation.

Hosts that can tolerate delayed receipt persistence may set
`receiptDeliveryFailureMode: "best-effort"` and observe the same typed error via
`onReceiptDeliveryFailure`. This returns a successful model result—or preserves
the original terminal Dispatch failure—without allowing receipt loss to become
invisible. Callback error text is never copied into the portable error or
receipt.
