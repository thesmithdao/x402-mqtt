import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from "@solana/kit";
import { Ledger, Seller, SpendCapError, createBuyer, startBuiltInBroker, connectBridge, startBridge, exportDataset } from "../dist/index.js";
import { SOLANA_NETWORK, SOLANA_USDC, SolanaChain, decodeSolana, inspectSolana, tokenAccount } from "../dist/solana.js";
import { explorerUrl, walletIdentity } from "../dist/networks.js";
import { loadConfig } from "../dist/config.js";

async function fixture(t, options = {}) {
  const payer = await createKeyPairSignerFromPrivateKeyBytes(randomBytes(32), true);
  const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", payer.keyPair.privateKey)).slice(-32);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", payer.keyPair.publicKey));
  const key = getBase58Decoder().decode(Uint8Array.from([...seed, ...publicBytes]));
  const fee = await createKeyPairSignerFromPrivateKeyBytes(randomBytes(32));
  const recipient = await createKeyPairSignerFromPrivateKeyBytes(randomBytes(32));
  const state = { verify: 0, settle: 0, txs: new Map(), rows: [], funded: true, valid: true, historyDown: false, wrongCluster: false, ...options };
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const rpcServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks));
    let result;
    if (call.method === "getGenesisHash") result = state.wrongCluster ? recipient.address : SOLANA_NETWORK.slice(7);
    else if (call.method === "getSlot") result = 1000;
    else if (call.method === "getAccountInfo") result = { context: { slot: 1000 }, value: { data: [mint.toString("base64"), "base64"], executable: false, lamports: 1461600, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 82 } };
    else if (call.method === "getLatestBlockhash") result = { context: { slot: 1000 }, value: { blockhash: recipient.address, lastValidBlockHeight: 1200 } };
    else if (call.method === "getTokenAccountBalance") result = { context: { slot: 1000 }, value: { amount: state.funded ? "1000000" : "0", decimals: 6, uiAmount: state.funded ? 1 : 0, uiAmountString: state.funded ? "1" : "0" } };
    else if (call.method === "isBlockhashValid") result = { context: { slot: 1400 }, value: state.valid };
    else if (call.method === "minimumLedgerSlot") result = state.firstSlot ?? 0;
    else if (call.method === "getTransaction") result = state.txs.get(call.params[0]) ?? null;
    else if (call.method === "getSignaturesForAddress") result = state.rows;
    else { response.writeHead(500); response.end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(state.historyDown && call.method === "getSignaturesForAddress" ? { jsonrpc: "2.0", id: call.id, error: { code: -1, message: "unavailable" } } : { jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise(resolve => rpcServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => rpcServer.close(resolve)));
  const rpc = `http://127.0.0.1:${rpcServer.address().port}`;
  const path = join(mkdtempSync(join(tmpdir(), "mqtt-solana-test-")), "ledger.jsonl");
  const accept = { scheme: "exact", network: SOLANA_NETWORK, amount: "1000", asset: SOLANA_USDC, payTo: recipient.address, maxTimeoutSeconds: 120, extra: { feePayer: fee.address } };
  const supported = { kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_NETWORK, extra: { feePayer: fee.address } }, { x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: { [SOLANA_NETWORK]: [fee.address] } };
  const broadcast = async payment => {
    const decoded = decodeSolana(payment.payload.transaction);
    const [feeSignatures] = await fee.signTransactions([decoded]);
    const transaction = { ...decoded, signatures: { ...decoded.signatures, ...feeSignatures } };
    const signature = getBase58Decoder().decode(transaction.signatures[fee.address]);
    state.txs.set(signature, { transaction: [getBase64EncodedWireTransaction(transaction), "base64"], meta: { err: state.chainError ?? null }, slot: 1001 });
    state.rows = [{ signature, slot: 1001, err: state.chainError ?? null }, ...state.rows];
    return { success: true, transaction: signature, network: SOLANA_NETWORK, payer: payer.address };
  };
  const facilitator = {
    getSupported: async () => supported,
    verify: async () => { state.verify += 1; return { isValid: state.verifyValid ?? true, payer: payer.address }; },
    settle: async payment => {
      state.settle += 1;
      if (state.refuse) throw new Error("refused");
      const receipt = await broadcast(payment);
      if (state.drop) throw new Error("response lost");
      if (state.pending) throw Object.assign(new Error("pending"), { transaction: receipt.transaction });
      return state.receiptMutation ? { ...receipt, ...state.receiptMutation } : receipt;
    },
  };
  const makeSeller = (overrides = {}) => new Seller({ offers: [{ topic: "sensor", price: "0.001" }, { topic: "other", price: "0.001" }], payTo: recipient.address, network: SOLANA_NETWORK, facilitator, ledger: new Ledger(path), readings: () => ({ value: 42, ts: Date.now() }), resourceBase: "mqtt://local", rpcUrl: rpc, ...overrides });
  const seller = makeSeller();
  if (!state.wrongCluster) await seller.start();
  const signing = new x402Client().register(SOLANA_NETWORK, new ExactSvmScheme(toClientSvmSigner(payer), { rpcUrl: rpc }));
  const sign = async (terms = seller.catalog().offers[0].accepts[0]) => signing.createPaymentPayload({ x402Version: 2, resource: { url: "mqtt://local/sensor" }, accepts: [terms] });
  const ask = async (payment, id = "request", topic = "sensor") => (await seller.handle(topic, Buffer.from(JSON.stringify({ id, replyTo: `x402/v1/res/test/${id}`, ...(payment ? { "x402/payment": payment } : {}) })))).reply;
  return { payer, key, fee, recipient, state, rpc, path, accept, supported, seller, makeSeller, sign, ask, broadcast };
}

test("Solana payments deliver once and bind the saved reading to the original request/topic", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  const results = await Promise.all([f.ask(payment), f.ask(payment)]);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  assert.equal(f.state.settle, 1);
  const receipt = results.find(row => row.status === 200)["x402/payment-response"];
  const again = await f.ask(payment);
  assert.deepEqual(again["x402/payment-response"], receipt);
  assert.equal((await f.ask(payment, "another")).status, 409);
  assert.equal((await f.ask(payment, "request", "other")).status, 409);
  const second = await f.sign();
  assert.equal((await f.ask(second)).status, 409);
  assert.equal(f.state.settle, 1);
  assert.equal(new Ledger(f.path).all().filter(row => row.state === "settled").length, 1);
  assert.ok(!readFileSync(f.path, "utf8").includes(payment.payload.transaction));
});

test("lost Solana settlement response recovers the exact transfer without another settlement", async t => {
  const f = await fixture(t, { drop: true });
  const payment = await f.sign();
  assert.equal((await f.ask(payment)).status, 200);
  assert.equal(f.state.settle, 1);
  assert.equal(new Ledger(f.path).all().at(-1).state, "recovered");
});

test("Solana saved replies survive a changed facilitator fee payer without accepting old new payments", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  const original = await f.ask(payment);
  f.supported.kinds[0].extra.feePayer = f.recipient.address;
  const restarted = f.makeSeller({ readings: () => undefined });
  await restarted.start();
  const ask = async value => (await restarted.handle("sensor", Buffer.from(JSON.stringify({ id: "request", replyTo: "x402/v1/res/test/request", "x402/payment": value })))).reply;
  assert.deepEqual(await ask(payment), original);
  assert.equal((await ask(await f.sign())).status, 400);
  const forged = structuredClone(payment);
  const bytes = Buffer.from(forged.payload.transaction, "base64");
  bytes[70] ^= 1;
  forged.payload.transaction = bytes.toString("base64");
  assert.equal((await ask(forged)).status, 400);
  assert.equal(f.state.settle, 1);
});

test("pending Solana payments survive restart and recover the original reading when the device is offline", async t => {
  const f = await fixture(t, { drop: true, historyDown: true });
  const payment = await f.sign();
  assert.equal((await f.ask(payment)).status, 503);
  assert.equal(new Ledger(f.path).pending().length, 1);
  f.state.historyDown = false;
  f.supported.kinds[0].extra.feePayer = f.recipient.address;
  const restarted = f.makeSeller({ readings: () => undefined });
  await restarted.start();
  const reply = (await restarted.handle("sensor", Buffer.from(JSON.stringify({ id: "request", replyTo: "x402/v1/res/test/request", "x402/payment": payment })))).reply;
  assert.equal(reply.status, 200);
  assert.equal(reply.result.value, 42);
  assert.equal(f.state.settle, 1);
});

test("Solana pending signature is reconciled but failed or unrelated transactions are not payment", async t => {
  const f = await fixture(t, { pending: true });
  assert.equal((await f.ask(await f.sign())).status, 200);
  f.state.chainError = { InstructionError: [2, "failed"] };
  assert.equal((await f.ask(await f.sign(), "failed")).status, 503);
  const chain = new SolanaChain(f.rpc);
  const payment = await f.sign();
  const proof = { ...await inspectSolana(payment, payment.accepted), slot: 800 };
  assert.equal((await chain.reconcile(proof, f.payer.address)).settlement, undefined);
});

test("wrong Solana terms and forged signatures never reach the facilitator", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  for (const mutation of [{ network: "eip155:8453" }, { asset: f.payer.address }, { amount: "999" }, { payTo: f.payer.address }, { extra: { feePayer: f.payer.address } }]) {
    assert.equal((await f.ask({ ...payment, accepted: { ...payment.accepted, ...mutation } })).status, 400);
  }
  for (const transaction of ["bad", "A".repeat(1804), "", 123, payment.payload.transaction.slice(0, -12)]) assert.equal((await f.ask({ ...payment, payload: { transaction } })).status, 400);
  const decoded = decodeSolana(payment.payload.transaction);
  const forged = { ...decoded, signatures: { ...decoded.signatures, [f.payer.address]: new Uint8Array(64) } };
  assert.equal((await f.ask({ ...payment, payload: { transaction: getBase64EncodedWireTransaction(forged) } })).status, 400);
  assert.equal(f.state.verify, 0);
  assert.equal(f.state.settle, 0);
});

test("changing the fee-payer signature bytes cannot evade Solana duplicate protection", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  assert.equal((await f.ask(payment)).status, 200);
  const decoded = decodeSolana(payment.payload.transaction);
  const altered = { ...decoded, signatures: { ...decoded.signatures, [f.fee.address]: randomBytes(64) } };
  assert.equal((await f.ask({ ...payment, payload: { transaction: getBase64EncodedWireTransaction(altered) } }, "new")).status, 409);
  assert.equal(f.state.settle, 1);
});

test("unfunded, offline, invalid and future readings are never settled on Solana", async t => {
  const f = await fixture(t, { funded: false });
  assert.equal((await f.ask(await f.sign())).status, 400);
  assert.equal(f.state.verify, 0);
  f.state.funded = true;
  for (const reading of [undefined, { value: NaN, ts: Date.now() }, { value: 1, ts: Date.now() - 60000 }, { value: 1, ts: Date.now() + 10000 }]) {
    const seller = f.makeSeller({ readings: () => reading });
    await seller.start();
    const payment = await f.sign();
    const reply = (await seller.handle("sensor", Buffer.from(JSON.stringify({ id: "r", replyTo: "x402/v1/res/test/r", "x402/payment": payment })))).reply;
    assert.equal(reply.status, 503);
  }
  assert.equal(f.state.settle, 0);
});

test("Solana quotes require supported fee-payer metadata and a matching RPC cluster", async t => {
  const f = await fixture(t);
  f.state.wrongCluster = true;
  await assert.rejects(f.makeSeller().start(), /network mismatch/);
  f.state.wrongCluster = false;
  delete f.supported.kinds[0].extra;
  await assert.rejects(f.makeSeller().start(), /fee payer/);
});

test("a Base seller advertises optional Solana without changing its Base quote", async t => {
  const f = await fixture(t);
  const seller = f.makeSeller({ network: "eip155:8453", payTo: "0x0000000000000000000000000000000000000001", solanaPayout: f.recipient.address, solanaRpcUrl: f.rpc });
  await seller.start();
  const accepts = seller.catalog().offers[0].accepts;
  assert.deepEqual(accepts.map(item => item.network), ["eip155:8453", SOLANA_NETWORK]);
  assert.deepEqual(accepts.map(item => item.amount), ["1000", "1000"]);
});

test("Solana expiry cannot release spending without complete finalized history", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  const proof = { ...await inspectSolana(payment, payment.accepted), slot: 800 };
  const chain = new SolanaChain(f.rpc);
  assert.equal(await chain.expiredUnused(proof, f.payer.address), false);
  f.state.valid = false;
  assert.equal(await chain.expiredUnused(proof, f.payer.address), true);
  f.state.firstSlot = 900;
  assert.equal(await chain.expiredUnused(proof, f.payer.address), false);
  f.state.firstSlot = 0;
  f.state.historyDown = true;
  await assert.rejects(chain.expiredUnused(proof, f.payer.address));
  f.state.historyDown = false;
  await f.broadcast(payment);
  assert.equal(await chain.expiredUnused(proof, f.payer.address), false);
});

test("Solana casing, explorer mapping and test exclusions remain network-specific", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  const receipt = await f.broadcast(payment);
  assert.equal(walletIdentity(SOLANA_NETWORK, f.payer.address), f.payer.address);
  assert.equal(explorerUrl("unknown", receipt.transaction), undefined);
  assert.ok(explorerUrl(SOLANA_NETWORK, receipt.transaction).startsWith("https://solscan.io/tx/"));
  assert.equal(explorerUrl(SOLANA_NETWORK, "https://example.com"), undefined);
  await f.ask(payment);
  const out = join(mkdtempSync(join(tmpdir(), "mqtt-export-")), "out");
  exportDataset(f.path, out, [f.payer.address]);
  assert.equal(JSON.parse(readFileSync(join(out, "x402-mqtt-sales.jsonl"), "utf8")).buyer, "cult-os-test");
});

test("Solana config is explicit and corrupt ledgers refuse startup", async t => {
  const f = await fixture(t);
  assert.equal(loadConfig("/nonexistent", { network: SOLANA_NETWORK, payout: f.recipient.address }).payout, f.recipient.address);
  assert.throws(() => loadConfig("/nonexistent", { network: SOLANA_NETWORK, payout: "0x0000000000000000000000000000000000000001" }), /payout/);
  writeFileSync(f.path, '{"id":"partial"');
  assert.throws(() => new Ledger(f.path), /corrupt/);
  writeFileSync(f.path, JSON.stringify({ ts: new Date().toISOString(), id: "request", topic: "sensor", state: "unknown" }));
  assert.throws(() => new Ledger(f.path), /corrupt/);
});

async function localBuyer(t, f, overrides = {}) {
  const broker = await startBuiltInBroker({ port: 0 });
  const connection = await connectBridge({ url: broker.url, username: broker.username, password: broker.password });
  const bridge = await startBridge(connection.client, connection.latest, f.seller);
  const buyer = await createBuyer({ url: broker.url, privateKey: f.key, network: SOLANA_NETWORK, rpcUrl: f.rpc, maxPerCall: "0.001", maxTotal: "0.003", ...overrides });
  t.after(async () => { await buyer.close(); await bridge.close(); await broker.close(); });
  return buyer;
}

test("Solana buyer enforces concurrent caps and confirms its receipt", async t => {
  const f = await fixture(t);
  const buyer = await localBuyer(t, f);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => buyer.buy("sensor")));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 3);
  assert.equal(results.filter(row => row.status === "rejected" && row.reason instanceof SpendCapError).length, 5);
  assert.equal(f.state.settle, 3);
  assert.equal(new Set(f.state.rows.map(row => row.signature)).size, 3);
});

test("Solana buyer holds pending spending and reclaims only expired unused payments", async t => {
  const f = await fixture(t, { refuse: true });
  const buyer = await localBuyer(t, f, { maxTotal: "0.001" });
  await assert.rejects(buyer.buy("sensor"), /pending/);
  await assert.rejects(buyer.buy("sensor"), SpendCapError);
  f.state.valid = false;
  f.state.historyDown = true;
  await assert.rejects(buyer.buy("sensor"), SpendCapError);
  f.state.historyDown = false;
  await assert.rejects(buyer.buy("sensor"), /pending/);
  assert.equal(f.state.settle, 2);
});

test("Solana buyer refuses a receipt for another transfer even when its own payment exists", async t => {
  const f = await fixture(t);
  const unrelated = await f.broadcast(await f.sign());
  f.state.receiptMutation = { transaction: unrelated.transaction };
  const buyer = await localBuyer(t, f, { maxTotal: "0.001" });
  await assert.rejects(buyer.buy("sensor"), /receipt not confirmed/);
  await assert.rejects(buyer.buy("sensor"), SpendCapError);
  assert.equal(f.state.settle, 1);
});

test("Solana buyer refuses malformed prices, mints and fee payers before signing", async t => {
  const f = await fixture(t);
  const buyer = await localBuyer(t, f);
  const { paymentRequired } = await buyer.quote("sensor");
  for (const mutation of [{ amount: "-1" }, { amount: "0" }, { amount: "1e3" }, { maxTimeoutSeconds: -1 }, { asset: f.payer.address }, { extra: {} }]) {
    await assert.rejects(buyer.sign({ ...paymentRequired, accepts: [{ ...paymentRequired.accepts[0], ...mutation }] }));
  }
  const { payment } = await buyer.sign(paymentRequired);
  assert.ok(payment.payload.transaction);
  assert.equal(f.state.settle, 0);
});

test("signed hostile Solana instructions are rejected before facilitator calls", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  const mutations = [
    message => { message.instructions[2].data = Uint8Array.from([12, 231, 3, 0, 0, 0, 0, 0, 0, 6]); },
    message => { message.instructions[2].data[9] = 9; },
    message => { new DataView(message.instructions[0].data.buffer).setUint32(1, 400001, true); },
    message => { new DataView(message.instructions[1].data.buffer).setBigUint64(1, 50001n, true); },
    message => { message.instructions.push(message.instructions[2]); },
    message => { message.instructions[3].programAddressIndex = message.instructions[2].programAddressIndex; },
    message => { message.instructions[2].accountIndices[2] = message.instructions[2].accountIndices[0]; },
  ];
  for (const mutate of mutations) {
    const transaction = decodeSolana(payment.payload.transaction);
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    compiled.instructions = compiled.instructions.map(instruction => ({ ...instruction, data: Uint8Array.from(instruction.data ?? []), accountIndices: [...(instruction.accountIndices ?? [])] }));
    mutate(compiled);
    const changed = { ...transaction, messageBytes: getCompiledTransactionMessageEncoder().encode(compiled) };
    const [signatures] = await f.payer.signTransactions([changed]);
    changed.signatures = { ...transaction.signatures, ...signatures };
    assert.equal((await f.ask({ ...payment, payload: { transaction: getBase64EncodedWireTransaction(changed) } })).status, 400);
  }
  assert.equal(f.state.verify, 0);
  assert.equal(f.state.settle, 0);
});

test("ledger write failure prevents Solana settlement", async t => {
  const f = await fixture(t);
  f.seller.options.ledger.append = () => { throw new Error("disk full"); };
  await assert.rejects(f.ask(await f.sign()), /disk full/);
  assert.equal(f.state.settle, 0);
});

test("Solana recovery stops at its history bound and does not release spending", async t => {
  const f = await fixture(t);
  const payment = await f.sign();
  const proof = { ...await inspectSolana(payment, payment.accepted), slot: 800 };
  const receipt = await f.broadcast(await f.sign());
  f.state.rows = Array.from({ length: 100 }, () => ({ signature: receipt.transaction, slot: 1001, err: { failed: true } }));
  f.state.valid = false;
  assert.equal((await new SolanaChain(f.rpc).reconcile(proof, f.payer.address)).complete, false);
  assert.equal(await new SolanaChain(f.rpc).expiredUnused(proof, f.payer.address), false);
});
