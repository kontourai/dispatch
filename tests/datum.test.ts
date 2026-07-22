import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindDatumResolvedRef } from "../src/datum.js";

describe("Datum binding", () => {
  it("maps a non-materialized reference without credential values", () => {
    const binding = bindDatumResolvedRef("extractor", {
      provider: "compatible", kind: "anthropic-compatible", model: "model-1",
      baseUrl: "https://models.example.test",
      auth: { kind: "env", ref: "MODEL_API_KEY", envVar: "MODEL_API_KEY", available: true },
      apiKeyEnv: "MODEL_API_KEY", apiKeySet: true,
    }, { evidence: { level: "declared", capabilities: ["tools"] } });
    assert.equal(binding.candidate.id, "extractor");
    assert.match(binding.candidate.runtimeId, /^datum:compatible:model-1:[a-f0-9]{12}$/);
    assert.equal(binding.target.auth.ref, "MODEL_API_KEY");
    assert.doesNotMatch(JSON.stringify(binding), /apiKey\":|secret-value/);
  });

  it("does not expose the endpoint in the receipt identity", () => {
    const binding = bindDatumResolvedRef("worker", {
      provider: "local", kind: "openai-compatible", model: "m",
      baseUrl: "http://private-host.example.test/v1",
      auth: { kind: "env", ref: "LOCAL_KEY", available: true }, apiKeySet: true,
    });
    assert.doesNotMatch(binding.candidate.runtimeId, /private-host/);
  });
});
