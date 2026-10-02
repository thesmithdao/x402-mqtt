import { randomBytes, randomUUID } from "node:crypto";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { SOLANA_NETWORK, SOLANA_USDC, SolanaChain, inspectSolana, solanaSigner, validSolanaSignature, validateSvmAddress, type SolanaProof } from "./solana.js";
import mqtt from "mqtt";
import { createPublicClient, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { PAYMENT_KEY, PAYMENT_RESPONSE_KEY, REQUEST_PREFIX, RESPONSE_PREFIX, isReading, isValidId, isValidTopic, MAX_MESSAGE_BYTES, requireTls, type Reading, type Reply } from "./spec.js";

export type BuyerOptions = {
  url: string;
  privateKey: string;
  network?: Network;
  maxPerCall?: string;
  maxTotal?: string;
  timeoutMs?: number;
  rpcUrl?: string;
  allowCleartext?: boolean;
};

export type Purchase = { topic: string; reading: Reading; settlement: SettleResponse; amount: string; ms: number };

export class SpendCapError extends Error {}

const MAX_WINDOW_SECONDS = 600;
const USDC: Record<string, string> = {
  [SOLANA_NETWORK]: SOLANA_USDC,
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};
const EXPIRY_MARGIN_SECONDS = 10n;
const usdcAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

type Hold = { amount: bigint; asset: Address; nonce: Hex; validBefore: bigint };
type SvmHold = { amount: bigint; solana: SolanaProof };

function authorizationOf(payment: PaymentPayload): { nonce?: Hex; validBefore?: string } | undefined {
  return (payment.payload as { authorization?: { nonce?: Hex; validBefore?: string } } | undefined)?.authorization;
}

function holdOf(payment: PaymentPayload, amount: bigint, asset: Address): Hold | undefined {
  const authorization = authorizationOf(payment);
  if (!authorization?.nonce || !authorization.validBefore) return undefined;
  return { amount, asset, nonce: authorization.nonce, validBefore: BigInt(authorization.validBefore) };
}

export async function createBuyer(options: BuyerOptions) {
  requireTls(options.url, "payments", options.allowCleartext);
  const network = options.network ?? "eip155:8453";
  const usdc = USDC[network];
  if (!usdc) throw new Error(`unsupported network ${network}, only Base and Base Sepolia USDC`);
  const isSolana = network === SOLANA_NETWORK;
  const solana = isSolana ? new SolanaChain(options.rpcUrl) : undefined;
  await solana?.initialize();
  const account = isSolana ? await solanaSigner(options.privateKey) : privateKeyToAccount(options.privateKey as Hex);
  const payer = new x402Client().register(network, isSolana ? new ExactSvmScheme(toClientSvmSigner(account as Awaited<ReturnType<typeof solanaSigner>>), { rpcUrl: solana!.url }) : new ExactEvmScheme(account as ReturnType<typeof privateKeyToAccount>));
  const chain = createPublicClient({ chain: network === "eip155:84532" ? baseSepolia : base, transport: http(options.rpcUrl) });
  if (![options.maxPerCall ?? "0.01", options.maxTotal ?? "1"].every(value => /^\d+(\.\d{1,6})?$/.test(value) && parseUnits(value, 6) > 0n)) throw new Error("spend caps must be positive USD amounts");
  const maxPerCall = parseUnits(options.maxPerCall ?? "0.01", 6);
  const maxTotal = parseUnits(options.maxTotal ?? "1", 6);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeout");
  const clientId = `x402-buyer-${randomBytes(16).toString("hex")}`;
  const inbox = `${RESPONSE_PREFIX}${clientId}`;
  const waiting = new Map<string, (reply: Reply) => void>();
  const holds = new Map<string, Hold | SvmHold>();
  let spent = 0n;

  const client = await mqtt.connectAsync(options.url, { clientId, clean: true, reconnectPeriod: 2000 });
  client.on("message", (topic, payload) => {
    if (payload.length > MAX_MESSAGE_BYTES) return;
    try {
      const reply = JSON.parse(payload.toString("utf8")) as Reply;
      if (!isValidId(reply.id) || topic !== `${inbox}/${reply.id}` || !Number.isInteger(reply.status)) return;
      const resolve = waiting.get(reply.id);
      if (resolve) {
        waiting.delete(reply.id);
        resolve(reply);
      }
    } catch {
      return;
    }
  });
  const granted = await client.subscribeAsync(`${inbox}/#`, { qos: 1 });
  if (granted.some(item => item.qos === 128)) {
    await client.endAsync();
    throw new Error("broker refused the reply topic");
  }

  function send(topic: string, id: string, payment?: PaymentPayload): Promise<Reply> {
    if (!isValidTopic(topic) || !isValidId(id)) return Promise.reject(new Error("invalid topic or request ID"));
    if (waiting.has(id)) return Promise.reject(new Error("request already waiting"));
    const body = JSON.stringify({ id, replyTo: `${inbox}/${id}`, ...(payment ? { [PAYMENT_KEY]: payment } : {}) });
    if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return Promise.reject(new Error("request too large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      waiting.set(id, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
      client.publish(`${REQUEST_PREFIX}${topic}`, body, { qos: 1 });
    });
  }

  async function quote(topic: string, id: string = randomUUID()): Promise<{ id: string; paymentRequired: PaymentRequired }> {
    const reply = await send(topic, id);
    if (reply.status !== 402 || !reply.paymentRequired) throw new Error(`${reply.status} ${reply.error ?? "no quote"}`);
    return { id, paymentRequired: reply.paymentRequired };
  }

  async function reclaim(): Promise<void> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const [nonce, hold] of [...holds]) {
      if ("solana" in hold) {
        holds.delete(nonce);
        try {
          if (await solana!.expiredUnused(hold.solana, account.address)) spent -= hold.amount;
          else holds.set(nonce, hold);
        } catch { holds.set(nonce, hold); }
        continue;
      }
      if (hold.validBefore + EXPIRY_MARGIN_SECONDS > now) continue;
      holds.delete(nonce);
      try {
        const used = await chain.readContract({ address: hold.asset, abi: usdcAbi, functionName: "authorizationState", args: [account.address as Address, hold.nonce] });
        if (!used) spent -= hold.amount;
      } catch {
        holds.set(nonce, hold);
      }
    }
  }

  async function sign(paymentRequired: PaymentRequired): Promise<{ payment: PaymentPayload; amount: bigint }> {
    if (paymentRequired?.x402Version !== 2 || !Array.isArray(paymentRequired.accepts)) throw new Error("invalid quote");
    const accept = paymentRequired.accepts.find(item => item.scheme === "exact" && item.network === network);
    if (!accept) throw new Error(`no ${network} option in the quote`);
    if (typeof accept.asset !== "string" || (isSolana ? accept.asset !== usdc : accept.asset.toLowerCase() !== usdc)) throw new Error(`quote asks for ${accept.asset}, only USDC is accepted`);
    if (typeof accept.amount !== "string" || !/^\d{1,20}$/.test(accept.amount) || BigInt(accept.amount) <= 0n || !Number.isSafeInteger(accept.maxTimeoutSeconds) || accept.maxTimeoutSeconds <= 0) throw new Error("invalid quote amount or expiry");
    if (isSolana && (!validateSvmAddress(accept.payTo) || !validateSvmAddress(String(accept.extra?.feePayer ?? "")))) throw new Error("invalid Solana quote");
    const amount = BigInt(accept.amount);
    if (amount > maxPerCall) throw new SpendCapError(`price ${accept.amount} is above the per-call cap`);
    if (accept.maxTimeoutSeconds > MAX_WINDOW_SECONDS) throw new Error(`quote asks for a ${accept.maxTimeoutSeconds}s payment window, the limit is ${MAX_WINDOW_SECONDS}s`);
    if (spent + amount > maxTotal) await reclaim();
    if (spent + amount > maxTotal) throw new SpendCapError("total spending cap reached");
    spent += amount;
    let payment: PaymentPayload;
    try {
      const slot = solana ? await solana.context() : undefined;
      const terms = isSolana ? { ...accept, extra: { ...accept.extra, recentBlockhash: undefined, lastValidBlockHeight: undefined } } : accept;
      payment = await payer.createPaymentPayload({ ...paymentRequired, accepts: [terms] });
      if (solana) {
        const proof = await inspectSolana(payment, terms);
        holds.set(proof.messageHash, { amount, solana: { messageHash: proof.messageHash, source: proof.source, destination: proof.destination, blockhash: proof.blockhash, slot: slot! } });
      }
    } catch (error) {
      spent -= amount;
      throw error;
    }
    const hold = holdOf(payment, amount, accept.asset as Address);
    if (hold) holds.set(hold.nonce, hold);
    return { payment, amount };
  }

  async function pay(topic: string, id: string, payment: PaymentPayload): Promise<Reply> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send(topic, id, payment);
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
  }

  async function buy(topic: string): Promise<Purchase> {
    const started = performance.now();
    const { id, paymentRequired } = await quote(topic);
    const { payment, amount } = await sign(paymentRequired);
    const reply = await pay(topic, id, payment);
    const settlement = reply[PAYMENT_RESPONSE_KEY];
    if (reply.status !== 200 || !reply.result || !settlement) throw new Error(`${reply.status} ${reply.error ?? "not delivered"}`);
    if (!isReading(reply.result) || settlement.success !== true || settlement.network !== network || (isSolana && (settlement.payer !== account.address || !validSolanaSignature(settlement.transaction))) || (!isSolana && !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction))) throw new Error("malformed reply from the seller");
    if (isSolana) {
      const proof = await inspectSolana(payment, payment.accepted);
      const held = holds.get(proof.messageHash) as SvmHold | undefined;
      const confirmed = held && (await solana!.reconcile(held.solana, account.address, settlement.transaction)).settlement;
      if (!confirmed || confirmed.transaction !== settlement.transaction) throw new Error("payment receipt not confirmed");
      holds.delete(proof.messageHash);
    }
    const nonce = authorizationOf(payment)?.nonce;
    if (nonce) holds.delete(nonce);
    return { topic, reading: reply.result, settlement, amount: amount.toString(), ms: Math.round(performance.now() - started) };
  }

  return {
    address: account.address,
    clientId,
    buy,
    quote,
    sign,
    send,
    close: () => client.endAsync(),
  };
}
