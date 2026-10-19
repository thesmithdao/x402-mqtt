import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mqtt from "mqtt";

export function readTVBox({ proc = "/proc", thermal = "/sys/class/thermal", storage = homedir() } = {}) {
  const readings = {};
  const ts = Date.now();
  const add = (topic, value, unit) => {
    if (Number.isFinite(value) && value >= 0) readings[topic] = { value, unit, ts };
  };
  try {
    const seconds = Number(readFileSync(join(proc, "uptime"), "utf8").match(/^(\d+(?:\.\d+)?)\s/)?.[1]);
    add("uptime", Math.round(seconds / 86400 * 1e6) / 1e6, "days");
  } catch {}
  try {
    const bytes = Number(readFileSync(join(proc, "meminfo"), "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]) * 1024;
    if (Number.isSafeInteger(bytes)) add("memory/available", bytes, "bytes");
  } catch {}
  try {
    const disk = statfsSync(storage);
    const bytes = disk.bavail * disk.bsize;
    if (Number.isSafeInteger(bytes)) add("storage/available", bytes, "bytes");
  } catch {}
  const channels = { soc_thermal: "soc/temperature", ddr_thermal: "ddr/temperature" };
  let zones = [];
  try { zones = readdirSync(thermal).filter(name => /^thermal_zone\d+$/.test(name)); } catch {}
  for (const zone of zones) {
    try {
      const type = readFileSync(join(thermal, zone, "type"), "utf8").trim();
      if (!Object.hasOwn(channels, type)) continue;
      const raw = readFileSync(join(thermal, zone, "temp"), "utf8").trim();
      if (!/^-?\d+$/.test(raw)) continue;
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value >= -60000 && value <= 200000) readings[channels[type]] = { value: value / 1000, unit: "°C", ts };
    } catch {}
  }
  return readings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const device = process.env.DEVICE ?? "tvbox";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(device)) throw new Error("Invalid DEVICE");
  if (!process.env.BROKER_URL) throw new Error("Set BROKER_URL");
  const client = mqtt.connect(process.env.BROKER_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    queueQoSZero: false,
  });
  client.on("error", () => console.error("MQTT connection unavailable"));
  const publish = () => {
    if (!client.connected) return;
    for (const [topic, reading] of Object.entries(readTVBox())) client.publish(`raw/${device}/${topic}`, JSON.stringify(reading), { qos: 0, retain: false });
  };
  client.on("connect", publish);
  const timer = setInterval(publish, 10000);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    clearInterval(timer);
    client.end(true);
  });
}
