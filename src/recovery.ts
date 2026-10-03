import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { isValidId, isValidTopic, MAX_MESSAGE_BYTES } from "./spec.js";

export type PurchaseRequest = {
  version: 1;
  id: string;
  topic: string;
  broker: string;
  payer: string;
  accepted: PaymentRequirements;
  authorization?: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  solana?: { message: string; slot: number; lastValidBlockHeight?: number };
};

export function brokerIdentity(url: string): string {
  return createHash("sha256").update(publicBrokerUrl(url)).digest("hex");
}

export function publicBrokerUrl(url: string): string {
  const broker = new URL(url);
  broker.username = "";
  broker.password = "";
  broker.search = "";
  broker.hash = "";
  return broker.toString();
}

export function validateRequest(value: unknown): asserts value is PurchaseRequest {
  if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > MAX_MESSAGE_BYTES) throw new Error("invalid purchase record");
  const request = value as PurchaseRequest;
  if (request.version !== 1 || !isValidId(request.id) || typeof request.topic !== "string" || !isValidTopic(request.topic) || !/^[a-f0-9]{64}$/.test(request.broker) || typeof request.payer !== "string" || !request.accepted || request.accepted.scheme !== "exact") throw new Error("invalid purchase record");
  if (Object.keys(request).some(key => !["version", "id", "topic", "broker", "payer", "accepted", "authorization", "solana"].includes(key))) throw new Error("invalid purchase record");
  if (Object.keys(request.accepted).some(key => !["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"].includes(key)) || (request.accepted.extra && Object.keys(request.accepted.extra).some(key => !["feePayer", "name", "version"].includes(key)))) throw new Error("invalid purchase record");
  if (request.solana) {
    if (request.authorization || Object.keys(request.solana).some(key => !["message", "slot", "lastValidBlockHeight"].includes(key)) || typeof request.solana.message !== "string" || !Number.isSafeInteger(request.solana.slot) || request.solana.slot < 0 || (request.solana.lastValidBlockHeight !== undefined && (!Number.isSafeInteger(request.solana.lastValidBlockHeight) || request.solana.lastValidBlockHeight < 0))) throw new Error("invalid purchase record");
  } else {
    const auth = request.authorization;
    if (!auth || Object.keys(auth).some(key => !["from", "to", "value", "validAfter", "validBefore", "nonce"].includes(key)) || ![auth.from, auth.to].every(address => typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)) || typeof auth.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce) || ![auth.value, auth.validAfter, auth.validBefore].every(amount => typeof amount === "string" && /^\d{1,78}$/.test(amount))) throw new Error("invalid purchase record");
  }
}

export class PurchaseStore {
  private prefix: string;
  private context: { broker: string; network: Network; payer: string; topic: string };

  constructor(readonly directory: string, url: string, network: Network, payer: string, topic: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("purchase directory must be private and owned by you");
    this.prefix = createHash("sha256").update(JSON.stringify([brokerIdentity(url), network, payer, topic])).digest("hex");
    this.context = { broker: brokerIdentity(url), network, payer, topic };
  }

  load(): PurchaseRequest | undefined {
    const file = readdirSync(this.directory).filter(name => name.startsWith(`${this.prefix}-`) && name.endsWith(".json")).sort()[0];
    if (!file) return undefined;
    const fd = openSync(join(this.directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_MESSAGE_BYTES) throw new Error();
      const request: unknown = JSON.parse(readFileSync(fd, "utf8"));
      validateRequest(request);
      this.checkContext(request);
      if (file !== this.filename(request.id)) throw new Error();
      return request;
    } catch {
      throw new Error("purchase record is invalid; preserve it for reconciliation");
    } finally { closeSync(fd); }
  }

  save(request: PurchaseRequest): void {
    validateRequest(request);
    this.checkContext(request);
    const fd = openSync(join(this.directory, this.filename(request.id)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(request)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.sync();
  }

  remove(request: PurchaseRequest): void {
    try { unlinkSync(join(this.directory, this.filename(request.id))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.sync();
  }

  private filename(id: string): string {
    if (!isValidId(id)) throw new Error("invalid request ID");
    return `${this.prefix}-${id}.json`;
  }

  private checkContext(request: PurchaseRequest): void {
    if (request.broker !== this.context.broker || request.accepted.network !== this.context.network || request.payer !== this.context.payer || request.topic !== this.context.topic) throw new Error("purchase record belongs to another context");
  }

  private sync(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
