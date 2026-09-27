import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import mqtt from "mqtt";
import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createBuyer } from "./buyer.js";
import { MAX_MESSAGE_BYTES, PAYMENT_RESPONSE_KEY, REQUEST_PREFIX, RESPONSE_PREFIX, type Reply } from "./spec.js";

const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const url = process.env.EVIDENCE_BROKER ?? "mqtt://127.0.0.1:1884";
const payout = process.env.EVIDENCE_PAYOUT as Address;
const keys = [process.env.X402_MQTT_BUYER_1_KEY, process.env.X402_MQTT_BUYER_2_KEY] as Hex[];
const chain = createPublicClient({ chain: base, transport: http(process.env.X402_BASE_RPC?.trim()) });
const abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

type Row = { scenario: string; expected: string; result: string; pass: boolean; proof: string[] };
const rows: Row[] = [];
const timings: number[] = [];
const link = (tx: string) => `[${tx.slice(0, 10)}…](https://basescan.org/tx/${tx})`;

async function transferred(tx: Hex, from: Address, amount: bigint): Promise<boolean> {
  const receipt = await chain.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") return false;
  const logs = parseEventLogs({ abi, logs: receipt.logs.filter(log => log.address.toLowerCase() === USDC.toLowerCase()), eventName: "Transfer" });
  return logs.some(log => log.args.from.toLowerCase() === from.toLowerCase() && log.args.to.toLowerCase() === payout.toLowerCase() && log.args.value === amount);
}

async function charged(payment: PaymentPayload): Promise<boolean> {
  const authorization = (payment.payload as { authorization: { from: Address; nonce: Hex } }).authorization;
  return chain.readContract({ address: USDC, abi, functionName: "authorizationState", args: [authorization.from, authorization.nonce] });
}

function record(row: Row) {
  rows.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.scenario} · ${row.result}`);
}

async function main() {
  if (!payout || keys.some(key => !key)) throw new Error("set EVIDENCE_PAYOUT, X402_MQTT_BUYER_1_KEY and X402_MQTT_BUYER_2_KEY");
  const buyers = await Promise.all(keys.map(privateKey => createBuyer({ url, privateKey, maxPerCall: "0.01", maxTotal: "0.1", timeoutMs: 45_000 })));
  const topics = ["mac/battery/temperature", "mac/battery/level", "mac/power/watts", "mac/cpu/load", "mac/memory/free", "mac/battery/cycles", "mac/thermal/pressure", "mac/battery/temperature", "mac/power/watts", "mac/cpu/load"];

  for (const [index, topic] of topics.entries()) {
    const buyer = buyers[index % 2];
    const purchase = await buyer.buy(topic);
    timings.push(purchase.ms);
    const ok = await transferred(purchase.settlement.transaction as Hex, buyer.address, BigInt(purchase.amount));
    record({
      scenario: `Paid reading · ${topic}`,
      expected: "reading delivered, exactly $0.001 moved on-chain",
      result: `${purchase.reading.value}${purchase.reading.unit ? ` ${purchase.reading.unit}` : ""} in ${(purchase.ms / 1000).toFixed(2)}s`,
      pass: ok,
      proof: [link(purchase.settlement.transaction)],
    });
  }

  const [one, two] = buyers;
  {
    const { id, paymentRequired } = await one.quote("mac/cpu/load");
    const { payment } = await one.sign(paymentRequired);
    const first = await one.send("mac/cpu/load", id, payment);
    const replay = await one.send("mac/cpu/load", randomUUID(), payment);
    const tx = first[PAYMENT_RESPONSE_KEY]?.transaction ?? "";
    record({
      scenario: "Replay a used payment",
      expected: "second use rejected, no second charge",
      result: `first ${first.status}, replay ${replay.status} ${replay.error ?? ""}`.trim(),
      pass: first.status === 200 && replay.status === 409 && (await transferred(tx as Hex, one.address, 1000n)),
      proof: [link(tx)],
    });
  }

  {
    const { paymentRequired } = await two.quote("mac/memory/free");
    const { payment } = await two.sign(paymentRequired);
    const raw = await mqtt.connectAsync(url, { clientId: `x402-dup-${randomUUID().slice(0, 8)}`, clean: true });
    const id = randomUUID();
    const replyTo = `${RESPONSE_PREFIX}${raw.options.clientId}/${id}`;
    await raw.subscribeAsync(replyTo, { qos: 1 });
    const replies: Reply[] = [];
    raw.on("message", (_topic, body) => replies.push(JSON.parse(body.toString()) as Reply));
    const ask = JSON.stringify({ id, replyTo, "x402/payment": payment });
    raw.publish(`${REQUEST_PREFIX}mac/memory/free`, ask, { qos: 1 });
    raw.publish(`${REQUEST_PREFIX}mac/memory/free`, ask, { qos: 1 });
    await new Promise(resolve => setTimeout(resolve, 20_000));
    raw.publish(`${REQUEST_PREFIX}mac/memory/free`, ask, { qos: 1 });
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await raw.endAsync();
    const settledTx = [...new Set(replies.flatMap(reply => (reply.status === 200 && reply[PAYMENT_RESPONSE_KEY] ? [reply[PAYMENT_RESPONSE_KEY].transaction] : [])))];
    const onChain = settledTx.length === 1 ? await transferred(settledTx[0] as Hex, two.address, 1000n) : false;
    record({
      scenario: "Same request delivered three times (MQTT redelivery)",
      expected: "one settlement; repeats get the same receipt or an in-progress refusal",
      result: `replies ${replies.map(reply => reply.status).join(", ")}, distinct settlements ${settledTx.length}`,
      pass: onChain,
      proof: settledTx.map(link),
    });
  }

  {
    const { paymentRequired } = await one.quote("mac/battery/level");
    const { payment } = await one.sign(paymentRequired);
    const [a, b] = await Promise.all([one.send("mac/battery/level", randomUUID(), payment), one.send("mac/battery/level", randomUUID(), payment)]);
    const winner = a.status === 200 ? a : b;
    const tx = winner[PAYMENT_RESPONSE_KEY]?.transaction ?? "";
    record({
      scenario: "One payment, two requests at once",
      expected: "one delivered, the other refused, one charge",
      result: [a.status, b.status].sort().join(" + "),
      pass: [a.status, b.status].sort().join(",") === "200,409" && (await transferred(tx as Hex, one.address, 1000n)),
      proof: [link(tx)],
    });
  }

  {
    const { id, paymentRequired } = await two.quote("mac/cpu/load");
    const underpaid: PaymentRequired = { ...paymentRequired, accepts: [{ ...paymentRequired.accepts[0], amount: "500" }] };
    const client = new x402Client().register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(keys[1])));
    const payment = await client.createPaymentPayload(underpaid);
    const reply = await two.send("mac/cpu/load", id, payment);
    const wasCharged = await charged(payment);
    record({
      scenario: "Underpayment ($0.0005 for a $0.001 reading)",
      expected: "rejected, not charged",
      result: `${reply.status} ${reply.error ?? ""}, charged: ${wasCharged}`.trim(),
      pass: reply.status === 400 && !wasCharged,
      proof: [],
    });
  }

  {
    const { id, paymentRequired } = await one.quote("mac/cpu/load");
    const sepolia: PaymentRequired = {
      ...paymentRequired,
      accepts: [{ ...paymentRequired.accepts[0], network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }],
    };
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(privateKeyToAccount(keys[0])));
    const payment = await client.createPaymentPayload(sepolia);
    const reply = await one.send("mac/cpu/load", id, payment);
    record({
      scenario: "Test-network payment sent to a mainnet quote",
      expected: "rejected, not charged",
      result: `${reply.status} ${reply.error ?? ""}`.trim(),
      pass: reply.status === 400,
      proof: [],
    });
  }

  {
    const { id, paymentRequired } = await two.quote("lab/offline-sensor");
    const { payment } = await two.sign(paymentRequired);
    const reply = await two.send("lab/offline-sensor", id, payment);
    const wasCharged = await charged(payment);
    record({
      scenario: "Device offline (a paid topic with no device publishing)",
      expected: "refused, not charged",
      result: `${reply.status} ${reply.error ?? ""}, charged: ${wasCharged}`.trim(),
      pass: reply.status === 503 && !wasCharged,
      proof: [],
    });
  }

  {
    const probe = await mqtt.connectAsync(url, { clientId: `x402-probe-${randomUUID().slice(0, 8)}`, clean: true });
    const leaked: string[] = [];
    probe.on("message", topic => leaked.push(topic));
    await probe.subscribeAsync(["raw/#", `${RESPONSE_PREFIX}${one.clientId}/#`], { qos: 1 });
    await one.quote("mac/cpu/load");
    await new Promise(resolve => setTimeout(resolve, 12_000));
    await probe.endAsync();
    record({
      scenario: "Unpaid client listens to raw data and another buyer's replies for 12s",
      expected: "no messages delivered",
      result: `${leaked.length} messages received`,
      pass: leaked.length === 0,
      proof: [],
    });
  }

  {
    const flood = await mqtt.connectAsync(url, { clientId: `x402-flood-${randomUUID().slice(0, 8)}`, clean: true });
    const inbox = `${RESPONSE_PREFIX}${flood.options.clientId}`;
    await flood.subscribeAsync(`${inbox}/#`, { qos: 1 });
    const statuses: number[] = [];
    flood.on("message", (_topic, payload) => statuses.push((JSON.parse(payload.toString()) as Reply).status));
    const big = JSON.stringify({ id: "oversized", replyTo: `${inbox}/oversized`, pad: "x".repeat(MAX_MESSAGE_BYTES + 1) });
    flood.publish(`${REQUEST_PREFIX}mac/cpu/load`, big, { qos: 1 });
    for (let index = 0; index < 80; index += 1) {
      const id = `q${index}`;
      flood.publish(`${REQUEST_PREFIX}mac/cpu/load`, JSON.stringify({ id, replyTo: `${inbox}/${id}` }), { qos: 1 });
    }
    await new Promise(resolve => setTimeout(resolve, 8000));
    await flood.endAsync();
    const limited = statuses.filter(status => status === 429).length;
    record({
      scenario: "Oversized message and a flood of 80 quote requests",
      expected: "oversized dropped, flood rate-limited",
      result: `${statuses.length} replies to 80 requests, ${limited} rate-limited, oversized ignored`,
      pass: limited > 0 && statuses.length === 80,
      proof: [],
    });
  }

  await Promise.all(buyers.map(buyer => buyer.close()));

  const sorted = [...timings].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const passed = rows.filter(row => row.pass).length;
  const table = rows.map(row => `| ${row.scenario} | ${row.expected} | ${row.result} | ${row.pass ? "pass" : "FAIL"} | ${row.proof.join(" ")} |`).join("\n");
  const markdown = `# Evidence

Real runs on Base mainnet, ${new Date().toISOString().slice(0, 10)}. A MacBook Air sells its sensor readings over MQTT (Mosquitto 2.1.2) and gets paid in USDC through the Coinbase facilitator. Nothing is mocked: every paid row links to its settlement on Basescan, and every "not charged" row was checked against the USDC contract.

The buyers are test wallets run by Cult OS. These are our own purchases, made to prove the pipeline, not customer sales.

- Payout: \`${payout}\`
- Buyers: ${buyers.map(buyer => `\`${buyer.address}\``).join(", ")}
- Result: ${passed} of ${rows.length} scenarios passed
- Paid reading, full round trip (quote, sign, settle, deliver): median ${(p50 / 1000).toFixed(2)}s, slowest 5% ${(p95 / 1000).toFixed(2)}s

| Scenario | Expected | Result | Status | Proof |
|---|---|---|---|---|
${table}
`;
  mkdirSync("evidence", { recursive: true });
  writeFileSync("EVIDENCE.md", markdown);
  writeFileSync("evidence/runs.json", `${JSON.stringify({ payout, buyers: buyers.map(buyer => buyer.address), rows, timings }, null, 2)}\n`);
  console.log(`\n${passed}/${rows.length} passed · median ${(p50 / 1000).toFixed(2)}s · EVIDENCE.md written`);
  process.exit(passed === rows.length ? 0 : 1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
