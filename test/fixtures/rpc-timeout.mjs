import assert from "node:assert/strict";
import { createServer } from "node:http";

const { SolanaChain, SolanaRpcUnavailableError } = await import(process.argv[2]);
const timers = new Set();
let closed = 0;
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  response.setHeader("content-type", "application/json");
  response.write('{"jsonrpc":"2.0","id":1,"result":');
  response.on("close", () => { closed++; });
  timers.add(setTimeout(() => globalThis.gc(), 200));
  timers.add(setTimeout(() => response.end("1}"), 2000));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const chain = new SolanaChain(`http://127.0.0.1:${server.address().port}`);
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    await assert.rejects(chain.call("getSlot", [], Date.now() + 700), SolanaRpcUnavailableError);
    assert.ok(performance.now() - started < 1500);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, i + 1);
  }
} finally {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
