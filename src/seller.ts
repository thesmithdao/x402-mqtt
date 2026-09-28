import { EventEmitter } from "node:events";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import type { Ledger, LedgerEntry } from "./ledger.js";
import { PAYMENT_KEY, PAYMENT_RESPONSE_KEY, parseAsk, type Catalog, type Offer, type Reading, type Reply } from "./spec.js";

export type SellerOptions = {
  offers: Offer[];
  payTo: Address;
  network: Network;
  facilitator: FacilitatorClient;
  ledger: Ledger;
  readings: (topic: string) => Reading | undefined;
  resourceBase: string;
  maxAgeMs?: number;
  rpcUrl?: string;
  rateLimitPerMinute?: number;
  quotesPerMinute?: number;
  paymentsPerMinute?: number;
  maxRequesters?: number;
};

type Bucket = { tokens: number; at: number };

export type Handled = { replyTo: string; reply: Reply };

const usdcAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

type Authorization = { from: Address; to: Address; value: string; nonce: Hex };

function authorizationOf(payment: PaymentPayload): Authorization | undefined {
  const authorization = (payment.payload as { authorization?: Partial<Authorization> } | undefined)?.authorization;
  if (!authorization?.from || !authorization.nonce || !authorization.value || !authorization.to) return undefined;
  return authorization as Authorization;
}

export class Seller extends EventEmitter {
  private server: x402ResourceServer;
  private requirements = new Map<string, PaymentRequirements[]>();
  private inflight = new Set<string>();
  private buckets = new Map<string, Bucket>();
  private quotes: Bucket = { tokens: 0, at: 0 };
  private payments: Bucket = { tokens: 0, at: 0 };
  private chain;

  constructor(private readonly options: SellerOptions) {
    super();
    this.server = new x402ResourceServer(options.facilitator).register(options.network, new ExactEvmScheme());
    this.chain = createPublicClient({ chain: base, transport: http(options.rpcUrl) });
  }

  async start(): Promise<void> {
    await this.server.initialize();
    for (const offer of this.options.offers) {
      const accepts = await this.server.buildPaymentRequirements({
        scheme: "exact",
        payTo: this.options.payTo,
        price: `$${offer.price}`,
        network: this.options.network,
        maxTimeoutSeconds: 120,
      });
      this.requirements.set(offer.topic, accepts);
    }
    await this.recover();
  }

  catalog(): Catalog {
    return {
      x402Version: 2,
      updatedAt: new Date().toISOString(),
      offers: this.options.offers.map(offer => ({
        topic: offer.topic,
        description: offer.description,
        unit: offer.unit,
        accepts: this.requirements.get(offer.topic) ?? [],
      })),
    };
  }

  async handle(topic: string, payload: Buffer): Promise<Handled | undefined> {
    const ask = parseAsk(payload);
    if (!ask) return undefined;
    const reply = (status: number, extra: Partial<Reply> = {}): Handled => ({ replyTo: ask.replyTo, reply: { id: ask.id, status, ...extra } });
    const accepts = this.requirements.get(topic);
    if (!accepts) return reply(404, { error: "nothing for sale on this topic" });
    if (!this.allow(ask.replyTo)) return reply(429, { error: "too many requests" });

    const payment = ask[PAYMENT_KEY];
    const offer = this.options.offers.find(item => item.topic === topic);
    if (!payment) {
      if (!this.take(this.quotes, this.options.quotesPerMinute ?? 600)) return reply(429, { error: "too many requests" });
      const paymentRequired = await this.server.createPaymentRequiredResponse(accepts, {
        url: `${this.options.resourceBase}/${topic}`,
        description: offer?.description ?? topic,
        mimeType: "application/json",
      });
      return reply(402, { paymentRequired });
    }

    if (!this.take(this.payments, this.options.paymentsPerMinute ?? 120)) return reply(429, { error: "too many requests, not charged" });
    const authorization = authorizationOf(payment);
    if (!authorization) return reply(400, { error: "unsupported payment payload" });
    const key = `${this.options.network}:${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`;
    const settled = this.options.ledger.settledFor(key);
    if (settled) {
      if (settled.id !== ask.id) return reply(409, { error: "payment already used" });
      return reply(200, { result: settled.reading, [PAYMENT_RESPONSE_KEY]: settled.settlement });
    }
    if (this.inflight.has(key)) return reply(409, { error: "payment already in progress" });

    this.inflight.add(key);
    const started = performance.now();
    const base = { id: ask.id, topic, key, payer: authorization.from, amount: authorization.value, network: this.options.network };
    try {
      const matched = this.server.findMatchingRequirements(accepts, payment);
      if (!matched) {
        this.record({ ...base, state: "rejected", error: "payment does not match the quote" });
        return reply(400, { error: "payment does not match the quote" });
      }

      let verified;
      try {
        verified = await this.server.verifyPayment(payment, matched);
      } catch {
        this.record({ ...base, state: "refused", error: "facilitator unavailable, not charged" });
        return reply(503, { error: "facilitator unavailable, not charged" });
      }
      if (!verified.isValid) {
        const error = verified.invalidReason ?? "invalid payment";
        this.record({ ...base, state: "rejected", error });
        return reply(400, { error });
      }

      const reading = this.options.readings(topic);
      const maxAgeMs = this.options.maxAgeMs ?? 30_000;
      if (!reading || Date.now() - reading.ts > maxAgeMs) {
        this.record({ ...base, state: "refused", error: "device offline, not charged" });
        return reply(503, { error: "device offline, not charged" });
      }

      this.options.ledger.append({ ...base, state: "verified", reading });
      let settlement: SettleResponse | undefined;
      try {
        settlement = await this.server.settlePayment(payment, matched);
      } catch {
        settlement = await this.settledOnChain(authorization);
      }
      if (!settlement?.success) {
        this.record({ ...base, state: "failed", error: "settlement failed, not charged" });
        return reply(503, { error: "settlement failed, not charged" });
      }

      this.record({ ...base, state: "settled", tx: settlement.transaction, reading, settlement, latencyMs: Math.round(performance.now() - started) });
      return reply(200, { result: reading, [PAYMENT_RESPONSE_KEY]: settlement });
    } finally {
      this.inflight.delete(key);
    }
  }

  private record(entry: Omit<LedgerEntry, "ts">): void {
    this.emit("entry", this.options.ledger.append(entry));
  }

  private allow(replyTo: string): boolean {
    const client = replyTo.split("/")[3] ?? replyTo;
    const limit = this.options.rateLimitPerMinute ?? 60;
    const max = this.options.maxRequesters ?? 10_000;
    const now = Date.now();
    let bucket = this.buckets.get(client);
    if (!bucket) {
      if (this.buckets.size >= max) {
        for (const [id, idle] of this.buckets) if (now - idle.at >= 60_000) this.buckets.delete(id);
      }
      if (this.buckets.size >= max) return false;
      bucket = { tokens: limit, at: now };
      this.buckets.set(client, bucket);
    }
    return this.take(bucket, limit, now);
  }

  private take(bucket: Bucket, limit: number, now = Date.now()): boolean {
    bucket.tokens = bucket.at ? Math.min(limit, bucket.tokens + ((now - bucket.at) / 60_000) * limit) : limit;
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private async settledOnChain(authorization: Authorization): Promise<SettleResponse | undefined> {
    const accepts = [...this.requirements.values()][0];
    const asset = accepts?.[0]?.asset as Address | undefined;
    if (!asset) return undefined;
    try {
      const used = await this.chain.readContract({ address: asset, abi: usdcAbi, functionName: "authorizationState", args: [authorization.from, authorization.nonce] });
      if (!used) return undefined;
      const latest = await this.chain.getBlockNumber();
      const logs = await this.chain.getLogs({
        address: asset,
        event: usdcAbi[1],
        args: { authorizer: authorization.from, nonce: authorization.nonce },
        fromBlock: latest > 2000n ? latest - 2000n : 0n,
        toBlock: latest,
      });
      const transaction = logs.at(-1)?.transactionHash ?? "";
      return { success: true, transaction, network: this.options.network, payer: authorization.from };
    } catch {
      return undefined;
    }
  }

  private async recover(): Promise<void> {
    for (const entry of this.options.ledger.pending()) {
      if (!entry.key || !entry.payer) continue;
      const nonce = entry.key.split(":").at(-1) as Hex;
      const settlement = await this.settledOnChain({ from: entry.payer as Address, to: this.options.payTo, value: entry.amount ?? "0", nonce });
      if (settlement?.success) {
        this.record({ id: entry.id, topic: entry.topic, key: entry.key, payer: entry.payer, amount: entry.amount, network: entry.network, state: "recovered", tx: settlement.transaction, reading: entry.reading, settlement });
      }
    }
  }
}
