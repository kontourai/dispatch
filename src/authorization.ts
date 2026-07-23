import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  AuthorizationLedger,
  AuthorizationRelease,
  AuthorizationReservation,
  AuthorizationSettlement,
  ExecutionAuthorization,
} from "./types.js";

const MAX_LEDGER_BYTES = 1_048_576;
const MAX_RECORDS = 8_192;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

interface StoredReservation {
  invocationId: string;
  state: "reserved" | "settled" | "released";
  capacity: AuthorizationReservation["capacity"];
  usage?: AuthorizationSettlement["usage"];
  reservedAt: string;
  settledAt?: string;
  releasedAt?: string;
  releaseReason?: AuthorizationRelease["reason"];
}

interface StoredLedger {
  schemaVersion: 1;
  authorizationId: string;
  limits: ExecutionAuthorization["limits"];
  reservations: Record<string, StoredReservation>;
}

interface PersistedLedger extends StoredLedger {
  integrity: {
    algorithm: "sha256";
    digest: string;
  };
}

export class AuthorizationExhaustedError extends Error {
  readonly code = "AUTHORIZATION_EXHAUSTED";
  constructor(readonly authorizationId: string) {
    super("Authorization capacity is exhausted");
    this.name = "AuthorizationExhaustedError";
  }
}

export class AuthorizationPersistenceError extends Error {
  readonly code = "AUTHORIZATION_PERSISTENCE_FAILED";
  readonly duplicateInvocationRisk: boolean;
  constructor(
    message = "Authorization ledger persistence failed",
    _cause?: unknown,
    readonly phase: "reserve" | "settle" | "recovery" = "reserve",
  ) {
    super(message);
    this.name = "AuthorizationPersistenceError";
    this.duplicateInvocationRisk = phase === "settle" || phase === "recovery";
  }
}

export interface FileAuthorizationLedgerOptions {
  root: string;
  now?: () => Date;
  lockTimeoutMs?: number;
}

export class FileAuthorizationLedger implements AuthorizationLedger {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #lockTimeoutMs: number;

  constructor(options: FileAuthorizationLedgerOptions) {
    this.#root = resolve(options.root);
    this.#now = options.now ?? (() => new Date());
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    ensurePrivateDirectory(this.#root);
  }

  async reserve(input: AuthorizationReservation): Promise<{
    status: "reserved" | "already-reserved" | "already-settled" | "already-released";
  }> {
    validateReservation(input);
    let status: "reserved" | "already-reserved" | "already-settled" | "already-released" = "reserved";
    await this.#mutate(input.authorizationId, (current) => {
      const ledger = current ?? {
        schemaVersion: 1 as const,
        authorizationId: input.authorizationId,
        limits: { ...input.limits },
        reservations: {},
      };
      if (!sameLimits(ledger.limits, input.limits)) {
        throw new AuthorizationPersistenceError("Authorization limits changed for an existing ledger");
      }
      const existing = ledger.reservations[input.reservationId];
      if (existing) {
        if (existing.invocationId === input.invocationId
          && JSON.stringify(existing.capacity) === JSON.stringify(input.capacity)) {
          status = existing.state === "settled"
            ? "already-settled"
            : existing.state === "released" ? "already-released" : "already-reserved";
          return ledger;
        }
        throw new AuthorizationPersistenceError("Reservation id was reused with different capacity");
      }
      if (Object.keys(ledger.reservations).length >= MAX_RECORDS) {
        throw new AuthorizationPersistenceError("Authorization ledger record limit reached");
      }
      assertCapacity(ledger, input.capacity);
      ledger.reservations[input.reservationId] = {
        invocationId: input.invocationId,
        state: "reserved",
        capacity: { ...input.capacity },
        reservedAt: this.#now().toISOString(),
      };
      return ledger;
    });
    return { status };
  }

  async settle(input: AuthorizationSettlement): Promise<void> {
    validateSettlement(input);
    await this.#mutate(input.authorizationId, (ledger) => {
      if (!ledger) throw new AuthorizationPersistenceError("Authorization ledger does not exist");
      const reservation = ledger.reservations[input.reservationId];
      if (!reservation) throw new AuthorizationPersistenceError("Authorization reservation does not exist");
      if (reservation.state === "released") throw new AuthorizationPersistenceError("Released authorization reservation cannot be settled");
      if (reservation.state === "settled") {
        if (JSON.stringify(reservation.usage) === JSON.stringify(input.usage)) return ledger;
        throw new AuthorizationPersistenceError("Authorization reservation was settled with different usage");
      }
      if ((reservation.capacity.maxTokens !== undefined && input.usage.totalTokens > reservation.capacity.maxTokens)
        || (reservation.capacity.maxCostUsd !== undefined && input.usage.costUsd > reservation.capacity.maxCostUsd)) {
        throw new AuthorizationPersistenceError("Measured usage exceeded its reserved worst-case capacity");
      }
      reservation.state = "settled";
      reservation.usage = { ...input.usage };
      reservation.settledAt = this.#now().toISOString();
      return ledger;
    });
  }

  async release(input: AuthorizationRelease): Promise<void> {
    validateRelease(input);
    await this.#mutate(input.authorizationId, (ledger) => {
      if (!ledger) throw new AuthorizationPersistenceError("Authorization ledger does not exist");
      const reservation = ledger.reservations[input.reservationId];
      if (!reservation) throw new AuthorizationPersistenceError("Authorization reservation does not exist");
      if (reservation.state === "settled") throw new AuthorizationPersistenceError("Settled authorization reservation cannot be released");
      if (reservation.state === "released") {
        if (reservation.releaseReason === input.reason) return ledger;
        throw new AuthorizationPersistenceError("Authorization reservation was released with a different reason");
      }
      reservation.state = "released";
      reservation.releaseReason = input.reason;
      reservation.releasedAt = this.#now().toISOString();
      return ledger;
    });
  }

  async #mutate(authorizationId: string, mutation: (ledger: StoredLedger | undefined) => StoredLedger): Promise<void> {
    const digest = createHash("sha256").update(authorizationId).digest("hex");
    const file = join(this.#root, `${digest}.json`);
    const lock = join(this.#root, `${digest}.lock`);
    const release = await acquireLock(lock, this.#lockTimeoutMs);
    try {
      const next = mutation(readLedger(file, authorizationId));
      writeLedger(file, next);
    } catch (error) {
      if (error instanceof AuthorizationExhaustedError || error instanceof AuthorizationPersistenceError) throw error;
      throw new AuthorizationPersistenceError(undefined, error);
    } finally {
      release();
    }
  }
}

function assertCapacity(ledger: StoredLedger, requested: AuthorizationReservation["capacity"]): void {
  let attempts = 0;
  let tokens = 0;
  let cost = 0;
  for (const reservation of Object.values(ledger.reservations)) {
    if (reservation.state === "released") continue;
    attempts += reservation.state === "settled" ? reservation.usage!.attempts : reservation.capacity.attempts;
    tokens += reservation.state === "settled" ? reservation.usage!.totalTokens : reservation.capacity.maxTokens ?? 0;
    cost += reservation.state === "settled" ? reservation.usage!.costUsd : reservation.capacity.maxCostUsd ?? 0;
  }
  if (attempts + requested.attempts > ledger.limits.maxAttempts
    || (ledger.limits.maxTotalTokens !== undefined && tokens + (requested.maxTokens ?? 0) > ledger.limits.maxTotalTokens)
    || (ledger.limits.maxCostUsd !== undefined && cost + (requested.maxCostUsd ?? 0) > ledger.limits.maxCostUsd)) {
    throw new AuthorizationExhaustedError(ledger.authorizationId);
  }
}

async function acquireLock(file: string, timeoutMs: number): Promise<() => void> {
  const started = Date.now();
  while (true) {
    try {
      const descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const identity = fstatSync(descriptor);
      try {
        writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
        fdatasyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return () => {
        try {
          const current = lstatSync(file);
          if (current.dev === identity.dev && current.ino === identity.ino) rmSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AuthorizationPersistenceError(undefined, error);
      if (Date.now() - started >= timeoutMs) throw new AuthorizationPersistenceError("Authorization ledger lock timed out");
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

function readLedger(file: string, expectedId: string): StoredLedger | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readBoundedFile(file, MAX_LEDGER_BYTES)) as PersistedLedger;
    const { integrity, ...ledger } = parsed;
    if (!integrity || integrity.algorithm !== "sha256" || integrity.digest !== ledgerDigest(ledger)
      || ledger.schemaVersion !== 1 || ledger.authorizationId !== expectedId
      || !ledger.reservations || typeof ledger.reservations !== "object" || Array.isArray(ledger.reservations)) {
      throw new Error("invalid ledger");
    }
    validateLimits(ledger.limits);
    for (const [id, reservation] of Object.entries(ledger.reservations)) {
      validateId(id, "reservation id");
      if (!reservation || !["reserved", "settled", "released"].includes(reservation.state)) throw new Error("invalid reservation");
      validateId(reservation.invocationId, "invocation id");
      validateCapacity(reservation.capacity, ledger.limits);
      if (reservation.state === "settled") validateUsage(reservation.usage);
      if (reservation.state === "released"
        && !["confirmed-not-launched", "provider-reconciled", "operator-reconciled"].includes(String(reservation.releaseReason))) {
        throw new Error("invalid released reservation");
      }
    }
    return ledger;
  } catch (error) {
    throw new AuthorizationPersistenceError("Authorization ledger is malformed or tampered", error);
  }
}

function writeLedger(file: string, ledger: StoredLedger): void {
  const persisted: PersistedLedger = {
    ...ledger,
    integrity: { algorithm: "sha256", digest: ledgerDigest(ledger) },
  };
  const bytes = `${JSON.stringify(persisted, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_LEDGER_BYTES) throw new AuthorizationPersistenceError("Authorization ledger exceeds its size bound");
  const temporary = join(dirname(file), `.${createHash("sha256").update(file).digest("hex").slice(0, 16)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, bytes);
    fdatasyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const directory = openSync(dirname(file), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new AuthorizationPersistenceError(undefined, error);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ledgerDigest(ledger: StoredLedger): string {
  return createHash("sha256").update(`dispatch:authorization-ledger:v1\0${canonicalJson(ledger)}`).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readBoundedFile(file: string, maxBytes: number): string {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("file is not a bounded regular file");
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function ensurePrivateDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AuthorizationPersistenceError("Authorization ledger root must be a real directory");
  chmodSync(root, 0o700);
}

function validateReservation(input: AuthorizationReservation): void {
  validateId(input.authorizationId, "authorization id");
  validateId(input.invocationId, "invocation id");
  validateId(input.reservationId, "reservation id");
  validateLimits(input.limits);
  validateCapacity(input.capacity, input.limits);
}

function validateSettlement(input: AuthorizationSettlement): void {
  validateId(input.authorizationId, "authorization id");
  validateId(input.reservationId, "reservation id");
  validateUsage(input.usage);
}

function validateRelease(input: AuthorizationRelease): void {
  validateId(input.authorizationId, "authorization id");
  validateId(input.reservationId, "reservation id");
  if (!["confirmed-not-launched", "provider-reconciled", "operator-reconciled"].includes(input.reason)) {
    throw new TypeError("Invalid authorization release reason");
  }
}

function validateLimits(limits: ExecutionAuthorization["limits"]): void {
  positiveInteger(limits.maxAttempts, "maxAttempts");
  if (limits.maxTotalTokens !== undefined) positiveInteger(limits.maxTotalTokens, "maxTotalTokens");
  if (limits.maxCostUsd !== undefined) positiveNumber(limits.maxCostUsd, "maxCostUsd");
}

function validateCapacity(capacity: AuthorizationReservation["capacity"], limits: ExecutionAuthorization["limits"]): void {
  if (capacity.attempts !== 1) throw new TypeError("Reservation attempts must equal one");
  if (limits.maxTotalTokens !== undefined && capacity.maxTokens === undefined) throw new TypeError("Token-bounded authorization requires maxTokens reservations");
  if (limits.maxCostUsd !== undefined && capacity.maxCostUsd === undefined) throw new TypeError("Cost-bounded authorization requires maxCostUsd reservations");
  if (capacity.maxTokens !== undefined) positiveInteger(capacity.maxTokens, "maxTokens");
  if (capacity.maxCostUsd !== undefined) positiveNumber(capacity.maxCostUsd, "maxCostUsd");
}

function validateUsage(usage: AuthorizationSettlement["usage"] | undefined): asserts usage is AuthorizationSettlement["usage"] {
  if (!usage || usage.attempts !== 1 || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0
    || !Number.isFinite(usage.costUsd) || usage.costUsd < 0) throw new TypeError("Invalid authorization settlement usage");
}

function validateId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new TypeError(`Invalid ${label}`);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
}

function positiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be positive`);
}

function sameLimits(left: ExecutionAuthorization["limits"], right: ExecutionAuthorization["limits"]): boolean {
  return left.maxAttempts === right.maxAttempts
    && left.maxTotalTokens === right.maxTotalTokens
    && left.maxCostUsd === right.maxCostUsd;
}
