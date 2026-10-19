# Sell readings from any device

Any device that publishes JSON to `raw/<topic>` can sell with x402-mqtt. New purchases require a sample younger than `maxAgeSeconds`, which defaults to 30. Publish more often than that to leave room for delivery delays:

```json
{ "value": 0.42, "unit": "load", "ts": 1790640000000 }
```

Then list the topics in the seller's `x402-mqtt.json` and run `x402-mqtt sell`:

```json
{
  "payout": "0xYourAddress",
  "offers": [{ "topic": "server/cpu/load", "price": "0.001", "unit": "load" }]
}
```

Two Linux servers, an Android phone and an IoT TV Box sell readings on Base at [cultos.dev/machines](https://www.cultos.dev/machines). The Mac runs are in [EVIDENCE.md](../EVIDENCE.md). Devices publish the same JSON for either payment network; configure Base, Solana or both on the seller as shown in [README.md](../README.md#solana).

## Mac

Built in. It sells battery, power, CPU, memory and thermal readings:

```bash
npx @cultos/x402-mqtt sell --mac --payout 0xYourAddress
```

## Linux server

[examples/linux/server.mjs](../examples/linux/server.mjs) reads `/proc` and publishes `uptime`, `cpu/load` and `memory/used` every 10 seconds:

```bash
BROKER_URL=mqtts://your-broker MQTT_USERNAME=server MQTT_PASSWORD=… node server.mjs
```

## Android phone

1. Install [F-Droid](https://f-droid.org), then **Termux** and **Termux:API** from F-Droid.
2. In Termux: `pkg upgrade -y && pkg install termux-api nodejs-lts && npm install mqtt`
3. Check the sensors: `termux-sensor -l`
4. Run [examples/android/phone.mjs](../examples/android/phone.mjs). It publishes `pressure/change3h` (after 3 hours) and `battery/temperature` every 10 seconds:

```bash
termux-wake-lock
BROKER_URL=mqtts://your-broker MQTT_USERNAME=phone MQTT_PASSWORD=… node phone.mjs
```

Keep the phone charging, and set Termux and Termux:API to **Unrestricted** battery use.

## IoT TV Box

[examples/android/tvbox.mjs](../examples/android/tvbox.mjs) publishes uptime, available memory/storage and readable SoC/DDR temperatures. It runs in Termux with Node 20 or later; Termux:API is not required.

```sh
pkg install nodejs-lts
npm install mqtt@5.16.0
termux-wake-lock
BROKER_URL=mqtts://your-broker DEVICE=tvbox MQTT_USERNAME=tvbox MQTT_PASSWORD=… node tvbox.mjs
```

Readings are sampled on connection and every 10 seconds. Missing or invalid channels are skipped; old observations are not queued during disconnection. Thermal zones are matched by driver type (`soc_thermal`, `ddr_thermal`); availability varies by device. Temperatures are internal, not ambient.

Add the available topics to your seller configuration:

```json
{
  "payout": "0xYourAddress",
  "offers": [
    { "topic": "tvbox/uptime", "price": "0.001", "unit": "days" },
    { "topic": "tvbox/memory/available", "price": "0.001", "unit": "bytes" },
    { "topic": "tvbox/storage/available", "price": "0.001", "unit": "bytes" },
    { "topic": "tvbox/soc/temperature", "price": "0.001", "unit": "°C" },
    { "topic": "tvbox/ddr/temperature", "price": "0.001", "unit": "°C" }
  ]
}
```

Use TLS and a device credential restricted to its own topics. For unattended collection, use Termux:Boot and service supervision; verify reconnect and reboot recovery on your device. No payment key or firmware replacement is needed.
