#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Hex } from "viem";
import { startBuiltInBroker, type BuiltInBroker } from "./broker.js";
import { connectBridge, startBridge } from "./bridge.js";
import { createBuyer } from "./buyer.js";
import { loadConfig } from "./config.js";
import { exportDataset } from "./export.js";
import { createFacilitator } from "./facilitator.js";
import { Ledger } from "./ledger.js";
import { startPage } from "./page.js";
import { Seller } from "./seller.js";
import { hasBattery, macOffers, startMacSource } from "./sources/mac.js";

const help = `x402-mqtt · x402 payments over MQTT

  x402-mqtt sell --payout 0x… [--mac] [--price 0.001] [--broker mqtt://…] [--facilitator coinbase|https://…]
  x402-mqtt buy <topic> [--broker mqtt://127.0.0.1:1883] [--max 0.01] [--allow-cleartext]      (X402_MQTT_BUYER_KEY)
  x402-mqtt export [--out dataset]

  sell reads x402-mqtt.json when present. The coinbase facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET.`;

async function sell(values: Record<string, string | boolean | undefined>) {
  const config = loadConfig(values.config as string | undefined, {
    payout: values.payout as `0x${string}` | undefined,
    broker: values.broker as string | undefined,
    facilitator: values.facilitator as string | undefined,
    price: values.price as string | undefined,
    source: values.mac ? "mac" : undefined,
    host: values.host as string | undefined,
  });

  const offers = [...config.offers];
  if (config.source === "mac") {
    const battery = await hasBattery();
    offers.push(...macOffers(config.price).filter(offer => battery || !/^mac\/(battery|power)\//.test(offer.topic)));
  }
  if (!offers.length) throw new Error("nothing to sell: add --mac or offers in x402-mqtt.json");

  let url = config.broker;
  let username = config.brokerUsername;
  let password = config.brokerPassword;
  let broker: BuiltInBroker | undefined;
  if (config.broker === "built-in") {
    broker = await startBuiltInBroker({ host: config.host, port: config.port });
    ({ url, username, password } = broker);
  }

  const facilitator = await createFacilitator(config.facilitator);
  const ledger = new Ledger(config.ledger);
  const { client, latest } = await connectBridge({ url, username, password });
  const seller = new Seller({
    offers,
    payTo: config.payout,
    network: config.network,
    facilitator,
    ledger,
    readings: topic => latest.get(topic),
    resourceBase: url.replace(/\/\/[^@/]*@/, "//"),
    maxAgeMs: config.maxAgeSeconds * 1000,
    rpcUrl: config.rpcUrl,
  });
  await seller.start();
  const bridge = await startBridge(client, latest, seller);
  const stopSource = config.source === "mac" ? startMacSource(bridge.publishReading) : undefined;
  const page = config.pagePort === false ? undefined : await startPage({ port: config.pagePort, seller, ledger, offers, latest, testBuyers: config.testBuyers });

  console.log(`selling on ${url.replace(/\/\/[^@/]*@/, "//")} · payout ${config.payout} · Base`);
  for (const offer of offers) console.log(`  ${offer.topic.padEnd(28)} $${offer.price}`);
  if (page) console.log(`sales page  http://127.0.0.1:${config.pagePort}`);
  seller.on("entry", entry => {
    if (entry.state === "settled" || entry.state === "recovered") console.log(`sold  ${entry.topic}  $${Number(entry.amount) / 1e6}  tx ${entry.tx}`);
    else if (entry.state !== "verified") console.log(`refused  ${entry.topic}  ${entry.error}`);
  });

  const shutdown = async () => {
    stopSource?.();
    page?.close();
    await bridge.close();
    await broker?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function buy(topic: string | undefined, values: Record<string, string | boolean | undefined>) {
  if (!topic) throw new Error("usage: x402-mqtt buy <topic>");
  const key = process.env.X402_MQTT_BUYER_KEY?.trim();
  if (!key) throw new Error("set X402_MQTT_BUYER_KEY to a small-balance wallet key");
  const buyer = await createBuyer({
    url: (values.broker as string | undefined) ?? "mqtt://127.0.0.1:1883",
    privateKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex,
    maxPerCall: (values.max as string | undefined) ?? "0.01",
    allowCleartext: values["allow-cleartext"] === true,
  });
  try {
    const purchase = await buyer.buy(topic);
    const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    const value = clean(`${purchase.reading.value}${purchase.reading.unit ? ` ${purchase.reading.unit}` : ""}`);
    const tx = /^0x[0-9a-fA-F]{64}$/.test(purchase.settlement.transaction) ? purchase.settlement.transaction : "unknown";
    console.log(`paid $${Number(purchase.amount) / 1e6} · ${value} · tx ${tx}`);
    if (tx !== "unknown") console.log(`https://basescan.org/tx/${tx}`);
  } finally {
    await buyer.close();
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      payout: { type: "string" },
      broker: { type: "string" },
      facilitator: { type: "string" },
      price: { type: "string" },
      host: { type: "string" },
      mac: { type: "boolean" },
      "allow-cleartext": { type: "boolean" },
      max: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, argument] = positionals;
  if (command === "sell") return sell(values);
  if (command === "buy") return buy(argument, values);
  if (command === "export") {
    const config = loadConfig(values.config, { payout: "0x0000000000000000000000000000000000000001" });
    const result = exportDataset(config.ledger, values.out ?? "dataset", config.testBuyers);
    return console.log(`exported ${result.rows} sales → ${values.out ?? "dataset"}/ (${result.files.join(", ")})`);
  }
  console.log(help);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
