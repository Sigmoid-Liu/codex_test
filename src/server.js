import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const holdingsPath = path.join(rootDir, "data", "holdings.json");
const cacheDir = path.join(rootDir, "data", "cache");
const cachePath = path.join(cacheDir, "portfolio.json");
const port = Number(process.env.PORT || 3000);

let portfolioCache = null;
let refreshState = {
  running: false,
  lastError: null
};

function nasdaqHistoryUrl(symbol) {
  const encoded = encodeURIComponent(symbol);
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  return `https://api.nasdaq.com/api/quote/${encoded}/historical?assetclass=stocks&fromdate=${from.toISOString().slice(0, 10)}&todate=${to.toISOString().slice(0, 10)}&limit=400`;
}

function yahooRssUrl(symbol) {
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
}

function isAshareSymbol(symbol) {
  return /^\d{6}$/.test(String(symbol));
}

function ashareMarketPrefix(symbol) {
  return /^(6|9)/.test(String(symbol)) ? "1" : "0";
}

function eastmoneySecid(symbol) {
  return `${ashareMarketPrefix(symbol)}.${symbol}`;
}

function eastmoneyHistoryUrl(symbol) {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  const begin = from.toISOString().slice(0, 10).replaceAll("-", "");
  const end = to.toISOString().slice(0, 10).replaceAll("-", "");
  const fields1 = "f1,f2,f3,f4,f5,f6";
  const fields2 = "f51,f52,f53,f54,f55,f56,f57,f58";
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${eastmoneySecid(symbol)}&fields1=${fields1}&fields2=${fields2}&klt=101&fqt=1&beg=${begin}&end=${end}`;
}

function eastmoneyNewsUrl(symbol) {
  const exchange = ashareMarketPrefix(symbol) === "1" ? "SH" : "SZ";
  return `https://emweb.securities.eastmoney.com/PC_HSF10/NewsBulletin/PageAjax?code=${exchange}${symbol}`;
}

function calculateMaxDrawdown(points) {
  let peak = -Infinity;
  let drawdownPeak = null;
  let trough = null;
  let peakDate = null;
  let drawdownPeakDate = null;
  let troughDate = null;
  let maxDrawdown = 0;

  for (const point of points) {
    if (!Number.isFinite(point.close)) continue;
    if (point.close > peak) {
      peak = point.close;
      peakDate = point.date;
    }

    const drawdown = peak > 0 ? (point.close - peak) / peak : 0;
    if (drawdown < maxDrawdown) {
      maxDrawdown = drawdown;
      drawdownPeak = peak;
      trough = point.close;
      drawdownPeakDate = peakDate;
      troughDate = point.date;
    }
  }

  return {
    percent: maxDrawdown,
    peak: drawdownPeak,
    trough,
    peakDate: drawdownPeakDate,
    troughDate
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "origin": "https://www.nasdaq.com",
      "referer": "https://www.nasdaq.com/",
      "user-agent": "Mozilla/5.0 portfolio-watch/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/rss+xml,application/xml,text/xml,text/plain,*/*",
      "user-agent": "portfolio-watch/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}`);
  }

  return response.text();
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function parseNasdaqMoney(value) {
  if (!value) return null;
  const number = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function parseNasdaqDate(value) {
  const [month, day, year] = String(value).split("/");
  if (!month || !day || !year) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

async function loadHoldings() {
  const raw = await readFile(holdingsPath, "utf8");
  return JSON.parse(raw);
}

function normalizeHoldings(input) {
  if (!Array.isArray(input)) {
    throw new Error("Holdings must be an array");
  }

  const holdings = input.map((item) => ({
    symbol: String(item.symbol || "").trim().toUpperCase(),
    name: String(item.name || "").trim(),
    shares: Number(item.shares),
    costBasis: Number(item.costBasis)
  })).filter((item) => item.symbol);

  if (!holdings.length) {
    throw new Error("Please add at least one holding");
  }

  if (holdings.length > 20) {
    throw new Error("Please keep holdings to 20 symbols or fewer");
  }

  for (const holding of holdings) {
    if (!Number.isFinite(holding.shares) || holding.shares <= 0) {
      throw new Error(`${holding.symbol} has an invalid share count`);
    }
    if (!Number.isFinite(holding.costBasis) || holding.costBasis < 0) {
      throw new Error(`${holding.symbol} has an invalid cost basis`);
    }
  }

  return holdings;
}

async function fetchQuoteHistory(symbol) {
  if (isAshareSymbol(symbol)) {
    return fetchAshareQuoteHistory(symbol);
  }

  return fetchUsQuoteHistory(symbol);
}

async function fetchAshareQuoteHistory(symbol) {
  const json = await fetchJson(eastmoneyHistoryUrl(symbol));
  const rows = json.data?.klines || [];
  if (!rows.length) throw new Error(`No historical data returned for ${symbol}`);

  const points = rows
    .map((row) => {
      const [date, open, close] = row.split(",");
      return { date, close: Number(close) };
    })
    .filter((point) => point.date && Number.isFinite(point.close));

  const latest = points.at(-1);
  const previous = points.at(-2);
  const first = points.at(0);

  return {
    currency: "CNY",
    exchange: ashareMarketPrefix(symbol) === "1" ? "SSE" : "SZSE",
    latestPrice: latest?.close ?? null,
    latestDate: latest?.date ?? null,
    previousClose: previous?.close ?? null,
    oneYearStart: first?.close ?? null,
    series: points,
    maxDrawdown: calculateMaxDrawdown(points)
  };
}

async function fetchUsQuoteHistory(symbol) {
  const json = await fetchJson(nasdaqHistoryUrl(symbol));
  const rows = json.data?.tradesTable?.rows || [];
  if (!rows.length) throw new Error(`No historical data returned for ${symbol}`);

  const points = rows
    .map((row) => ({
      date: parseNasdaqDate(row.date),
      close: parseNasdaqMoney(row.close)
    }))
    .filter((point) => point.close !== null);
  points.sort((a, b) => a.date.localeCompare(b.date));

  const latest = points.at(-1);
  const previous = points.at(-2);
  const first = points.at(0);

  return {
    currency: "USD",
    exchange: "NASDAQ",
    latestPrice: latest?.close ?? null,
    latestDate: latest?.date ?? null,
    previousClose: previous?.close ?? null,
    oneYearStart: first?.close ?? null,
    series: points,
    maxDrawdown: calculateMaxDrawdown(points)
  };
}

async function fetchNews(symbol) {
  if (isAshareSymbol(symbol)) {
    return fetchAshareNews(symbol);
  }

  try {
    const xml = await fetchText(yahooRssUrl(symbol));
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 5);
    const feedTitle = extractTag(xml, "title") || "Yahoo Finance";

    return items.map((match) => ({
      title: extractTag(match[1], "title") || "Untitled",
      link: extractTag(match[1], "link"),
      source: extractTag(match[1], "source") || feedTitle,
      publishedAt: extractTag(match[1], "pubDate") || null
    }));
  } catch (error) {
    return [{
      title: `News temporarily unavailable for ${symbol}`,
      link: "",
      source: "System",
      publishedAt: new Date().toISOString(),
      error: error.message
    }];
  }
}

async function fetchAshareNews(symbol) {
  try {
    const json = await fetchJson(eastmoneyNewsUrl(symbol));
    const items = json.gszx?.data?.items || [];
    return items.slice(0, 5).map((item) => ({
      title: item.title || "未命名资讯",
      link: item.uniqueUrl || item.url || "",
      source: item.source || "东方财富",
      publishedAt: item.showDateTime ? new Date(item.showDateTime).toISOString() : null,
      summary: item.summary || ""
    }));
  } catch (error) {
    return [{
      title: `${symbol} 资讯暂时不可用`,
      link: `https://so.eastmoney.com/news/s?keyword=${encodeURIComponent(symbol)}`,
      source: "System",
      publishedAt: new Date().toISOString(),
      error: error.message
    }];
  }
}

function enrichHolding(holding, market, news) {
  const latestPrice = market.latestPrice;
  const marketValue = Number.isFinite(latestPrice) ? latestPrice * holding.shares : null;
  const costValue = Number.isFinite(holding.costBasis) ? holding.costBasis * holding.shares : null;
  const dayChange = market.previousClose && latestPrice
    ? (latestPrice - market.previousClose) / market.previousClose
    : null;
  const oneYearChange = market.oneYearStart && latestPrice
    ? (latestPrice - market.oneYearStart) / market.oneYearStart
    : null;
  const unrealizedPnl = marketValue !== null && costValue !== null ? marketValue - costValue : null;
  const unrealizedPnlPercent = unrealizedPnl !== null && costValue > 0 ? unrealizedPnl / costValue : null;

  return {
    ...holding,
    market,
    news,
    metrics: {
      marketValue,
      costValue,
      dayChange,
      oneYearChange,
      unrealizedPnl,
      unrealizedPnlPercent
    }
  };
}

function summarizePortfolio(positions) {
  const currencies = [...new Set(positions.map((item) => item.market.currency))];
  const hasSingleCurrency = currencies.length <= 1;
  const totalMarketValue = positions.reduce((sum, item) => sum + (item.metrics.marketValue || 0), 0);
  const totalCostValue = positions.reduce((sum, item) => sum + (item.metrics.costValue || 0), 0);
  const totalPnl = totalMarketValue - totalCostValue;
  const worstDrawdown = positions.reduce((worst, item) => {
    const drawdown = item.market.maxDrawdown.percent;
    return drawdown < worst.percent
      ? { symbol: item.symbol, percent: drawdown, peakDate: item.market.maxDrawdown.peakDate, troughDate: item.market.maxDrawdown.troughDate }
      : worst;
  }, { symbol: null, percent: 0, peakDate: null, troughDate: null });

  return {
    currency: hasSingleCurrency ? positions[0]?.market.currency || "USD" : "MIXED",
    totalMarketValue: hasSingleCurrency ? totalMarketValue : null,
    totalCostValue: hasSingleCurrency ? totalCostValue : null,
    totalPnl: hasSingleCurrency ? totalPnl : null,
    totalPnlPercent: hasSingleCurrency && totalCostValue > 0 ? totalPnl / totalCostValue : null,
    worstDrawdown
  };
}

async function analyzeHoldings(holdings) {
  const normalizedHoldings = normalizeHoldings(holdings);
  const positions = await Promise.all(normalizedHoldings.map(async (holding) => {
    const [market, news] = await Promise.all([
      fetchQuoteHistory(holding.symbol),
      fetchNews(holding.symbol)
    ]);
    return enrichHolding(holding, market, news);
  }));

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizePortfolio(positions),
    positions
  };
}

async function refreshPortfolio() {
  if (refreshState.running) return portfolioCache;
  refreshState = { running: true, lastError: null };

  try {
    const holdings = await loadHoldings();
    portfolioCache = {
      ...await analyzeHoldings(holdings),
      holdingsPath,
    };

    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(portfolioCache, null, 2));
    return portfolioCache;
  } catch (error) {
    refreshState.lastError = error.message;
    if (portfolioCache) return portfolioCache;

    try {
      portfolioCache = JSON.parse(await readFile(cachePath, "utf8"));
      return portfolioCache;
    } catch {
      throw error;
    }
  } finally {
    refreshState.running = false;
  }
}

async function loadInitialCache() {
  try {
    portfolioCache = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    portfolioCache = null;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) {
      throw new Error("Request body is too large");
    }
  }

  return raw ? JSON.parse(raw) : {};
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  }[ext] || "application/octet-stream";
}

async function sendStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(rootDir, "public", safePath);

  if (!filePath.startsWith(path.join(rootDir, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": body.length
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function nextShanghaiRefreshDelay() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  let nextUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 30);

  if (nextUtc <= now.getTime()) {
    nextUtc += 24 * 60 * 60 * 1000;
  }

  return nextUtc - now.getTime();
}

function scheduleDailyRefresh() {
  setTimeout(() => {
    refreshPortfolio().catch((error) => {
      refreshState.lastError = error.message;
    }).finally(scheduleDailyRefresh);
  }, nextShanghaiRefreshDelay());
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/healthz") && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (req.url.startsWith("/api/portfolio") && req.method === "GET") {
    try {
      const data = portfolioCache || await refreshPortfolio();
      sendJson(res, 200, { ...data, refreshState });
    } catch (error) {
      sendJson(res, 500, { error: error.message, refreshState });
    }
    return;
  }

  if (req.url.startsWith("/api/refresh") && req.method === "POST") {
    try {
      const data = await refreshPortfolio();
      sendJson(res, 200, { ...data, refreshState });
    } catch (error) {
      sendJson(res, 500, { error: error.message, refreshState });
    }
    return;
  }

  if (req.url.startsWith("/api/analyze") && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const data = await analyzeHoldings(body.holdings);
      sendJson(res, 200, { ...data, refreshState });
    } catch (error) {
      sendJson(res, 400, { error: error.message, refreshState });
    }
    return;
  }

  await sendStatic(req, res);
});

await loadInitialCache();
refreshPortfolio().catch((error) => {
  refreshState.lastError = error.message;
});
scheduleDailyRefresh();

server.listen(port, () => {
  console.log(`Portfolio Watch running at http://localhost:${port}`);
});
