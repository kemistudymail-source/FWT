const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = "1e2fac91-7f63-4c46-b3d5-aabc39a1f7e5";
const CHAT_ID = "5092755750";
const PORT = process.env.PORT || 3000;

const MIN_TOKEN_AGE_DAYS = 29;
const MIN_GAP_HOURS = 36;
const MIN_MC = 1000;
const MAX_MC = 10000;
const SCAN_INTERVAL_MS = 60 * 1000;
const CREDIT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // check credits every hour

const RAYDIUM_PROGRAMS = [
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ35MKDzgCcn7",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAo",
];

// ── HTTP server ───────────────────────────────────────────────────────────────
http.createServer((req, res) => res.end("OK")).listen(PORT, () => {
  log("BOOT", `Health check server on port ${PORT}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}
function logError(tag, msg, err) {
  console.error(`[${new Date().toISOString()}] [${tag}] ${msg}`, err?.message || err || "");
}

// ── API Key — stored in key.json, swappable via Telegram command ──────────────
const KEY_FILE = path.join(__dirname, "key.json");

function loadApiKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const data = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
      if (data.key) {
        log("BOOT", `Loaded API key from key.json: ${data.key.slice(0, 8)}...`);
        return data.key;
      }
    }
  } catch (e) {
    logError("BOOT", "Failed to load key.json:", e);
  }
  // Fallback to hardcoded key
  return "05ac53c1-3ee2-4da3-a4ae-097d549f874e";
}

function saveApiKey(key) {
  try {
    fs.writeFileSync(KEY_FILE, JSON.stringify({ key }), "utf8");
    log("KEY", `Saved new API key: ${key.slice(0, 8)}...`);
  } catch (e) {
    logError("KEY", "Failed to save key.json:", e);
  }
}

let HELIUS_API_KEY = loadApiKey();

function getHelixRpc() {
  return `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
}
function getHeliusTx() {
  return `https://api-mainnet.helius-rpc.com/v0`;
}

// ── Persistent state ──────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      log("BOOT", `Loaded state: ${Object.keys(data.lastSeen || {}).length} tokens tracked, ${(data.alerted || []).length} alerted`);
      return { lastSeen: data.lastSeen || {}, alerted: new Set(data.alerted || []) };
    }
  } catch (e) {
    logError("BOOT", "Failed to load state:", e);
  }
  log("BOOT", "No state file — starting fresh");
  return { lastSeen: {}, alerted: new Set() };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastSeen: state.lastSeen,
      alerted: [...state.alerted],
    }), "utf8");
  } catch (e) {
    logError("SAVE", "Failed to save state:", e);
  }
}

const state = loadState();

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new Telegraf(TELEGRAM_TOKEN);

async function sendTelegram(msg) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    logError("TELEGRAM", "Failed to send:", e);
  }
}

function sendAlert(token) {
  const dexUrl = `https://dexscreener.com/solana/${token.address}`;
  const msg =
    `🚨 *DORMANT TOKEN WOKE UP*\n\n` +
    `*${token.symbol || "UNKNOWN"}*\n` +
    `📅 Age: ${token.ageDays} days old\n` +
    `💤 Was dormant: ${token.gapHours}h\n` +
    `💰 MC: $${Math.round(token.mc).toLocaleString()}\n` +
    `🔗 [View on DexScreener](${dexUrl})`;
  sendTelegram(msg);
  log("ALERT", `${token.symbol} | MC $${Math.round(token.mc)} | Gap ${token.gapHours}h | Age ${token.ageDays}d`);
}

// ── Credit exhaustion tracker ─────────────────────────────────────────────────
let creditAlertSent = false;
let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_ALERT = 3; // must fail 3 times in a row before alerting

async function handleHeliusError(status, body) {
  const isCredit = status === 402 || (body && body.toLowerCase().includes("credit"));
  const isRateLimit = status === 429;

  if (isCredit || isRateLimit) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_FAILURES_BEFORE_ALERT && !creditAlertSent) {
      creditAlertSent = true;
      logError("HELIUS", `Credits exhausted after ${consecutiveFailures} failures (${status})`);
      await sendTelegram(
        `🪫 *Helius credits exhausted*\n\n` +
        `The scanner has run out of API credits.\n\n` +
        `To swap your key, send:\n` +
        `\`/setkey YOUR_NEW_API_KEY\`\n\n` +
        `Top up at helius.dev`
      );
    }
  }
}

function resetCreditAlert() {
  if (consecutiveFailures > 0) {
    log("HELIUS", "Successful call — resetting failure counter");
  }
  consecutiveFailures = 0;
  creditAlertSent = false;
}

// ── Helius: check remaining credits ──────────────────────────────────────────
async function checkAndReportCredits() {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/api-usage?api-key=${HELIUS_API_KEY}`
    );
    if (!res.ok) return;
    const json = await res.json();

    // Helius returns dailyRequestCount and dailyRequestLimit
    const used = json?.dailyRequestCount ?? null;
    const limit = json?.dailyRequestLimit ?? null;

    if (used === null || limit === null) return;

    const remaining = limit - used;
    const pct = Math.round((remaining / limit) * 100);

    log("CREDITS", `Used: ${used.toLocaleString()} / ${limit.toLocaleString()} | Remaining: ${remaining.toLocaleString()} (${pct}%)`);

    // Alert if below 20%
    if (pct <= 20) {
      await sendTelegram(
        `⚠️ *Helius credits low*\n\n` +
        `Used: ${used.toLocaleString()} / ${limit.toLocaleString()}\n` +
        `Remaining: ${remaining.toLocaleString()} (${pct}%)\n\n` +
        `Swap key with: \`/setkey YOUR_NEW_API_KEY\``
      );
    } else {
      await sendTelegram(
        `📊 *Helius Credit Report*\n\n` +
        `Used: ${used.toLocaleString()} / ${limit.toLocaleString()}\n` +
        `Remaining: ${remaining.toLocaleString()} (${pct}%)`
      );
    }
  } catch (e) {
    logError("CREDITS", "Failed to check credits:", e);
  }
}

// ── Telegram commands ─────────────────────────────────────────────────────────
bot.command("setkey", async (ctx) => {
  // Only allow from your chat
  if (String(ctx.chat.id) !== String(CHAT_ID)) return;

  const parts = ctx.message.text.trim().split(/\s+/);
  const newKey = parts[1];

  if (!newKey) {
    return ctx.reply("Usage: /setkey YOUR_NEW_HELIUS_API_KEY");
  }

  HELIUS_API_KEY = newKey;
  saveApiKey(newKey);
  consecutiveFailures = 0;
  creditAlertSent = false;

  log("KEY", `API key swapped to ${newKey.slice(0, 8)}... via Telegram`);
  await ctx.reply(`✅ API key updated to ${newKey.slice(0, 8)}...\n\nScanner will resume on next scan.`);
});

bot.command("getkey", async (ctx) => {
  if (String(ctx.chat.id) !== String(CHAT_ID)) return;
  await ctx.reply(`🔑 Current Helius API key:
\`${HELIUS_API_KEY}\``, { parse_mode: "Markdown" });
});

bot.command("credits", async (ctx) => {
  if (String(ctx.chat.id) !== String(CHAT_ID)) return;
  await ctx.reply("Checking credits...");
  await checkAndReportCredits();
});

bot.command("status", async (ctx) => {
  if (String(ctx.chat.id) !== String(CHAT_ID)) return;
  await ctx.reply(
    `📡 *Scanner Status*\n\n` +
    `API key: \`${HELIUS_API_KEY.slice(0, 8)}...\`\n` +
    `Tracking: ${Object.keys(state.lastSeen).length} tokens\n` +
    `Alerted: ${state.alerted.size} tokens\n` +
    `MC range: $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}\n` +
    `Min age: ${MIN_TOKEN_AGE_DAYS} days\n` +
    `Min gap: ${MIN_GAP_HOURS}h\n` +
    `Scan every: ${SCAN_INTERVAL_MS / 1000}s`,
    { parse_mode: "Markdown" }
  );
});

// Start bot polling for commands
bot.launch().catch((e) => logError("BOT", "Failed to launch bot:", e));

// ── Helius: get recent txs for a program ──────────────────────────────────────
async function getRecentMintsFromProgram(programId) {
  const mints = new Map();
  try {
    const sigRes = await fetch(getHelixRpc(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [programId, { limit: 100, commitment: "confirmed" }],
      }),
    });
    if (!sigRes.ok) {
      const text = await sigRes.text().catch(() => "");
      await handleHeliusError(sigRes.status, text);
      return mints;
    }
    const sigJson = await sigRes.json();
    const sigs = sigJson?.result || [];
    if (!sigs.length) return mints;

    log("FETCH", `${programId.slice(0, 8)}... → ${sigs.length} recent txs`);

    const signatures = sigs.map((s) => s.signature);
    const txRes = await fetch(
      `${getHeliusTx()}/transactions?api-key=${HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: signatures }),
      }
    );
    if (!txRes.ok) {
      logError("FETCH", `Enhanced tx parse failed: ${txRes.status}`);
      return mints;
    }
    const txs = await txRes.json();
    if (!Array.isArray(txs)) return mints;

    for (const tx of txs) {
      if (tx.type !== "SWAP") continue;
      const blockTime = tx.timestamp;
      for (const transfer of tx.tokenTransfers || []) {
        const mint = transfer.mint;
        if (!mint) continue;
        if (!mints.has(mint) || blockTime < mints.get(mint)) {
          mints.set(mint, blockTime);
        }
      }
    }

    resetCreditAlert();
    log("FETCH", `${programId.slice(0, 8)}... → ${mints.size} unique swap mints`);
  } catch (e) {
    logError("FETCH", `Exception for ${programId.slice(0, 8)}:`, e);
  }
  return mints;
}

// ── Helius: get last trade timestamp for a token ──────────────────────────────
async function getLastTradeSec(mintAddress) {
  try {
    const res = await fetch(getHelixRpc(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [mintAddress, { limit: 5, commitment: "confirmed" }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await handleHeliusError(res.status, text);
      return null;
    }
    const json = await res.json();
    if (json?.error) {
      await handleHeliusError(200, json.error.message || "");
      return null;
    }
    resetCreditAlert();
    const sigs = json?.result;
    if (!sigs?.length) return null;
    return sigs[0]?.blockTime || null;
  } catch (e) {
    return null;
  }
}

// ── DexScreener: get MC + age + symbol for a token ───────────────────────────
async function getDexData(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${address}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = Array.isArray(json) ? json : (json?.pairs || []);
    if (!pairs.length) return null;

    const hasGraduated = pairs.some((p) => {
      const dexId = (p.dexId || "").toLowerCase();
      return !dexId.includes("pump");
    });

    if (!hasGraduated) {
      log("SCAN", `Skipping pre-bond ${address.slice(0, 8)}... — PumpFun only`);
      return null;
    }

    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = pairs[0];
    return {
      mc: best.marketCap || best.fdv || 0,
      pairCreatedAt: best.pairCreatedAt || null,
      symbol: best.baseToken?.symbol || null,
    };
  } catch (e) {
    return null;
  }
}

// ── Helius: token age fallback ────────────────────────────────────────────────
async function getTokenAgeDays(mintAddress) {
  try {
    const res = await fetch(getHelixRpc(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [mintAddress, { limit: 1000, commitment: "confirmed" }],
      }),
    });
    const json = await res.json();
    const sigs = json?.result;
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1];
    if (!oldest?.blockTime) return null;
    return Math.floor((Date.now() / 1000 - oldest.blockTime) / 86400);
  } catch (e) {
    return null;
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  log("SCAN", "Starting scan...");

  const allMints = new Map();
  for (const program of RAYDIUM_PROGRAMS) {
    const mints = await getRecentMintsFromProgram(program);
    for (const [mint, blockTime] of mints) {
      if (!allMints.has(mint)) allMints.set(mint, blockTime);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  log("SCAN", `Total unique mints from recent swaps: ${allMints.size}`);

  const nowSec = Math.floor(Date.now() / 1000);
  let skippedAlerted = 0, skippedGap = 0, skippedMC = 0, skippedAge = 0, passed = 0;

  for (const [mint, currentTxTime] of allMints) {
    if (state.alerted.has(mint)) { skippedAlerted++; continue; }

    const prevLastSeen = state.lastSeen[mint];
    state.lastSeen[mint] = currentTxTime;

    let effectivePrev = prevLastSeen;
    if (!effectivePrev) {
      const actualLast = await getLastTradeSec(mint);
      if (actualLast && actualLast < currentTxTime) {
        effectivePrev = actualLast;
        log("SCAN", `New token ${mint.slice(0, 8)}... — fetched actual last trade`);
      } else {
        continue;
      }
    }

    const gapHours = Math.floor((currentTxTime - effectivePrev) / 3600);
    if (gapHours < MIN_GAP_HOURS) { skippedGap++; continue; }

    log("SCAN", `Gap hit: ${mint.slice(0, 8)}... | ${gapHours}h gap — checking MC + age`);

    const dex = await getDexData(mint);
    if (!dex) { log("SCAN", `No DexScreener data for ${mint.slice(0, 8)}...`); skippedMC++; continue; }
    if (dex.mc < MIN_MC || dex.mc > MAX_MC) {
      log("SCAN", `MC rejected: ${dex.symbol || mint.slice(0, 8)} $${Math.round(dex.mc).toLocaleString()} (range $${MIN_MC}-$${MAX_MC})`);
      skippedMC++; continue;
    }

    let ageDays = dex.pairCreatedAt
      ? Math.floor((Date.now() - dex.pairCreatedAt) / 86_400_000)
      : await getTokenAgeDays(mint);

    if (!ageDays || ageDays < MIN_TOKEN_AGE_DAYS) { skippedAge++; continue; }

    passed++;
    state.alerted.add(mint);
    saveState(state);
    sendAlert({ address: mint, symbol: dex.symbol, ageDays, gapHours, mc: dex.mc });
    await new Promise((r) => setTimeout(r, 500));
  }

  saveState(state);
  log("SCAN", `Done — passed: ${passed} | skipped: alerted=${skippedAlerted} gap=${skippedGap} mc=${skippedMC} age=${skippedAge}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
log("BOOT", "SOL Dormant Token Scanner starting");
log("BOOT", `MC: $${MIN_MC}–$${MAX_MC} | Age: ${MIN_TOKEN_AGE_DAYS}d | Gap: ${MIN_GAP_HOURS}h | Interval: ${SCAN_INTERVAL_MS / 1000}s`);

sendTelegram(
  `✅ *Scanner Online*\n\n` +
  `MC range: $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}\n` +
  `Min age: ${MIN_TOKEN_AGE_DAYS} days\n` +
  `Min gap: ${MIN_GAP_HOURS}h dormant\n` +
  `Scan every: ${SCAN_INTERVAL_MS / 1000}s\n` +
  `Tracking: ${Object.keys(state.lastSeen).length} tokens\n\n` +
  `Commands:\n` +
  `/setkey YOUR_KEY — swap Helius API key\n` +
  `/credits — check remaining credits\n` +
  `/status — bot status`
);

process.on("uncaughtException", (e) => {
  logError("CRASH", "Uncaught exception:", e);
  sendTelegram(`🔴 *Scanner crashed*: ${e.message}`).finally(() => process.exit(1));
});
process.on("unhandledRejection", (e) => {
  logError("CRASH", "Unhandled rejection:", e);
});

// Hourly credit check
setInterval(checkAndReportCredits, CREDIT_CHECK_INTERVAL_MS);

scan();
setInterval(scan, SCAN_INTERVAL_MS);
