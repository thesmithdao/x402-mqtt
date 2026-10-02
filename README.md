# x402-mqtt

x402 payments over MQTT. Devices sell their data to agents, paid in USDC on Base or Solana.

An x402 transport for MQTT, the protocol most connected devices already speak.

![architecture](docs/architecture.svg)

The first real use case is a [MacBook selling](EVIDENCE.md) its own sensor readings on Base mainnet.

## Try it live

Three machines sell their own readings at [cultos.dev/machines](https://www.cultos.dev/machines): two in Germany and an Android phone in Brazil. Buy one for $0.001 with a wallet holding a little USDC on Base:

```bash
X402_MQTT_BUYER_KEY=0x… npx @cultos/x402-mqtt buy machine01/uptime --broker wss://machines.cultos.dev/mqtt
```

## Sell your Mac's readings

```bash
export CDP_API_KEY_ID=…  CDP_API_KEY_SECRET=…
npx @cultos/x402-mqtt sell --mac --payout 0xYourAddress
```

```
selling on mqtt://127.0.0.1:1883 payout 0xYourAddress Base
  mac/battery/temperature      $0.001
  mac/battery/level            $0.001
  mac/power/watts              $0.001
  …
sales page  http://127.0.0.1:4020
```

The built-in broker starts automatically, so there's nothing else to install. Money goes straight to your payout address; the seller side never holds a key.

## Buy a reading

```bash
X402_MQTT_BUYER_KEY=0x… npx @cultos/x402-mqtt buy mac/battery/temperature
paid $0.001 · 31.4 °C · tx 0xec7f730c…
```

Or from an agent:

```ts
import { createBuyer } from "@cultos/x402-mqtt";

const buyer = await createBuyer({ url: "mqtt://127.0.0.1:1883", privateKey, maxPerCall: "0.01", maxTotal: "1" });
const { reading, settlement } = await buyer.buy("mac/battery/temperature");
```

### Solana

Base is the default. To sell on Solana, set `"network"` to `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"` and `"payout"` to a Solana address. To accept both, keep the Base config and add `"solanaPayout"`.

```bash
npx @cultos/x402-mqtt sell --mac --network solana --payout YOUR_SOLANA_ADDRESS
npx @cultos/x402-mqtt buy mac/cpu/load --network solana --max 0.001
```

Set `X402_MQTT_BUYER_KEY` locally: an EVM hex key for Base, or a base58-encoded 64-byte Solana keypair for Solana. Never put keys in commands, prompts or repositories. The seller uses a payout address, not a wallet key. Buyer and recipient USDC token accounts must already exist. Coinbase advertises the fee payer and sponsors settlement fees.

For agents, pass `network: SOLANA_NETWORK` to `createBuyer`; import the constant from `@cultos/x402-mqtt`. Spending caps apply to one buyer instance. Optional `rpcUrl` selects its RPC. Sellers use `rpcUrl` for their primary network and `solanaRpcUrl` for an additional Solana offer. The CLI accepts `--rpc`, `--solana-rpc` and `--solana-payout`.

If an optional Solana RPC is temporarily unavailable at startup, the seller warns and offers Base only. Restart after RPC recovery to enable Solana. Wrong-network, authentication and malformed-RPC responses still stop startup; a Solana-only seller requires its RPC.

## How it works

1. The buyer asks on `x402/v1/req/<topic>` and gets a standard x402 `402` quote.
2. It signs one exact USDC authorization and asks again with it.
3. The bridge verifies the payment, makes sure it has a fresh reading, settles, and only then replies with the reading and the transaction.

An offline device or invalid payment is refused before settlement. A settlement timeout can still mean a payment landed: the seller keeps it pending and checks the chain. Retry the same request and payment to recover its saved reading. The full protocol is in [SPEC.md](SPEC.md); it reuses x402's `PaymentRequired`, `PaymentPayload` and `SettleResponse`.

### Recover a purchase

If a CLI purchase is pending, rerun the same command. It resumes the original payment, including after a process restart. Before sending, the CLI saves unsigned recovery data in `$XDG_CACHE_HOME/x402-mqtt` or `~/.cache/x402-mqtt`. Records contain public payment terms, never keys or signatures. Keep this directory private; corrupt records stop the purchase. A successful purchase clears its record. Proven unused expiry clears it without buying again; the next command starts a new purchase.

Library callers can catch `PurchasePendingError` and call `buyer.resume(error.request)`. For recovery after a process restart, persist the unsigned request with `onPrepared` before transmission and pass it to a new buyer with the same broker, wallet and network. `PurchaseExpiredError` means finalized chain evidence established unused expiry. Caps apply to each buyer instance; resuming reserves the original amount once.

## Sell any device

Anything that publishes to MQTT can sell. Point the device at `raw/<topic>` and list the topic:

```json
{
  "payout": "0xYourAddress",
  "offers": [{ "topic": "garden/soil/moisture", "price": "0.002", "unit": "%" }]
}
```

Save it as `x402-mqtt.json` and run `x402-mqtt sell`. Readings older than 30 seconds count as offline and are never sold.

Examples for a Mac, a Linux server and an Android phone: [docs/devices.md](docs/devices.md).

## Works with Mosquitto

Already running a broker? Set `"broker"` to it with the bridge's username and password (`mqtts://` or `wss://` unless it runs on the same machine), and use the access rules in [examples/mosquitto](examples/mosquitto): buyers can only ask and read their own replies, and only the bridge can read `raw/#`. The evidence was collected on Mosquitto 2.1.2.

## Safety Notes

- **Sellers hold no keys,** only a payout address. The facilitator key lives in the bridge and is never logged.
- **Readings retained before settlement.** Lost replies can be recovered using the same request and payment. Uncertain settlements stay pending until the exact payment is confirmed.
- **Idempotent payments.** Replays, duplicates and concurrent reuse of one payment are refused. MQTT redelivery never double-charges.
- **Private data stays private.** Raw readings and other buyers' replies are blocked at the broker, and the built-in broker only accepts requests that reply to the sender itself.
- **Floods stay cheap.** Forged and unfunded payments are refused before they reach the facilitator. A wallet only earns a higher limit after it pays, and new buyers can't be locked out by a flood of fake IDs.
- **Buyers have caps,** per call and in total, held even when buys run in parallel. A payment counts as spent until it expires unused on-chain, whatever the seller replies, and the same payment is resent instead of signing a new one. Caps cover one buyer instance, not restarts.
- **TLS for remote brokers.** The buyer and the seller refuse plain `mqtt://` or `ws://` to anything but localhost unless you pass `--allow-cleartext`.
- **USDC only.** Base and Solana buyers accept only canonical USDC, so their caps mean dollars. Solana supports ordinary keypair transfers; smart wallets, lookup tables and durable nonces are refused.

## datasets

[dataset/](dataset): initial runs as JSONL and CSV, with checksums.

## From source

```bash
git clone https://github.com/thesmithdao/x402-mqtt && cd x402-mqtt
npm install && npm run build
node dist/cli.js sell --mac --payout 0xYourAddress
```

Node 20 or newer. MIT license. Built by [Cult OS](https://cultos.dev).
