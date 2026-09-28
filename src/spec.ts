import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";

export const REQUEST_PREFIX = "x402/v1/req/";
export const RESPONSE_PREFIX = "x402/v1/res/";
export const CATALOG_TOPIC = "x402/v1/catalog";
export const RAW_PREFIX = "raw/";
export const PAYMENT_KEY = "x402/payment";
export const PAYMENT_RESPONSE_KEY = "x402/payment-response";
export const MAX_MESSAGE_BYTES = 16384;

export type Reading = { value: number | string; unit?: string; ts: number };

export type Ask = {
  id: string;
  replyTo: string;
  [PAYMENT_KEY]?: PaymentPayload;
};

export type Reply = {
  id: string;
  status: number;
  error?: string;
  paymentRequired?: PaymentRequired;
  result?: Reading;
  [PAYMENT_RESPONSE_KEY]?: SettleResponse;
};

export type Offer = { topic: string; price: string; description?: string; unit?: string };

export type CatalogEntry = { topic: string; description?: string; unit?: string; accepts: PaymentRequirements[] };

export type Catalog = { x402Version: 2; updatedAt: string; offers: CatalogEntry[] };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidTopic(topic: string): boolean {
  if (topic.length === 0 || topic.length > 200) return false;
  if (topic.startsWith("/") || topic.startsWith("$")) return false;
  if (topic.includes("#") || topic.includes("+")) return false;
  return topic.split("/").every(part => part.length > 0);
}

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function parseAsk(payload: Buffer): Ask | undefined {
  if (payload.length > MAX_MESSAGE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const ask = value as Record<string, unknown>;
  if (!isValidId(ask.id)) return undefined;
  if (typeof ask.replyTo !== "string" || !ask.replyTo.startsWith(RESPONSE_PREFIX) || !isValidTopic(ask.replyTo)) return undefined;
  const payment = ask[PAYMENT_KEY];
  if (payment !== undefined && (!payment || typeof payment !== "object")) return undefined;
  return { id: ask.id, replyTo: ask.replyTo, [PAYMENT_KEY]: payment as PaymentPayload | undefined };
}

export function isReading(value: unknown): value is Reading {
  if (!value || typeof value !== "object") return false;
  const { value: reading, unit, ts } = value as Record<string, unknown>;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  if (typeof reading === "number" && !Number.isFinite(reading)) return false;
  if (typeof reading !== "number" && (typeof reading !== "string" || reading.length > 256)) return false;
  return unit === undefined || (typeof unit === "string" && unit.length <= 16);
}

export function parseReading(payload: Buffer): Reading | undefined {
  if (payload.length > 1024) return undefined;
  try {
    const value = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    if (!isReading(value)) return undefined;
    return { value: value.value, unit: value.unit, ts: value.ts };
  } catch {
    return undefined;
  }
}
