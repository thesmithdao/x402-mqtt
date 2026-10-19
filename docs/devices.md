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

An Android TV box can publish through Termux while the seller runs on your existing server. The box needs no payment key or public administration port.

On our Android 11 box, five topics are working. Temperature availability depends on the hardware and firmware:

| Topic suffix | Reading | Unit |
| --- | --- | --- |
| `uptime` | Time since boot | days |
| `memory/available` | Available memory | bytes |
| `storage/available` | Available storage | bytes |
| `soc/temperature` | SoC thermal-zone temperature | °C |
| `ddr/temperature` | DDR thermal-zone temperature | °C |

Check which thermal zones your box exposes from Termux:

```sh
for zone in /sys/class/thermal/thermal_zone*; do
  cat "$zone/type" "$zone/temp"
done
```

Match zones by `type`, not their numeric order. Our box exposes `soc_thermal` and `ddr_thermal`. Linux reports `temp` in millidegrees Celsius: `47800` becomes `47.8 °C`. These are internal temperatures, not room temperature. Skip unreadable or invalid samples.

For example, a current SoC reading published to `raw/tvbox/soc/temperature` uses the normal reading contract, with `ts` set to the actual sample time in Unix milliseconds:

```json
{ "value": 47.8, "unit": "°C", "ts": 1792377615910 }
```

List the matching offers on the seller:

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

Publish every 10 seconds over TLS with a device credential limited to its own topics. Use Termux:Boot, a wake lock and service supervision for unattended collection. Test reconnect and reboot recovery on your box. No firmware replacement is required.
