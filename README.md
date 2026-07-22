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
