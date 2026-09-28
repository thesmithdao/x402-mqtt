import { randomBytes, randomUUID } from "node:crypto";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import mqtt from "mqtt";
import { createPublicClient, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { PAYMENT_KEY, PAYMENT_RESPONSE_KEY, REQUEST_PREFIX, RESPONSE_PREFIX, isReading, type Reading, type Reply } from "./spec.js";

export type BuyerOptions = {
  url: string;
  privateKey: Hex;
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
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};
const EXPIRY_MARGIN_SECONDS = 10n;
const usdcAbi = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

type Hold = { amount: bigint; asset: Address; nonce: Hex; validBefore: bigint };

function checkTransport(url: string, allowCleartext?: boolean): void {
  const { protocol, hostname } = new URL(url);
  if (protocol === "mqtts:" || protocol === "wss:" || allowCleartext) return;
  if (hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname)) return;
  throw new Error(`refusing to send payments over ${protocol}// to ${hostname}: use mqtts:// or wss://, or set allowCleartext`);
}

function authorizationOf(payment: PaymentPayload): { nonce?: Hex; validBefore?: string } | undefined {
  return (payment.payload as { authorization?: { nonce?: Hex; validBefore?: string } } | undefined)?.authorization;
}

function holdOf(payment: PaymentPayload, amount: bigint, asset: Address): Hold | undefined {
  const authorization = authorizationOf(payment);
  if (!authorization?.nonce || !authorization.validBefore) return undefined;
  return { amount, asset, nonce: authorization.nonce, validBefore: BigInt(authorization.validBefore) };
}

export async function createBuyer(options: BuyerOptions) {
  checkTransport(options.url, options.allowCleartext);
  const network = options.network ?? "eip155:8453";
  const account = privateKeyToAccount(options.privateKey);
  const payer = new x402Client().register(network, new ExactEvmScheme(account));
  const chain = createPublicClient({ chain: network === "eip155:84532" ? baseSepolia : base, transport: http(options.rpcUrl) });
  const maxPerCall = parseUnits(options.maxPerCall ?? "0.01", 6);
  const maxTotal = parseUnits(options.maxTotal ?? "1", 6);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clientId = `x402-buyer-${randomBytes(16).toString("hex")}`;
  const inbox = `${RESPONSE_PREFIX}${clientId}`;
  const waiting = new Map<string, (reply: Reply) => void>();
  const holds = new Map<Hex, Hold>();
  let spent = 0n;

  const client = await mqtt.connectAsync(options.url, { clientId, clean: true, reconnectPeriod: 2000 });
  client.on("message", (_topic, payload) => {
    try {
      const reply = JSON.parse(payload.toString("utf8")) as Reply;
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
  if (granted.some(item => item.qos === 128)) throw new Error("broker refused the reply topic");

  function send(topic: string, id: string, payment?: PaymentPayload): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      waiting.set(id, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
      const ask = { id, replyTo: `${inbox}/${id}`, ...(payment ? { [PAYMENT_KEY]: payment } : {}) };
      client.publish(`${REQUEST_PREFIX}${topic}`, JSON.stringify(ask), { qos: 1 });
    });
  }

  async function quote(topic: string, id: string = randomUUID()): Promise<{ id: string; paymentRequired: PaymentRequired }> {
    const reply = await send(topic, id);
    if (reply.status !== 402 || !reply.paymentRequired) throw new Error(`${reply.status} ${reply.error ?? "no quote"}`);
    return { id, paymentRequired: reply.paymentRequired };
  }

  async function reclaim(): Promise<void> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const [nonce, hold] of holds) {
      if (hold.validBefore + EXPIRY_MARGIN_SECONDS > now) continue;
      holds.delete(nonce);
      try {
        const used = await chain.readContract({ address: hold.asset, abi: usdcAbi, functionName: "authorizationState", args: [account.address, hold.nonce] });
        if (!used) spent -= hold.amount;
      } catch {
        holds.set(nonce, hold);
      }
    }
  }

  async function sign(paymentRequired: PaymentRequired): Promise<{ payment: PaymentPayload; amount: bigint }> {
    const accept = paymentRequired.accepts.find(item => item.scheme === "exact" && item.network === network);
    if (!accept) throw new Error(`no ${network} option in the quote`);
    if (USDC[network] && accept.asset.toLowerCase() !== USDC[network]) throw new Error(`quote asks for ${accept.asset}, only USDC is accepted`);
    const amount = BigInt(accept.amount);
    if (amount > maxPerCall) throw new SpendCapError(`price ${accept.amount} is above the per-call cap`);
    if (accept.maxTimeoutSeconds > MAX_WINDOW_SECONDS) throw new Error(`quote asks for a ${accept.maxTimeoutSeconds}s payment window, the limit is ${MAX_WINDOW_SECONDS}s`);
    if (spent + amount > maxTotal) await reclaim();
    if (spent + amount > maxTotal) throw new SpendCapError("total spending cap reached");
    spent += amount;
    let payment: PaymentPayload;
    try {
      payment = await payer.createPaymentPayload({ ...paymentRequired, accepts: [accept] });
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
    if (!isReading(reply.result) || typeof settlement.transaction !== "string") throw new Error("malformed reply from the seller");
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
