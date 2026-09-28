import { existsSync, readFileSync } from "node:fs";
import { isAddress, type Address } from "viem";
import type { Network } from "@x402/core/types";
import { isValidTopic, type Offer } from "./spec.js";

export type Config = {
  broker: "built-in" | string;
  brokerUsername?: string;
  brokerPassword?: string;
  host: string;
  port: number;
  payout: Address;
  network: Network;
  facilitator: string;
  source?: "mac";
  price: string;
  offers: Offer[];
  maxAgeSeconds: number;
  ledger: string;
  pagePort: number | false;
  testBuyers: string[];
  rpcUrl?: string;
  allowCleartext?: boolean;
};

const defaults = {
  broker: "built-in",
  host: "127.0.0.1",
  port: 1883,
  network: "eip155:8453" as Network,
  facilitator: "coinbase",
  price: "0.001",
  offers: [] as Offer[],
  maxAgeSeconds: 30,
  ledger: "x402-mqtt-ledger.jsonl",
  pagePort: 4020 as number | false,
  testBuyers: [] as string[],
};

export function loadConfig(path: string | undefined, overrides: Partial<Config>): Config {
  const file = path ?? "x402-mqtt.json";
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Config>) : {};
  const config = { ...defaults, ...fromFile, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) } as Config;
  if (!config.payout || !isAddress(config.payout)) throw new Error("set a payout address: --payout 0x… or \"payout\" in x402-mqtt.json");
  if (!/^\d+(\.\d{1,6})?$/.test(config.price)) throw new Error("price must be a USD amount like 0.001");
  for (const offer of config.offers) {
    if (!isValidTopic(offer.topic)) throw new Error(`invalid topic: ${offer.topic}`);
    if (!/^\d+(\.\d{1,6})?$/.test(offer.price)) throw new Error(`invalid price for ${offer.topic}`);
  }
  return config;
}
