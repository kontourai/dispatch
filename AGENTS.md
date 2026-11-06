# Dispatch Agent Guidance

Dispatch is a provider-neutral policy and execution layer.

- Keep all policy explicit in execution-plan inputs.
- Never place credential values in plans, candidates, receipts, logs, or tests.
- Keep configuration, capability evidence, and runtime implementations behind
  narrow ports with deterministic fakes.
- Every retry, fallback, and budget decision must be receipt-visible.
- Do not add domain prompt or response-interpretation semantics.
- Install dependencies with `pnpm install`. The pnpm version is pinned in
  `package.json` (`packageManager`). Dependency install scripts are blocked by
  default; the only packages allowed to run one are listed under `allowBuilds`
  in `pnpm-workspace.yaml`, pinned by version.
- Run `npm run verify` before pushing. Scripts stay on `npm run …` — that only
  invokes `package.json` scripts and does not depend on which tool installed
  `node_modules`.
- Docs are published with Corpus: `corpus.json` lists the published docs
  and the MCP topics, and `npm run docs:check` is the gate. When you change
  code that a document `covers`, update that document.

## Source-qualified documentation review

The Corpus gate selects the canonical documents mapped in `corpus.json` when
implementation inputs change. Review those claims against the actual callers.
Update inaccurate prose in the same PR. If it remains accurate, record a new
local input/output byte review with a concrete explanation and limits in
`corpus-content.json`, following the [shared review contract](https://github.com/kontourai/corpus/blob/b127e35a818b532369843731b3c64792baade83e/docs/related-content.md#review-an-unchanged-covering-document).
`npm run docs:check -- --base origin/main` uses that same reviewed Corpus source.
Do not add filler text or refresh hashes without inspecting the change. A
passing check does not certify semantic correctness, runtime or publication.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `npx --no @kontourai/veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
