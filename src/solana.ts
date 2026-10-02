import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS, transactionMessageHash, validateSvmAddress } from "@x402/svm";
import { address, createKeyPairSignerFromBytes, decompileTransactionMessage, getAddressEncoder, getBase58Decoder, getBase58Encoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress, getTransactionDecoder, verifySignature } from "@solana/kit";

export const SOLANA_NETWORK = SOLANA_MAINNET_CAIP2;
export const SOLANA_USDC = USDC_MAINNET_ADDRESS;
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type SolanaProof = { messageHash: string; source: string; destination: string; blockhash: string; slot: number };
export type SolanaPayment = SolanaProof & { payer: string; amount: string };
type ChainTransaction = { transaction: [string, string]; meta: { err: unknown } | null; slot: number };
type SignatureRow = { signature: string; slot: number; err: unknown };

export async function solanaSigner(key: string) {
  try {
    const bytes = getBase58Encoder().encode(key);
    if (bytes.length !== 64) throw new Error();
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    throw new Error("Solana key must be a base58-encoded 64-byte keypair");
  }
}

export async function tokenAccount(owner: string): Promise<string> {
  const encode = getAddressEncoder();
  const [account] = await getProgramDerivedAddress({ programAddress: ATA, seeds: [encode.encode(address(owner)), encode.encode(TOKEN), encode.encode(address(SOLANA_USDC))] });
  return account;
}

export function decodeSolana(transaction: string) {
  if (typeof transaction !== "string" || transaction.length > 1800 || !/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)) throw new Error("invalid Solana transaction");
  const bytes = getBase64Encoder().encode(transaction);
  if (bytes.length > 1232) throw new Error("invalid Solana transaction");
  return getTransactionDecoder().decode(bytes);
}

export function solanaIdentity(payment: PaymentPayload) {
  const transaction = decodeSolana((payment.payload as { transaction: string }).transaction);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return { payer: compiled.staticAccounts[1], feePayer: compiled.staticAccounts[0], messageHash: transactionMessageHash(transaction) };
}

export async function inspectSolana(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SolanaPayment> {
  if (payment.x402Version !== 2 || requirements.network !== SOLANA_NETWORK || requirements.asset !== SOLANA_USDC) throw new Error("unsupported Solana payment");
  const transaction = decodeSolana((payment.payload as { transaction: string }).transaction);
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (compiled.header.numSignerAccounts !== 2 || ("addressTableLookups" in compiled && compiled.addressTableLookups?.length)) throw new Error("unsupported Solana transaction");
  const feePayer = compiled.staticAccounts[0];
  const payer = compiled.staticAccounts[1];
  if (!payer || feePayer !== requirements.extra?.feePayer || feePayer === payer) throw new Error("invalid Solana fee payer");
  const instructions = decompileTransactionMessage(compiled).instructions;
  if (instructions.length !== 4) throw new Error("unsupported Solana instructions");
  const [limit, price, transfer, memo] = instructions;
  const data = (value: typeof transfer) => new DataView(Uint8Array.from(value.data ?? []).buffer);
  if (limit.programAddress !== COMPUTE || limit.data?.length !== 5 || limit.data[0] !== 2 || data(limit).getUint32(1, true) > 400_000) throw new Error("invalid compute limit");
  if (price.programAddress !== COMPUTE || price.data?.length !== 9 || price.data[0] !== 3 || data(price).getBigUint64(1, true) > 50_000n) throw new Error("invalid compute price");
  if (limit.accounts?.length || price.accounts?.length || memo.accounts?.length || memo.programAddress !== MEMO || !memo.data?.length || memo.data.length > 256) throw new Error("invalid Solana memo");
  if (transfer.programAddress !== TOKEN || transfer.data?.length !== 10 || transfer.data[0] !== 12 || transfer.data[9] !== 6 || transfer.accounts?.length !== 4) throw new Error("invalid USDC transfer");
  const [source, mint, destination, authority] = transfer.accounts;
  if (source.role !== 1 || destination.role !== 1 || mint.role !== 0 || authority.role !== 2 || compiled.header.numReadonlySignerAccounts !== 1) throw new Error("unsupported Solana account roles");
  const [expectedSource, expectedDestination] = await Promise.all([tokenAccount(payer), tokenAccount(requirements.payTo)]);
  const amount = data(transfer).getBigUint64(1, true).toString();
  if (source.address !== expectedSource || mint.address !== SOLANA_USDC || destination.address !== expectedDestination || authority.address !== payer || amount !== requirements.amount || source.address === destination.address) throw new Error("payment does not match the quote");
  const signature = transaction.signatures[payer];
  if (!signature || !signature.some(byte => byte !== 0)) throw new Error("invalid payment signature");
  const publicKey = await crypto.subtle.importKey("raw", Uint8Array.from(getAddressEncoder().encode(payer)), "Ed25519", false, ["verify"]);
  if (!await verifySignature(publicKey, signature, transaction.messageBytes)) throw new Error("invalid payment signature");
  return { payer, amount, source: expectedSource, destination: expectedDestination, blockhash: compiled.lifetimeToken, messageHash: transactionMessageHash(transaction), slot: 0 };
}

export class SolanaChain {
  constructor(readonly url = "https://api.mainnet-beta.solana.com") {
    const { protocol, hostname, username, password } = new URL(url);
    if (username || password || (protocol !== "https:" && !(protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)))) throw new Error("Solana RPC must use HTTPS or loopback HTTP");
  }

  async call<T>(method: string, params: unknown[] = [], deadline = Date.now() + 10_000): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Solana RPC timeout");
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(Math.min(remaining, 10_000)), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!response.ok || !response.body) throw new Error("Solana RPC unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_048_576) throw new Error("Solana RPC response too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: T; error?: unknown };
    if (result.error || !("result" in result)) throw new Error("Solana RPC unavailable");
    return result.result as T;
  }

  async initialize(): Promise<void> {
    const genesis = await this.call<string>("getGenesisHash");
    if (typeof genesis !== "string" || genesis.slice(0, 32) !== SOLANA_NETWORK.slice(7)) throw new Error("Solana RPC network mismatch");
  }

  async context(): Promise<number> {
    const slot = await this.call<number>("getSlot", [{ commitment: "finalized" }]);
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error("invalid Solana slot");
    return Math.max(0, slot - 200);
  }

  async balance(source: string): Promise<bigint> {
    const result = await this.call<{ value: { amount: string; decimals: number } }>("getTokenAccountBalance", [source, { commitment: "confirmed" }]);
    if (result.value?.decimals !== 6 || !/^\d+$/.test(result.value.amount)) throw new Error("invalid USDC balance");
    return BigInt(result.value.amount);
  }

  async reconcile(proof: SolanaProof, payer: string, knownSignature?: string, commitment: "confirmed" | "finalized" = "confirmed"): Promise<{ settlement?: SettleResponse; complete: boolean }> {
    const deadline = Date.now() + 15_000;
    const check = async (signature: string): Promise<SettleResponse | undefined> => {
      if (!validSolanaSignature(signature)) return undefined;
      const result = await this.call<ChainTransaction | null>("getTransaction", [signature, { encoding: "base64", commitment, maxSupportedTransactionVersion: 0 }], deadline);
      if (!result) throw new Error("Solana history incomplete");
      if (!result.meta || result.meta.err !== null) return undefined;
      const transaction = decodeSolana(result.transaction[0]);
      const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      const firstSignature = transaction.signatures[compiled.staticAccounts[0]];
      if (!firstSignature || getBase58Decoder().decode(firstSignature) !== signature || transactionMessageHash(transaction) !== proof.messageHash) return undefined;
      return { success: true, transaction: signature, network: SOLANA_NETWORK, payer };
    };
    if (knownSignature) {
      const settlement = await check(knownSignature);
      if (settlement) return { settlement, complete: true };
    }
    let before: string | undefined;
    for (let page = 0; page < 2; page += 1) {
      const rows = await this.call<SignatureRow[]>("getSignaturesForAddress", [proof.source, { commitment, limit: 100, ...(before ? { before } : {}) }], deadline);
      if (!Array.isArray(rows) || rows.length > 100) throw new Error("invalid Solana history");
      for (const row of rows) {
        if (!Number.isSafeInteger(row.slot) || !validSolanaSignature(row.signature)) throw new Error("invalid Solana history");
        if (row.slot < proof.slot) return { complete: true };
        if (row.err === null) {
          const settlement = await check(row.signature);
          if (settlement) return { settlement, complete: true };
        }
      }
      if (rows.length < 100) return { complete: true };
      before = rows.at(-1)?.signature;
    }
    return { complete: false };
  }

  async expiredUnused(proof: SolanaProof, payer: string): Promise<boolean> {
    const valid = await this.call<{ value: boolean }>("isBlockhashValid", [proof.blockhash, { commitment: "finalized" }]);
    if (valid.value !== false) return false;
    const firstSlot = await this.call<number>("minimumLedgerSlot");
    if (!Number.isSafeInteger(firstSlot) || firstSlot > proof.slot) return false;
    const result = await this.reconcile(proof, payer, undefined, "finalized");
    return result.complete && !result.settlement;
  }
}

export function validSolanaSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
  try { return getBase58Encoder().encode(value).length === 64; } catch { return false; }
}

export { validateSvmAddress };
