// check_sources_queue_retry.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const http = require("http");
const https = require("https");
const bs58 = require("bs58");
process.stdout.on("error", (err) => { if (err && err.code === "EPIPE") process.exit(0); });

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "LunaTV-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const MAX_DAYS = 30;
const WARN_STREAK = 3;
const ENABLE_SEARCH_TEST = true;
const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 8000;
const CONCURRENT_LIMIT = 12;
const MAX_RETRY = 2;
const RETRY_DELAY_MS = 500;

const axiosInstance = axios.create({
  timeout: TIMEOUT_MS,
  headers: { Accept: "application/json" },
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 64 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64 }),
  maxRedirects: 3,
});

const ts = () => new Date().toISOString().replace("T", " ").slice(11, 19);
const log = (...args) => console.log(`[${ts()}]`, ...args);

// === CLI 参数解析 ===
const argv = process.argv.slice(2);
const sourceUrlArg = argv.find(a => a.startsWith("--source-url="));
const SOURCE_URL = sourceUrlArg ? sourceUrlArg.split("=")[1] : null;

// === 加载配置（本地或远程） ===
async function loadConfig() {
  if (SOURCE_URL) {
    log("加载远程配置", SOURCE_URL);
    const resp = await axiosInstance.get(SOURCE_URL, { responseType: "text" });
    const raw = String(resp.data).trim();
    let text = raw;
    try {
      JSON.parse(raw);
    } catch {
      try {
        const bytes = bs58.decode(raw.replace(/\s+/g, ""));
        text = Buffer.from(bytes).toString("utf-8");
      } catch (e) {
        throw new Error("无法解析远程配置（既非 JSON 也非 Base58）");
      }
    }
    const cfg = JSON.parse(text);
    return cfg;
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在:", CONFIG_PATH);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

let config;
let apiEntries = [];

// === 读取历史记录 ===
let history = [];
if (fs.existsSync(REPORT_PATH)) {
  const old = fs.readFileSync(REPORT_PATH, "utf-8");
  const match = old.match(/```json\n([\s\S]+?)\n```/);
  if (match) {
    try {
      history = JSON.parse(match[1]);
    } catch {}
  }
}

// === 当前 CST 时间 ===
const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  .toISOString()
  .replace("T", " ")
  .slice(0, 16) + " CST";

// === 工具函数（带重试） ===
const delay = ms => new Promise(r => setTimeout(r, ms));

const safeGet = async (url) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const start = Date.now();
    try {
      try {
        log("HEAD", attempt, url);
        const resHead = await axiosInstance.head(url, { timeout: Math.min(TIMEOUT_MS, 4000) });
        const latencyMs = Date.now() - start;
        return { success: resHead.status === 200, latencyMs };
      } catch {
        log("STREAM", attempt, url);
        const controller = new AbortController();
        const t0 = Date.now();
        const res = await axiosInstance.get(url, { responseType: "stream", signal: controller.signal, timeout: TIMEOUT_MS });
        let ttfb;
        await new Promise((resolve) => {
          const onData = () => {
            ttfb = Date.now() - t0;
            controller.abort();
            try { res.data.destroy(); } catch {}
            resolve();
          };
          res.data.once("data", onData);
          res.data.once("error", resolve);
          res.data.once("end", resolve);
        });
        const latencyMs = typeof ttfb === "number" ? ttfb : Date.now() - start;
        return { success: res.status === 200, latencyMs };
      }
    } catch {
      const latencyMs = Date.now() - start;
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS * attempt);
      else return { success: false, latencyMs };
    }
  }
};

const testSearch = async (api, keyword) => {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const url = `${api}?wd=${encodeURIComponent(keyword)}`;
      const res = await axios.get(url, { timeout: TIMEOUT_MS });
      if (res.status !== 200 || !res.data || typeof res.data !== "object") return "❌";
      const list = res.data.list || [];
      if (!list.length) return "无结果";
      return list.some(item => JSON.stringify(item).includes(keyword)) ? "✅" : "不匹配";
    } catch {
      if (attempt < MAX_RETRY) await delay(RETRY_DELAY_MS);
      else return "❌";
    }
  }
};

// === 队列并发执行函数 ===
const queueRun = (tasks, limit) => {
  let index = 0;
  let active = 0;
  const results = [];

  return new Promise(resolve => {
    const next = () => {
      while (active < limit && index < tasks.length) {
        const i = index++;
        active++;
        tasks[i]().then(res => results[i] = res)
                  .catch(err => results[i] = { error: err })
                  .finally(() => {
                    active--;
                    next();
                  });
      }

      if (index >= tasks.length && active === 0) resolve(results);
    };

    next();
  });
};

// === 主逻辑 ===
(async () => {
  const tStart = Date.now();
  let completed = 0;

  config = await loadConfig();
  apiEntries = Object.values(config.api_site).map((s) => ({
    name: s.name,
    api: s.api,
    detail: s.detail || "-",
    disabled: !!s.disabled,
  }));

  log("配置源加载完成", `条目: ${apiEntries.length}`);
  log("开始检测", `总源: ${apiEntries.length}`, `并发: ${CONCURRENT_LIMIT}`);

  const tasks = apiEntries.map(({ name, api, disabled }) => async () => {
    if (disabled) return { name, api, disabled, success: false, searchStatus: "无法搜索" };

    log("开始", name);
    const { success, latencyMs } = await safeGet(api);
    const searchStatus = ENABLE_SEARCH_TEST
      ? (success ? (latencyMs < 2000 ? await testSearch(api, SEARCH_KEYWORD) : "慢速") : "-")
      : "-";
    completed++;
    log("完成", `${completed}/${apiEntries.length}`, name, success ? "✅" : "❌", `${latencyMs}ms`, searchStatus);
    return { name, api, disabled, success, latencyMs, searchStatus };
  });

  const todayResults = await queueRun(tasks, CONCURRENT_LIMIT);

  const todayRecord = {
    date: new Date().toISOString().slice(0, 10),
    keyword: SEARCH_KEYWORD,
    results: todayResults,
  };

  history.push(todayRecord);
  if (history.length > MAX_DAYS) history = history.slice(-MAX_DAYS);

  // === 统计和生成报告 ===
  const stats = {};
  for (const { name, api, detail, disabled } of apiEntries) {
    stats[api] = { name, api, detail, disabled, ok: 0, fail: 0, fail_streak: 0, trend: "", searchStatus: "-", status: "❌", latencyAvgMs: "-", lastLatencyMs: "-", reliable: "-" };

    const latencies = [];
    for (const day of history) {
      const rec = day.results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) stats[api].ok++;
      else stats[api].fail++;
      if (typeof rec.latencyMs === "number") latencies.push(rec.latencyMs);
    }

    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].results.find((x) => x.api === api);
      if (!rec) continue;
      if (rec.success) break;
      streak++;
    }
    const total = stats[api].ok + stats[api].fail;
    stats[api].successRate = total > 0 ? ((stats[api].ok / total) * 100).toFixed(1) + "%" : "-";

    const recent = history.slice(-7);
    stats[api].trend = recent.map(day => {
      const r = day.results.find(x => x.api === api);
      return r ? (r.success ? "✅" : "❌") : "-";
    }).join("");

    const latest = todayResults.find(x => x.api === api);
    if (latest) {
      stats[api].searchStatus = latest.searchStatus;
      if (typeof latest.latencyMs === "number") stats[api].lastLatencyMs = Math.round(latest.latencyMs);
    }

    if (latencies.length > 0) {
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      stats[api].latencyAvgMs = avg;
    }

    const rateNum = parseFloat(String(stats[api].successRate).replace(/%/, ""));
    const avgLatency = typeof stats[api].latencyAvgMs === "number" ? stats[api].latencyAvgMs : Infinity;
    if (!isNaN(rateNum)) {
      if (rateNum >= 90 && avgLatency < 2500) stats[api].reliable = "✅ 高";
      else if (rateNum >= 70 && avgLatency < 5000) stats[api].reliable = "⚠️ 中";
      else stats[api].reliable = "❌ 低";
    }

    if (disabled) stats[api].status = "🚫";
    else if (streak >= WARN_STREAK) stats[api].status = "🚨";
    else if (latest?.success) stats[api].status = "✅";
  }

  // === 生成 Markdown 报告 ===
  let md = `# 源接口健康检测报告\n\n`;
  md += `最近更新时间：${now}\n\n`;
  md += `**总源数:** ${apiEntries.length} | **检测关键词:** ${SEARCH_KEYWORD}\n\n`;
  md += "| 状态 | 资源名称 | 地址 | API | 搜索功能 | 成功次数 | 失败次数 | 成功率 | 最近7天趋势 | 平均响应(ms) | 最近响应(ms) | 可靠性 |\n";
  md += "|------|---------|-----|-----|---------|---------:|--------:|-------:|--------------|--------------:|--------------:|--------|\n";

  const sorted = Object.values(stats).sort((a, b) => {
    const order = { "🚨": 1, "❌": 2, "✅": 3, "🚫": 4 };
    return order[a.status] - order[b.status];
  });

  for (const s of sorted) {
    const detailLink = s.detail.startsWith("http") ? `[Link](${s.detail})` : s.detail;
    const apiLink = `[Link](${s.api})`;
    md += `| ${s.status} | ${s.name} | ${detailLink} | ${apiLink} | ${s.searchStatus} | ${s.ok} | ${s.fail} | ${s.successRate} | ${s.trend} | ${s.latencyAvgMs} | ${s.lastLatencyMs} | ${s.reliable} |\n`;
  }

  md += `\n<details>\n<summary>📜 点击展开查看历史检测数据 (JSON)</summary>\n\n`;
  md += "```json\n" + JSON.stringify(history, null, 2) + "\n```\n";
  md += `</details>\n`;


  fs.writeFileSync(REPORT_PATH, md, "utf-8");
  log("报告生成", REPORT_PATH);

  const htmlRows = sorted.map(s => {
    const detailCell = s.detail.startsWith("http") ? `<a href="${s.detail}" target="_blank" rel="noopener">Link</a>` : s.detail;
    const apiCell = `<a href="${s.api}" target="_blank" rel="noopener">Link</a>`;
    return `<tr>` +
      `<td>${s.status}</td>` +
      `<td>${s.name}</td>` +
      `<td>${detailCell}</td>` +
      `<td>${apiCell}</td>` +
      `<td>${s.searchStatus}</td>` +
      `<td style="text-align:right;">${s.ok}</td>` +
      `<td style="text-align:right;">${s.fail}</td>` +
      `<td style="text-align:right;">${s.successRate}</td>` +
      `<td>${s.trend}</td>` +
      `<td style="text-align:right;">${s.latencyAvgMs}</td>` +
      `<td style="text-align:right;">${s.lastLatencyMs}</td>` +
      `<td>${s.reliable}</td>` +
    `</tr>`;
  }).join("");

  const html = `<!DOCTYPE html>` +
  `<html lang="zh-CN">` +
  `<head>` +
  `<meta charset="UTF-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
  `<title>源接口健康检测报告</title>` +
  `<style>` +
  `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}` +
  `h1{margin:0 0 10px}` +
  `table{width:100%;border-collapse:collapse;margin-top:16px}` +
  `th,td{border:1px solid #ddd;padding:8px}` +
  `th{background:#f5f5f5;text-align:left}` +
  `code{background:#f4f4f4;padding:2px 6px;border-radius:3px}` +
  `.meta{color:#555}` +
  `</style>` +
  `</head>` +
  `<body>` +
  `<h1>源接口健康检测报告</h1>` +
  `<div class="meta">最近更新时间：${now}</div>` +
  `<div class="meta">总源数：${apiEntries.length} ｜ 检测关键词：${SEARCH_KEYWORD}</div>` +
  `<table>` +
  `<thead>` +
  `<tr>` +
  `<th>状态</th>` +
  `<th>资源名称</th>` +
  `<th>地址</th>` +
  `<th>API</th>` +
  `<th>搜索功能</th>` +
  `<th>成功次数</th>` +
  `<th>失败次数</th>` +
  `<th>成功率</th>` +
  `<th>最近7天趋势</th>` +
  `<th>平均响应(ms)</th>` +
  `<th>最近响应(ms)</th>` +
  `<th>可靠性</th>` +
  `</tr>` +
  `</thead>` +
  `<tbody>` +
  htmlRows +
  `</tbody>` +
  `</table>` +
  `</body>` +
  `</html>`;

  const HTML_PATH = path.join(__dirname, "report.html");
  fs.writeFileSync(HTML_PATH, html, "utf-8");
  log("HTML 生成", HTML_PATH);
  const tEnd = Date.now();
  log("完成", `耗时: ${Math.round(tEnd - tStart)}ms`);

  const reliable = {};
  const entries = config.api_site || {};
  for (const [key, val] of Object.entries(entries)) {
    const s = stats[val.api];
    if (!s) continue;
    const rate = parseFloat(String(s.successRate).replace(/%/, ""));
    if (!isNaN(rate) && rate >= 90 && s.status !== "🚨") {
      reliable[key] = val;
    }
  }
  const reliableOut = { api_site: reliable };
  const RELIABLE_PATH = path.join(__dirname, "reliable-config.json");
  fs.writeFileSync(RELIABLE_PATH, JSON.stringify(reliableOut, null, 2), "utf-8");
  log("可靠配置生成", RELIABLE_PATH, `数量: ${Object.keys(reliable).length}`);

  try {
    const ha = axiosInstance.defaults.httpAgent;
    const hsa = axiosInstance.defaults.httpsAgent;
    if (ha && typeof ha.destroy === "function") ha.destroy();
    if (hsa && typeof hsa.destroy === "function") hsa.destroy();
  } catch {}

  process.exit(0);
})();
