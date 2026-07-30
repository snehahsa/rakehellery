(() => {
  // Robinhood Chain (chainId 4663). Preferred: Alchemy Robinhood RPC.
  // Optional overrides: ?alchemy=https://robinhood-mainnet.g.alchemy.com/v2/KEY
  //                   or localStorage rakehellery-alchemy
  const ALCHEMY_RPC_DEFAULT =
    "https://robinhood-mainnet.g.alchemy.com/v2/9poJOAJQy5Got7Wpv8cO7";
  // Fallback: public Robinhood RPC (rate-limited)
  const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
  const CHAIN_ID = 4663;
  const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
  const Q96 = 2n ** 96n;
  const PLAYERS = 6;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const STORAGE_KEY = "rakehellery-ca";
  const ALCHEMY_KEY = "rakehellery-alchemy";
  // Change this when the real CA is live. Optional override: ?ca=0x...
  const CONTRACT_ADDRESS = "0xC5C2B9366Fa689D31d9093BA16E1D158cA9Ba6d4";
  // Constructor mint; net burn = INITIAL − totalSupply when costs work on-chain.
  const INITIAL_SUPPLY = 10_000_000_000n * 10n ** 18n;
  // After settlement: 60% 1st + 20% 2nd reminted; 20% stays burned.
  const BURN_RETAIN_PCT = 20n;
  const REFRESH_MS = 45000;

  const S = {
    currentGame: "0x60b663bb",
    gameEnabled: "0xe1565ca9",
    gameCostUSDX96: "0xe68e917e",
    getGameCostTokens: "0x5f01b1d1",
    safeTokenPriceUSDX96: "0xd145c895",
    totalSupply: "0x18160ddd",
    decimals: "0x313ce567",
    symbol: "0x95d89b41",
    balanceOf: "0x70a08231",
    gameResults: "0xfdba1b7c",
    gameRunnerUps: "0x245d19cd",
    gamePlayers: "0x62e2961b",
    gameCostTokens: "0x30a542a5",
  };
  const DEFAULT_ENTRY_USD = 30n;

  function resolveAlchemyRpc() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("alchemy");
    if (fromQuery && /^https:\/\//i.test(fromQuery)) {
      localStorage.setItem(ALCHEMY_KEY, fromQuery);
      return fromQuery;
    }
    const saved = localStorage.getItem(ALCHEMY_KEY);
    // Drop stale Ethereum-mainnet RPCs saved from the old site config.
    if (
      saved &&
      /^https:\/\//i.test(saved) &&
      !/eth-mainnet|mainnet\.infura|ethereum/i.test(saved)
    ) {
      return saved;
    }
    if (saved) localStorage.removeItem(ALCHEMY_KEY);
    if (ALCHEMY_RPC_DEFAULT && !ALCHEMY_RPC_DEFAULT.includes("YOUR_KEY")) {
      return ALCHEMY_RPC_DEFAULT;
    }
    return "";
  }

  const ALCHEMY_RPC = resolveAlchemyRpc();
  const USE_ALCHEMY = Boolean(ALCHEMY_RPC);
  const RPC_URL = ALCHEMY_RPC || PUBLIC_RPC;

  function pad32(value) {
    const hex =
      typeof value === "bigint" || typeof value === "number"
        ? BigInt(value).toString(16)
        : String(value).replace(/^0x/i, "");
    return hex.padStart(64, "0");
  }

  function encodeAddress(addr) {
    return pad32(addr.toLowerCase().replace(/^0x/, ""));
  }

  function callData(sel, ...words) {
    return sel + words.join("");
  }

  function decodeUint(hex) {
    const h = (hex || "0x").replace(/^0x/, "");
    if (!h) return 0n;
    return BigInt("0x" + h.slice(-64));
  }

  function decodeAddress(hex) {
    const h = (hex || "0x").replace(/^0x/, "").slice(-64);
    return ("0x" + h.slice(24)).toLowerCase();
  }

  function decodeBool(hex) {
    return decodeUint(hex) !== 0n;
  }

  function decodeString(hex) {
    const raw = (hex || "0x").replace(/^0x/, "");
    if (raw.length < 128) return "";
    const offset = Number(BigInt("0x" + raw.slice(0, 64)));
    const len = Number(BigInt("0x" + raw.slice(offset * 2, offset * 2 + 64)));
    const data = raw.slice(offset * 2 + 64, offset * 2 + 64 + len * 2);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  }

  function isAddress(value) {
    return /^0x[a-fA-F0-9]{40}$/.test(value);
  }

  function shortAddr(addr) {
    if (!addr || addr === ZERO) return "—";
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  function explorerUrl(addr) {
    return `${EXPLORER_URL}/address/${addr}`;
  }

  function setAddrLink(id, addr) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!addr || addr === ZERO || addr === "—") {
      el.textContent = "—";
      el.removeAttribute("href");
      el.removeAttribute("title");
      el.removeAttribute("target");
      el.removeAttribute("rel");
      el.classList.remove("addr-copyable");
      delete el.dataset.addr;
      return;
    }
    el.textContent = shortAddr(addr);
    el.href = explorerUrl(addr);
    el.target = "_blank";
    el.rel = "noreferrer";
    el.dataset.addr = addr;
    el.classList.remove("addr-copyable");
    el.title = `Open on explorer`;
  }

  function slotAddress(n) {
    return "0x" + n.toString(16).padStart(40, "0");
  }

  function formatTokens(amount, decimals = 18n) {
    let dec = BigInt(decimals);
    if (dec <= 0n || dec > 36n) dec = 18n;
    const base = 10n ** dec;
    const whole = amount / base;
    if (whole >= 1_000_000_000n) return `${(Number(whole) / 1e9).toFixed(2)}B`;
    if (whole >= 1_000_000n) return `${(Number(whole) / 1e6).toFixed(2)}M`;
    if (whole >= 10_000n) return `${(Number(whole) / 1e3).toFixed(1)}K`;
    const frac = (amount % base)
      .toString()
      .padStart(Number(dec), "0")
      .slice(0, 2);
    return `${whole}.${frac}`;
  }

  function formatUsdFromX96(x96) {
    const usd = Number(x96) / Number(Q96);
    if (!Number.isFinite(usd)) return "—";
    return `$${usd >= 10 ? usd.toFixed(0) : usd.toFixed(2)}`;
  }

  // Owner sometimes passes plain dollars (e.g. 5) instead of dollars * Q96.
  function normalizeCostUsdX96(raw) {
    if (raw == null || raw <= 0n) return DEFAULT_ENTRY_USD * Q96;
    if (raw < Q96) return raw * Q96;
    return raw;
  }

  function tokensForUsdX96(costUsdX96, priceX96, decimals) {
    if (!costUsdX96 || !priceX96 || priceX96 <= 0n) return null;
    const dec = BigInt(decimals);
    return (costUsdX96 * 10n ** dec) / priceX96;
  }

  function formatCommaInt(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Full token count with commas (no K/M/B abbreviation).
  function formatTokenCount(amount, decimals = 18n) {
    let dec = BigInt(decimals);
    if (dec <= 0n || dec > 36n) dec = 18n;
    return formatCommaInt(amount / 10n ** dec);
  }

  // Round UP to at most 2 significant digits.
  // e.g. 23,900,000 → 24,000,000 ; 890,001 → 900,000 ; 5,930,039 → 6,000,000
  function roundUpCleanTokens(whole) {
    if (whole <= 0n) return 0n;
    const s = whole.toString();
    if (s.length <= 2) return whole;
    const mag = 10n ** BigInt(s.length - 2);
    return ((whole + mag - 1n) / mag) * mag;
  }

  function setEntryDisplay(entryTokens, decimals, symbol, costUsdX96) {
    const box = document.getElementById("stat-entry");
    const main = document.getElementById("stat-entry-main");
    const usdEl = document.getElementById("stat-entry-usd");
    const noteEl = document.getElementById("stat-entry-note");
    if (!box || !main || !usdEl) return;

    const usd =
      costUsdX96 != null && costUsdX96 > 0n
        ? Number(costUsdX96 / (1n << 96n))
        : 0;
    usdEl.textContent = usd > 0 ? `(worth $${usd})` : "";

    if (entryTokens != null && entryTokens > 0n) {
      let dec = BigInt(decimals);
      if (dec <= 0n || dec > 36n) dec = 18n;
      const whole = entryTokens / 10n ** dec;
      const clean = roundUpCleanTokens(whole);
      main.textContent = `${formatCommaInt(clean)} ${symbol}`;
      if (noteEl) {
        noteEl.textContent =
          "Rounded up for display. Send at least the exact lower fee — mid-game this is the locked fee for this table.";
      }
    } else {
      main.textContent = "—";
      if (noteEl) {
        noteEl.textContent = "Waiting for contract entry fee…";
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ethCallRpc(rpcUrl, to, data) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    if (typeof json.result === "string" && json.result.startsWith("0x")) {
      return json.result;
    }
    throw new Error("Unexpected RPC response");
  }

  async function ethCall(to, data) {
    try {
      return await ethCallRpc(RPC_URL, to, data);
    } catch (err) {
      if (RPC_URL !== PUBLIC_RPC) {
        return ethCallRpc(PUBLIC_RPC, to, data);
      }
      throw err;
    }
  }

  async function softCall(to, data, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) await sleep(300 * attempt);
        return { success: true, returnData: await ethCall(to, data) };
      } catch (err) {
        lastErr = err;
      }
    }
    console.warn("eth_call failed", data.slice(0, 10), lastErr);
    return { success: false, returnData: "0x" };
  }

  async function rpcBatch(rpcUrl, calls) {
    const chunkSize = 50;
    const results = [];
    for (let i = 0; i < calls.length; i += chunkSize) {
      const chunk = calls.slice(i, i + chunkSize);
      const body = chunk.map((c, idx) => ({
        jsonrpc: "2.0",
        id: i + idx + 1,
        method: "eth_call",
        params: [{ to: c.target, data: c.data }, "latest"],
      }));
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`RPC batch HTTP ${res.status}`);
      const json = await res.json();
      const arr = Array.isArray(json) ? json : [json];
      const byId = Object.fromEntries(arr.map((row) => [row.id, row]));
      for (let j = 0; j < chunk.length; j++) {
        const row = byId[i + j + 1];
        if (row?.result && typeof row.result === "string" && !row.error) {
          results.push({ success: true, returnData: row.result });
        } else {
          results.push({ success: false, returnData: "0x" });
        }
      }
    }
    return results;
  }

  async function parallelCalls(calls) {
    if (!calls.length) return [];
    try {
      return await rpcBatch(RPC_URL, calls);
    } catch (err) {
      console.warn("RPC batch failed, trying fallback", err);
    }
    if (RPC_URL !== PUBLIC_RPC) {
      try {
        return await rpcBatch(PUBLIC_RPC, calls);
      } catch (err) {
        console.warn("Public RPC batch failed, falling back", err);
      }
    }
    const chunkSize = 4;
    const results = [];
    for (let i = 0; i < calls.length; i += chunkSize) {
      if (i > 0) await sleep(200);
      const chunk = calls.slice(i, i + chunkSize);
      const part = await Promise.all(
        chunk.map((c) => softCall(c.target, c.data)),
      );
      results.push(...part);
    }
    return results;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function shortSlotLabel(n) {
    return `0x000…000${n.toString(16)}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  function initSeatBoard() {
    const board = document.getElementById("seat-board");
    if (!board || board.dataset.bound) return;
    board.dataset.bound = "1";

    const onActivate = async (row) => {
      const addr = row.dataset.addr;
      if (!addr) return;
      const ok = await copyText(addr);
      if (!ok) return;
      row.classList.add("copied");
      const state = row.querySelector(".seat-state");
      if (state) state.textContent = "Copied";
      clearTimeout(row._copyTimer);
      row._copyTimer = setTimeout(() => {
        row.classList.remove("copied");
        if (state) {
          state.textContent =
            row.dataset.filled === "1" ? "Filled" : "Open";
        }
      }, 1200);
    };

    board.addEventListener("click", async (e) => {
      const player = e.target.closest("a.seat-player[href^='http']");
      if (player) {
        e.stopPropagation();
        return;
      }
      const row = e.target.closest(".seat-row");
      if (row) onActivate(row);
    });
    board.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest(".seat-row");
      if (!row) return;
      e.preventDefault();
      onActivate(row);
    });
  }

  function initSeatMapCopy() {
    document.querySelectorAll(".seat-map code, .game-grid code").forEach((code) => {
      const text = code.textContent.trim();
      const slotMatch = text.match(/0x0+…0*([1-6])$/i) || text.match(/#([1-6])/);
      let addr = code.dataset.addr;
      if (!addr) {
        const n = slotMatch ? Number(slotMatch[1]) : 0;
        if (n >= 1 && n <= 6) addr = slotAddress(n);
      }
      if (!addr) return;
      code.dataset.addr = addr;
      code.classList.add("addr-copyable");
      code.title = `Click to copy ${addr}`;
      code.setAttribute("role", "button");
      code.tabIndex = 0;
      const activate = async () => {
        const ok = await copyText(addr);
        if (!ok) return;
        const prev = code.textContent;
        code.classList.add("copied");
        code.textContent = "Copied";
        clearTimeout(code._copyTimer);
        code._copyTimer = setTimeout(() => {
          code.classList.remove("copied");
          code.textContent = prev;
        }, 1200);
      };
      code.addEventListener("click", activate);
      code.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    });
  }

  function setSeatBoard(seatOccupants) {
    const rows = document.querySelectorAll("#seat-board .seat-row");
    rows.forEach((row, i) => {
      const n = Number(row.dataset.slot) || i + 1;
      const occupant = seatOccupants?.[n - 1] || ZERO;
      const filled = Boolean(occupant && occupant !== ZERO);
      row.dataset.filled = filled ? "1" : "0";
      row.classList.toggle("filled", filled);
      const addr = row.querySelector(".seat-addr");
      const state = row.querySelector(".seat-state");
      const player = row.querySelector(".seat-player");
      if (addr) addr.textContent = shortSlotLabel(n);
      if (state && !row.classList.contains("copied")) {
        state.textContent = filled ? "Filled" : "Open";
      }
      if (player) {
        if (filled) {
          player.textContent = shortAddr(occupant);
          player.href = explorerUrl(occupant);
          player.target = "_blank";
          player.rel = "noreferrer";
          player.dataset.addr = occupant;
          player.classList.remove("addr-copyable");
          player.title = "Open on explorer";
        } else {
          player.textContent = "—";
          player.removeAttribute("href");
          player.removeAttribute("title");
          player.removeAttribute("target");
          player.removeAttribute("rel");
          player.classList.remove("addr-copyable");
          delete player.dataset.addr;
        }
      }
      row.title = `Copy seat ${row.dataset.addr}`;
    });
  }

  function setSeatDots(flagsOrCount) {
    const dots = document.querySelectorAll("#seat-dots i");
    dots.forEach((dot, i) => {
      const filled = Array.isArray(flagsOrCount)
        ? Boolean(flagsOrCount[i])
        : i < flagsOrCount;
      dot.classList.toggle("filled", filled);
    });
  }

  function resolveCa() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("ca");
    if (fromQuery && isAddress(fromQuery)) {
      localStorage.setItem(STORAGE_KEY, fromQuery);
      return fromQuery;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    // Drop stale cached CAs so site default updates apply.
    const stale = new Set([
      "0xdc06b8dd02a9e6a5ed17818c873743496c6f67c7",
      "0xa59565957a93882253647e150d2d8fa43f63033e",
    ]);
    if (saved && isAddress(saved) && !stale.has(saved.toLowerCase())) {
      return saved;
    }
    if (saved) localStorage.removeItem(STORAGE_KEY);
    return CONTRACT_ADDRESS;
  }

  async function loadStats(ca) {
    const statusEl = document.getElementById("live-status");
    const noteEl = document.getElementById("live-note");
    const ledger = document.getElementById("live-ledger");
    if (ledger) ledger.dataset.loading = "1";
    if (statusEl && statusEl.textContent.includes("…")) {
      // keep existing copy on refresh
    } else if (statusEl && !ledger?.dataset.ready) {
      statusEl.textContent = "Loading live stats…";
    }

    try {
      const base = await parallelCalls([
        { target: ca, data: S.currentGame },
        { target: ca, data: S.gameEnabled },
        { target: ca, data: S.totalSupply },
        { target: ca, data: S.decimals },
        { target: ca, data: S.symbol },
        { target: ca, data: S.gameCostUSDX96 },
        { target: ca, data: S.getGameCostTokens },
        { target: ca, data: S.safeTokenPriceUSDX96 },
      ]);

      if (!base[0].success) throw new Error("Not a readable game token");

      const currentGame = Number(decodeUint(base[0].returnData));
      const enabled = decodeBool(base[1].returnData);
      const supply = decodeUint(base[2].returnData);
      const decimals =
        base[3].success && decodeUint(base[3].returnData) > 0n
          ? decodeUint(base[3].returnData)
          : 18n;
      // On-chain ticker may still read EXCESS; always display VICE (CA unchanged).
      const symbol = "VICE";
      const rawCostUsdX96 = base[5].success
        ? decodeUint(base[5].returnData)
        : 0n;
      const costUsdX96 = normalizeCostUsdX96(rawCostUsdX96);
      const priceX96 =
        base[7].success &&
        base[7].returnData &&
        base[7].returnData.length >= 66
          ? decodeUint(base[7].returnData)
          : 0n;
      let entryTokens =
        base[6].success &&
        base[6].returnData &&
        base[6].returnData.length >= 66
          ? decodeUint(base[6].returnData)
          : null;
      // getGameCostTokens() is 0 when gameCostUSDX96 was set as plain dollars
      // (e.g. 5) instead of dollars * Q96 — recompute from price.
      if ((entryTokens == null || entryTokens === 0n) && priceX96 > 0n) {
        entryTokens = tokensForUsdX96(costUsdX96, priceX96, decimals);
      }

      // Priority batch: seats + recent settled games (Crown / Consolation).
      // Burn totals load after so rate-limits don't wipe winners.
      const priority = [];
      const pTags = [];

      for (let seat = 1; seat <= PLAYERS; seat++) {
        priority.push({
          target: ca,
          data: callData(
            S.gamePlayers,
            pad32(currentGame),
            encodeAddress(slotAddress(seat)),
          ),
        });
        pTags.push(`seat${seat}`);
      }

      const gamesToCheck = [];
      for (let back = 0; back < 5; back++) {
        const g = currentGame - back;
        if (g > 0) gamesToCheck.push(g);
      }

      for (const g of gamesToCheck) {
        priority.push({
          target: ca,
          data: callData(S.gameResults, pad32(g)),
        });
        pTags.push(`result${g}`);
        priority.push({
          target: ca,
          data: callData(S.gameRunnerUps, pad32(g)),
        });
        pTags.push(`runner${g}`);
      }

      const pOut = await parallelCalls(priority);
      const by = Object.fromEntries(pTags.map((t, i) => [t, pOut[i]]));

      let seatsFilled = 0;
      let seatReadsOk = true;
      const seatOccupants = [];
      for (let seat = 1; seat <= PLAYERS; seat++) {
        const r = by[`seat${seat}`];
        if (!r?.success) seatReadsOk = false;
        const player =
          currentGame > 0 && r?.success
            ? decodeAddress(r.returnData)
            : ZERO;
        const taken = player !== ZERO;
        seatOccupants.push(taken ? player : ZERO);
        if (taken) seatsFilled++;
      }

      const resultCur =
        currentGame > 0 && by[`result${currentGame}`]?.success
          ? decodeAddress(by[`result${currentGame}`].returnData)
          : ZERO;

      // If current table looks empty because reads failed, try previous game seats
      // only for status: a full unsettled previous game means "Awaiting".
      let prevFilled = 0;
      let prevResult = ZERO;
      if (currentGame > 1) {
        prevResult = by[`result${currentGame - 1}`]?.success
          ? decodeAddress(by[`result${currentGame - 1}`].returnData)
          : ZERO;
      }

      // Extra: if current seats read failed / empty, count prior game occupancy
      // when that game is still unsettled (helps when RPC returns sparse data).
      let prevOccupants = null;
      if (
        currentGame > 1 &&
        seatsFilled === 0 &&
        prevResult === ZERO
      ) {
        const prevSeatCalls = [];
        for (let seat = 1; seat <= PLAYERS; seat++) {
          prevSeatCalls.push({
            target: ca,
            data: callData(
              S.gamePlayers,
              pad32(currentGame - 1),
              encodeAddress(slotAddress(seat)),
            ),
          });
        }
        const prevOut = await parallelCalls(prevSeatCalls);
        prevOccupants = prevOut.map((r) =>
          r.success ? decodeAddress(r.returnData) : ZERO,
        );
        prevFilled = prevOccupants.filter((p) => p !== ZERO).length;
      }

      let settledGame = 0;
      let winSlot = ZERO;
      let runSlot = ZERO;

      for (const g of gamesToCheck) {
        const slot = by[`result${g}`]?.success
          ? decodeAddress(by[`result${g}`].returnData)
          : ZERO;
        if (slot !== ZERO) {
          settledGame = g;
          winSlot = slot;
          runSlot = by[`runner${g}`]?.success
            ? decodeAddress(by[`runner${g}`].returnData)
            : ZERO;
          break;
        }
      }

      let winnerWallet = ZERO;
      let runnerWallet = ZERO;
      if (settledGame > 0 && winSlot !== ZERO) {
        const resolve = [
          {
            target: ca,
            data: callData(
              S.gamePlayers,
              pad32(settledGame),
              encodeAddress(winSlot),
            ),
          },
        ];
        if (runSlot !== ZERO) {
          resolve.push({
            target: ca,
            data: callData(
              S.gamePlayers,
              pad32(settledGame),
              encodeAddress(runSlot),
            ),
          });
        }
        const resolved = await parallelCalls(resolve);
        if (resolved[0]?.success) {
          winnerWallet = decodeAddress(resolved[0].returnData);
        }
        if (resolved[1]?.success) {
          runnerWallet = decodeAddress(resolved[1].returnData);
        }
      }

      // Burnt: prefer true supply delta (ERC-20 _burn). Seat wallets are never
      // funded — entries burn, then 80% remints on settle, 20% stays gone.
      // If supply is unchanged (e.g. gameCostUSDX96 set as plain dollars → cost 0),
      // estimate from game seats × live entry and the 20% retain rule.
      let burned = supply < INITIAL_SUPPLY ? INITIAL_SUPPLY - supply : 0n;
      if (
        burned === 0n &&
        currentGame > 0 &&
        entryTokens != null &&
        entryTokens > 0n
      ) {
        const scan = [];
        for (let g = 1; g <= currentGame; g++) {
          scan.push({
            target: ca,
            data: callData(S.gameResults, pad32(g)),
          });
          scan.push({
            target: ca,
            data: callData(S.gameCostTokens, pad32(g)),
          });
        }
        const scanOut = await parallelCalls(scan);
        let est = 0n;
        for (let g = 1; g <= currentGame; g++) {
          const ri = (g - 1) * 2;
          const slot = scanOut[ri]?.success
            ? decodeAddress(scanOut[ri].returnData)
            : ZERO;
          let cost = scanOut[ri + 1]?.success
            ? decodeUint(scanOut[ri + 1].returnData)
            : 0n;
          if (cost === 0n) cost = entryTokens;
          if (slot !== ZERO) {
            est += (cost * BigInt(PLAYERS) * BURN_RETAIN_PCT) / 100n;
          } else if (g === currentGame && seatsFilled > 0) {
            est += cost * BigInt(seatsFilled);
          }
        }
        burned = est;
      }

      let statusLine;
      let statusShort;
      let displayGame = currentGame;
      let displaySeats = seatsFilled;
      const EMPTY_BOARD = [ZERO, ZERO, ZERO, ZERO, ZERO, ZERO];

      // Waiting = 6 seats taken and winners not paid yet.
      // (Also covers RPC gaps where current looks empty but prior game is full+unsettled.)
      const isWaiting =
        (seatsFilled >= PLAYERS && resultCur === ZERO) ||
        (prevFilled >= PLAYERS &&
          prevResult === ZERO &&
          seatsFilled === 0 &&
          resultCur === ZERO);

      // Settled current game: on-chain seats still list old players, but anyone
      // can open the next game — show an empty board ready to fill.
      const isSettledOpen = currentGame > 0 && resultCur !== ZERO;

      let boardOccupants = EMPTY_BOARD;

      if (!enabled) {
        statusLine = "Game paused by owner";
        statusShort = "Paused";
        boardOccupants =
          currentGame > 0 && !isSettledOpen ? seatOccupants : EMPTY_BOARD;
        displaySeats = boardOccupants.filter((p) => p !== ZERO).length;
      } else if (!seatReadsOk && seatsFilled === 0 && !isSettledOpen && !isWaiting) {
        statusLine = `Game #${currentGame || "—"} — seats still loading`;
        statusShort = "Loading";
        boardOccupants = EMPTY_BOARD;
        displaySeats = 0;
      } else if (isWaiting) {
        displayGame =
          seatsFilled >= PLAYERS ? currentGame : Math.max(1, currentGame - 1);
        displaySeats = seatsFilled >= PLAYERS ? seatsFilled : prevFilled;
        boardOccupants =
          seatsFilled >= PLAYERS
            ? seatOccupants
            : prevOccupants || seatOccupants;
        statusLine = `Game #${displayGame} full — Waiting for a Uniswap buy/sell ≥ 2× entry`;
        statusShort = "Waiting";
      } else if (isSettledOpen) {
        displayGame = currentGame + 1;
        displaySeats = 0;
        boardOccupants = EMPTY_BOARD;
        statusLine = `Game #${currentGame} settled — seats open for game #${displayGame}`;
        statusShort = "Filling";
      } else if (currentGame === 0) {
        displayGame = 1;
        displaySeats = 0;
        boardOccupants = EMPTY_BOARD;
        statusLine = "No games yet — first seat starts game #1";
        statusShort = "Filling";
      } else {
        displayGame = currentGame;
        displaySeats = seatsFilled;
        boardOccupants = seatOccupants;
        statusLine =
          seatsFilled === 0
            ? `Game #${currentGame} — seats open (0 of ${PLAYERS})`
            : `Game #${currentGame} Filling — ${seatsFilled} of ${PLAYERS} seats taken`;
        statusShort = "Filling";
      }

      setText("stat-game", displayGame === 0 ? "—" : `#${displayGame}`);
      setText(
        "stat-seats",
        `${displaySeats}/${PLAYERS}`,
      );

      setSeatDots(boardOccupants.map((p) => p !== ZERO));
      setSeatBoard(boardOccupants);
      setText("stat-status", statusShort);

      // Join fee: once a game has started, seats must pay gameCostTokens[game]
      // (locked at seat 1). Live getGameCostTokens() only applies to a new table.
      let joinTokens = entryTokens;
      if (
        currentGame > 0 &&
        !isSettledOpen &&
        seatsFilled > 0 &&
        seatsFilled < PLAYERS
      ) {
        const lockedOut = await parallelCalls([
          {
            target: ca,
            data: callData(S.gameCostTokens, pad32(currentGame)),
          },
        ]);
        if (lockedOut[0]?.success) {
          const locked = decodeUint(lockedOut[0].returnData);
          if (locked > 0n) joinTokens = locked;
        }
      }
      setEntryDisplay(joinTokens, decimals, symbol, costUsdX96);
      setAddrLink("stat-winner", winnerWallet);
      setAddrLink("stat-runner", runnerWallet);
      setText(
        "stat-burnt",
        `~${formatTokenCount(burned, decimals)} ${symbol}`,
      );

      if (statusEl) statusEl.textContent = statusLine;
      if (noteEl) {
        const time = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const source = USE_ALCHEMY ? "Robinhood · Alchemy" : "Robinhood RPC";
        noteEl.textContent = `${source} · ${time}`;
      }
      if (ledger) ledger.dataset.ready = "1";
    } catch (err) {
      console.error(err);
      if (statusEl) {
        statusEl.textContent = "Could not read the contract right now. Try Refresh.";
      }
    } finally {
      if (ledger) delete ledger.dataset.loading;
    }
  }

  function init() {
    const ledger = document.getElementById("live-ledger");
    if (!ledger) return;
    initSeatBoard();
    initSeatMapCopy();

    const ca = resolveCa();
    const refreshBtn = document.getElementById("live-refresh");
    let timer = null;
    let started = false;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      if (refreshBtn) {
        refreshBtn.disabled = true;
        const label = refreshBtn.querySelector(".seat-refresh-text");
          if (label) label.textContent = "Refreshing";
        }
        try {
          await loadStats(ca);
        } finally {
          refreshing = false;
          if (refreshBtn) {
            refreshBtn.disabled = false;
            const label = refreshBtn.querySelector(".seat-refresh-text");
            if (label) label.textContent = "Refresh";
          }
        }
    };

    const boot = () => {
      if (started) {
        refresh();
        return;
      }
      started = true;
      refresh();
      timer = window.setInterval(() => refresh(), REFRESH_MS);
    };

    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        started = true;
        if (!timer) {
          timer = window.setInterval(() => refresh(), REFRESH_MS);
        }
        refresh();
      });
    }

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            boot();
          }
        },
        { rootMargin: "160px" },
      );
      io.observe(ledger);
    } else {
      boot();
    }

    // Deep-link / already in view
    if (location.hash === "#game") boot();
    window.setTimeout(() => {
      const rect = ledger.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) boot();
    }, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
