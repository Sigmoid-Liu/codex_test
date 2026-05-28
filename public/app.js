let holdings = [];
let portfolio = null;
let selectedSymbol = null;
let chart = null;

const storageKey = "portfolio-watch-holdings";
const defaultHoldings = [
  { symbol: "300857", name: "协创数据", shares: 400, costBasis: 254 },
  { symbol: "002487", name: "大金重工", shares: 1000, costBasis: 75 }
];

const els = {
  refreshBtn: document.querySelector("#refreshBtn"),
  shareBtn: document.querySelector("#shareBtn"),
  addHoldingBtn: document.querySelector("#addHoldingBtn"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  holdingsForm: document.querySelector("#holdingsForm"),
  holdingRows: document.querySelector("#holdingRows"),
  formStatus: document.querySelector("#formStatus"),
  totalMarketValue: document.querySelector("#totalMarketValue"),
  totalPnl: document.querySelector("#totalPnl"),
  worstDrawdown: document.querySelector("#worstDrawdown"),
  generatedAt: document.querySelector("#generatedAt"),
  positionCount: document.querySelector("#positionCount"),
  positions: document.querySelector("#positions"),
  selectedName: document.querySelector("#selectedName"),
  selectedSymbol: document.querySelector("#selectedSymbol"),
  selectedPrice: document.querySelector("#selectedPrice"),
  selectedChange: document.querySelector("#selectedChange"),
  selectedDrawdown: document.querySelector("#selectedDrawdown"),
  selectedDrawdownRange: document.querySelector("#selectedDrawdownRange"),
  selectedPnl: document.querySelector("#selectedPnl"),
  news: document.querySelector("#news"),
  chartCanvas: document.querySelector("#priceChart")
};

const moneyFormatters = new Map();

const percent = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  maximumFractionDigits: 2
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatMoney(value, currency = "USD") {
  if (!Number.isFinite(value)) return "--";
  if (currency === "MIXED") return "多币种";
  if (!moneyFormatters.has(currency)) {
    moneyFormatters.set(currency, new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }));
  }
  return moneyFormatters.get(currency).format(value);
}

function formatPercent(value) {
  return Number.isFinite(value) ? percent.format(value) : "--";
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function classFor(value) {
  if (!Number.isFinite(value) || value === 0) return "";
  return value > 0 ? "positive" : "negative";
}

function encodeHoldings(value) {
  const binary = unescape(encodeURIComponent(JSON.stringify(value)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeHoldings(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(decodeURIComponent(escape(atob(base64))));
}

function normalizeHolding(item) {
  return {
    symbol: String(item.symbol || "").trim().toUpperCase(),
    name: String(item.name || "").trim(),
    shares: Number(item.shares),
    costBasis: Number(item.costBasis)
  };
}

function readHoldingsFromForm() {
  return [...els.holdingRows.querySelectorAll(".holding-row")]
    .map((row) => normalizeHolding({
      symbol: row.querySelector("[name='symbol']").value,
      name: row.querySelector("[name='name']").value,
      shares: row.querySelector("[name='shares']").value,
      costBasis: row.querySelector("[name='costBasis']").value
    }))
    .filter((item) => item.symbol);
}

function saveHoldings() {
  localStorage.setItem(storageKey, JSON.stringify(holdings));
}

function setStatus(message, tone = "") {
  els.formStatus.textContent = message;
  els.formStatus.className = `form-status ${tone}`;
}

function renderHoldingRows() {
  els.holdingRows.innerHTML = "";
  holdings.forEach((holding, index) => {
    const row = document.createElement("div");
    row.className = "form-grid holding-row";
    row.innerHTML = `
      <input name="symbol" autocomplete="off" placeholder="300857 / AAPL" value="${escapeHtml(holding.symbol)}" required>
      <input name="name" autocomplete="off" placeholder="可选" value="${escapeHtml(holding.name)}">
      <input name="shares" type="number" min="0" step="0.01" value="${Number.isFinite(holding.shares) ? holding.shares : ""}" required>
      <input name="costBasis" type="number" min="0" step="0.001" value="${Number.isFinite(holding.costBasis) ? holding.costBasis : ""}" required>
      <button class="remove-button" type="button" title="删除" aria-label="删除">×</button>
    `;
    row.querySelector(".remove-button").addEventListener("click", () => {
      holdings.splice(index, 1);
      if (!holdings.length) holdings.push({ symbol: "", name: "", shares: 0, costBasis: 0 });
      renderHoldingRows();
    });
    els.holdingRows.append(row);
  });
}

function setSummary(data) {
  const currency = data.summary.currency || data.positions[0]?.market.currency || "USD";
  els.totalMarketValue.textContent = formatMoney(data.summary.totalMarketValue, currency);
  els.totalPnl.textContent = `${formatMoney(data.summary.totalPnl, currency)} (${formatPercent(data.summary.totalPnlPercent)})`;
  els.totalPnl.className = classFor(data.summary.totalPnl);
  els.worstDrawdown.textContent = `${data.summary.worstDrawdown.symbol || "--"} ${formatPercent(data.summary.worstDrawdown.percent)}`;
  els.worstDrawdown.className = "negative";
  els.generatedAt.textContent = formatTime(data.generatedAt);
  els.positionCount.textContent = data.positions.length;
}

function renderPositions(data) {
  els.positions.innerHTML = "";
  for (const position of data.positions) {
    const button = document.createElement("button");
    button.className = `position ${position.symbol === selectedSymbol ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(position.symbol)}</strong>
        <small>${escapeHtml(position.name || position.market.exchange || "Holding")}</small>
      </span>
      <span class="position-price">
        <strong>${formatMoney(position.market.latestPrice, position.market.currency)}</strong>
        <small class="${classFor(position.metrics.dayChange)}">${formatPercent(position.metrics.dayChange)}</small>
      </span>
    `;
    button.addEventListener("click", () => selectPosition(position.symbol));
    els.positions.append(button);
  }
}

function renderChart(position) {
  const labels = position.market.series.map((point) => point.date);
  const values = position.market.series.map((point) => point.close);

  if (chart) chart.destroy();
  chart = new Chart(els.chartCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `${position.symbol} 收盘价`,
        data: values,
        borderColor: "#1f6f78",
        backgroundColor: "rgba(31, 111, 120, 0.12)",
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8 },
          grid: { display: false }
        },
        y: {
          ticks: {
            callback: (value) => formatMoney(value, position.market.currency)
          }
        }
      }
    }
  });
}

function renderNews(position) {
  els.news.innerHTML = "";
  for (const item of position.news) {
    const link = document.createElement(item.link ? "a" : "div");
    link.className = "news-item";
    if (item.link) {
      link.href = item.link;
      link.target = "_blank";
      link.rel = "noreferrer";
    }
    link.innerHTML = `
      <strong>${escapeHtml(item.title)}</strong>
      <span class="news-meta">${escapeHtml(item.source || "News")} · ${formatTime(item.publishedAt)}</span>
    `;
    els.news.append(link);
  }
}

function clearDetail() {
  els.selectedName.textContent = "--";
  els.selectedSymbol.textContent = "先添加持仓";
  els.selectedPrice.textContent = "--";
  els.selectedChange.textContent = "--";
  els.selectedDrawdown.textContent = "--";
  els.selectedDrawdownRange.textContent = "--";
  els.selectedPnl.textContent = "--";
  els.news.innerHTML = "";
  if (chart) chart.destroy();
}

function selectPosition(symbol) {
  selectedSymbol = symbol;
  const position = portfolio?.positions.find((item) => item.symbol === symbol);
  if (!position) return;

  renderPositions(portfolio);
  els.selectedName.textContent = position.name || position.market.exchange || "Holding";
  els.selectedSymbol.textContent = position.symbol;
  els.selectedPrice.textContent = formatMoney(position.market.latestPrice, position.market.currency);
  els.selectedChange.textContent = `今日 ${formatPercent(position.metrics.dayChange)} · 一年 ${formatPercent(position.metrics.oneYearChange)}`;
  els.selectedChange.className = classFor(position.metrics.dayChange);
  els.selectedDrawdown.textContent = formatPercent(position.market.maxDrawdown.percent);
  els.selectedDrawdown.className = "negative";
  els.selectedDrawdownRange.textContent = `${position.market.maxDrawdown.peakDate || "--"} 至 ${position.market.maxDrawdown.troughDate || "--"}`;
  els.selectedPnl.textContent = `${formatMoney(position.metrics.unrealizedPnl, position.market.currency)} (${formatPercent(position.metrics.unrealizedPnlPercent)})`;
  els.selectedPnl.className = classFor(position.metrics.unrealizedPnl);
  renderChart(position);
  renderNews(position);
}

async function analyzePortfolio() {
  holdings = readHoldingsFromForm();
  if (!holdings.length) {
    setStatus("请先添加至少一只股票", "error");
    return;
  }

  els.refreshBtn.disabled = true;
  els.analyzeBtn.disabled = true;
  setStatus("正在更新行情和资讯...");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holdings })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "数据加载失败");

    portfolio = payload;
    saveHoldings();
    if (!portfolio.positions.some((position) => position.symbol === selectedSymbol)) {
      selectedSymbol = portfolio.positions[0]?.symbol;
    }
    setSummary(portfolio);
    renderPositions(portfolio);
    selectPosition(selectedSymbol);
    setStatus("已更新", "success");
  } catch (error) {
    setStatus(error.message, "error");
    els.news.innerHTML = `<div class="news-item"><strong>${escapeHtml(error.message)}</strong><span class="news-meta">请检查代码、股数和成本价</span></div>`;
  } finally {
    els.refreshBtn.disabled = false;
    els.analyzeBtn.disabled = false;
  }
}

async function sharePortfolio() {
  holdings = readHoldingsFromForm();
  const url = new URL(window.location.href);
  url.searchParams.set("h", encodeHoldings(holdings));
  const shareUrl = url.toString();

  try {
    await navigator.clipboard.writeText(shareUrl);
    setStatus("分享链接已复制", "success");
  } catch {
    window.prompt("复制分享链接", shareUrl);
  }
}

function initHoldings() {
  const params = new URLSearchParams(window.location.search);
  const shared = params.get("h");

  try {
    if (shared) {
      holdings = decodeHoldings(shared).map(normalizeHolding);
      localStorage.setItem(storageKey, JSON.stringify(holdings));
      return;
    }
  } catch {
    setStatus("分享链接解析失败，已加载本地持仓", "error");
  }

  try {
    holdings = JSON.parse(localStorage.getItem(storageKey) || "null") || defaultHoldings;
  } catch {
    holdings = defaultHoldings;
  }

  holdings = holdings.map(normalizeHolding);
}

els.addHoldingBtn.addEventListener("click", () => {
  holdings = readHoldingsFromForm();
  holdings.push({ symbol: "", name: "", shares: 0, costBasis: 0 });
  renderHoldingRows();
});

els.holdingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  analyzePortfolio();
});

els.refreshBtn.addEventListener("click", analyzePortfolio);
els.shareBtn.addEventListener("click", sharePortfolio);

initHoldings();
renderHoldingRows();
clearDetail();
analyzePortfolio();
