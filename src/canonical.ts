import { createHash } from "node:crypto";
import { canonicalJson, invocationDigest } from "@kontourai/relay";
import type { ExecutionPlan } from "./types.js";

export { invocationDigest };

export function executionPlanDigest(plan: ExecutionPlan): string {
  const secretFreePlan = {
    schemaVersion: plan.schemaVersion,
    role: plan.role,
    requestDigest: invocationDigest(plan.request),
    candidates: plan.candidates,
    budget: plan.budget,
    policy: plan.policy,
    authorization: plan.authorization,
  };
  return createHash("sha256").update(`dispatch:execution-plan:v1\0${canonicalJson(secretFreePlan)}`).digest("hex");
}
