import { SOLANA_NETWORK, validSolanaSignature } from "./solana.js";

export function networkName(network: string): string {
  return network === "eip155:8453" ? "Base" : network === "eip155:84532" ? "Base Sepolia" : network === SOLANA_NETWORK ? "Solana" : "unknown";
}

export function walletIdentity(network: string | undefined, value: string): string {
  return network?.startsWith("eip155:") || /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
}

export function isTestBuyer(network: string | undefined, payer: string | undefined, buyers: string[]): boolean {
  return !!payer && buyers.some(value => walletIdentity(network, value) === walletIdentity(network, payer));
}

export function explorerUrl(network: string, tx: string): string | undefined {
  if (network === SOLANA_NETWORK && validSolanaSignature(tx)) return `https://solscan.io/tx/${tx}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
    if (network === "eip155:84532") return `https://sepolia.basescan.org/tx/${tx}`;
  }
  return undefined;
}
