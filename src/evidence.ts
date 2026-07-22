import type { CapabilityEvidenceSource, ExecutionCandidate } from "./types.js";

/** Enrich candidates lacking explicit evidence without changing input order. */
export async function withCapabilityEvidence(candidates: readonly ExecutionCandidate[], source: CapabilityEvidenceSource): Promise<readonly ExecutionCandidate[]> {
  return Object.freeze(await Promise.all(candidates.map(async (candidate) => {
    if (candidate.evidence !== undefined) return candidate;
    const evidence = await source.evidenceFor(candidate);
    return evidence === undefined ? candidate : Object.freeze({ ...candidate, evidence });
  })));
}
