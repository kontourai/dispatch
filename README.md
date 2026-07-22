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
