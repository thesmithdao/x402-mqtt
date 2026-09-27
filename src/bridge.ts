import { randomBytes } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { CATALOG_TOPIC, RAW_PREFIX, REQUEST_PREFIX, parseReading, type Reading } from "./spec.js";
import type { Seller } from "./seller.js";

export type Bridge = {
  client: MqttClient;
  latest: Map<string, Reading>;
  publishReading: (topic: string, reading: Reading) => void;
  close: () => Promise<void>;
};

export async function connectBridge(options: { url: string; username?: string; password?: string }): Promise<{ client: MqttClient; latest: Map<string, Reading> }> {
  const client = await mqtt.connectAsync(options.url, {
    clientId: `x402-bridge-${randomBytes(4).toString("hex")}`,
    username: options.username,
    password: options.password,
    clean: true,
    reconnectPeriod: 2000,
  });
  return { client, latest: new Map() };
}

export async function startBridge(client: MqttClient, latest: Map<string, Reading>, seller: Seller): Promise<Bridge> {
  client.on("message", (topic, payload) => {
    if (topic.startsWith(RAW_PREFIX)) {
      const reading = parseReading(payload);
      if (reading) latest.set(topic.slice(RAW_PREFIX.length), reading);
      return;
    }
    if (!topic.startsWith(REQUEST_PREFIX)) return;
    seller
      .handle(topic.slice(REQUEST_PREFIX.length), payload)
      .then(handled => (handled ? client.publishAsync(handled.replyTo, JSON.stringify(handled.reply), { qos: 1 }) : undefined))
      .catch(() => undefined);
  });

  await client.subscribeAsync([`${RAW_PREFIX}#`, `${REQUEST_PREFIX}#`], { qos: 1 });
  await client.publishAsync(CATALOG_TOPIC, JSON.stringify(seller.catalog()), { qos: 1, retain: true });

  return {
    client,
    latest,
    publishReading: (topic, reading) => {
      client.publish(`${RAW_PREFIX}${topic}`, JSON.stringify(reading), { qos: 0 });
    },
    close: async () => {
      await client.endAsync();
    },
  };
}
