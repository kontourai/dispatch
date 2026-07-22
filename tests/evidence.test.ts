import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityEvidenceFromBearing } from "../src/bearing.js";
import { withCapabilityEvidence } from "../src/index.js";

describe("capability evidence", () => {
  it("enriches only candidates without explicit evidence", async () => {
    const candidates = [
      { id: "explicit", runtimeId: "one", evidence: { level: "declared" as const, capabilities: ["tools"] } },
      { id: "lookup", runtimeId: "two" },
    ];
    const enriched = await withCapabilityEvidence(candidates, { async evidenceFor(candidate) {
      return { level: "confirmed", capabilities: [candidate.id], source: "fixture" };
    } });
    assert.equal(enriched[0], candidates[0]);
    assert.deepEqual(enriched[1]?.evidence, { level: "confirmed", capabilities: ["lookup"], source: "fixture" });
  });

  it("projects confirmed Bearing requirement evidence", () => {
    const evidence = capabilityEvidenceFromBearing({
      candidateId: "c", model: { id: "p/m", revision: null, quantization: null },
      execution: { runtime: { id: "api", version: null }, adapter: null, effectiveContextTokens: null, toolSurface: ["tools"], hardware: null, workflow: null },
      rank: 1, score: 1,
      reasons: [{ code: "REQUIREMENT_MET", measurementKey: "tools", summary: "met" }],
      evidence: [{ measurementKey: "tools", observationIds: ["o"], evidenceIds: ["e"] }],
      uncertainty: { level: "low", basis: ["fixture"], gaps: [] },
    }, "digest");
    assert.deepEqual(evidence, { level: "confirmed", capabilities: ["tools"], source: "bearing:catalog:digest" });
  });
});
