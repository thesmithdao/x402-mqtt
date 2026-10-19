import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTVBox } from "../examples/android/tvbox.mjs";

test("TV box maps thermal types and returns only fresh approved readings", () => {
  const root = mkdtempSync(join(tmpdir(), "mqtt-tvbox-"));
  try {
    const proc = join(root, "proc"), thermal = join(root, "thermal");
    mkdirSync(proc); mkdirSync(thermal);
    writeFileSync(join(proc, "uptime"), "86400.0 100000.0\n");
    writeFileSync(join(proc, "meminfo"), "MemAvailable: 1234 kB\nSerial: private\n");
    for (const [id, type, temp] of [[8, "soc_thermal", "46200"], [2, "ddr_thermal", "47800"], [3, "unknown", "99000"]]) {
      const dir = join(thermal, `thermal_zone${id}`); mkdirSync(dir);
      writeFileSync(join(dir, "type"), type + "\n"); writeFileSync(join(dir, "temp"), temp + "\n");
    }
    const before = Date.now(), values = readTVBox({ proc, thermal, storage: root });
    assert.deepEqual(Object.keys(values).sort(), ["uptime", "memory/available", "storage/available", "soc/temperature", "ddr/temperature"].sort());
    assert.equal(values.uptime.value, 1); assert.equal(values["memory/available"].value, 1234 * 1024);
    assert.equal(values["soc/temperature"].value, 46.2); assert.equal(values["ddr/temperature"].value, 47.8);
    assert.equal(values["soc/temperature"].unit, "°C");
    for (const value of Object.values(values)) {
      assert.deepEqual(Object.keys(value), ["value", "unit", "ts"]);
      assert.ok(value.ts >= before && value.ts <= Date.now());
    }
    assert.ok(!JSON.stringify(values).includes("private"));
    for (const invalid of ["", "NaN", "Infinity", "46.2", "999999", "-999999", "123junk"]) {
      writeFileSync(join(thermal, "thermal_zone8/temp"), invalid);
      const next = readTVBox({ proc, thermal, storage: root });
      assert.equal(next["soc/temperature"], undefined); assert.equal(next["ddr/temperature"].value, 47.8);
      assert.ok(next.uptime);
    }
    unlinkSync(join(thermal, "thermal_zone2/temp"));
    assert.equal(readTVBox({ proc, thermal, storage: root })["ddr/temperature"], undefined);
    const missing = join(root, "missing");
    assert.deepEqual(readTVBox({ proc: missing, thermal: missing, storage: missing }), {});
    writeFileSync(join(proc, "uptime"), "invalid\n"); writeFileSync(join(proc, "meminfo"), "invalid\n");
    assert.deepEqual(readTVBox({ proc, thermal, storage: missing }), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
