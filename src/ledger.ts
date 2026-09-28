import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { SettleResponse } from "@x402/core/types";
import type { Reading } from "./spec.js";

export type LedgerState = "verified" | "settled" | "recovered" | "rejected" | "refused" | "failed";

export type LedgerEntry = {
  ts: string;
  id: string;
  topic: string;
  state: LedgerState;
  key?: string;
  payer?: string;
  payTo?: string;
  amount?: string;
  network?: string;
  tx?: string;
  error?: string;
  reading?: Reading;
  settlement?: SettleResponse;
  latencyMs?: number;
};

export class Ledger {
  private entries: LedgerEntry[] = [];
  private finals = new Map<string, LedgerEntry>();

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this.index(JSON.parse(line) as LedgerEntry);
      } catch {
        continue;
      }
    }
  }

  append(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
    const full = { ts: new Date().toISOString(), ...entry };
    appendFileSync(this.path, `${JSON.stringify(full)}\n`);
    this.index(full);
    return full;
  }

  settledFor(key: string): LedgerEntry | undefined {
    const entry = this.finals.get(key);
    return entry && (entry.state === "settled" || entry.state === "recovered") ? entry : undefined;
  }

  pending(): LedgerEntry[] {
    const latest = new Map<string, LedgerEntry>();
    for (const entry of this.entries) if (entry.key) latest.set(entry.key, entry);
    return [...latest.values()].filter(entry => entry.state === "verified");
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  private index(entry: LedgerEntry): void {
    this.entries.push(entry);
    if (entry.key && entry.state !== "verified") this.finals.set(entry.key, entry);
  }
}
