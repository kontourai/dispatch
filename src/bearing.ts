import type { RankedCandidate, RankedCandidateV2 } from "@kontourai/bearing";
import type { CapabilityEvidence } from "./types.js";

/** Project a Bearing-ranked candidate into Dispatch's minimal evidence input. */
export function capabilityEvidenceFromBearing(candidate: RankedCandidate | RankedCandidateV2, catalogDigest: string): CapabilityEvidence {
  const capabilities = candidate.reasons
    .filter((reason) => reason.code === "REQUIREMENT_MET")
    .map((reason) => reason.measurementKey)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  const evidenceKeys = new Set(candidate.evidence.filter((entry) => entry.evidenceIds.length > 0).map((entry) => entry.measurementKey));
  const confirmed = capabilities.length > 0 && capabilities.every((capability) => evidenceKeys.has(capability));
  return Object.freeze({
    level: confirmed ? "confirmed" : capabilities.length > 0 ? "declared" : "unavailable",
    capabilities: Object.freeze(capabilities),
    source: `bearing:catalog:${catalogDigest}`,
  });
}
