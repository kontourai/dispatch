# Dispatch Agent Guidance

Dispatch is a provider-neutral policy and execution layer.

- Keep all policy explicit in execution-plan inputs.
- Never place credential values in plans, candidates, receipts, logs, or tests.
- Keep configuration, capability evidence, and runtime implementations behind
  narrow ports with deterministic fakes.
- Every retry, fallback, and budget decision must be receipt-visible.
- Do not add domain prompt or response-interpretation semantics.
- Run `npm run verify` before pushing.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
