import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "./ledger.js";

export type DatasetRow = {
  time: string;
  topic: string;
  value: number | string | undefined;
  unit: string | undefined;
  reading_time: string | undefined;
  price_usd: number;
  network: string | undefined;
  tx: string | undefined;
  payer: string | undefined;
  buyer: "cult-os-test" | "external";
  latency_ms: number | undefined;
};

const columns: (keyof DatasetRow)[] = ["time", "topic", "value", "unit", "reading_time", "price_usd", "network", "tx", "payer", "buyer", "latency_ms"];

function csvCell(value: unknown): string {
  const text = value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportDataset(ledgerPath: string, outDir: string, testBuyers: string[]): { rows: number; files: string[] } {
  const tests = new Set(testBuyers.map(address => address.toLowerCase()));
  const rows: DatasetRow[] = new Ledger(ledgerPath)
    .all()
    .filter(entry => entry.state === "settled" || entry.state === "recovered")
    .map(entry => ({
      time: entry.ts,
      topic: entry.topic,
      value: entry.reading?.value,
      unit: entry.reading?.unit,
      reading_time: entry.reading ? new Date(entry.reading.ts).toISOString() : undefined,
      price_usd: Number(entry.amount ?? "0") / 1e6,
      network: entry.network,
      tx: entry.tx,
      payer: entry.payer,
      buyer: entry.payer && tests.has(entry.payer.toLowerCase()) ? "cult-os-test" : "external",
      latency_ms: entry.latencyMs,
    }));

  mkdirSync(outDir, { recursive: true });
  const jsonl = rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  const csv = [columns.join(","), ...rows.map(row => columns.map(column => csvCell(row[column])).join(","))].join("\n") + "\n";
  const files = { "x402-mqtt-sales.jsonl": jsonl, "x402-mqtt-sales.csv": csv };
  const sums: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outDir, name), content);
    sums.push(`${createHash("sha256").update(content).digest("hex")}  ${name}`);
  }
  writeFileSync(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  return { rows: rows.length, files: [...Object.keys(files), "SHA256SUMS"] };
}
