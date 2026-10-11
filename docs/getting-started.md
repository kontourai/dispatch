# Getting started

Dispatch takes an execution plan and a registry of model runtimes, tries the
plan's candidates in order under its budget, and returns either a model result
or a terminal failure. Both come with a receipt. This page installs the
package, runs a plan through the credential-free CLI, and then makes the same
call from code.

## Requirements

- Node.js 22 or newer (`engines.node` is `>=22`).
- The package is ESM only (`"type": "module"`).

## Install

```sh
npm install @kontourai/dispatch
```

Dispatch depends on [`@kontourai/relay`](https://github.com/kontourai/relay),
which defines the model runtime contract (`ModelRuntime`) and the request and
result types. Install Relay directly as well if your code imports it, for
example to construct a provider runtime.

The Datum, Bearing, and AI SDK integrations are optional peer dependencies.
Install them only if you import the matching entrypoint:

| Entrypoint | Peer dependency |
| --- | --- |
| `@kontourai/dispatch/datum` | `@kontourai/datum` `^0.7.0 \|\| ^0.8.0` |
| `@kontourai/dispatch/bearing` | `@kontourai/bearing` `^0.2.0` |
| `@kontourai/dispatch/ai-sdk` | `@ai-sdk/provider` `>=3.0.0` |

## Run a plan without credentials

The `dispatch` CLI runs a plan against fixture runtimes or recorded Relay
results, so you can see routing, fallback, and receipts without a provider
account.

Write a plan with two candidates. Each candidate names the runtime it runs on
through `runtimeId`.

```json
{
  "schemaVersion": 1,
  "role": "structured-worker",
  "request": { "messages": [{ "role": "user", "content": "Summarize the ticket." }] },
  "candidates": [
    { "id": "primary", "runtimeId": "primary-runtime" },
    { "id": "fallback", "runtimeId": "fallback-runtime" }
  ],
  "budget": { "maxAttempts": 2, "maxTotalTokens": 2000 }
}
```

Write a fixtures file that queues one outcome per runtime. The primary runtime
fails with a retryable error and the fallback succeeds:

```json
{
  "runtimes": {
    "primary-runtime": [
      { "code": "RATE_LIMITED", "message": "Fixture rate limit", "retryable": true }
    ],
    "fallback-runtime": [
      {
        "provider": "fixture",
        "model": "fixture-model",
        "outputText": "ok",
        "toolCalls": [],
        "usage": { "inputTokens": 12, "outputTokens": 3 },
        "latencyMs": 0
      }
    ]
  }
}
```

Run it:

```sh
npx dispatch fixture --plan plan.json --fixtures fixtures.json
```

The output is a `dispatch.cli.result/v1` JSON document holding the model
`result` and the `receipt`. The receipt's `outcome` is `succeeded`, and its
`attempts` list both tries: the failed `primary` attempt with
`errorCode: "RATE_LIMITED"` and `retryable: true`, then the successful
`fallback` attempt with its token counts. `totalTokens` is `15`, the sum of
the measured attempts.

Change the primary failure to `"retryable": false` and run it again. Dispatch
stops after the first attempt, the receipt's `outcome` is `exhausted`, and the
CLI exits `2`. A non-retryable failure ends the run unless the plan sets
`policy.retryRuntimeFailures`.

The [reference](reference.md#cli) lists every CLI option and exit code.

## Call Dispatch from code

`dispatch(plan, runtimes, options?)` is the same operation as the CLI. The
second argument is a `RuntimeRegistry`, any object with a
`get(runtimeId)` method that returns a Relay `ModelRuntime` or `undefined`.
This example uses Relay's Anthropic-compatible runtime:

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

if ("result" in outcome) {
  console.log(outcome.result.outputText);
}
console.log(outcome.receipt);
```

`dispatch()` resolves to a result and a receipt when the outcome is
`succeeded`, and to a receipt alone for every other outcome. It does not throw
for provider failures; it records them as attempts. It throws a `TypeError`
for an invalid plan, and an `AuthorizationPersistenceError` when a durable
authorization cannot be recorded safely.

Your application builds the runtimes and resolves credentials. Dispatch never
reads configuration or credentials itself.

## Next steps

- [Concepts](concepts.md) explains plans, candidates, eligibility, budgets,
  and receipts, and how one run proceeds.
- [Durable authorization](guides/durable-authorization.md) shows how to share
  a hard ceiling across concurrent calls and process restarts.
- [Reference](reference.md) lists every entrypoint, type, and CLI option.
