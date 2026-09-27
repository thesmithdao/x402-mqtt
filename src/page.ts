import http from "node:http";
import type { Ledger, LedgerEntry } from "./ledger.js";
import type { Seller } from "./seller.js";
import type { Offer, Reading } from "./spec.js";

type PageOptions = { port: number; seller: Seller; ledger: Ledger; offers: Offer[]; latest: Map<string, Reading>; testBuyers: string[] };

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function snapshot(options: Omit<PageOptions, "port" | "seller">) {
  const entries = options.ledger.all();
  const sales = entries.filter(entry => entry.state === "settled" || entry.state === "recovered");
  const refused = entries.filter(entry => entry.state === "rejected" || entry.state === "refused" || entry.state === "failed");
  const tests = new Set(options.testBuyers.map(address => address.toLowerCase()));
  const earned = sales.reduce((sum, entry) => sum + BigInt(entry.amount ?? "0"), 0n);
  const row = (entry: LedgerEntry) => ({
    ts: entry.ts,
    topic: entry.topic,
    tx: entry.tx,
    amount: entry.amount,
    error: entry.error,
    buyer: entry.payer && tests.has(entry.payer.toLowerCase()) ? "cult-os-test" : "external",
  });
  return {
    earnedUsd: Number(earned) / 1e6,
    sales: sales.length,
    buyers: new Set(sales.map(entry => entry.payer?.toLowerCase())).size,
    medianMs: median(sales.flatMap(entry => (entry.latencyMs ? [entry.latencyMs] : []))),
    topics: options.offers.map(offer => ({
      topic: offer.topic,
      price: offer.price,
      sold: sales.filter(entry => entry.topic === offer.topic).length,
      live: options.latest.get(offer.topic),
    })),
    recentSales: sales.slice(-20).reverse().map(row),
    recentRefused: refused.slice(-10).reverse().map(row),
  };
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>x402-mqtt</title>
<style>:root{--bg:#0b0b0b;--panel:#111110;--fg:#e6e6e3;--muted:#8f8f89;--line:#2c2c2a;--accent:#e4a340;--ok:#3f9a5c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:28px 16px}
main{max-width:980px;margin:0 auto;display:grid;gap:22px}header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:22px}.live{color:var(--muted)}.live b{color:var(--ok)}.stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.stats div{padding:14px 16px;border-right:1px solid var(--line)}.stats div:last-child{border:0}.n{font-size:26px;font-weight:600}.n.acc{color:var(--accent)}.l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
section{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:12px 16px}h2{margin:0 0 8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
table{width:100%;border-collapse:collapse}td{padding:7px 0;border-top:1px solid var(--line)}td.r{text-align:right}a{color:var(--accent)}.m{color:var(--muted)}
@media(max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}</style></head><body><main>
<header><h1>x402-mqtt</h1><span class="live"><b>●</b> selling · Base</span></header>
<div class="stats"><div><div class="n acc" id="earned">$0</div><div class="l">Earned</div></div><div><div class="n" id="sales">0</div><div class="l">Sales</div></div><div><div class="n" id="buyers">0</div><div class="l">Buyers</div></div><div><div class="n" id="median">–</div><div class="l">Median</div></div></div>
<section><h2>Topics</h2><table id="topics"></table></section><section><h2>Sales</h2><table id="salesList"></table></section><section><h2>Refused</h2><table id="refusedList"></table></section>
</main><script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const time=t=>new Date(t).toLocaleTimeString();
function render(s){earned.textContent="$"+s.earnedUsd.toFixed(3);sales.textContent=s.sales;buyers.textContent=s.buyers;median.textContent=s.medianMs?(s.medianMs/1000).toFixed(1)+"s":"–";
topics.innerHTML=s.topics.map(t=>"<tr><td>"+esc(t.topic)+"</td><td class=r>$"+esc(t.price)+"</td><td class=r>"+t.sold+" sold</td><td class='r m'>"+(t.live?esc(t.live.value)+" "+esc(t.live.unit||""):"offline")+"</td></tr>").join("");
salesList.innerHTML=s.recentSales.map(e=>"<tr><td class=m>"+time(e.ts)+"</td><td>"+esc(e.topic)+"</td><td class=m>"+esc(e.buyer)+"</td><td class=r><a href='https://basescan.org/tx/"+esc(e.tx)+"' target=_blank rel=noreferrer>"+esc((e.tx||"").slice(0,10))+"…</a></td></tr>").join("")||"<tr><td class=m>No sales yet</td></tr>";
refusedList.innerHTML=s.recentRefused.map(e=>"<tr><td class=m>"+time(e.ts)+"</td><td>"+esc(e.topic)+"</td><td class=r>"+esc(e.error)+"</td></tr>").join("")||"<tr><td class=m>Nothing refused</td></tr>";}
fetch("/api/state").then(r=>r.json()).then(render);const events=new EventSource("/events");events.onmessage=m=>render(JSON.parse(m.data));
</script></body></html>`;

export function startPage(options: PageOptions): Promise<http.Server> {
  const clients = new Set<http.ServerResponse>();
  const state = () => JSON.stringify(snapshot(options));
  const push = () => {
    const data = `data: ${state()}\n\n`;
    for (const client of clients) client.write(data);
  };
  options.seller.on("entry", push);
  setInterval(push, 5000).unref();

  const server = http.createServer((request, response) => {
    if (request.url === "/api/state") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(state());
    }
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return response.write(`data: ${state()}\n\n`);
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  return new Promise(resolve => server.listen(options.port, "127.0.0.1", () => resolve(server)));
}
