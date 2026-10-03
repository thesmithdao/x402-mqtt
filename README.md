# x402-mqtt

x402 payments over MQTT. Devices sell their data to agents, paid in USDC on Base or Solana.

Uses x402 v2 over MQTT, with the existing broker and a local payment bridge.

![architecture](docs/architecture.svg)

The first real use case is a [MacBook selling](EVIDENCE.md) its own sensor readings on Base mainnet.

## Try it live

Three machines sell their own readings at [cultos.dev/machines](https://www.cultos.dev/machines): two in Germany and an IoT device in Brazil. Buy one for $0.001 with a wallet holding a little USDC on Base:

```bash
npx @cultos/x402-mqtt buy machine01/uptime --broker wss://machines.cultos.dev/mqtt --max 0.001
```

Load `X402_MQTT_BUYER_KEY` into your local environment first. Never paste wallet keys into commands, prompts or repositories. The public fleet currently accepts Base; Solana support below is for your own seller.

## Sell your Mac's readings

Load `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` into your local environment, then run:

```bash
npx @cultos/x402-mqtt sell --mac --payout 0xYourAddress
```

```
selling on mqtt://127.0.0.1:1883 · payout 0xYourAddress · Base
  mac/battery/temperature      $0.001
  mac/battery/level            $0.001
  mac/power/watts              $0.001
  …
sales page  http://127.0.0.1:4020
```

The built-in broker starts automatically, so there's nothing else to install. Money goes straight to your payout address; the seller side never holds a key.

## Buy a reading

```bash
npx @cultos/x402-mqtt buy mac/battery/temperature --max 0.001
paid $0.001 · 31.4 °C · tx 0xec7f730c…
```

Or from an agent:

```ts
import { createBuyer } from "@cultos/x402-mqtt";

const buyer = await createBuyer({ url: "mqtt://127.0.0.1:1883", privateKey, maxPerCall: "0.01", maxTotal: "1" });
try {
  const { reading, settlement } = await buyer.buy("mac/battery/temperature");
} finally {
  await buyer.close();
}
```

### Solana

Solana is part of the unreleased 0.2.0 candidate. Run these examples from that checkout.

Sell on Solana:

```bash
node dist/cli.js sell --mac --network solana --payout YOUR_SOLANA_ADDRESS
```

Buy a reading in another terminal:

```bash
node dist/cli.js buy mac/cpu/load --network solana --max 0.001
```

Load the buyer's base58-encoded 64-byte keypair into `X402_MQTT_BUYER_KEY`. The buyer and payout wallets need USDC token accounts; the buyer needs enough USDC for the purchase. The facilitator sponsors settlement fees.

To accept both Base and Solana:

```bash
node dist/cli.js sell --mac --payout 0xYourAddress --solana-payout YOUR_SOLANA_ADDRESS
```

Devices keep publishing the same readings. Buyers choose the payment network. In code, import `SOLANA_NETWORK` and pass it as `network` to `createBuyer`.

RPC defaults are built in. Custom endpoints and config-file fields are covered in [configuration](SPEC.md#configuration).

## How it works

1. The buyer asks on `x402/v1/req/<topic>` and gets a standard x402 `402` quote.
2. It signs one exact USDC authorization and asks again with it.
3. The bridge verifies the payment, makes sure it has a fresh reading, settles, and only then replies with the reading and the transaction.

An offline device or invalid payment is refused before settlement. A settlement timeout can still mean a payment landed: the seller keeps it pending and checks the chain. Retry the same request and payment to recover its saved reading. The full protocol is in [SPEC.md](SPEC.md); it reuses x402's `PaymentRequired`, `PaymentPayload` and `SettleResponse`.

### Recover a purchase

If a CLI purchase is pending, rerun the same command. It resumes the original payment and retrieves its saved reading. Recovery records stay on your machine and contain no keys or signatures.

Library callers use `buyer.resume(error.request)` after a `PurchasePendingError`. See [recovery](SPEC.md#recovery) for persistence and expiry handling.

## Sell any device

Anything that publishes to MQTT can sell. Point the device at `raw/<topic>` and list the topic:

```json
{
  "payout": "0xYourAddress",
  "offers": [{ "topic": "garden/soil/moisture", "price": "0.002", "unit": "%" }]
}
```

Save it as `x402-mqtt.json` and run `x402-mqtt sell`. New purchases require a fresh reading; `maxAgeSeconds` defaults to 30. Recovery returns the original saved reading.

Examples for a Mac, a Linux server and an Android phone: [docs/devices.md](docs/devices.md).

## Works with Mosquitto

Already running a broker? Set `"broker"` to it with the bridge's username and password (`mqtts://` or `wss://` unless it runs on the same machine), and use the access rules in [examples/mosquitto](examples/mosquitto): buyers can only ask and read their own replies, and only the bridge can read `raw/#`. The evidence was collected on Mosquitto 2.1.2.

## Safety notes

- **Sellers hold no keys,** only a payout address. The facilitator key lives in the bridge and is never logged.
- **Readings retained before settlement.** Lost replies can be recovered using the same request and payment. Uncertain settlements stay pending until the exact payment is confirmed.
- **Idempotent payments.** Retrying the same request and payment returns its saved result without another settlement. Reusing a payment for a different request or topic is refused.
- **Private data stays private.** Raw readings and other buyers' replies are blocked at the broker, and the built-in broker only accepts requests that reply to the sender itself.
- **Floods stay cheap.** Forged and unfunded payments are refused before they reach the facilitator. A wallet only earns a higher limit after it pays, and new buyers can't be locked out by a flood of fake IDs.
- **Buyers have caps,** per call and in total, held even when buys run in parallel. Sent payments count as spent until confirmed unused after expiry, whatever the seller replies. A failed checkpoint sends no payment and releases its reservation. Caps cover one buyer instance, not restarts.
- **TLS for remote brokers.** The buyer and the seller refuse plain `mqtt://` or `ws://` to anything but localhost unless you pass `--allow-cleartext`.
- **USDC only.** Base and Solana buyers accept only canonical USDC, so their caps mean dollars. Solana supports ordinary keypair transfers; smart wallets, lookup tables and durable nonces are refused.

## Upgrading from 0.1.x

Existing Base configuration works as before. Add a Solana payout to accept it alongside Base. Operators can find ledger and rollback details in [upgrade notes](SPEC.md#upgrade-notes).

## Datasets

[dataset/](dataset): initial runs as JSONL and CSV, with checksums.

## From source

```bash
git clone https://github.com/thesmithdao/x402-mqtt && cd x402-mqtt
npm install && npm run build
node dist/cli.js sell --mac --payout 0xYourAddress
```

Node 20 or newer. MIT license. Built by [Cult OS](https://cultos.dev).
