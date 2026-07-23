# Dispatch

Dispatch turns an explicit execution policy and a set of candidate model
runtimes into an invocation outcome with a portable receipt.

## Language

**Execution Plan**: Immutable input describing the role, candidates,
constraints, budgets, and fallback policy for one run.

**Candidate**: A secret-free runtime target identity plus the capabilities and
limits relevant to routing.

**Attempt**: One bounded invocation of a selected candidate.

**Dispatch Receipt**: Schema-versioned record of the plan digest, routing
decisions, attempt outcomes, usage, latency, and terminal outcome.

**Execution Authorization**: Caller-issued, content-free capacity shared across
multiple Dispatch invocations. Each provider attempt reserves caller-declared
worst-case capacity before launch.

**Authorization Reservation**: Durable attempt, token, and cost capacity held
until measured usage is settled or an explicit reconciliation releases it.

## Boundaries

- Hosts own configuration sources and credential resolution.
- Capability sources own their evidence and confidence semantics.
- Model runtimes own provider/framework invocation mechanics.
- Dispatch owns deterministic policy evaluation and execution receipts.
- Dispatch owns authorization reservation mechanics, not who may issue or
  reconcile an authorization.
- Domain applications own prompts, tools, schemas, and interpretation.
