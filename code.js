/*
===========================================================
NEXUS CRYPT V4 — LIVE
Display + manual-override layer over kalshi-bridge.js.
kalshi-bridge.js remains the brain: real auth, real balance,
real order gating, hardcoded caps. This file never talks to
Kalshi directly and never holds a Kalshi key.

VESKA = Execution   NORO  = Fair Value   LUMEN = Sentiment
TIDAL = Scanner     ZEPHR = Liquidity    RUNE  = Risk Gate
OKAPI = Exposure    MARIN = Liquidation
===========================================================
*/

(() => {
  "use strict";

  /* ================================================================
     BRIDGE CONFIG
     Leave baseUrl "" if these files are served BY the bridge itself
     (drop them into wherever kalshi-bridge.js serves its dashboard
     from — same-origin, no CORS issues). Only set baseUrl if NEXUS
     is hosted somewhere else and needs to reach the bridge remotely
     — note that "somewhere else" must still be able to route to
     wherever the bridge actually runs; a public host cannot reach
     your laptop's localhost.
  ================================================================ */
  const BRIDGE = {
    baseUrl: "",
    pollInterval: 4000,
    pairs: ["SOL", "DOGE", "XRP", "BNB"],
    endpoints: {
      status: () => "/status",
      balance: () => "/balance",
      risk: () => "/risk",
      markets: () => "/markets",
      confidence: (pair) => `/confidence/${pair}`,
      orders: () => "/orders"
    }
  };

  /* ================================================================
     ⚠️ ADAPTER — VERIFY AGAINST YOUR REAL BRIDGE, THEN EDIT HERE ⚠️
     Run these and compare field names to the guesses below:
       curl http://localhost:9000/status
       curl http://localhost:9000/balance
       curl http://localhost:9000/risk
       curl http://localhost:9000/markets
       curl http://localhost:9000/confidence/SOL
     Every render function reads data THROUGH these functions, so
     fixing a field name here fixes it everywhere on the dashboard.
     Anything genuinely not exposed by the bridge stays null — the
     UI shows "N/A" rather than a fabricated number.
  ================================================================ */
  const adapt = {
    balanceUsd: (j) =>
      j?.balance ?? j?.balance_usd ??
      (j?.balance_cents != null ? j.balance_cents / 100 : null),

    liveTradingEnabled: (j) =>
      j?.live_trading_enabled ?? j?.liveTradingEnabled ?? j?.armed ?? false,

    dailyPnl: (j) =>
      j?.daily_pnl ?? j?.dailyPnL ?? j?.realized_pnl_today ?? null,

    dailyLossCap: (j) =>
      j?.daily_loss_cap ?? j?.dailyLossCap ?? 7.0,

    positionCount: (j) =>
      j?.position_count ?? (Array.isArray(j?.open_positions) ? j.open_positions.length : null) ?? 0,

    maxPositions: (j) =>
      j?.max_positions ?? j?.maxPositions ?? 5,

    positions: (j) =>
      j?.positions ?? j?.open_positions ?? [],

    price: (j) =>
      j?.price ?? j?.market_price ?? j?.mid_price ?? null,

    confidenceScore: (j) =>
      j?.confidence ?? j?.confidence_score ?? null,

    edgeYes: (j) =>
      j?.edge_yes ?? j?.edgeYes ?? null,

    edgeNo: (j) =>
      j?.edge_no ?? j?.edgeNo ?? null,

    openInterest: (j) =>
      j?.open_interest ?? j?.volume ?? null,

    orderBookImbalance: (j) =>
      j?.order_book_imbalance ?? j?.imbalance ?? null,

    bestPair: (j) =>
      j?.best_pair ?? j?.top_pair ?? null,

    marketEntryForPair: (marketsJson, pair) => {
      const list =
        marketsJson?.markets ??
        marketsJson?.pairs ??
        (Array.isArray(marketsJson) ? marketsJson : null);

      if (!list) return null;

      return list.find(
        (m) => (m.pair ?? m.symbol ?? m.ticker) === pair
      ) ?? null;
    },

    orderAccepted: (j) => j?.accepted ?? j?.ok ?? j?.success ?? false,
    orderReason: (j) => j?.reason ?? j?.message ?? j?.error ?? ""
  };

  /* ======================================================
     STATE — mirrors the bridge, holds nothing authoritative
  ====================================================== */

  const state = {
    connected: false,
    polling: true,
    pair: BRIDGE.pairs[0],
    cycle: 0,
    status: null,
    balance: null,
    risk: null,
    markets: null,
    confidence: null,
    ledger: []
  };

  /* ======================================================
     DOM HELPERS
  ====================================================== */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function setText(sel, value) {
    $$(sel).forEach((el) => { el.textContent = value; });
  }

  function formatMoney(value) {
    if (value == null || !Number.isFinite(value)) return "—";
    return Number(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function formatPct(value, decimals = 1) {
    if (value == null || !Number.isFinite(value)) return "—";
    return `${(value * (Math.abs(value) <= 1 ? 100 : 1)).toFixed(decimals)}%`;
  }

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  /* ======================================================
     BRIDGE CLIENT
  ====================================================== */

  async function fetchJSON(path) {
    const res = await fetch(BRIDGE.baseUrl + path, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async function pollOnce() {
    try {
      const [status, balance, risk, markets, confidence] = await Promise.all([
        fetchJSON(BRIDGE.endpoints.status()),
        fetchJSON(BRIDGE.endpoints.balance()),
        fetchJSON(BRIDGE.endpoints.risk()),
        fetchJSON(BRIDGE.endpoints.markets()),
        fetchJSON(BRIDGE.endpoints.confidence(state.pair))
      ]);

      state.status = status;
      state.balance = balance;
      state.risk = risk;
      state.markets = markets;
      state.confidence = confidence;
      state.cycle++;

      setConnected(true);
    } catch (err) {
      setConnected(false);
      addLedger("NEXUS", "BRIDGE UNREACHABLE", err.message);
    }

    render();
  }

  function setConnected(ok) {
    const wasConnected = state.connected;
    state.connected = ok;

    const banner = $("#connection-banner");
    if (banner) banner.hidden = ok;

    const urlDisplay = $("#bridge-url-display");
    if (urlDisplay) urlDisplay.textContent = BRIDGE.baseUrl || window.location.origin;

    if (ok && !wasConnected) {
      addLedger("NEXUS", "BRIDGE CONNECTED", `Polling ${BRIDGE.baseUrl || "same origin"}`);
    }
  }

  /* ======================================================
     LEDGER
  ====================================================== */

  function addLedger(agent, action, details) {
    state.ledger.unshift({ time: nowTime(), agent, action, details });
    if (state.ledger.length > 100) state.ledger.pop();
  }

  function renderLedger() {
    const ledger = $("#ledger");
    if (!ledger) return;

    ledger.innerHTML = state.ledger
      .slice(0, 25)
      .map(
        (e) => `
          <div class="ledger-entry">
            <span class="ledger-time">${e.time}</span>
            <strong>${e.agent}</strong>
            <span>${e.action}</span>
            <small>${e.details}</small>
          </div>
        `
      )
      .join("");
  }

  /* ======================================================
     AGENT SIGNAL DERIVATION
     Best-effort mapping from bridge fields to the 8 named
     agent cards. Anything the bridge doesn't expose reads
     "N/A" instead of a made-up value — fill these in once
     you confirm what /risk and /markets actually return.
  ====================================================== */

  function computeAgentSignals() {
    const conf = state.confidence;
    const risk = state.risk;
    const marketEntry = adapt.marketEntryForPair(state.markets, state.pair);

    const edgeYes = adapt.edgeYes(conf);
    const edgeNo = adapt.edgeNo(conf);
    const confidenceScore = adapt.confidenceScore(conf);
    const imbalance = adapt.orderBookImbalance(conf) ?? adapt.orderBookImbalance(marketEntry);

    const dailyPnl = adapt.dailyPnl(risk);
    const dailyCap = adapt.dailyLossCap(risk);
    const posCount = adapt.positionCount(risk);
    const maxPos = adapt.maxPositions(risk);

    const signals = {};

    // NORO — fair value / edge
    if (edgeYes != null || edgeNo != null) {
      const best = Math.max(edgeYes ?? -Infinity, edgeNo ?? -Infinity);
      signals.NORO = {
        signal: best > 0 ? (edgeYes >= edgeNo ? "BUY" : "SELL") : "HOLD",
        detail: `edge_yes ${formatPct(edgeYes)} / edge_no ${formatPct(edgeNo)}`
      };
    } else {
      signals.NORO = { signal: "N/A", detail: "Bridge did not return edge_yes/edge_no" };
    }

    // LUMEN — sentiment (order book imbalance as proxy; adjust if bridge has real sentiment)
    if (imbalance != null) {
      signals.LUMEN = {
        signal: imbalance > 0.2 ? "BUY" : imbalance < -0.2 ? "SELL" : "HOLD",
        detail: `Order book imbalance ${formatPct(imbalance)}`
      };
    } else {
      signals.LUMEN = { signal: "N/A", detail: "No sentiment/imbalance field found" };
    }

    // TIDAL — scanner
    const bestPair = adapt.bestPair(state.markets);
    signals.TIDAL = {
      signal: bestPair ? "SCANNING" : (state.connected ? "SCANNING" : "OFFLINE"),
      detail: bestPair ? `Favoring ${bestPair}` : `Watching ${BRIDGE.pairs.join("/")}`
    };

    // ZEPHR — liquidity / open interest
    const openInterest = adapt.openInterest(conf) ?? adapt.openInterest(marketEntry);
    signals.ZEPHR = {
      signal: openInterest == null ? "N/A" : openInterest < 20 ? "CAUTION" : "CLEAR",
      detail: openInterest == null ? "No open-interest field found" : `Open interest ${openInterest}`
    };

    // RUNE — risk gate (daily loss cap)
    if (dailyPnl != null) {
      const usedPct = dailyCap ? Math.abs(Math.min(dailyPnl, 0)) / dailyCap : 0;
      signals.RUNE = {
        signal: usedPct >= 1 ? "BLOCK" : usedPct >= 0.7 ? "CAUTION" : "CLEAR",
        detail: `Daily P&L ${formatMoney(dailyPnl)} of ${formatMoney(-dailyCap)} cap`
      };
    } else {
      signals.RUNE = { signal: "N/A", detail: "No daily_pnl field found on /risk" };
    }

    // OKAPI — exposure (position count vs max)
    signals.OKAPI = {
      signal: posCount >= maxPos ? "BLOCK" : posCount >= maxPos - 1 ? "CAUTION" : "CLEAR",
      detail: `${posCount} / ${maxPos} concurrent positions`
    };

    // MARIN — liquidation
    const positions = adapt.positions(risk);
    const hasPosition = Array.isArray(positions) && positions.length > 0;
    signals.MARIN = hasPosition
      ? { signal: "MONITORING", detail: `${positions.length} open position(s)` }
      : { signal: "STANDBY", detail: "No active position" };

    // VESKA — execution / arm state
    const armed = adapt.liveTradingEnabled(state.status);
    signals.VESKA = {
      signal: armed ? "ARMED" : "DRY-RUN",
      detail: armed ? "LIVE_TRADING_ENABLED = true" : "Bridge is in simulated/dry-run mode"
    };

    return signals;
  }

  /* ======================================================
     RENDER
  ====================================================== */

  function renderHeader() {
    const armed = adapt.liveTradingEnabled(state.status);

    setText("#mode-label", state.connected ? (armed ? "LIVE" : "DRY-RUN") : "OFFLINE");
    setText("#footer-mode", armed ? "LIVE / REAL MONEY" : "DRY-RUN / NO REAL ORDERS");
    setText("#last-cycle", nowTime());
    setText("#cycle", state.cycle);
    setText("#cycles", state.cycle);

    const dot = $("#mode-dot");
    if (dot) {
      dot.classList.toggle("state-live", !!armed && state.connected);
      dot.classList.toggle("state-offline", !state.connected);
    }
  }

  function renderStats() {
    const balance = adapt.balanceUsd(state.balance);
    const dailyPnl = adapt.dailyPnl(state.risk);
    const confidenceScore = adapt.confidenceScore(state.confidence);

    setText("#vitality", state.connected ? "100%" : "0%");
    setText("#consensus", confidenceScore == null ? "—" : formatPct(confidenceScore));
    setText("#equity", formatMoney(balance));
    setText("#pnl", formatMoney(dailyPnl));
  }

  function renderMarket() {
    const conf = state.confidence;
    const marketEntry = adapt.marketEntryForPair(state.markets, state.pair);
    const price = adapt.price(conf) ?? adapt.price(marketEntry);

    setText("#market-title", `${state.pair} MARKET`);
    setText("#price", formatMoney(price));
    setText("#current-price", formatMoney(price));
    setText("#edge-yes", formatPct(adapt.edgeYes(conf)));
    setText("#edge-no", formatPct(adapt.edgeNo(conf)));
    setText("#confidence-score", formatPct(adapt.confidenceScore(conf)));

    const oi = adapt.openInterest(conf) ?? adapt.openInterest(marketEntry);
    setText("#volume", oi == null ? "—" : String(oi));

    const imbalance = adapt.orderBookImbalance(conf) ?? adapt.orderBookImbalance(marketEntry);
    setText("#sentiment", imbalance == null ? "—" : formatPct(imbalance));

    const edgeYes = adapt.edgeYes(conf);
    const edgeNo = adapt.edgeNo(conf);
    let signal = "HOLD";
    if (edgeYes != null && edgeYes > 0 && edgeYes >= (edgeNo ?? -Infinity)) signal = "BUY";
    else if (edgeNo != null && edgeNo > 0 && edgeNo > (edgeYes ?? -Infinity)) signal = "SELL";

    setText("#signal", signal);
    $$("#signal").forEach((el) => {
      el.style.color = signal === "BUY" ? "var(--green)" : signal === "SELL" ? "var(--red)" : "var(--yellow)";
    });
  }

  function renderPosition() {
    const positions = adapt.positions(state.risk);
    const pos = Array.isArray(positions)
      ? positions.find((p) => (p.pair ?? p.symbol ?? p.ticker) === state.pair)
      : null;

    if (!pos) {
      setText("#position", "FLAT");
      setText("#current-position", "NO POSITION");
      setText("#entry", "—");
      setText("#unrealized", "$0.00");
      return;
    }

    const side = pos.side ?? pos.direction ?? "OPEN";
    const entry = pos.entry ?? pos.entry_price ?? null;
    const unrealized = pos.unrealized_pnl ?? pos.unrealizedPnl ?? null;

    setText("#position", side);
    setText("#current-position", side);
    setText("#entry", formatMoney(entry));
    setText("#unrealized", formatMoney(unrealized));
  }

  function renderAgents() {
    const signals = computeAgentSignals();

    $$(".agent-card").forEach((card) => {
      const name = card.dataset.agent;
      const sig = signals[name];
      if (!sig) return;

      const statusEl = card.querySelector("[data-status]");
      const detailEl = card.querySelector("[data-detail]");
      if (statusEl) statusEl.textContent = sig.signal;
      if (detailEl) detailEl.textContent = sig.detail;

      card.classList.remove("state-buy", "state-sell", "state-hold", "state-blocked", "state-na");

      if (sig.signal === "BUY" || sig.signal === "ARMED") card.classList.add("state-buy");
      else if (sig.signal === "SELL") card.classList.add("state-sell");
      else if (sig.signal === "BLOCK" || sig.signal === "OFFLINE") card.classList.add("state-blocked");
      else if (sig.signal === "N/A") card.classList.add("state-na");
      else card.classList.add("state-hold");
    });
  }

  function renderPairTabs() {
    const wrap = $("#pair-tabs");
    if (!wrap || wrap.childElementCount === BRIDGE.pairs.length) return;

    wrap.innerHTML = BRIDGE.pairs
      .map((p) => `<button type="button" class="pair-tab" data-pair="${p}">${p}</button>`)
      .join("");

    wrap.querySelectorAll(".pair-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.pair = btn.dataset.pair;
        pollOnce();
      });
    });
  }

  function updatePairTabActive() {
    $$(".pair-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pair === state.pair);
    });
  }

  function render() {
    renderPairTabs();
    updatePairTabActive();
    renderHeader();
    renderStats();
    renderMarket();
    renderPosition();
    renderAgents();
    renderLedger();

    const pause = $("#pause");
    if (pause) pause.textContent = state.polling ? "PAUSE POLLING" : "RESUME POLLING";
  }

  /* ======================================================
     MANUAL OVERRIDE — real orders, real money.
     ⚠️ ADAPT the request body below to match /orders' actual
     schema once you've confirmed it (see kalshi-bridge.js or
     curl -X POST it with a tiny test order first).
  ====================================================== */

  async function manualOrder(side) {
    const confirmed = window.confirm(
      `Send a REAL ${side} order for ${state.pair} to the bridge?\nThis calls a live endpoint with real funds.`
    );
    if (!confirmed) return;

    try {
      const res = await fetch(BRIDGE.baseUrl + BRIDGE.endpoints.orders(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pair: state.pair,
          side,
          // ADAPT: confirm whether the bridge expects amount_cents,
          // size, or stake — this guesses amount_cents at the $0.10 cap.
          amount_cents: 10
        })
      });

      const json = await res.json().catch(() => ({}));
      const accepted = adapt.orderAccepted(json);

      addLedger(
        "VESKA",
        accepted ? `MANUAL ${side} ACCEPTED` : `MANUAL ${side} REJECTED`,
        adapt.orderReason(json) || `HTTP ${res.status}`
      );
    } catch (err) {
      addLedger("VESKA", `MANUAL ${side} FAILED`, err.message);
    }

    render();
  }

  function bindControls() {
    $("#buy")?.addEventListener("click", () => manualOrder("BUY"));
    $("#sell")?.addEventListener("click", () => manualOrder("SELL"));

    $("#close")?.addEventListener("click", () => {
      // ADAPT: no documented "close position" endpoint yet — this
      // sends the opposite-side order as a naive close. Confirm the
      // bridge actually supports this before relying on it.
      const positions = adapt.positions(state.risk);
      const pos = Array.isArray(positions)
        ? positions.find((p) => (p.pair ?? p.symbol ?? p.ticker) === state.pair)
        : null;
      if (!pos) {
        addLedger("VESKA", "CLOSE SKIPPED", "No open position for this pair");
        render();
        return;
      }
      const side = (pos.side ?? "").toUpperCase() === "LONG" ? "SELL" : "BUY";
      manualOrder(side);
    });

    $("#pause")?.addEventListener("click", () => {
      state.polling = !state.polling;
      addLedger("NEXUS", state.polling ? "POLLING RESUMED" : "POLLING PAUSED", "Display only — bridge keeps trading regardless");
      render();
    });
  }

  /* ======================================================
     STARTUP
  ====================================================== */

  function boot() {
    addLedger("NEXUS", "SYSTEM ONLINE", "NEXUS display initialized — connecting to bridge");
    render();
    pollOnce();
    setInterval(() => {
      if (state.polling) pollOnce();
    }, BRIDGE.pollInterval);
  }

  bindControls();
  boot();
})();
