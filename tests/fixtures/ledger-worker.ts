import { FileAuthorizationLedger } from "../../src/authorization.js";

const [root, authorizationId, invocationId] = process.argv.slice(2);
if (!root || !authorizationId || !invocationId) process.exit(64);

const ledger = new FileAuthorizationLedger({ root });
try {
  await ledger.reserve({
    authorizationId,
    invocationId,
    reservationId: `reservation-${invocationId}`,
    limits: { maxAttempts: 2, maxTotalTokens: 20, maxCostUsd: 2 },
    capacity: { attempts: 1, maxTokens: 10, maxCostUsd: 1 },
  });
  process.stdout.write("reserved\n");
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  process.stdout.write(`${code}\n`);
}
