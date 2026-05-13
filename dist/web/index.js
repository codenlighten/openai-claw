import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { listSessions, loadSession } from "../session.js";
import { readCostLog, costByDay, costByModel } from "../cost.js";
const INDEX_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>openai-claw dashboard</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, Segoe UI, sans-serif; margin: 0; background: #0e1116; color: #d6deeb; }
  header { padding: 12px 20px; border-bottom: 1px solid #1f242c; background: #161a22; display: flex; gap: 16px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; color: #82aaff; }
  header span { color: #5c6773; font-size: 12px; }
  nav { padding: 12px 20px; border-bottom: 1px solid #1f242c; display: flex; gap: 8px; }
  nav button { background: #161a22; color: #d6deeb; border: 1px solid #2a313c; padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit; }
  nav button.active { background: #2a313c; }
  main { padding: 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #1f242c; }
  th { color: #82aaff; font-weight: 600; }
  tr:hover { background: #161a22; }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .dim { color: #5c6773; }
  pre.session { background: #161a22; padding: 12px; border-radius: 4px; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .card { background: #161a22; border: 1px solid #1f242c; padding: 12px 16px; border-radius: 4px; min-width: 200px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .big { font-size: 22px; color: #c3e88d; }
</style>
</head><body>
<header>
  <h1>openai-claw</h1>
  <span id="workdir"></span>
  <span class="dim" id="updated"></span>
</header>
<nav>
  <button id="tab-overview" class="active">Overview</button>
  <button id="tab-sessions">Sessions</button>
  <button id="tab-cost">Cost</button>
  <button id="tab-evals">Evals</button>
</nav>
<main id="main"></main>
<script>
(async function () {
  const $ = (sel) => document.querySelector(sel);
  const main = $("#main");
  const tabs = ["overview", "sessions", "cost", "evals"];
  function setActive(t) {
    for (const x of tabs) $("#tab-" + x).classList.toggle("active", x === t);
    render(t);
  }
  for (const t of tabs) $("#tab-" + t).addEventListener("click", () => setActive(t));

  async function fetchJSON(url) { const r = await fetch(url); return r.json(); }

  const meta = await fetchJSON("/api/meta");
  $("#workdir").textContent = meta.workdir;
  $("#updated").textContent = new Date().toLocaleString();

  async function render(t) {
    if (t === "overview") return renderOverview();
    if (t === "sessions") return renderSessions();
    if (t === "cost") return renderCost();
    if (t === "evals") return renderEvals();
  }

  async function renderOverview() {
    const [sessions, cost, evals] = await Promise.all([
      fetchJSON("/api/sessions"),
      fetchJSON("/api/cost"),
      fetchJSON("/api/evals"),
    ]);
    const totalUSD = (cost.entries || []).reduce((s, e) => s + e.costUSD, 0);
    const totalTokens = (cost.entries || []).reduce((s, e) => s + e.prompt_tokens + e.completion_tokens, 0);
    const cached = (cost.entries || []).reduce((s, e) => s + e.cached_tokens, 0);
    const cachePct = totalTokens > 0 ? (cached / totalTokens * 100).toFixed(0) + "%" : "—";
    const passRate = evals && evals.cases > 0 ? Math.round(100 * evals.passed / evals.cases) + "%" : "—";
    main.innerHTML = \`
      <div class="row">
        <div class="card"><div class="dim">Sessions</div><div class="big">\${sessions.length}</div></div>
        <div class="card"><div class="dim">Total cost</div><div class="big">$\${totalUSD.toFixed(4)}</div></div>
        <div class="card"><div class="dim">Cache hit rate</div><div class="big">\${cachePct}</div></div>
        <div class="card"><div class="dim">Eval pass rate</div><div class="big">\${passRate}</div></div>
      </div>\`;
  }

  async function renderSessions() {
    const sessions = await fetchJSON("/api/sessions");
    if (!sessions.length) { main.innerHTML = '<p class="dim">(no sessions yet)</p>'; return; }
    main.innerHTML = '<table><thead><tr><th>id</th><th>saved</th><th class="num">msgs</th><th>preview</th></tr></thead><tbody id="sb"></tbody></table><div id="detail"></div>';
    const tb = $("#sb");
    for (const s of sessions) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td><a href="#" data-id="' + s.id + '">' + s.id.slice(0, 24) + '…</a></td>' +
        '<td class="dim">' + s.savedAt + '</td>' +
        '<td class="num">' + s.messageCount + '</td>' +
        '<td>' + (s.preview || "") + '</td>';
      tr.querySelector("a").addEventListener("click", async (e) => {
        e.preventDefault();
        const data = await fetchJSON("/api/sessions/" + s.id);
        const lines = (data.messages || []).map((m) => {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return "[" + m.role + (m.name ? ":" + m.name : "") + "] " + (c || "").slice(0, 2000);
        });
        $("#detail").innerHTML = '<h3>' + s.id + '</h3><pre class="session">' + lines.join("\\n\\n").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"}[c])) + '</pre>';
      });
      tb.appendChild(tr);
    }
  }

  async function renderCost() {
    const cost = await fetchJSON("/api/cost");
    if (!cost.entries.length) { main.innerHTML = '<p class="dim">(no cost log yet)</p>'; return; }
    let html = '<h3>By day</h3><table><thead><tr><th>date</th><th class="num">cost</th><th class="num">tokens</th><th class="num">turns</th></tr></thead><tbody>';
    for (const d of cost.byDay) html += '<tr><td>' + d.date + '</td><td class="num">$' + d.costUSD.toFixed(4) + '</td><td class="num">' + d.tokens + '</td><td class="num">' + d.turns + '</td></tr>';
    html += '</tbody></table><h3>By model</h3><table><thead><tr><th>model</th><th class="num">cost</th><th class="num">tokens</th><th class="num">turns</th></tr></thead><tbody>';
    for (const m of cost.byModel) html += '<tr><td>' + m.model + '</td><td class="num">$' + m.costUSD.toFixed(4) + '</td><td class="num">' + m.tokens + '</td><td class="num">' + m.turns + '</td></tr>';
    html += '</tbody></table>';
    main.innerHTML = html;
  }

  async function renderEvals() {
    const evals = await fetchJSON("/api/evals");
    if (!evals || !evals.results) { main.innerHTML = '<p class="dim">(no eval report — run npm run eval first)</p>'; return; }
    let html = '<p>' + evals.passed + '/' + evals.cases + ' passed at ' + evals.ranAt + ' (total $' + (evals.totalCostUSD || 0).toFixed(4) + ')</p>';
    html += '<table><thead><tr><th>id</th><th>status</th><th class="num">turns</th><th class="num">ms</th><th class="num">cost</th><th>failures</th></tr></thead><tbody>';
    for (const r of evals.results) {
      const status = r.passed ? '<span style="color:#c3e88d">✓</span>' : '<span style="color:#ff5370">✗</span>';
      html += '<tr><td>' + r.id + '</td><td>' + status + '</td><td class="num">' + r.turns + '</td><td class="num">' + r.durationMs + '</td><td class="num">$' + (r.costUSD || 0).toFixed(4) + '</td><td class="dim">' + (r.failures || []).join("; ") + '</td></tr>';
    }
    html += '</tbody></table>';
    main.innerHTML = html;
  }

  setActive("overview");
})();
</script>
</body></html>`;
function sendJson(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
function sendHtml(res, html) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
}
export async function startDashboard(config, port) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${port}`);
        try {
            if (url.pathname === "/")
                return sendHtml(res, INDEX_HTML);
            if (url.pathname === "/api/meta")
                return sendJson(res, { workdir: config.workdir, model: config.model });
            if (url.pathname === "/api/sessions")
                return sendJson(res, listSessions(config));
            if (url.pathname.startsWith("/api/sessions/")) {
                const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
                const data = loadSession(config, id);
                return sendJson(res, data ?? {});
            }
            if (url.pathname === "/api/cost") {
                const entries = readCostLog(config);
                return sendJson(res, {
                    entries,
                    byDay: costByDay(entries),
                    byModel: costByModel(entries),
                });
            }
            if (url.pathname === "/api/evals") {
                const file = path.join(config.workdir, "test", "eval-report.json");
                if (!fs.existsSync(file))
                    return sendJson(res, {});
                try {
                    return sendJson(res, JSON.parse(fs.readFileSync(file, "utf8")));
                }
                catch {
                    return sendJson(res, {});
                }
            }
            res.writeHead(404);
            res.end("not found");
        }
        catch (e) {
            res.writeHead(500);
            res.end(`server error: ${e?.message ?? e}`);
        }
    });
    await new Promise((resolve) => server.listen(port, () => resolve()));
    console.error(chalk.green(`dashboard listening on http://localhost:${port}`));
    console.error(chalk.dim("Ctrl-C to stop"));
    await new Promise(() => { }); // run until killed
}
//# sourceMappingURL=index.js.map