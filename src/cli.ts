#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { PurchaseStore, publicBrokerUrl, type PurchaseRequest } from "./recovery.js";
import { SOLANA_NETWORK } from "./solana.js";
import { explorerUrl, networkName } from "./networks.js";
import { startBuiltInBroker, type BuiltInBroker } from "./broker.js";
import { connectBridge, startBridge } from "./bridge.js";
import { createBuyer, PurchaseExpiredError, PurchasePendingError } from "./buyer.js";
import { loadConfig } from "./config.js";
import { exportDataset } from "./export.js";
import { createFacilitator } from "./facilitator.js";
import { Ledger } from "./ledger.js";
import { startPage } from "./page.js";
import { Seller } from "./seller.js";
import { hasBattery, macOffers, startMacSource } from "./sources/mac.js";

const help = `x402-mqtt · x402 payments over MQTT

  x402-mqtt sell --payout <address> [--network base|solana] [--solana-payout <address>] [--mac] [--price 0.001] [--broker mqtt://…] [--facilitator coinbase|https://…]
  x402-mqtt buy <topic> [--network base|solana] [--broker mqtt://127.0.0.1:1883] [--max 0.01] [--allow-cleartext]      (X402_MQTT_BUYER_KEY)
  x402-mqtt export [--out dataset]

  sell reads x402-mqtt.json when present. The coinbase facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET.`;

function selectedNetwork(value: string | boolean | undefined) {
  if (value === undefined) return undefined;
  if (value === "base") return "eip155:8453" as const;
  if (value === "solana") return SOLANA_NETWORK;
  throw new Error("network must be base or solana");
}

async function sell(values: Record<string, string | boolean | undefined>) {
  const config = loadConfig(values.config as string | undefined, {
    payout: values.payout as string | undefined,
    network: selectedNetwork(values.network),
    solanaPayout: values["solana-payout"] as string | undefined,
    solanaRpcUrl: values["solana-rpc"] as string | undefined,
    rpcUrl: values.rpc as string | undefined,
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
  const { client, latest } = await connectBridge({ url, username, password, allowCleartext: broker !== undefined || config.allowCleartext === true || values["allow-cleartext"] === true });
  const seller = new Seller({
    offers,
    payTo: config.payout,
    network: config.network,
    facilitator,
    ledger,
    readings: topic => latest.get(topic),
    resourceBase: publicBrokerUrl(url),
    maxAgeMs: config.maxAgeSeconds * 1000,
    rpcUrl: config.rpcUrl,
    solanaPayout: config.solanaPayout,
    solanaRpcUrl: config.solanaRpcUrl,
  });
  await seller.start();
  const bridge = await startBridge(client, latest, seller);
  const stopSource = config.source === "mac" ? startMacSource(bridge.publishReading) : undefined;
  const page = config.pagePort === false ? undefined : await startPage({ port: config.pagePort, seller, ledger, offers, latest, testBuyers: config.testBuyers });

  console.log(`selling on ${publicBrokerUrl(url)} · payout ${config.payout} · ${networkName(config.network)}${config.solanaPayout ? " + Solana" : ""}`);
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
  const url = (values.broker as string | undefined) ?? "mqtt://127.0.0.1:1883";
  const network = selectedNetwork(values.network) ?? "eip155:8453";
  let store: PurchaseStore;
  let request: PurchaseRequest | undefined;
  const buyer = await createBuyer({
    url,
    network,
    rpcUrl: values.rpc as string | undefined,
    privateKey: selectedNetwork(values.network) === SOLANA_NETWORK ? key : (key.startsWith("0x") ? key : `0x${key}`),
    maxPerCall: (values.max as string | undefined) ?? "0.01",
    allowCleartext: values["allow-cleartext"] === true,
    onPrepared: value => { store.save(value); request = value; },
  });
  try {
    store = new PurchaseStore(join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "x402-mqtt"), url, network, buyer.address, topic);
    request = store.load();
    const purchase = request ? await buyer.resume(request) : await buyer.buy(topic);
    store.remove(request!);
    const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
    const value = clean(`${purchase.reading.value}${purchase.reading.unit ? ` ${purchase.reading.unit}` : ""}`);
    const link = explorerUrl(purchase.settlement.network, purchase.settlement.transaction);
    const tx = link ? purchase.settlement.transaction : "unknown";
    console.log(`paid $${Number(purchase.amount) / 1e6} · ${value} · tx ${tx}`);
    if (link) console.log(link);
  } catch (error) {
    if (error instanceof PurchaseExpiredError && request) store!.remove(request);
    if (error instanceof PurchasePendingError && !(error instanceof PurchaseExpiredError)) throw new Error(`${error.message}; rerun this command to resume`);
    throw error;
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
      network: { type: "string" },
      "solana-payout": { type: "string" },
      "solana-rpc": { type: "string" },
      rpc: { type: "string" },
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
  console.error((error instanceof Error ? error.message : "request failed").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 256));
  process.exit(1);
});
