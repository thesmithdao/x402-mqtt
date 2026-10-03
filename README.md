# x402-mqtt

Sell machine data over MQTT, paid in USDC on Base or Solana.

Devices publish readings. Agents request them, pay through x402, and receive the data with a payment receipt.

![Architecture](docs/architecture.svg)

## Sell readings

Load `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` into your local environment.

These examples use your Mac’s built-in readings. Linux and Android collectors are covered below.

### Base

```bash
npx @cultos/x402-mqtt@0.2.0 sell --mac --payout 0xYourAddress
```

Base is the default. Buyers pay in Base USDC.

### Solana

```bash
npx @cultos/x402-mqtt@0.2.0 sell --mac --network solana --payout YOUR_SOLANA_ADDRESS
```

Buyers pay in Solana USDC. The buyer and payout wallets need existing USDC token accounts. The facilitator sponsors settlement fees.

### Accept both

```bash
npx @cultos/x402-mqtt@0.2.0 sell --mac --payout 0xYourAddress --solana-payout YOUR_SOLANA_ADDRESS
```

One seller, the same readings, two payment options. Buyers choose their network.

The built-in broker starts automatically. Payments go directly to your payout address; the seller holds no wallet key.

## Buy a reading

Load `X402_MQTT_BUYER_KEY` into your local environment using the key for your chosen network. Fund that wallet with USDC.

**Base**

```bash
npx @cultos/x402-mqtt@0.2.0 buy mac/cpu/load --max 0.001
```

**Solana**

```bash
npx @cultos/x402-mqtt@0.2.0 buy mac/cpu/load --network solana --max 0.001
```

Solana buyers use a base58-encoded 64-byte keypair. `--max` limits the purchase price in USDC.

If a purchase is pending, rerun the same command. It resumes the original payment and retrieves its saved reading.

## Linux and Android

| Device | Readings | Setup |
| --- | --- | --- |
| Mac | Battery, power, CPU, memory and thermal readings | Built in with `--mac` |
| Linux | Uptime, CPU load and memory usage | [Linux collector](docs/devices.md#linux-server) |
| Android | Battery temperature and three-hour pressure change | [Termux collector](docs/devices.md#android-phone) |

Linux and Android collectors publish to your MQTT broker. List their topics and prices in the seller configuration. Either device can sell through Base, Solana or both.

Any other device can do the same. Publish to `raw/<topic>` and add an offer to `x402-mqtt.json`:

```json
{
  "payout": "0xYourAddress",
  "offers": [
    { "topic": "garden/soil/moisture", "price": "0.002", "unit": "%" }
  ]
}
```

Run `x402-mqtt sell` to serve those offers. See the [device guide](docs/devices.md) for the reading format and collector setup.

## How it works

1. The buyer requests a topic and receives an x402 quote.
2. It signs a payment for the selected network.
3. The bridge verifies payment, retains a fresh reading, settles, and returns the reading with its receipt.

An offline device is refused before settlement. Interrupted purchases recover the original saved reading using the same payment.

Already running Mosquitto? Connect the bridge to your broker and use the [example access rules](examples/mosquitto).

The [SPEC](SPEC.md) covers configuration, spending caps, safety and recovery.

## From an agent

```ts
import { createBuyer } from "@cultos/x402-mqtt";

const buyer = await createBuyer({
  url: "mqtt://127.0.0.1:1883",
  privateKey,
  maxPerCall: "0.001",
  maxTotal: "1",
});

try {
  const { reading, settlement } = await buyer.buy("mac/cpu/load");
} finally {
  await buyer.close();
}
```

Base is the default. For Solana, import `SOLANA_NETWORK` and pass it as `network`, using your Solana keypair.

## Upgrading

Existing Base configuration remains valid. Add a Solana payout to accept both networks.

See [upgrade notes](SPEC.md#upgrade-notes) for ledger preservation and rollback.

## From source

```bash
git clone https://github.com/thesmithdao/x402-mqtt
cd x402-mqtt
npm ci
npm run build
```

Node 20 or newer. MIT license.

## Try it live

Three machines sell readings at [cultos.dev/machines](https://www.cultos.dev/machines).

The public fleet currently accepts Base. With `X402_MQTT_BUYER_KEY` loaded and a little Base USDC:

```bash
npx @cultos/x402-mqtt@0.2.0 buy machine01/uptime --broker wss://machines.cultos.dev/mqtt --max 0.001
```

Built by [Cult OS](https://cultos.dev).
