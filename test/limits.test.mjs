import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import mqtt from "mqtt";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Ledger, Seller, SpendCapError, connectBridge, createBuyer, exportDataset, startBuiltInBroker } from "../dist/index.js";
import { startPage } from "../dist/page.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const accept = { scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } };
const port = () => 20000 + Math.floor(Math.random() * 20000);
const key = () => `0x${randomBytes(32).toString("hex")}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeFacilitator(counter) {
  return {
    verify: async () => {
      counter.verify += 1;
      return { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
    },
    settle: async () => {
      throw new Error("not used");
    },
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }),
  };
}

function payingFacilitator(counter) {
  return {
    ...fakeFacilitator(counter),
    verify: async () => {
      counter.verify += 1;
      return { isValid: true };
    },
    settle: async payment => ({ success: true, transaction: TX, network: "eip155:8453", payer: payment.payload.authorization.from }),
  };
}

function fakeRpc(options = {}) {
  const word = value => `0x${value.toString(16).padStart(64, "0")}`;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => (body += chunk));
    request.on("end", () => {
      const call = JSON.parse(body);
      const result = item => {
        if (item.method === "eth_chainId") return "0x2105";
        if (item.method === "eth_blockNumber") return "0x100000";
        if (item.method === "eth_getLogs") return options.logs ?? [];
        if (item.method === "eth_getTransactionReceipt") return options.receipt ?? null;
        const data = item.params?.[0]?.data ?? item.params?.[0]?.input ?? "";
        if (data.startsWith("0x70a08231")) return word(options.balance ?? 0n);
        if (data.startsWith("0xe94a0102")) return word(options.used ? 1n : 0n);
        return word(options.signature ? 1n : 0n);
      };
      const answer = item => ({ jsonrpc: "2.0", id: item.id, result: result(item) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(call) ? call.map(answer) : answer(call)));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, options, close: () => server.close() })));
}

async function fakeSeller(broker, onPaid, window = 120) {
  const client = await mqtt.connectAsync(broker.url, { username: broker.username, password: broker.password });
  await client.subscribeAsync("x402/v1/req/#", { qos: 1 });
  client.on("message", async (_topic, payload) => {
    const ask = JSON.parse(payload.toString());
    if (!ask["x402/payment"]) {
      client.publish(ask.replyTo, JSON.stringify({ id: ask.id, status: 402, paymentRequired: { x402Version: 2, resource: { url: "mqtt://test/t", description: "t", mimeType: "application/json" }, accepts: [{ ...accept, maxTimeoutSeconds: window }] } }), { qos: 1 });
      return;
    }
    await wait(50);
    client.publish(ask.replyTo, JSON.stringify(onPaid(ask)), { qos: 1 });
  });
  return client;
}

test("concurrent buys never exceed the total cap", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const seller = await fakeSeller(broker, ask => ({ id: ask.id, status: 200, result: { value: 1, ts: Date.now() }, "x402/payment-response": { success: true, transaction: "0x1", network: "eip155:8453", payer: PAY_TO } }));
  const buyer = await createBuyer({ url: broker.url, privateKey: key(), maxPerCall: "0.001", maxTotal: "0.003" });
  try {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => buyer.buy("t")));
    const paid = results.filter(result => result.status === "fulfilled").length;
    const capped = results.filter(result => result.status === "rejected" && result.reason instanceof SpendCapError).length;
    assert.equal(paid, 3);
    assert.equal(capped, 7);
  } finally {
    await buyer.close();
    await seller.endAsync();
    await broker.close();
  }
});

test("a seller that claims not charged cannot get past the cap", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const seller = await fakeSeller(broker, ask => ({ id: ask.id, status: 503, error: "device offline, not charged" }));
  const buyer = await createBuyer({ url: broker.url, privateKey: key(), maxPerCall: "0.001", maxTotal: "0.002" });
  try {
    await assert.rejects(buyer.buy("t"), /503/);
    await assert.rejects(buyer.buy("t"), /503/);
    await assert.rejects(buyer.buy("t"), SpendCapError);
  } finally {
    await buyer.close();
    await seller.endAsync();
    await broker.close();
  }
});

test("a held payment is released only after it expires unused on-chain", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const seller = await fakeSeller(broker, ask => ({ id: ask.id, status: 503, error: "device offline, not charged" }), 1);
  const unused = await fakeRpc({ used: false });
  const used = await fakeRpc({ used: true });
  const honest = await createBuyer({ url: broker.url, privateKey: key(), maxPerCall: "0.001", maxTotal: "0.001", rpcUrl: unused.url });
  const cheated = await createBuyer({ url: broker.url, privateKey: key(), maxPerCall: "0.001", maxTotal: "0.001", rpcUrl: used.url });
  try {
    await assert.rejects(honest.buy("t"), /503/);
    await assert.rejects(cheated.buy("t"), /503/);
    await assert.rejects(honest.buy("t"), SpendCapError);
    await wait(12_500);
    await assert.rejects(honest.buy("t"), /503/);
    await assert.rejects(cheated.buy("t"), SpendCapError);
  } finally {
    await honest.close();
    await cheated.close();
    unused.close();
    used.close();
    await seller.endAsync();
    await broker.close();
  }
});

test("quotes with long payment windows are refused", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const seller = await fakeSeller(broker, ask => ({ id: ask.id, status: 503 }), 3600);
  const buyer = await createBuyer({ url: broker.url, privateKey: key() });
  try {
    await assert.rejects(buyer.buy("t"), /payment window/);
  } finally {
    await buyer.close();
    await seller.endAsync();
    await broker.close();
  }
});

test("payments are never sent in cleartext to a remote broker", async () => {
  await assert.rejects(createBuyer({ url: "mqtt://broker.example.com:1883", privateKey: key() }), /mqtts:\/\/ or wss:\/\//);
  await assert.rejects(createBuyer({ url: "ws://10.0.0.5:9001/mqtt", privateKey: key() }), /refusing/);
});

function makeSeller(counter, rpc, extra = {}) {
  return new Seller({
    offers: [{ topic: "t", price: "0.001" }],
    payTo: PAY_TO,
    network: "eip155:8453",
    facilitator: fakeFacilitator(counter),
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "x402-mqtt-")), "ledger.jsonl")),
    readings: () => ({ value: 1, ts: Date.now() }),
    resourceBase: "mqtt://test",
    rpcUrl: rpc.url,
    ...extra,
  });
}

async function signed(seller, privateKey = key()) {
  const paymentRequired = { x402Version: 2, resource: { url: "mqtt://test/t", description: "t", mimeType: "application/json" }, accepts: seller.catalog().offers[0].accepts };
  return new x402Client().register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(privateKey))).createPaymentPayload(paymentRequired);
}

let asks = 0;
const ask = (seller, payment) => {
  asks += 1;
  return seller.handle("t", Buffer.from(JSON.stringify({ id: `a${asks}`, replyTo: `x402/v1/res/c${asks}/${asks}`, ...(payment ? { "x402/payment": payment } : {}) })));
};

const events = parseAbi(["event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const TX = `0x${"ab".repeat(32)}`;
const BLOCK = `0x${"cd".repeat(32)}`;
const log = (index, topics, data = "0x") => ({ address: USDC, blockHash: BLOCK, blockNumber: "0xfffff", data, logIndex: `0x${index.toString(16)}`, removed: false, topics, transactionHash: TX, transactionIndex: "0x0" });
const usedLog = (from, nonce) => log(0, encodeEventTopics({ abi: events, eventName: "AuthorizationUsed", args: { authorizer: from, nonce } }));
const transferLog = (from, to, value) => log(1, encodeEventTopics({ abi: events, eventName: "Transfer", args: { from, to } }), encodeAbiParameters([{ type: "uint256" }], [value]));
const receiptWith = logs => ({ blockHash: BLOCK, blockNumber: "0xfffff", contractAddress: null, cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", from: PAY_TO, gasUsed: "0x1", logs, logsBloom: `0x${"0".repeat(512)}`, status: "0x1", to: USDC, transactionHash: TX, transactionIndex: "0x0", type: "0x2" });

async function failedSettlement(setup) {
  const rpc = await fakeRpc({ balance: 10n ** 12n, used: true });
  const seller = makeSeller({ verify: 0 }, rpc, {
    facilitator: {
      verify: async () => ({ isValid: true }),
      settle: async () => {
        throw new Error("settlement failed");
      },
      getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: [], signers: {} }),
    },
  });
  await seller.start();
  const payment = await signed(seller);
  const { from, nonce } = payment.payload.authorization;
  setup(rpc, from, nonce);
  try {
    return await ask(seller, payment);
  } finally {
    rpc.close();
  }
}

test("a cancelled nonce is never taken as payment", async () => {
  const handled = await failedSettlement(() => {});
  assert.equal(handled.reply.status, 503);
  assert.equal(handled.reply.result, undefined);
});

test("a nonce spent on a transfer to someone else is never taken as payment", async () => {
  const handled = await failedSettlement((rpc, from, nonce) => {
    rpc.options.logs = [usedLog(from, nonce)];
    rpc.options.receipt = receiptWith([usedLog(from, nonce), transferLog(from, "0x1111111111111111111111111111111111111111", 1000n)]);
  });
  assert.equal(handled.reply.status, 503);
  assert.equal(handled.reply.result, undefined);
});

test("a real transfer to the payout for the exact amount still counts", async () => {
  const handled = await failedSettlement((rpc, from, nonce) => {
    rpc.options.logs = [usedLog(from, nonce)];
    rpc.options.receipt = receiptWith([usedLog(from, nonce), transferLog(from, PAY_TO, 1000n)]);
  });
  assert.equal(handled.reply.status, 200);
  assert.equal(handled.reply["x402/payment-response"].transaction, TX);
});

test("the seller never talks cleartext to a remote broker", async () => {
  await assert.rejects(connectBridge({ url: "mqtt://broker.example.com:1883", username: "x402-bridge", password: "secret" }), /refusing/);
  await assert.rejects(connectBridge({ url: "mqtt://broker.example.com:1883" }), /refusing/);
  const broker = await startBuiltInBroker({ port: port() });
  try {
    const { client } = await connectBridge({ url: broker.url });
    await client.endAsync();
  } finally {
    await broker.close();
  }
});

test("forged payments never reach the facilitator or the ledger", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc({ balance: 10n ** 12n });
  const seller = makeSeller(counter, rpc);
  await seller.start();
  const accepted = seller.catalog().offers[0].accepts[0];
  const now = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < 1000; index += 1) {
      const from = privateKeyToAccount(key()).address;
      await ask(seller, { x402Version: 2, accepted, payload: { signature: `0x${randomBytes(65).toString("hex")}`, authorization: { from, to: PAY_TO, value: "1000", validAfter: String(now - 60), validBefore: String(now + 120), nonce: `0x${randomBytes(32).toString("hex")}` } } });
    }
    assert.equal(counter.verify, 0);
    assert.equal(seller.options.ledger.all().length, 0);
  } finally {
    rpc.close();
  }
});

test("unfunded signers never reach the facilitator", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc({ balance: 0n });
  const seller = makeSeller(counter, rpc);
  await seller.start();
  try {
    for (let index = 0; index < 20; index += 1) {
      const handled = await ask(seller, await signed(seller));
      assert.equal(handled.reply.status, 400);
    }
    assert.equal(counter.verify, 0);
  } finally {
    rpc.close();
  }
});

test("a known buyer keeps paying through a flood of new signers", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc({ balance: 10n ** 12n });
  const seller = makeSeller(counter, rpc, { paymentsPerMinute: 20, facilitator: payingFacilitator(counter) });
  await seller.start();
  const buyerKey = key();
  try {
    await ask(seller, await signed(seller, buyerKey));
    const before = counter.verify;
    const statuses = [];
    for (let index = 0; index < 60; index += 1) statuses.push((await ask(seller, await signed(seller))).reply.status);
    assert.ok(statuses.includes(429));
    const during = counter.verify;
    await ask(seller, await signed(seller, buyerKey));
    assert.equal(counter.verify, during + 1);
    assert.ok(before >= 1);
  } finally {
    rpc.close();
  }
});

test("forged payments in a known buyer's name cannot block that buyer", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc({ balance: 10n ** 12n, signature: false });
  const seller = makeSeller(counter, rpc, { facilitator: payingFacilitator(counter) });
  await seller.start();
  const buyerKey = key();
  const from = privateKeyToAccount(buyerKey).address;
  const accepted = seller.catalog().offers[0].accepts[0];
  const now = Math.floor(Date.now() / 1000);
  try {
    await ask(seller, await signed(seller, buyerKey));
    for (let index = 0; index < 100; index += 1) {
      await ask(seller, { x402Version: 2, accepted, payload: { signature: `0x${randomBytes(65).toString("hex")}`, authorization: { from, to: PAY_TO, value: "1000", validAfter: String(now - 60), validBefore: String(now + 120), nonce: `0x${randomBytes(32).toString("hex")}` } } });
    }
    const before = counter.verify;
    await ask(seller, await signed(seller, buyerKey));
    assert.equal(counter.verify, before + 1);
  } finally {
    rpc.close();
  }
});

test("quotes stay cheap and do not need a global cap", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc();
  const seller = makeSeller(counter, rpc);
  await seller.start();
  try {
    let quotes = 0;
    for (let index = 0; index < 2000; index += 1) if ((await ask(seller)).reply.status === 402) quotes += 1;
    assert.equal(quotes, 2000);
    assert.equal(counter.verify, 0);
  } finally {
    rpc.close();
  }
});

test("buyers only sign for USDC", async () => {
  for (const network of ["eip155:8453", "eip155:84532"]) {
    const broker = await startBuiltInBroker({ port: port() });
    const client = await mqtt.connectAsync(broker.url, { username: broker.username, password: broker.password });
    await client.subscribeAsync("x402/v1/req/#", { qos: 1 });
    client.on("message", (_topic, payload) => {
      const request = JSON.parse(payload.toString());
      client.publish(request.replyTo, JSON.stringify({ id: request.id, status: 402, paymentRequired: { x402Version: 2, resource: { url: "mqtt://test/t", description: "t", mimeType: "application/json" }, accepts: [{ ...accept, network, asset: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" }] } }), { qos: 1 });
    });
    const buyer = await createBuyer({ url: broker.url, privateKey: key(), network });
    try {
      await assert.rejects(buyer.buy("t"), /only USDC/);
    } finally {
      await buyer.close();
      await client.endAsync();
      await broker.close();
    }
  }
});

test("buyers refuse networks without a known USDC", async () => {
  await assert.rejects(createBuyer({ url: "mqtt://127.0.0.1:1", privateKey: key(), network: "eip155:1" }), /unsupported network/);
});

test("a malformed reading from the seller is rejected", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const seller = await fakeSeller(broker, request => ({ id: request.id, status: 200, result: { value: { evil: true }, ts: Date.now() }, "x402/payment-response": { success: true, transaction: "0x1", network: "eip155:8453", payer: PAY_TO } }));
  const buyer = await createBuyer({ url: broker.url, privateKey: key() });
  try {
    await assert.rejects(buyer.buy("t"), /malformed/);
  } finally {
    await buyer.close();
    await seller.endAsync();
    await broker.close();
  }
});

test("the local page only answers its own host", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc();
  const seller = makeSeller(counter, rpc);
  await seller.start();
  const pagePort = port();
  const server = await startPage({ port: pagePort, seller, ledger: seller.options.ledger, offers: [{ topic: "t", price: "0.001" }], latest: new Map(), testBuyers: [] });
  const status = host => new Promise(resolve => {
    import("node:http").then(({ request }) => request({ host: "127.0.0.1", port: pagePort, path: "/api/state", headers: { host } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).end());
  });
  try {
    assert.equal(await status(`127.0.0.1:${pagePort}`), 200);
    assert.equal(await status(`localhost:${pagePort}`), 200);
    assert.equal(await status("rebind.attacker.example"), 403);
  } finally {
    server.close();
    rpc.close();
  }
});

test("the built-in broker drops requests that reply to someone else", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const bridge = await mqtt.connectAsync(broker.url, { username: broker.username, password: broker.password });
  const seen = [];
  await bridge.subscribeAsync("x402/v1/req/#", { qos: 1 });
  bridge.on("message", (_topic, payload) => seen.push(JSON.parse(payload.toString()).id));
  const anon = await mqtt.connectAsync(broker.url, { clientId: "x402-buyer-honest", reconnectPeriod: 0 });
  try {
    await anon.publishAsync("x402/v1/req/t", JSON.stringify({ id: "own", replyTo: "x402/v1/res/x402-buyer-honest/own" }), { qos: 0 });
    await anon.publishAsync("x402/v1/req/t", JSON.stringify({ id: "spoof", replyTo: "x402/v1/res/someone-else/spoof" }), { qos: 0 });
    await wait(300);
    assert.deepEqual(seen, ["own"]);
  } finally {
    await anon.endAsync(true);
    await bridge.endAsync();
    await broker.close();
  }
});

test("limiter state stays bounded under unique requesters", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc();
  const seller = makeSeller(counter, rpc, { maxRequesters: 100 });
  await seller.start();
  try {
    for (let index = 0; index < 2000; index += 1) await ask(seller);
    assert.ok(seller.buckets.size <= 100, `kept ${seller.buckets.size} requesters`);
  } finally {
    rpc.close();
  }
});

test("payments the facilitator refuses never earn the trusted tier", async () => {
  const rpc = await fakeRpc({ balance: 10n ** 12n });
  const invalid = makeSeller({ verify: 0 }, rpc);
  const down = makeSeller({ verify: 0 }, rpc, {
    facilitator: {
      ...fakeFacilitator({ verify: 0 }),
      verify: async () => {
        throw new Error("down");
      },
    },
  });
  await invalid.start();
  await down.start();
  const buyerKey = key();
  try {
    assert.equal((await ask(invalid, await signed(invalid, buyerKey))).reply.status, 400);
    assert.equal((await ask(down, await signed(down, buyerKey))).reply.status, 503);
    assert.equal(invalid.trusted.size, 0);
    assert.equal(down.trusted.size, 0);
  } finally {
    rpc.close();
  }
});

test("facilitator calls share one global budget", async () => {
  const counter = { verify: 0 };
  const rpc = await fakeRpc({ balance: 10n ** 12n });
  const seller = makeSeller(counter, rpc, { facilitatorPerMinute: 5 });
  await seller.start();
  try {
    for (let index = 0; index < 20; index += 1) await ask(seller, await signed(seller));
    assert.equal(counter.verify, 5);
  } finally {
    rpc.close();
  }
});

test("a fallback settlement only counts in the quoted token", async () => {
  const OTHER = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
  const rpc = await fakeRpc({ balance: 10n ** 12n, used: true });
  const seller = makeSeller({ verify: 0 }, rpc, {
    offers: [{ topic: "t", price: "0.001" }, { topic: "t2", price: "0.001" }],
    facilitator: {
      ...fakeFacilitator({ verify: 0 }),
      verify: async () => ({ isValid: true }),
      settle: async () => {
        throw new Error("settlement failed");
      },
    },
  });
  await seller.start();
  const other = seller.requirements.get("t2").map(item => ({ ...item, asset: OTHER }));
  seller.requirements.set("t2", other);
  const client = new x402Client();
  client.setSpendControls(false);
  const payment = await client.register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(key()))).createPaymentPayload({ x402Version: 2, resource: { url: "mqtt://test/t2", description: "t2", mimeType: "application/json" }, accepts: other });
  const { from, nonce } = payment.payload.authorization;
  rpc.options.logs = [usedLog(from, nonce)];
  rpc.options.receipt = receiptWith([usedLog(from, nonce), transferLog(from, PAY_TO, 1000n)]);
  try {
    const handled = await seller.handle("t2", Buffer.from(JSON.stringify({ id: "other", replyTo: "x402/v1/res/other/1", "x402/payment": payment })));
    assert.equal(handled.reply.status, 503);
    assert.equal(seller.options.ledger.all().find(entry => entry.state === "verified").asset, OTHER);
  } finally {
    rpc.close();
  }
});

test("the built-in broker drops oversized requests", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const bridge = await mqtt.connectAsync(broker.url, { username: broker.username, password: broker.password });
  const seen = [];
  await bridge.subscribeAsync("x402/v1/req/#", { qos: 1 });
  bridge.on("message", (_topic, payload) => seen.push(JSON.parse(payload.toString()).id));
  const anon = await mqtt.connectAsync(broker.url, { clientId: "x402-buyer-big", reconnectPeriod: 0 });
  try {
    await anon.publishAsync("x402/v1/req/t", JSON.stringify({ id: "small", replyTo: "x402/v1/res/x402-buyer-big/small" }), { qos: 0 });
    await anon.publishAsync("x402/v1/req/t", JSON.stringify({ id: "big", replyTo: "x402/v1/res/x402-buyer-big/big", pad: "x".repeat(20000) }), { qos: 0 });
    await wait(300);
    assert.deepEqual(seen, ["small"]);
  } finally {
    await anon.endAsync(true);
    await bridge.endAsync();
    await broker.close();
  }
});

test("a new buyer still gets a quote when requesters are full", async () => {
  const rpc = await fakeRpc();
  const seller = makeSeller({ verify: 0 }, rpc, { maxRequesters: 100 });
  await seller.start();
  const quote = id => seller.handle("t", Buffer.from(JSON.stringify({ id, replyTo: `x402/v1/res/${id}/1` })));
  try {
    for (let index = 0; index < 100; index += 1) assert.equal((await quote(`spray${index}`)).reply.status, 402);
    await wait(700);
    assert.equal((await quote("honest")).reply.status, 402);
    assert.ok(seller.buckets.size <= 100);
  } finally {
    rpc.close();
  }
});

test("exported CSV cells never start a formula", async () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-mqtt-"));
  const ledger = new Ledger(join(dir, "ledger.jsonl"));
  const markers = ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"];
  for (const [index, value] of markers.entries()) ledger.append({ id: `c${index}`, topic: "t", state: "settled", amount: "1000", reading: { value, ts: Date.now() } });
  exportDataset(join(dir, "ledger.jsonl"), join(dir, "out"), []);
  const cells = readFileSync(join(dir, "out", "x402-mqtt-sales.csv"), "utf8").split("\n").slice(1, -1).map(line => line.split(",")[2].replace(/^"/, ""));
  assert.equal(cells.length, markers.length);
  for (const cell of cells) assert.ok(cell.startsWith("'"), cell);
});
