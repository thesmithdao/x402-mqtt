import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import mqtt from "mqtt";
import { Ledger, Seller, SpendCapError, createBuyer, startBuiltInBroker } from "../dist/index.js";

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

async function fakeSeller(broker, onPaid) {
  const client = await mqtt.connectAsync(broker.url, { username: broker.username, password: broker.password });
  await client.subscribeAsync("x402/v1/req/#", { qos: 1 });
  client.on("message", async (_topic, payload) => {
    const ask = JSON.parse(payload.toString());
    if (!ask["x402/payment"]) {
      client.publish(ask.replyTo, JSON.stringify({ id: ask.id, status: 402, paymentRequired: { x402Version: 2, resource: { url: "mqtt://test/t", description: "t", mimeType: "application/json" }, accepts: [accept] } }), { qos: 1 });
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

test("a not-charged reply releases the reserved amount", async () => {
  const broker = await startBuiltInBroker({ port: port() });
  const seller = await fakeSeller(broker, ask => ({ id: ask.id, status: 503, error: "device offline, not charged" }));
  const buyer = await createBuyer({ url: broker.url, privateKey: key(), maxPerCall: "0.001", maxTotal: "0.001" });
  try {
    await assert.rejects(buyer.buy("t"), /503/);
    await assert.rejects(buyer.buy("t"), /503/);
  } finally {
    await buyer.close();
    await seller.endAsync();
    await broker.close();
  }
});

test("a flood of fake requesters cannot run up facilitator calls or limiter state", async () => {
  const counter = { verify: 0 };
  const seller = new Seller({
    offers: [{ topic: "t", price: "0.001" }],
    payTo: PAY_TO,
    network: "eip155:8453",
    facilitator: fakeFacilitator(counter),
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "x402-mqtt-")), "ledger.jsonl")),
    readings: () => ({ value: 1, ts: Date.now() }),
    resourceBase: "mqtt://test",
  });
  await seller.start();
  const accepted = seller.catalog().offers[0].accepts[0];
  let quotes = 0;
  for (let index = 0; index < 2000; index += 1) {
    const replyTo = `x402/v1/res/fake-${index}/${index}`;
    const paid = index % 2 === 1;
    const payment = { x402Version: 2, accepted, payload: { signature: "0x00", authorization: { from: PAY_TO, to: PAY_TO, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: `0x${randomBytes(32).toString("hex")}` } } };
    const handled = await seller.handle("t", Buffer.from(JSON.stringify({ id: `a${index}`, replyTo, ...(paid ? { "x402/payment": payment } : {}) })));
    if (handled?.reply.status === 402) quotes += 1;
  }
  assert.ok(counter.verify <= 120, `facilitator verified ${counter.verify} fake payments`);
  assert.ok(quotes <= 600, `answered ${quotes} quotes`);
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
  const seller = new Seller({
    offers: [{ topic: "t", price: "0.001" }],
    payTo: PAY_TO,
    network: "eip155:8453",
    facilitator: fakeFacilitator({ verify: 0 }),
    ledger: new Ledger(join(mkdtempSync(join(tmpdir(), "x402-mqtt-")), "ledger.jsonl")),
    readings: () => ({ value: 1, ts: Date.now() }),
    resourceBase: "mqtt://test",
    maxRequesters: 100,
  });
  await seller.start();
  for (let index = 0; index < 2000; index += 1) {
    await seller.handle("t", Buffer.from(JSON.stringify({ id: `a${index}`, replyTo: `x402/v1/res/fake-${index}/${index}` })));
  }
  assert.ok(seller.buckets.size <= 100, `kept ${seller.buckets.size} requesters`);
});
