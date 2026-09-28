import { execFileSync } from "node:child_process";
import mqtt from "mqtt";

const device = process.env.DEVICE ?? "phone";
const client = mqtt.connect(process.env.BROKER_URL, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
const WINDOW = 3 * 3_600_000;
const SLACK = 10 * 60_000;
const history = [];

function read(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, { timeout: 15_000 }).toString());
  } catch {
    return null;
  }
}

function publish(topic, value, unit) {
  client.publish(`raw/${device}/${topic}`, JSON.stringify({ value, unit, ts: Date.now() }));
}

setInterval(() => {
  const now = Date.now();
  const hpa = Object.values(read("termux-sensor", ["-s", "Barometer", "-n", "1"]) ?? {})[0]?.values?.[0];
  if (typeof hpa === "number") {
    history.push({ t: now, hpa });
    while (history[0].t < now - WINDOW - SLACK) history.shift();
    const past = history.find(item => Math.abs(item.t - (now - WINDOW)) <= SLACK);
    if (past) publish("pressure/change3h", Number((hpa - past.hpa).toFixed(1)), "hPa");
  }
  const battery = read("termux-battery-status", []);
  if (typeof battery?.temperature === "number") publish("battery/temperature", battery.temperature, "°C");
}, 10_000);
