import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Offer, Reading } from "../spec.js";

const run = promisify(execFile);

async function output(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(command, args, { timeout: 5000 });
    return stdout;
  } catch {
    return "";
  }
}

function field(text: string, name: string): string | undefined {
  return text.match(new RegExp(`"${name}" = (\\S+)`))?.[1];
}

function signed(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(BigInt.asIntN(64, BigInt(value)));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const macOffers = (price: string): Offer[] => [
  { topic: "mac/battery/temperature", price, unit: "°C", description: "Battery temperature" },
  { topic: "mac/battery/level", price, unit: "%", description: "Battery charge level" },
  { topic: "mac/battery/cycles", price, unit: "cycles", description: "Battery charge cycles" },
  { topic: "mac/power/watts", price, unit: "W", description: "Battery power draw" },
  { topic: "mac/cpu/load", price, unit: "load", description: "CPU load, 1-minute average" },
  { topic: "mac/memory/free", price, unit: "%", description: "Free memory" },
  { topic: "mac/thermal/pressure", price, description: "Thermal pressure" },
];

export async function hasBattery(): Promise<boolean> {
  return (await output("ioreg", ["-rn", "AppleSmartBattery"])).includes('"Temperature"');
}

export async function readMac(): Promise<Map<string, Reading>> {
  const ts = Date.now();
  const readings = new Map<string, Reading>();
  const [battery, loadavg, memory, thermal] = await Promise.all([
    output("ioreg", ["-rn", "AppleSmartBattery"]),
    output("sysctl", ["-n", "vm.loadavg"]),
    output("memory_pressure", []),
    output("pmset", ["-g", "therm"]),
  ]);

  const temperature = Number(field(battery, "Temperature"));
  if (Number.isFinite(temperature) && temperature > 0) readings.set("mac/battery/temperature", { value: round(temperature / 100, 1), unit: "°C", ts });
  const current = Number(field(battery, "CurrentCapacity"));
  const max = Number(field(battery, "MaxCapacity"));
  if (Number.isFinite(current) && max > 0) readings.set("mac/battery/level", { value: Math.round((current / max) * 100), unit: "%", ts });
  const cycles = Number(field(battery, "CycleCount"));
  if (Number.isFinite(cycles)) readings.set("mac/battery/cycles", { value: cycles, unit: "cycles", ts });
  const volts = Number(field(battery, "Voltage"));
  const amps = signed(field(battery, "InstantAmperage") ?? field(battery, "Amperage"));
  if (Number.isFinite(volts) && amps !== undefined) readings.set("mac/power/watts", { value: round(Math.abs((volts / 1000) * (amps / 1000)), 1), unit: "W", ts });

  const load = Number(loadavg.match(/[\d.]+/)?.[0]);
  if (Number.isFinite(load)) readings.set("mac/cpu/load", { value: round(load, 2), unit: "load", ts });
  const free = Number(memory.match(/free percentage:\s*(\d+)%/)?.[1]);
  if (Number.isFinite(free)) readings.set("mac/memory/free", { value: free, unit: "%", ts });
  if (thermal) {
    const level = thermal.match(/(?:CPU|Thermal)[^\n]*level[^\d\n]*(\d+)/i)?.[1];
    readings.set("mac/thermal/pressure", { value: level === undefined || level === "0" ? "normal" : `level ${level}`, ts });
  }
  return readings;
}

export function startMacSource(publish: (topic: string, reading: Reading) => void, intervalMs = 5000): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const [topic, reading] of await readMac()) publish(topic, reading);
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
