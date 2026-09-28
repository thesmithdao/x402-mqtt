import { readFileSync } from "node:fs";
import mqtt from "mqtt";

const device = process.env.DEVICE ?? "server";
const client = mqtt.connect(process.env.BROKER_URL, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });

function publish(topic, value, unit) {
  client.publish(`raw/${device}/${topic}`, JSON.stringify({ value, unit, ts: Date.now() }));
}

setInterval(() => {
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  const memory = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map(line => {
    const [key, value] = line.split(":");
    return [key, parseInt(value, 10)];
  }));
  publish("uptime", Number((uptime / 86_400).toFixed(2)), "days");
  publish("cpu/load", load, "load");
  publish("memory/used", Math.round((1 - memory.MemAvailable / memory.MemTotal) * 100), "%");
}, 10_000);
