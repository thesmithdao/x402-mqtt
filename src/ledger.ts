import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import type { SettleResponse } from "@x402/core/types";
import type { Reading } from "./spec.js";
import type { SolanaProof } from "./solana.js";

export type LedgerState = "verified" | "pending" | "settled" | "recovered" | "rejected" | "refused" | "failed";

export type LedgerEntry = {
  ts: string;
  id: string;
  topic: string;
  state: LedgerState;
  key?: string;
  payer?: string;
  payTo?: string;
  asset?: string;
  amount?: string;
  network?: string;
  tx?: string;
  error?: string;
  reading?: Reading;
  settlement?: SettleResponse;
  latencyMs?: number;
  solana?: SolanaProof;
};

export class Ledger {
  private entries: LedgerEntry[] = [];
  private latest = new Map<string, LedgerEntry>();

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (!entry || typeof entry.ts !== "string" || typeof entry.id !== "string" || typeof entry.topic !== "string" || !["verified", "pending", "settled", "recovered", "rejected", "refused", "failed"].includes(entry.state) || (entry.key !== undefined && typeof entry.key !== "string")) throw new Error();
        this.index(entry);
      } catch {
        throw new Error("ledger is corrupt; restore or reconcile it before starting");
      }
    }
  }

  append(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
    const full = { ts: new Date().toISOString(), ...entry };
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(full)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.index(full);
    return full;
  }

  settledFor(key: string): LedgerEntry | undefined {
    const entry = this.latest.get(key);
    return entry && (entry.state === "settled" || entry.state === "recovered") ? entry : undefined;
  }

  pending(): LedgerEntry[] {
    return [...this.latest.values()].filter(entry => entry.state === "verified" || entry.state === "pending");
  }

  forKey(key: string): LedgerEntry | undefined {
    return this.latest.get(key);
  }

  forRequest(id: string, topic: string, network: string, payer: string): LedgerEntry | undefined {
    return [...this.latest.values()].find(entry => entry.id === id && entry.topic === topic && entry.network === network && entry.payer === payer && ["verified", "pending", "settled", "recovered"].includes(entry.state));
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  private index(entry: LedgerEntry): void {
    this.entries.push(entry);
    if (entry.key) this.latest.set(entry.key, entry);
  }
}
