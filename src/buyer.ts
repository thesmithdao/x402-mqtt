import { randomBytes, randomUUID } from "node:crypto";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import mqtt from "mqtt";
import { parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMENT_KEY, PAYMENT_RESPONSE_KEY, REQUEST_PREFIX, RESPONSE_PREFIX, type Reading, type Reply } from "./spec.js";

export type BuyerOptions = {
  url: string;
  privateKey: Hex;
  network?: Network;
  maxPerCall?: string;
  maxTotal?: string;
  timeoutMs?: number;
};

export type Purchase = { topic: string; reading: Reading; settlement: SettleResponse; amount: string; ms: number };

export class SpendCapError extends Error {}

export async function createBuyer(options: BuyerOptions) {
  const network = options.network ?? "eip155:8453";
  const account = privateKeyToAccount(options.privateKey);
  const payer = new x402Client().register(network, new ExactEvmScheme(account));
  const maxPerCall = parseUnits(options.maxPerCall ?? "0.01", 6);
  const maxTotal = parseUnits(options.maxTotal ?? "1", 6);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clientId = `x402-buyer-${randomBytes(6).toString("hex")}`;
  const inbox = `${RESPONSE_PREFIX}${clientId}`;
  const waiting = new Map<string, (reply: Reply) => void>();
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

  async function sign(paymentRequired: PaymentRequired): Promise<{ payment: PaymentPayload; amount: bigint }> {
    const accept = paymentRequired.accepts.find(item => item.scheme === "exact" && item.network === network);
    if (!accept) throw new Error(`no ${network} option in the quote`);
    const amount = BigInt(accept.amount);
    if (amount > maxPerCall) throw new SpendCapError(`price ${accept.amount} is above the per-call cap`);
    if (spent + amount > maxTotal) throw new SpendCapError("total spending cap reached");
    const payment = await payer.createPaymentPayload({ ...paymentRequired, accepts: [accept] });
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
    spent += amount;
    const reply = await pay(topic, id, payment);
    const settlement = reply[PAYMENT_RESPONSE_KEY];
    if (reply.status !== 200 || !reply.result || !settlement) {
      spent -= amount;
      throw new Error(`${reply.status} ${reply.error ?? "not delivered"}`);
    }
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
