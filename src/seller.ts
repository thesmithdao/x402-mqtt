import { EventEmitter } from "node:events";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { SolanaChain, SOLANA_NETWORK, SOLANA_USDC, inspectSolana, solanaIdentity, validateSvmAddress, type SolanaPayment } from "./solana.js";
import { createPublicClient, http, parseAbi, parseEventLogs, verifyTypedData, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Ledger, LedgerEntry } from "./ledger.js";
import { PAYMENT_KEY, PAYMENT_RESPONSE_KEY, parseAsk, isReading, type Catalog, type Offer, type Reading, type Reply } from "./spec.js";
import { publicBrokerUrl } from "./recovery.js";

export type SellerOptions = {
  offers: Offer[];
  payTo: string;
  solanaPayout?: string;
  solanaRpcUrl?: string;
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
  payerPerMinute?: number;
  facilitatorPerMinute?: number;
  maxRequesters?: number;
};

type Bucket = { tokens: number; at: number };

export type Handled = { replyTo: string; reply: Reply };

const TRUSTED_MS = 60 * 60_000;

const usdcAbi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

type Authorization = { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };

function authorizationOf(payment: PaymentPayload): Authorization | undefined {
  const authorization = (payment.payload as { authorization?: Partial<Authorization> } | undefined)?.authorization;
  if (!authorization?.from || !authorization.nonce || !authorization.value || !authorization.to || !authorization.validAfter || !authorization.validBefore) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(authorization.from) || !/^0x[0-9a-fA-F]{40}$/.test(authorization.to) || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) return undefined;
  if (![authorization.value, authorization.validAfter, authorization.validBefore].every(value => /^\d{1,78}$/.test(value))) return undefined;
  return authorization as Authorization;
}

function fits(authorization: Authorization, matched: PaymentRequirements, recorded = false): boolean {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return authorization.to.toLowerCase() === matched.payTo.toLowerCase()
    && BigInt(authorization.value) === BigInt(matched.amount)
    && BigInt(authorization.validAfter) <= now
    && (recorded || BigInt(authorization.validBefore) > now + 6n);
}

export class Seller extends EventEmitter {
  private server: x402ResourceServer;
  private requirements = new Map<string, PaymentRequirements[]>();
  private inflight = new Set<string>();
  private requests = new Set<string>();
  private buckets = new Map<string, Bucket>();
  private payers = new Map<string, Bucket>();
  private verifies = new Map<string, Bucket>();
  private trusted = new Map<string, number>();
  private quotes: Bucket = { tokens: 0, at: 0 };
  private unknownPayers: Bucket = { tokens: 0, at: 0 };
  private facilitatorCalls: Bucket = { tokens: 0, at: 0 };
  private admissions: Bucket = { tokens: 0, at: 0 };
  private quoteCache = new Map<string, PaymentRequired>();
  private chain;
  private solana?: SolanaChain;

  constructor(private readonly options: SellerOptions) {
    super();
    this.server = new x402ResourceServer(options.facilitator);
    if (options.network === SOLANA_NETWORK || options.solanaPayout) {
      if (!validateSvmAddress(options.network === SOLANA_NETWORK ? options.payTo : options.solanaPayout!)) throw new Error("invalid Solana payout");
      if (options.network === SOLANA_NETWORK && options.solanaPayout) throw new Error("Solana payout is already configured");
      this.solana = new SolanaChain(options.network === SOLANA_NETWORK ? options.rpcUrl : options.solanaRpcUrl);
      this.server.register(SOLANA_NETWORK, new ExactSvmScheme());
    }
    if (options.network !== SOLANA_NETWORK) {
      if (!["eip155:8453", "eip155:84532"].includes(options.network)) throw new Error("unsupported network");
      this.server.register(options.network, new ExactEvmScheme());
    }
    this.chain = createPublicClient({ chain: options.network === "eip155:84532" ? baseSepolia : base, transport: http(options.rpcUrl) });
  }

  async start(): Promise<void> {
    await this.server.initialize();
    await this.solana?.initialize();
    for (const offer of this.options.offers) {
      const accepts = await this.server.buildPaymentRequirements({
        scheme: "exact",
        payTo: this.options.payTo,
        price: `$${offer.price}`,
        network: this.options.network,
        maxTimeoutSeconds: 120,
      });
      if (this.options.solanaPayout) {
        accepts.push(...await this.server.buildPaymentRequirements({ scheme: "exact", payTo: this.options.solanaPayout, price: { asset: SOLANA_USDC, amount: accepts[0].amount }, network: SOLANA_NETWORK, maxTimeoutSeconds: 120 }));
      }
      if (accepts.some(item => item.network === SOLANA_NETWORK && !validateSvmAddress(String(item.extra?.feePayer ?? "")))) throw new Error("facilitator did not advertise a Solana fee payer");
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
      if (this.options.quotesPerMinute !== undefined && !this.take(this.quotes, this.options.quotesPerMinute)) return reply(429, { error: "too many requests" });
      return reply(402, { paymentRequired: await this.quoteFor(topic, accepts, offer) });
    }

    let matched: PaymentRequirements | undefined;
    try {
      let available = accepts;
      if (payment.accepted?.network === SOLANA_NETWORK) {
        const identity = solanaIdentity(payment);
        const prior = this.options.ledger.forKey(`${SOLANA_NETWORK}:${identity.payer}:${identity.messageHash}`);
        if (prior?.solana?.messageHash === identity.messageHash && ["verified", "pending", "settled", "recovered"].includes(prior.state)) {
          available = accepts.map(item => item.network === SOLANA_NETWORK ? { ...item, extra: { ...item.extra, feePayer: identity.feePayer } } : item);
        }
      }
      matched = this.server.findMatchingRequirements(available, payment);
    } catch { return reply(400, { error: "unsupported payment payload" }); }
    if (!matched) return reply(400, { error: "payment does not match the quote" });
    const isSolana = matched.network === SOLANA_NETWORK;
    const authorization = isSolana ? undefined : authorizationOf(payment);
    let svm: SolanaPayment | undefined;
    if (isSolana) {
      try { svm = await inspectSolana(payment, matched); } catch { return reply(400, { error: "invalid Solana payment" }); }
    } else {
      const saved = authorization && this.options.ledger.forKey(`${matched.network}:${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`);
      const recorded = !!saved && ["verified", "pending", "settled", "recovered"].includes(saved.state);
      if (!authorization || !fits(authorization, matched, recorded)) return reply(400, { error: "payment does not match the quote" });
    }
    const payer = svm?.payer ?? authorization!.from.toLowerCase();
    const key = `${matched.network}:${payer}:${svm?.messageHash ?? authorization!.nonce.toLowerCase()}`;
    if (this.inflight.has(key)) return reply(409, { error: "payment already in progress" });
    this.inflight.add(key);
    const requestKey = `${matched.network}:${payer}:${topic}:${ask.id}`;
    let ownsRequest = false;
    const started = performance.now();
    const base = { id: ask.id, topic, key, payer: svm?.payer ?? authorization!.from, amount: matched.amount, network: matched.network };
    try {
      const known = this.isTrusted(`${matched.network}:${payer}`);
      const perPayer = this.options.payerPerMinute ?? 30;
      let budgeted = false;
      if (!isSolana) {
        const signature = (payment.payload as { signature?: Hex }).signature;
        const typed = {
          address: authorization!.from,
          domain: { name: String(matched.extra?.name ?? ""), version: String(matched.extra?.version ?? ""), chainId: Number(matched.network.split(":")[1]), verifyingContract: matched.asset as Address },
          types: authorizationTypes,
          primaryType: "TransferWithAuthorization" as const,
          message: { from: authorization!.from, to: authorization!.to, value: BigInt(authorization!.value), validAfter: BigInt(authorization!.validAfter), validBefore: BigInt(authorization!.validBefore), nonce: authorization!.nonce },
          signature: signature ?? "0x",
        };
        const signedLocally = typeof signature === "string" && (await verifyTypedData(typed).catch(() => false));
        if (!signedLocally) {
          const allowed = known ? this.limit(this.verifies, payer, perPayer) : this.take(this.unknownPayers, this.options.paymentsPerMinute ?? 300);
          if (!allowed) return reply(429, { error: "too many requests, not charged" });
          budgeted = !known;
          const signedOnChain = typeof signature === "string" && (await this.chain.verifyTypedData(typed).catch(() => false));
          if (!signedOnChain) return reply(400, { error: "invalid payment signature" });
        }
      }
      const existing = this.options.ledger.forKey(key);
      if (existing && ["verified", "pending", "settled", "recovered"].includes(existing.state)) {
        if (existing.id !== ask.id || existing.topic !== topic) return reply(409, { error: "payment already used" });
        let settled = this.options.ledger.settledFor(key);
        if (!settled) {
          if (!this.limit(this.payers, `${matched.network}:${payer}`, perPayer) || !this.take(this.facilitatorCalls, this.options.facilitatorPerMinute ?? 600)) return reply(429, { error: "too many requests; payment pending" });
          settled = await this.reconcileEntry(existing);
        }
        if (settled) return reply(200, { result: settled.reading, [PAYMENT_RESPONSE_KEY]: settled.settlement });
        return reply(503, { error: "payment pending; retry the same request" });
      }
      const prior = this.options.ledger.forRequest(ask.id, topic, matched.network, base.payer);
      if (prior && prior.key !== key) return reply(409, { error: "request already has a payment" });
      if (this.requests.has(requestKey)) return reply(409, { error: "request already in progress" });
      this.requests.add(requestKey);
      ownsRequest = true;
      if (!this.limit(this.payers, `${matched.network}:${payer}`, perPayer)) return reply(429, { error: "too many requests, not charged" });
      if (!known && !budgeted && !this.take(this.unknownPayers, this.options.paymentsPerMinute ?? 300)) return reply(429, { error: "too many requests, not charged" });
      if (!known) {
        let balance: bigint;
        try {
          balance = svm ? await this.solana!.balance(svm.source) : await this.chain.readContract({ address: matched.asset as Address, abi: usdcAbi, functionName: "balanceOf", args: [authorization!.from] });
        } catch { return reply(503, { error: "chain unavailable, not charged" }); }
        if (balance < BigInt(matched.amount)) {
          this.record({ ...base, state: "rejected", error: "insufficient balance" });
          return reply(400, { error: "insufficient balance" });
        }
      }
      if (!this.take(this.facilitatorCalls, this.options.facilitatorPerMinute ?? 600)) return reply(429, { error: "too many requests, not charged" });
      let verified;
      try { verified = await this.server.verifyPayment(payment, matched); } catch {
        this.record({ ...base, state: "refused", error: "facilitator unavailable, not charged" });
        return reply(503, { error: "facilitator unavailable, not charged" });
      }
      if (!verified.isValid || (isSolana && verified.payer !== svm!.payer)) {
        this.record({ ...base, state: "rejected", error: "invalid payment" });
        return reply(400, { error: "invalid payment" });
      }
      const reading = this.options.readings(topic);
      const maxAgeMs = this.options.maxAgeMs ?? 30_000;
      if (!isReading(reading) || reading.ts > Date.now() + 5000 || Date.now() - reading.ts > maxAgeMs) {
        this.record({ ...base, state: "refused", error: "device offline, not charged" });
        return reply(503, { error: "device offline, not charged" });
      }

      if (svm) {
        try { svm.slot = await this.solana!.context(); } catch { return reply(503, { error: "chain unavailable, not charged" }); }
      }
      const pending = this.options.ledger.append({ ...base, state: "verified", reading, payTo: matched.payTo, asset: matched.asset, ...(svm ? { solana: { messageHash: svm.messageHash, source: svm.source, destination: svm.destination, blockhash: svm.blockhash, slot: svm.slot } } : {}) });
      let settlement: SettleResponse | undefined;
      try {
        settlement = await this.server.settlePayment(payment, matched);
        if (!settlement.success || settlement.network !== matched.network || (isSolana && settlement.payer !== svm!.payer)) throw new Error("invalid settlement response");
      } catch (error) {
        const transaction = (error as { transaction?: unknown })?.transaction;
        const unresolved = typeof transaction === "string" && transaction ? { ...pending, tx: transaction } : pending;
        const recovered = await this.reconcileEntry(unresolved);
        if (recovered) return reply(200, { result: recovered.reading, [PAYMENT_RESPONSE_KEY]: recovered.settlement });
        this.record({ ...unresolved, state: "pending", error: "payment pending" });
        return reply(503, { error: "payment pending; retry the same request" });
      }
      this.trust(`${matched.network}:${payer}`);
      this.record({ ...pending, state: "settled", tx: settlement.transaction, settlement, latencyMs: Math.round(performance.now() - started) });
      return reply(200, { result: reading, [PAYMENT_RESPONSE_KEY]: settlement });
    } finally {
      this.inflight.delete(key);
      if (ownsRequest) this.requests.delete(requestKey);
    }
  }

  private record(entry: Omit<LedgerEntry, "ts">): void {
    this.emit("entry", this.options.ledger.append(entry));
  }

  private async quoteFor(topic: string, accepts: PaymentRequirements[], offer: Offer | undefined): Promise<PaymentRequired> {
    const cached = this.quoteCache.get(topic);
    if (cached) return cached;
    const paymentRequired = await this.server.createPaymentRequiredResponse(accepts, {
      url: `${publicBrokerUrl(this.options.resourceBase).replace(/\/$/, "")}/${topic}`,
      description: offer?.description ?? topic,
      mimeType: "application/json",
    });
    this.quoteCache.set(topic, paymentRequired);
    return paymentRequired;
  }

  private allow(replyTo: string): boolean {
    const max = this.options.maxRequesters ?? 10_000;
    return this.limit(this.buckets, replyTo.split("/")[3] ?? replyTo, this.options.rateLimitPerMinute ?? 60, () => this.take(this.admissions, max));
  }

  private limit(buckets: Map<string, Bucket>, id: string, limit: number, admit?: () => boolean): boolean {
    const max = this.options.maxRequesters ?? 10_000;
    const now = Date.now();
    let bucket = buckets.get(id);
    if (bucket) buckets.delete(id);
    else {
      if (admit && !admit()) return false;
      if (buckets.size >= max) buckets.delete(buckets.keys().next().value as string);
      bucket = { tokens: limit, at: now };
    }
    buckets.set(id, bucket);
    return this.take(bucket, limit, now);
  }

  private isTrusted(payer: string): boolean {
    const until = this.trusted.get(payer);
    return until !== undefined && until > Date.now();
  }

  private trust(payer: string): void {
    const now = Date.now();
    if (!this.trusted.has(payer) && this.trusted.size >= (this.options.maxRequesters ?? 10_000)) {
      for (const [key, until] of this.trusted) if (until <= now) this.trusted.delete(key);
      if (this.trusted.size >= (this.options.maxRequesters ?? 10_000)) return;
    }
    this.trusted.set(payer, now + TRUSTED_MS);
  }

  private take(bucket: Bucket, limit: number, now = Date.now()): boolean {
    bucket.tokens = bucket.at ? Math.min(limit, bucket.tokens + ((now - bucket.at) / 60_000) * limit) : limit;
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private async settledOnChain(authorization: Pick<Authorization, "from" | "nonce">, expected: { payTo: string; amount: string; asset: string | undefined }): Promise<SettleResponse | undefined> {
    const asset = expected.asset as Address | undefined;
    if (!asset) return undefined;
    try {
      const used = await this.chain.readContract({ address: asset, abi: usdcAbi, functionName: "authorizationState", args: [authorization.from, authorization.nonce] });
      if (!used) return undefined;
      const latest = await this.chain.getBlockNumber();
      const logs = await this.chain.getLogs({
        address: asset,
        event: usdcAbi[2],
        args: { authorizer: authorization.from, nonce: authorization.nonce },
        fromBlock: latest > 2000n ? latest - 2000n : 0n,
        toBlock: latest,
      });
      for (const log of [...logs].reverse()) {
        if (!log.transactionHash) continue;
        const receipt = await this.chain.getTransactionReceipt({ hash: log.transactionHash });
        if (receipt.status !== "success") continue;
        const transfers = parseEventLogs({ abi: usdcAbi, eventName: "Transfer", logs: receipt.logs.filter(item => item.address.toLowerCase() === asset.toLowerCase()) });
        const paid = transfers.some(transfer => transfer.args.from.toLowerCase() === authorization.from.toLowerCase() && transfer.args.to.toLowerCase() === expected.payTo.toLowerCase() && transfer.args.value === BigInt(expected.amount));
        if (paid) return { success: true, transaction: log.transactionHash, network: this.options.network, payer: authorization.from };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async reconcileEntry(entry: LedgerEntry): Promise<LedgerEntry | undefined> {
    if (!entry.key || !entry.payer || !entry.reading) return undefined;
    let settlement: SettleResponse | undefined;
    if (entry.network === SOLANA_NETWORK) {
      if (!this.solana || !entry.solana) return undefined;
      try { settlement = (await this.solana.reconcile(entry.solana, entry.payer, entry.tx)).settlement; } catch { return undefined; }
    } else {
      if (entry.network && entry.network !== this.options.network) return undefined;
      const nonce = entry.key.split(":").at(-1) as Hex;
      const asset = entry.asset ?? this.requirements.get(entry.topic)?.find(item => item.network !== SOLANA_NETWORK)?.asset;
      settlement = await this.settledOnChain({ from: entry.payer as Address, nonce }, { payTo: entry.payTo ?? this.options.payTo, amount: entry.amount ?? "0", asset });
    }
    if (!settlement?.success) return undefined;
    const recovered = this.options.ledger.append({ ...entry, state: "recovered", tx: settlement.transaction, settlement });
    this.emit("entry", recovered);
    return recovered;
  }

  private async recover(): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (const entry of this.options.ledger.pending()) {
      if (Date.now() >= deadline) break;
      await this.reconcileEntry(entry);
    }
  }
}
