import { createHash } from "node:crypto";
import type { ProviderKind, ResolvedRef } from "@kontourai/datum";
import type { CapabilityEvidence, ExecutionCandidate } from "./types.js";

export interface DatumRuntimeTarget {
  runtimeId: string;
  provider: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  auth: {
    kind: ResolvedRef["auth"]["kind"];
    ref: string;
    available: boolean;
  };
}

export interface DatumCandidateBinding {
  candidate: ExecutionCandidate;
  target: DatumRuntimeTarget;
}

export interface DatumCandidateOptions {
  id?: string;
  runtimeId?: string;
  evidence?: CapabilityEvidence;
  estimatedUsdPer1kTokens?: number;
}

function derivedRuntimeId(resolved: ResolvedRef): string {
  const endpointDigest = createHash("sha256").update(resolved.baseUrl ?? "default").digest("hex").slice(0, 12);
  return `datum:${resolved.provider}:${resolved.model}:${endpointDigest}`;
}

/** Maps non-materializing Datum output. Credential values are never accepted. */
export function bindDatumResolvedRef(role: string, resolved: ResolvedRef, options: DatumCandidateOptions = {}): DatumCandidateBinding {
  if (!role) throw new TypeError("Datum role must not be empty");
  const runtimeId = options.runtimeId ?? derivedRuntimeId(resolved);
  const candidate: ExecutionCandidate = Object.freeze({
    id: options.id ?? role,
    runtimeId,
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.estimatedUsdPer1kTokens === undefined ? {} : { estimatedUsdPer1kTokens: options.estimatedUsdPer1kTokens }),
  });
  const target: DatumRuntimeTarget = Object.freeze({
    runtimeId,
    provider: resolved.provider,
    kind: resolved.kind,
    model: resolved.model,
    ...(resolved.baseUrl === undefined ? {} : { baseUrl: resolved.baseUrl }),
    auth: Object.freeze({ kind: resolved.auth.kind, ref: resolved.auth.ref, available: resolved.auth.available }),
  });
  return Object.freeze({ candidate, target });
}
