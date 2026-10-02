import { randomBytes, randomUUID } from "node:crypto";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { getBase64EncodedWireTransaction, signBytes } from "@solana/kit";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { SOLANA_NETWORK, SOLANA_USDC, SolanaChain, decodeSolana, inspectSolana, inspectSolanaMessage, unsignedSolana, solanaSigner, validSolanaSignature, validateSvmAddress, type SolanaProof } from "./solana.js";
import { brokerIdentity, validateRequest, type PurchaseRequest } from "./recovery.js";
import mqtt from "mqtt";
import { createPublicClient, http, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";
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
  onPrepared?: (request: PurchaseRequest) => void | Promise<void>;
};

export type Purchase = { topic: string; reading: Reading; settlement: SettleResponse; amount: string; ms: number };

export class SpendCapError extends Error {}
export class PurchasePendingError extends Error {
  constructor(readonly request: PurchaseRequest, message: string) { super(message); }
}
export class PurchaseExpiredError extends PurchasePendingError {}

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
  if (!usdc) throw new Error(`unsupported network ${network}`);
  const isSolana = network === SOLANA_NETWORK;
  const solana = isSolana ? new SolanaChain(options.rpcUrl) : undefined;
  await solana?.initialize();
  const account = await (async () => {
    try { return isSolana ? await solanaSigner(options.privateKey) : privateKeyToAccount(options.privateKey as Hex); }
    catch { throw new Error("invalid buyer key for the selected network"); }
  })();
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
  const accounted = new Set<string>();
  const reservations = new Map<string, Promise<void>>();
  const resuming = new Set<string>();
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

  async function baseExpiredUnused(authorization: { nonce: Hex; validBefore: bigint }, asset: Address): Promise<boolean> {
    if (authorization.validBefore + EXPIRY_MARGIN_SECONDS >= BigInt(Math.floor(Date.now() / 1000))) return false;
    if (await chain.getChainId() !== Number(network.split(":")[1])) return false;
    const finalized = await chain.getBlock({ blockTag: "finalized" });
    if (finalized.number === null || finalized.timestamp <= authorization.validBefore + EXPIRY_MARGIN_SECONDS) return false;
    return !await chain.readContract({ address: asset, abi: usdcAbi, functionName: "authorizationState", args: [account.address as Address, authorization.nonce], blockNumber: finalized.number });
  }

  async function reclaim(): Promise<void> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const [nonce, hold] of [...holds]) {
      if ("solana" in hold) {
        try {
          if (await solana!.expiredUnused(hold.solana, account.address) && holds.get(nonce) === hold) { holds.delete(nonce); accounted.delete(nonce); spent -= hold.amount; }
        } catch {}
        continue;
      }
      if (hold.validBefore + EXPIRY_MARGIN_SECONDS > now) continue;
      try {
        if (await baseExpiredUnused(hold, hold.asset) && holds.get(nonce) === hold) { holds.delete(nonce); accounted.delete(nonce); spent -= hold.amount; }
      } catch {}
    }
  }

  function checkTerms(accept: PaymentRequirements): bigint {
    if (!accept || accept.scheme !== "exact" || accept.network !== network) throw new Error("invalid quote");
    if (typeof accept.asset !== "string" || (isSolana ? accept.asset !== usdc : accept.asset.toLowerCase() !== usdc)) throw new Error(`quote asks for ${accept.asset}, only USDC is accepted`);
    if (typeof accept.amount !== "string" || !/^\d{1,20}$/.test(accept.amount) || BigInt(accept.amount) <= 0n || !Number.isSafeInteger(accept.maxTimeoutSeconds) || accept.maxTimeoutSeconds <= 0) throw new Error("invalid quote amount or expiry");
    if (isSolana && (!validateSvmAddress(accept.payTo) || !validateSvmAddress(String(accept.extra?.feePayer ?? "")))) throw new Error("invalid Solana quote");
    if (!isSolana && (!isAddress(accept.payTo) || typeof accept.extra?.name !== "string" || typeof accept.extra?.version !== "string")) throw new Error("invalid Base quote");
    const amount = BigInt(accept.amount);
    if (amount > maxPerCall) throw new SpendCapError(`price ${accept.amount} is above the per-call cap`);
    if (accept.maxTimeoutSeconds > MAX_WINDOW_SECONDS) throw new Error(`quote asks for a ${accept.maxTimeoutSeconds}s payment window, the limit is ${MAX_WINDOW_SECONDS}s`);
    return amount;
  }

  async function reserve(amount: bigint): Promise<void> {
    if (spent + amount > maxTotal) await reclaim();
    if (spent + amount > maxTotal) throw new SpendCapError("total spending cap reached");
    spent += amount;
  }

  async function reservePurchase(identity: string, amount: bigint): Promise<void> {
    const pending = reservations.get(identity);
    if (pending) return pending;
    if (accounted.has(identity)) return;
    const reservation = reserve(amount).then(() => { accounted.add(identity); });
    reservations.set(identity, reservation);
    try { await reservation; }
    finally { reservations.delete(identity); }
  }

  async function sign(paymentRequired: PaymentRequired): Promise<{ payment: PaymentPayload; amount: bigint }> {
    if (paymentRequired?.x402Version !== 2 || !Array.isArray(paymentRequired.accepts)) throw new Error("invalid quote");
    const accept = paymentRequired.accepts.find(item => item.scheme === "exact" && item.network === network);
    if (!accept) throw new Error(`no ${network} option in the quote`);
    const amount = checkTerms(accept);
    await reserve(amount);
    let payment: PaymentPayload;
    try {
      const blockhash = solana ? await solana.latestBlockhash() : undefined;
      const terms = isSolana ? { ...accept, extra: { ...accept.extra, recentBlockhash: blockhash!.blockhash, lastValidBlockHeight: String(blockhash!.lastValidBlockHeight) } } : accept;
      payment = await payer.createPaymentPayload({ ...paymentRequired, accepts: [terms] });
      if (solana) {
        const proof = await inspectSolana(payment, terms);
        if (proof.blockhash !== blockhash!.blockhash) throw new Error("Solana blockhash mismatch");
        holds.set(proof.messageHash, { amount, solana: { ...proof, slot: blockhash!.slot, lastValidBlockHeight: blockhash!.lastValidBlockHeight } });
        accounted.add(proof.messageHash);
      }
    } catch (error) {
      spent -= amount;
      throw error;
    }
    const hold = holdOf(payment, amount, accept.asset as Address);
    if (hold) { holds.set(hold.nonce, hold); accounted.add(hold.nonce); }
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

  async function deliver(request: PurchaseRequest, payment: PaymentPayload, started: number): Promise<Purchase> {
    let problem = "payment reply unavailable; retry the same purchase";
    try {
      const reply = await pay(request.topic, request.id, payment);
      const settlement = reply[PAYMENT_RESPONSE_KEY];
      problem = `${reply.status} ${String(reply.error ?? "not delivered").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 256)}`;
      if (reply.status !== 200 || !reply.result || !settlement) throw new Error();
      problem = "malformed reply from the seller";
      if (!isReading(reply.result) || settlement.success !== true || settlement.network !== network || (isSolana && (settlement.payer !== account.address || !validSolanaSignature(settlement.transaction))) || (!isSolana && !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction))) throw new Error("malformed reply from the seller");
      if (isSolana) {
        problem = "payment receipt not confirmed";
        const proof = await inspectSolana(payment, payment.accepted);
        const held = holds.get(proof.messageHash) as SvmHold | undefined;
        const confirmed = held && (await solana!.reconcile(held.solana, account.address, settlement.transaction)).settlement;
        if (!confirmed || confirmed.transaction !== settlement.transaction) throw new Error("payment receipt not confirmed");
        holds.delete(proof.messageHash);
      }
      const nonce = authorizationOf(payment)?.nonce;
      if (nonce) holds.delete(nonce);
      return { topic: request.topic, reading: reply.result, settlement, amount: request.accepted.amount, ms: Math.round(performance.now() - started) };
    } catch {
      let unused = false;
      try {
        if (isSolana) {
          const proof = await inspectSolana(payment, payment.accepted);
          unused = await solana!.expiredUnused({ ...proof, slot: request.solana!.slot, lastValidBlockHeight: request.solana!.lastValidBlockHeight }, account.address);
        } else {
          const auth = request.authorization!;
          unused = await baseExpiredUnused({ nonce: auth.nonce as Hex, validBefore: BigInt(auth.validBefore) }, payment.accepted.asset as Address);
        }
      } catch {}
      if (unused) throw new PurchaseExpiredError(request, "payment expired unused; retry to start a new purchase");
      throw new PurchasePendingError(request, problem);
    }
  }

  async function buy(topic: string): Promise<Purchase> {
    const started = performance.now();
    const { id, paymentRequired } = await quote(topic);
    const { payment } = await sign(paymentRequired);
    const accepted = payment.accepted;
    const request: PurchaseRequest = { version: 1, id, topic, broker: brokerIdentity(options.url), payer: account.address, accepted: { scheme: accepted.scheme, network: accepted.network, amount: accepted.amount, asset: accepted.asset, payTo: accepted.payTo, maxTimeoutSeconds: accepted.maxTimeoutSeconds, extra: isSolana ? { feePayer: accepted.extra?.feePayer } : { name: accepted.extra?.name, version: accepted.extra?.version } } };
    if (isSolana) {
      const transaction = decodeSolana((payment.payload as { transaction: string }).transaction);
      const proof = await inspectSolana(payment, accepted);
      const held = (holds.get(proof.messageHash) as SvmHold).solana;
      request.solana = { message: Buffer.from(transaction.messageBytes).toString("base64"), slot: held.slot, lastValidBlockHeight: held.lastValidBlockHeight };
    } else request.authorization = { ...(payment.payload as { authorization: NonNullable<PurchaseRequest["authorization"]> }).authorization };
    validateRequest(request);
    await options.onPrepared?.(structuredClone(request));
    return deliver(request, payment, started);
  }

  async function resume(value: PurchaseRequest): Promise<Purchase> {
    const started = performance.now();
    const request = structuredClone(value);
    validateRequest(request);
    if (resuming.has(request.id)) throw new Error("purchase already in progress");
    if (request.broker !== brokerIdentity(options.url) || (isSolana ? request.payer !== account.address : request.payer.toLowerCase() !== account.address.toLowerCase()) || !!request.solana !== isSolana) throw new Error("purchase record belongs to another broker, wallet or network");
    const amount = checkTerms(request.accepted);
    resuming.add(request.id);
    try {
      let payment: PaymentPayload;
      if (isSolana) {
        const transaction = unsignedSolana(request.solana!.message);
        const proof = await inspectSolanaMessage(transaction, request.accepted);
        if (proof.payer !== account.address) throw new Error("purchase signer mismatch");
        await reservePurchase(proof.messageHash, amount);
        holds.set(proof.messageHash, { amount, solana: { ...proof, slot: request.solana!.slot, lastValidBlockHeight: request.solana!.lastValidBlockHeight } });
        const signer = account as Awaited<ReturnType<typeof solanaSigner>>;
        const signature = await signBytes(signer.keyPair.privateKey, transaction.messageBytes);
        payment = { x402Version: 2, accepted: request.accepted, payload: { transaction: getBase64EncodedWireTransaction({ ...transaction, signatures: { ...transaction.signatures, [signer.address]: signature } }) } };
      } else {
        const auth = request.authorization!;
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (auth.from.toLowerCase() !== account.address.toLowerCase() || auth.to.toLowerCase() !== request.accepted.payTo.toLowerCase() || auth.value !== request.accepted.amount || BigInt(auth.validBefore) <= BigInt(auth.validAfter) || BigInt(auth.validAfter) > now || BigInt(auth.validBefore) > now + BigInt(request.accepted.maxTimeoutSeconds) + EXPIRY_MARGIN_SECONDS) throw new Error("purchase authorization mismatch");
        await reservePurchase(auth.nonce, amount);
        holds.set(auth.nonce as Hex, { amount, asset: request.accepted.asset as Address, nonce: auth.nonce as Hex, validBefore: BigInt(auth.validBefore) });
        const signature = await (account as ReturnType<typeof privateKeyToAccount>).signTypedData({ domain: { name: String(request.accepted.extra?.name), version: String(request.accepted.extra?.version), chainId: Number(network.split(":")[1]), verifyingContract: request.accepted.asset as Address }, types: authorizationTypes, primaryType: "TransferWithAuthorization", message: { from: auth.from as Address, to: auth.to as Address, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as Hex } });
        payment = { x402Version: 2, accepted: request.accepted, payload: { authorization: auth, signature } };
      }
      return await deliver(request, payment, started);
    } finally { resuming.delete(request.id); }
  }

  return {
    address: account.address,
    clientId,
    buy,
    resume,
    quote,
    sign,
    send,
    close: () => client.endAsync(),
  };
}
