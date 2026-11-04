# ESP8266 through a hosted broker

Sell temperature and humidity readings without opening ports on the device’s network.

```text
ESP8266 → local Mosquitto → TLS bridge → Cult OS broker → hosted seller → buyer
```

For this example, we use the Cult OS broker and a hosted seller. The device operator runs the ESP8266 and local Mosquitto; the bridge forwards readings over TLS. Payments go directly to the operator’s payout wallet.

The same setup works with your own broker and seller. Replace the endpoints and credentials accordingly.

## Device

Publish every five seconds to `raw/temperatura` and `raw/umidade`:

```json
{ "value": 28.5, "unit": "°C", "ts": 1793750504000 }
```

Synchronize the clock with NTP. On ESP8266, use 64-bit epoch milliseconds and serialize with `%llu`:

```cpp
uint64_t ts = (uint64_t)time(nullptr) * 1000ULL;
```

Pass `(unsigned long long)ts` to `snprintf`. Skip invalid sensor values and publication until the clock is synchronized. Readings expire after 30 seconds by default.

## Local bridge

Add [bridge.conf](bridge.conf) to the local Mosquitto configuration. Set the broker endpoint, device credentials, client ID and your system’s CA bundle path. Restrict file access and restart Mosquitto.

Keep the ESP8266 connected to its local broker. The bridge forwards only the two listed topics over TLS. Topic names must match the firmware.

## Hosted seller

In this case, Cult OS runs the seller on an isolated broker with its own credentials and ledger. The device operator supplies a Base payout address and runs only the device and bridge.

[x402-mqtt.json](x402-mqtt.json) is a host-side configuration example. Seller credentials and facilitator keys stay on the host.

## Buy

Load the buyer’s `X402_MQTT_BUYER_KEY`, then connect to this setup’s public broker:

```sh
npx @cultos/x402-mqtt@0.2.0 buy temperatura \
  --broker wss://machines.cultos.dev/mqtt/airsense --max 0.001
```

Both offers cost 0.001 USDC on Base. A pending purchase resumes when the same command is rerun.
