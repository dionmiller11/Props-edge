// ── LINE MONITOR WORKER v4 ──
// Game lines via ESPN (free) + Sharp money detection via ActionNetwork (free)
// Prop lines via Linemate
// Alerts via ntfy.sh

const NTFY_CHANNEL = 'dion-sharp-x9m4';
const NTFY_URL     = `https://ntfy.sh/${NTFY_CHANNEL}`;
const PROXY        = 'https://sports-proxy.dion-miller11.workers.dev';

const DEFAULT_THRESHOLDS = {
  spread:     1.5,
  total:      2.0,
  ml:         20,
  prop:       0.5,
  rlm_public: 60,
  steam:      2.0,
};

const DEFAULT_SPORT_TOGGLES = {
  nfl: true, ncaaf: true, nba: true, wnba: true,
  mlb: true, nhl: true, mma: false, epl: false, ucl: false, mls: false,
};

const DEFAULT_ALERT_PRIORITIES = {
  rlm: 'high', steam: 'high', prop: 'default', move: 'default',
};

// Loaded from KV at runtime
let THRESHOLDS = { ...DEFAULT_THRESHOLDS };
let SPORT_TOGGLES = { ...DEFAULT_SPORT_TOGGLES };
let ALERT_PRIORITIES = { ...DEFAULT_ALERT_PRIORITIES };

async function loadSettings(env) {
  try {
    const raw = await env.LINE_MONITOR_KV.get('config:settings');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.thresholds) THRESHOLDS = { ...DEFAULT_THRESHOLDS, ...s.thresholds };
    if (s.sportToggles) SPORT_TOGGLES = { ...DEFAULT_SPORT_TOGGLES, ...s.sportToggles };
    if (s.alertPriorities) ALERT_PRIORITIES = { ...DEFAULT_ALERT_PRIORITIES, ...s.alertPriorities };
  } catch(e) { console.error('loadSettings failed:', e.message); }
}

// ESPN sport configs
const GAME_SPORTS = [
  { key: 'nfl',   label: 'NFL',    espn: 'football/nfl',             an: 'nfl'   },
  { key: 'ncaaf', label: 'NCAAFB', espn: 'football/college-football', an: 'ncaaf' },
  { key: 'nba',   label: 'NBA',    espn: 'basketball/nba',            an: 'nba'   },
  { key: 'wnba',  label: 'WNBA',   espn: 'basketball/wnba',           an: null    },
  { key: 'mlb',   label: 'MLB',    espn: 'baseball/mlb',              an: 'mlb'   },
  { key: 'nhl',   label: 'NHL',    espn: 'hockey/nhl',                an: 'nhl'   },
  { key: 'mma',   label: 'MMA',    espn: 'mma/ufc',                   an: null    },
  { key: 'epl',   label: 'EPL',    espn: 'soccer/eng.1',              an: null    },
  { key: 'ucl',   label: 'UCL',    espn: 'soccer/uefa.champions',     an: null    },
  { key: 'mls',   label: 'MLS',    espn: 'soccer/usa.1',              an: null    },
];

// Prop sports via Linemate
const PROP_SPORTS = [
  { key: 'nfl',  label: 'NFL',  lmUrl: 'https://api.linemate.io/api/nfl/v1/trends/straights?lineTypes=MAIN&trendTypes=PLAYER&limit=200'  },
  { key: 'nba',  label: 'NBA',  lmUrl: 'https://api.linemate.io/api/nba/v1/trends/straights?lineTypes=MAIN&trendTypes=PLAYER&limit=200'  },
  { key: 'wnba', label: 'WNBA', lmUrl: 'https://api.linemate.io/api/wnba/v1/trends/straights?lineTypes=MAIN&trendTypes=PLAYER&limit=200' },
  { key: 'mlb',  label: 'MLB',  lmUrl: 'https://api.linemate.io/api/mlb/v1/trends/straights?lineTypes=MAIN&trendTypes=PLAYER&limit=200'  },
  { key: 'nhl',  label: 'NHL',  lmUrl: 'https://api.linemate.io/api/nhl/v1/trends/straights?lineTypes=MAIN&trendTypes=PLAYER&limit=200'  },
];

// ── FETCH WITH TIMEOUT ──
async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── SEND NTFY ──
async function sendAlert(alert) {
  try {
    await fetchWithTimeout(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Title': alert.title, 'Tags': alert.tags || 'bell', 'Priority': alert.priority || 'default' },
      body: alert.body,
    }, 4000);
  } catch(e) { console.error('ntfy failed:', e.message); }
}

// ── FETCH ESPN SCOREBOARD ──
async function fetchESPNGames(sport) {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport.espn}/scoreboard`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const data = await res.json();
    const games = [];
    for (const evt of (data.events || [])) {
      const comp = evt.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const odds = comp.odds?.[0];
      games.push({
        id: evt.id, sport: sport.key,
        home: home.team?.abbreviation || home.team?.displayName || 'HOME',
        away: away.team?.abbreviation || away.team?.displayName || 'AWAY',
        homeFull: home.team?.displayName || '',
        awayFull: away.team?.displayName || '',
        commence: evt.date,
        spread: odds?.spread != null ? parseFloat(odds.spread) : null,
        total:  odds?.overUnder != null ? parseFloat(odds.overUnder) : null,
        ml_home: odds?.homeTeamOdds?.moneyLine != null ? parseInt(odds.homeTeamOdds.moneyLine) : null,
        ml_away: odds?.awayTeamOdds?.moneyLine != null ? parseInt(odds.awayTeamOdds.moneyLine) : null,
        ts: Date.now(),
      });
    }
    return games;
  } catch(e) { console.error(`ESPN error ${sport.key}:`, e.message); return []; }
}

// ── FETCH ACTION NETWORK PUBLIC BETTING % ──
async function fetchActionNetworkSplits(anKey, dateStr) {
  try {
    const url = `https://api.actionnetwork.com/web/v1/scoreboard/${anKey}?period=game&bookIds=15,30,69,76,123&date=${dateStr}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.actionnetwork.com/' } }, 5000);
    if (!res.ok) return {};
    const data = await res.json();
    const splits = {};
    for (const game of (data.games || [])) {
      const teams = game.teams || [];
      const awayTeam = teams.find(t => t.id === game.away_team_id);
      const homeTeam = teams.find(t => t.id === game.home_team_id);
      if (!awayTeam || !homeTeam) continue;
      const key = `${awayTeam.abbr}@${homeTeam.abbr}`.toLowerCase();
      const consensus = game.bookmakers?.[0]?.lines?.[0];
      splits[key] = {
        spread_away_pct:  consensus?.spread?.away?.bets_pct  || null,
        spread_home_pct:  consensus?.spread?.home?.bets_pct  || null,
        spread_away_money: consensus?.spread?.away?.money_pct || null,
        spread_home_money: consensus?.spread?.home?.money_pct || null,
        total_over_pct:   consensus?.total?.over?.bets_pct   || null,
        total_under_pct:  consensus?.total?.under?.bets_pct  || null,
        ml_away_pct:      consensus?.ml?.away?.bets_pct      || null,
        ml_home_pct:      consensus?.ml?.home?.bets_pct      || null,
      };
    }
    return splits;
  } catch(e) { console.error('ActionNetwork error:', e.message); return {}; }
}

// ── DETECT GAME LINE MOVEMENT ──
function detectGameMovement(prev, curr, sportLabel, splits) {
  const alerts = [];
  const game = `${curr.away} @ ${curr.home}`;
  const splitKey = `${curr.away}@${curr.home}`.toLowerCase();
  const split = splits?.[splitKey] || {};

  // Spread movement
  if (prev.spread != null && curr.spread != null) {
    const diff = curr.spread - prev.spread;
    const absDiff = Math.abs(diff);
    if (absDiff >= THRESHOLDS.spread) {
      const homePublic = split.spread_home_pct;
      const awayPublic = split.spread_away_pct;
      let rlmNote = '';
      if (homePublic && awayPublic) {
        const majorityOnHome = homePublic >= THRESHOLDS.rlm_public;
        const majorityOnAway = awayPublic >= THRESHOLDS.rlm_public;
        const lineMovedAwayFavorable = diff > 0;
        if ((majorityOnHome && lineMovedAwayFavorable) || (majorityOnAway && !lineMovedAwayFavorable)) {
          rlmNote = `\n🚨 REVERSE LINE MOVEMENT — ${majorityOnHome ? homePublic : awayPublic}% public on ${majorityOnHome ? curr.home : curr.away} but line moved opposite`;
        }
      }
      const isSteam = absDiff >= THRESHOLDS.steam;
      alerts.push({
        title: `${isSteam ? '🚨 STEAM' : '📊'} ${sportLabel} SPREAD — ${game}`,
        body: `${prev.spread > 0 ? '+' : ''}${prev.spread} → ${curr.spread > 0 ? '+' : ''}${curr.spread} (${diff > 0 ? '+' : ''}${diff.toFixed(1)})${homePublic ? `\n📊 Public: ${curr.away} ${awayPublic}% / ${curr.home} ${homePublic}%` : ''}${rlmNote}`,
        tags: isSteam ? 'rotating_light,chart_with_upwards_trend' : 'chart_with_upwards_trend',
        priority: (isSteam || rlmNote) ? 'high' : 'default',
        type: rlmNote ? 'rlm' : isSteam ? 'steam' : 'move',
      });
    }
  }

  // Total movement
  if (prev.total != null && curr.total != null) {
    const diff = curr.total - prev.total;
    const absDiff = Math.abs(diff);
    if (absDiff >= THRESHOLDS.total) {
      const overPublic = split.total_over_pct;
      const underPublic = split.total_under_pct;
      let rlmNote = '';
      if (overPublic && underPublic) {
        const majorityOver = overPublic >= THRESHOLDS.rlm_public;
        const majorityUnder = underPublic >= THRESHOLDS.rlm_public;
        if ((majorityOver && diff < 0) || (majorityUnder && diff > 0)) {
          rlmNote = `\n🚨 SHARP TOTAL — ${majorityOver ? overPublic : underPublic}% on ${majorityOver ? 'OVER' : 'UNDER'} but total moved ${diff > 0 ? 'UP' : 'DOWN'}`;
        }
      }
      alerts.push({
        title: `${rlmNote ? '🚨 SHARP' : '📈'} ${sportLabel} TOTAL — ${game}`,
        body: `O/U: ${prev.total} → ${curr.total} (${diff > 0 ? '+' : ''}${diff.toFixed(1)})${overPublic ? `\n📊 Public: O ${overPublic}% / U ${underPublic}%` : ''}${rlmNote}`,
        tags: rlmNote ? 'rotating_light' : 'chart_with_upwards_trend',
        priority: rlmNote ? 'high' : 'default',
        type: rlmNote ? 'rlm' : 'move',
      });
    }
  }

  // ML movement
  if (prev.ml_home != null && curr.ml_home != null) {
    const diff = Math.abs(curr.ml_home - prev.ml_home);
    if (diff >= THRESHOLDS.ml) {
      const mlAwayPublic = split.ml_away_pct;
      const mlHomePublic = split.ml_home_pct;
      alerts.push({
        title: `💰 ${sportLabel} ML MOVE — ${game}`,
        body: `${curr.home} ML: ${prev.ml_home > 0 ? '+' : ''}${prev.ml_home} → ${curr.ml_home > 0 ? '+' : ''}${curr.ml_home}${mlHomePublic ? `\n📊 Public: ${curr.away} ${mlAwayPublic}% / ${curr.home} ${mlHomePublic}%` : ''}`,
        tags: 'moneybag',
        priority: diff >= 50 ? 'high' : 'default',
        type: 'move',
      });
    }
  }

  return alerts;
}

// ── MONITOR GAME LINES ──
async function monitorGameLines(env) {
  const alerts = [];
  const sportsMeta = {};
  const todayStr = new Date().toISOString().split('T')[0];

  for (const sport of GAME_SPORTS.filter(s => SPORT_TOGGLES[s.key] !== false)) {
    const games = await fetchESPNGames(sport);
    if (!games.length) continue;
    const now = new Date();
    const upcoming = games.filter(g => {
      const gt = new Date(g.commence);
      const hoursUntil = (gt - now) / 3600000;
      return hoursUntil > -3 && hoursUntil < 168;
    });
    if (!upcoming.length) continue;

    let splits = {};
    if (sport.an) {
      splits = await fetchActionNetworkSplits(sport.an, todayStr);
    }

    sportsMeta[sport.key] = { label: sport.label, gameCount: upcoming.length, hasSplits: Object.keys(splits).length > 0, ts: Date.now() };

    for (const curr of upcoming) {
      const prevRaw = await env.LINE_MONITOR_KV.get(`game:${curr.id}`);

      const openerRaw = await env.LINE_MONITOR_KV.get(`opener:${curr.id}`);
      if (!openerRaw && curr.spread != null) {
        await env.LINE_MONITOR_KV.put(`opener:${curr.id}`, JSON.stringify({ spread: curr.spread, total: curr.total, ml_home: curr.ml_home, ts: Date.now() }), { expirationTtl: 604800 });
      }

      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        const gameAlerts = detectGameMovement(prev, curr, sport.label, splits);
        alerts.push(...gameAlerts);
      }
      const splitKey = `${curr.away}@${curr.home}`.toLowerCase();
      const gameSplit = splits[splitKey] || null;
      await env.LINE_MONITOR_KV.put(`game:${curr.id}`, JSON.stringify({...curr, publicPct: gameSplit}), { expirationTtl: 86400 });
    }
  }

  return { alerts, sportsMeta };
}

// ── FETCH LINEMATE PROPS ──
async function fetchLinemateProps(sport, token) {
  const res = await fetchWithTimeout(sport.lmUrl, { headers: {
    'Origin': 'https://linemate.io',
    'Referer': 'https://linemate.io/',
    'linemate-client-country': 'US',
    'linemate-client-locale': 'en',
    'linemate-client-platform': 'web',
  } }, 8000);
  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (!res.ok) return [];
  return res.json();
}

function snapshotProp(item, sportKey) {
  const playerName = item.player?.fullName || 'Unknown';
  const team = item.team?.code || '—';
  const marketName = item.market?.name || '';
  const books = item.market?.books || {};
  let bestLine = null;
  for (const bk of Object.keys(books)) {
    const line = books[bk]?.over?.current?.value;
    if (line != null && bestLine === null) bestLine = line;
  }
  if (!bestLine) return null;
  return { id: `${sportKey}:${playerName}:${marketName}`, player: playerName, team, sport: sportKey, market: marketName, line: bestLine, ts: Date.now() };
}

function detectPropMovement(prev, curr, sportLabel) {
  const diff = Math.abs(curr.line - prev.line);
  if (diff < THRESHOLDS.prop) return null;
  const dir = curr.line > prev.line ? '📈 LINE UP' : '📉 LINE DOWN';
  return {
    title: `${sportLabel} PROP MOVE — ${curr.player}`,
    body: `${curr.market.replace(/_/g, ' ')}: ${prev.line} → ${curr.line}\n${dir} (${curr.team})`,
    tags: 'sports_medal',
    priority: diff >= 1.0 ? 'high' : 'default',
    type: 'prop',
  };
}

// ── MONITOR PROPS ──
async function monitorProps(env) {
  const alerts = [];
  const propsMeta = {};
  const token = await env.LINE_MONITOR_KV.get('config:lm_token');
  if (!token) return { alerts, propsMeta, tokenMissing: true };

  for (const sport of PROP_SPORTS) {
    let items;
    try { items = await fetchLinemateProps(sport, token); }
    catch(e) {
      if (e.message === 'TOKEN_EXPIRED') {
        await env.LINE_MONITOR_KV.delete('config:lm_token');
        await sendAlert({ title: '🔑 Linemate Token Expired', body: 'Open Line Monitor dashboard and paste a fresh token to resume prop monitoring.', tags: 'key,warning', priority: 'high' });
        return { alerts, propsMeta, tokenExpired: true };
      }
      continue;
    }
    let propCount = 0;
    for (const item of items) {
      const curr = snapshotProp(item, sport.key);
      if (!curr) continue;
      propCount++;
      const prevRaw = await env.LINE_MONITOR_KV.get(`prop:${curr.id}`);
      if (prevRaw) {
        const prev = JSON.parse(prevRaw);
        const alert = detectPropMovement(prev, curr, sport.label);
        if (alert) alerts.push(alert);
      }
      await env.LINE_MONITOR_KV.put(`prop:${curr.id}`, JSON.stringify(curr), { expirationTtl: 86400 });
    }
    propsMeta[sport.key] = { label: sport.label, propCount, ts: Date.now() };
  }
  return { alerts, propsMeta };
}

// ── MAIN MONITOR ──
async function runMonitor(env) {
  await loadSettings(env);
  const allAlerts = [];
  const { alerts: gameAlerts, sportsMeta } = await monitorGameLines(env);
  allAlerts.push(...gameAlerts);
  const { alerts: propAlerts, propsMeta, tokenExpired, tokenMissing } = await monitorProps(env);
  allAlerts.push(...propAlerts);

  const rlmAlerts = allAlerts.filter(a => a.type === 'rlm');
  const steamAlerts = allAlerts.filter(a => a.type === 'steam');

  await env.LINE_MONITOR_KV.put('meta:last_run', JSON.stringify({
    ts: Date.now(), sportsMeta, propsMeta,
    alertCount: allAlerts.length,
    rlmCount: rlmAlerts.length,
    steamCount: steamAlerts.length,
    tokenExpired: !!tokenExpired,
    tokenMissing: !!tokenMissing,
  }), { expirationTtl: 3600 });

  if (allAlerts.length > 0) {
    const logRaw = await env.LINE_MONITOR_KV.get('meta:alert_log');
    const log = logRaw ? JSON.parse(logRaw) : [];
    const newLog = [...allAlerts.map(a => ({ ...a, ts: Date.now() })), ...log].slice(0, 50);
    await env.LINE_MONITOR_KV.put('meta:alert_log', JSON.stringify(newLog), { expirationTtl: 604800 });
    for (const alert of allAlerts) await sendAlert(alert);
  }

  console.log(`Monitor v4: ${allAlerts.length} alerts (${rlmAlerts.length} RLM, ${steamAlerts.length} steam, ${propAlerts.length} prop)`);
  return { total: allAlerts.length, rlm: rlmAlerts.length, steam: steamAlerts.length, game: gameAlerts.length - rlmAlerts.length - steamAlerts.length, prop: propAlerts.length };
}

// ── HTTP HANDLER ──
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });

  if (url.pathname === '/monitor/status') {
    const meta  = await env.LINE_MONITOR_KV.get('meta:last_run');
    const log   = await env.LINE_MONITOR_KV.get('meta:alert_log');
    const token = await env.LINE_MONITOR_KV.get('config:lm_token');
    return new Response(JSON.stringify({ lastRun: meta ? JSON.parse(meta) : null, alerts: log ? JSON.parse(log) : [], tokenSet: !!token }), { headers: cors });
  }

  if (url.pathname === '/monitor/token' && request.method === 'POST') {
    const body = await request.json();
    if (body.token) { await env.LINE_MONITOR_KV.put('config:lm_token', body.token.trim(), { expirationTtl: 86400 }); return new Response(JSON.stringify({ ok: true }), { headers: cors }); }
    return new Response(JSON.stringify({ ok: false }), { headers: cors });
  }

  if (url.pathname === '/monitor/run' && request.method === 'POST') {
    const result = await runMonitor(env);
    return new Response(JSON.stringify(result), { headers: cors });
  }

  if (url.pathname === '/monitor/settings') {
    if (request.method === 'GET') {
      const raw = await env.LINE_MONITOR_KV.get('config:settings');
      const settings = raw ? JSON.parse(raw) : {
        thresholds: DEFAULT_THRESHOLDS,
        sportToggles: DEFAULT_SPORT_TOGGLES,
        alertPriorities: DEFAULT_ALERT_PRIORITIES,
      };
      return new Response(JSON.stringify(settings), { headers: cors });
    }
    if (request.method === 'POST') {
      const body = await request.json();
      const existing = await env.LINE_MONITOR_KV.get('config:settings');
      const current = existing ? JSON.parse(existing) : {};
      const merged = {
        thresholds: { ...DEFAULT_THRESHOLDS, ...(current.thresholds||{}), ...(body.thresholds||{}) },
        sportToggles: { ...DEFAULT_SPORT_TOGGLES, ...(current.sportToggles||{}), ...(body.sportToggles||{}) },
        alertPriorities: { ...DEFAULT_ALERT_PRIORITIES, ...(current.alertPriorities||{}), ...(body.alertPriorities||{}) },
      };
      await env.LINE_MONITOR_KV.put('config:settings', JSON.stringify(merged));
      return new Response(JSON.stringify({ ok: true, settings: merged }), { headers: cors });
    }
  }

  // ── BET TRACKER SYNC ──
  if (url.pathname === '/bets/save' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { bets } = body;
      if (!Array.isArray(bets)) return new Response(JSON.stringify({ ok: false, error: 'missing bets array' }), { headers: cors });
      await env.LINE_MONITOR_KV.put('bets:dion', JSON.stringify({ bets, updatedAt: Date.now() }), { expirationTtl: 7776000 });
      return new Response(JSON.stringify({ ok: true, count: bets.length }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  if (url.pathname === '/bets/get') {
    const raw = await env.LINE_MONITOR_KV.get('bets:dion');
    if (!raw) return new Response(JSON.stringify({ found: false, bets: [] }), { headers: cors });
    return new Response(JSON.stringify({ found: true, ...JSON.parse(raw) }), { headers: cors });
  }

  // ── SNAPSHOT SYNC (cross-device) ──
    if (url.pathname === '/snapshot/save' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { date, plays } = body;
      if (!date || !Array.isArray(plays)) return new Response(JSON.stringify({ ok: false, error: 'missing date or plays' }), { headers: cors });
      const key = `snapshot:${date}`;
      const existing = await env.LINE_MONITOR_KV.get(key);
      const cur = existing ? JSON.parse(existing) : { date, plays: [] };
      const seen = new Set(cur.plays.map(p => p.player + '|' + p.prop + '|' + (p.sport||'')));
      plays.forEach(p => {
        const k = p.player + '|' + p.prop + '|' + (p.sport||'');
        if (!seen.has(k)) { cur.plays.push(p); seen.add(k); }
      });
      cur.updatedAt = Date.now();
      await env.LINE_MONITOR_KV.put(key, JSON.stringify(cur), { expirationTtl: 604800 });
      return new Response(JSON.stringify({ ok: true, total: cur.plays.length }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  if (url.pathname === '/snapshot/get') {
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    const key = `snapshot:${date}`;
    const raw = await env.LINE_MONITOR_KV.get(key);
    if (!raw) return new Response(JSON.stringify({ found: false, date }), { headers: cors });
    return new Response(JSON.stringify({ found: true, ...JSON.parse(raw) }), { headers: cors });
  }

  if (url.pathname === '/monitor/lines') {
    const keys = await env.LINE_MONITOR_KV.list({ prefix: 'game:' });
    const lines = [];
    for (const key of keys.keys) {
      try {
        const curr = await env.LINE_MONITOR_KV.get(key.name);
        const opener = await env.LINE_MONITOR_KV.get(key.name.replace('game:', 'opener:'));
        if (!curr) continue;
        const c = JSON.parse(curr);
        const o = opener ? JSON.parse(opener) : null;
        lines.push({
          id: c.id, sport: c.sport,
          away: c.away, home: c.home,
          commence: c.commence,
          current: { spread: c.spread, total: c.total, ml_home: c.ml_home, ml_away: c.ml_away },
          opener: o ? { spread: o.spread, total: o.total, ml_home: o.ml_home } : null,
          spreadMove: o && c.spread != null && o.spread != null ? +(c.spread - o.spread).toFixed(1) : null,
          totalMove: o && c.total != null && o.total != null ? +(c.total - o.total).toFixed(1) : null,
          mlMove: o && c.ml_home != null && o.ml_home != null ? c.ml_home - o.ml_home : null,
          publicPct: c.publicPct || null,
        });
      } catch(e) {}
    }
    lines.sort((a, b) => new Date(a.commence) - new Date(b.commence));
    return new Response(JSON.stringify({ lines, ts: Date.now() }), { headers: cors });
  }

  // ── SIM PREDICTIONS ──
  if (url.pathname === '/sim/save' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { date, predictions, force } = body;
      if (!date || !Array.isArray(predictions)) return new Response(JSON.stringify({ ok: false, error: 'missing date or predictions' }), { headers: cors });
      const key = `sim:${date}`;
      let existing, added;
      if (force) {
        // Force mode: fully replace predictions for this date
        existing = { date, predictions, updatedAt: Date.now() };
        added = predictions.length;
      } else {
        const existRaw = await env.LINE_MONITOR_KV.get(key);
        existing = existRaw ? JSON.parse(existRaw) : { date, predictions: [] };
        const seen = new Set(existing.predictions.map(p => p.gameId + ':' + p.betType));
        added = 0;
        for (const p of predictions) {
          const k = p.gameId + ':' + p.betType;
          if (!seen.has(k)) { existing.predictions.push({ ...p, savedAt: Date.now(), result: null }); seen.add(k); added++; }
        }
        existing.updatedAt = Date.now();
      }
      await env.LINE_MONITOR_KV.put(key, JSON.stringify(existing), { expirationTtl: 1209600 });
      return new Response(JSON.stringify({ ok: true, total: existing.predictions.length, added }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  if (url.pathname === '/sim/results') {
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    const forceRegrade = url.searchParams.get('regrade') === '1';
    const raw = await env.LINE_MONITOR_KV.get(`sim:${date}`);
    if (!raw) return new Response(JSON.stringify({ found: false, date, predictions: [] }), { headers: cors });
    const data = JSON.parse(raw);

    let graded = 0;
    const updated = await Promise.all(data.predictions.map(async p => {
      if (p.result !== null && !forceRegrade) return p;
      try {
        const sportPath = { nfl:'football/nfl', ncaafb:'football/college-football', ncaaf:'football/college-football', nba:'basketball/nba', wnba:'basketball/wnba', mlb:'baseball/mlb', nhl:'hockey/nhl' }[(p.sport||'').toLowerCase()] || 'football/nfl';
        const res = await fetchWithTimeout(`https://site.api.espn.com/apis/site/v2/sports/${sportPath}/summary?event=${p.gameId}`, {}, 5000);
        if (!res.ok) return p;
        const d = await res.json();
        const status = d.header?.competitions?.[0]?.status?.type?.name || '';
        if (!status.toLowerCase().includes('final')) return p;
        const comp = d.header?.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) return p;
        const homeScore = parseFloat(home.score) || 0;
        const awayScore = parseFloat(away.score) || 0;
        const finalTotal = homeScore + awayScore;
        const margin = awayScore - homeScore;

        let result = null;
        if (p.betType === 'total') {
          if (finalTotal === p.line) { result = 'P'; }
          else {
            const simFavoredOver = p.simOverPct > 50;
            const wentOver = finalTotal > p.line;
            result = simFavoredOver === wentOver ? 'W' : 'L';
          }
        } else if (p.betType === 'spread') {
          // p.spread is home-team perspective (negative = home fav, e.g. CLE -10.5 → p.spread=-10.5)
          // margin = awayScore - homeScore; awayCoverMargin uses -p.spread (away's perspective)
          const awayCoverMargin = margin - p.spread;
          if (awayCoverMargin === 0) { result = 'P'; }
          else {
            const simFavoredAway = p.simAwayPct > 50;
            const awayCovers = awayCoverMargin > 0;
            result = simFavoredAway === awayCovers ? 'W' : 'L';
          }
        } else if (p.betType === 'ml') {
          if (homeScore === awayScore) { result = 'P'; }
          else {
            const simFavoredAway = p.simAwayPct > 50;
            const awayWon = awayScore > homeScore;
            result = simFavoredAway === awayWon ? 'W' : 'L';
          }
        }
        if (result) graded++;
        return { ...p, result, homeScore, awayScore, finalTotal, gradedAt: Date.now() };
      } catch(e) { return p; }
    }));

    if (graded > 0) {
      data.predictions = updated;
      data.updatedAt = Date.now();
      await env.LINE_MONITOR_KV.put(`sim:${date}`, JSON.stringify(data), { expirationTtl: 1209600 });
    }

    return new Response(JSON.stringify({ found: true, date, predictions: updated, graded }), { headers: cors });
  }

  if (url.pathname === '/sim/dates') {
    const keys = await env.LINE_MONITOR_KV.list({ prefix: 'sim:' });
    const dates = keys.keys.map(k => k.name.replace('sim:', '')).sort().reverse();
    return new Response(JSON.stringify({ dates }), { headers: cors });
  }

  // ── GAME LINES SNAPSHOT SYNC ──
  if (url.pathname === '/gamelines/save' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { date, games, force } = body;
      if (!date || !Array.isArray(games)) return new Response(JSON.stringify({ ok: false, error: 'missing date or games' }), { headers: cors });
      const key = `glsnapshot:${date}`;
      const existRaw = await env.LINE_MONITOR_KV.get(key);
      let cur = existRaw ? JSON.parse(existRaw) : { date, games: [] };
      let added = 0;
      if (force) {
        // Force mode (re-grade): fully replace all game data — overwrites stale grades
        const existingById = {};
        for (const g of cur.games) existingById[g.id] = g;
        for (const g of games) {
          if (existingById[g.id]) {
            existingById[g.id] = { ...existingById[g.id], ...g };
          } else {
            existingById[g.id] = g; added++;
          }
        }
        cur.games = Object.values(existingById);
      } else {
        // Normal mode: only update grades when result fields are present
        const seen = new Set(cur.games.map(g => g.id));
        for (const g of games) {
          if (!seen.has(g.id)) { cur.games.push(g); seen.add(g.id); added++; }
          else {
            const idx = cur.games.findIndex(x => x.id === g.id);
            if (idx >= 0 && (g.result_spread || g.result_total || g.result_ml_home)) {
              cur.games[idx] = { ...cur.games[idx], ...g };
            }
          }
        }
      }
      cur.updatedAt = Date.now();
      await env.LINE_MONITOR_KV.put(key, JSON.stringify(cur), { expirationTtl: 2592000 });
      return new Response(JSON.stringify({ ok: true, total: cur.games.length, added }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  if (url.pathname === '/gamelines/get') {
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    const key = `glsnapshot:${date}`;
    const raw = await env.LINE_MONITOR_KV.get(key);
    if (!raw) return new Response(JSON.stringify({ found: false, date, games: [] }), { headers: cors });
    return new Response(JSON.stringify({ found: true, ...JSON.parse(raw) }), { headers: cors });
  }
  // ── Linemate token store/refresh ──────────────────────────
  // MoneyPuck proxy
if (url.pathname.startsWith('/moneypuck/')) {
  const file = url.pathname.replace('/moneypuck/', '');
  const mpUrl = `https://moneypuck.com/moneypuck/playerData/seasonSummary/2026/regular/${file}`;
  const mpRes = await fetch(mpUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://moneypuck.com/' }
  });
  const csv = await mpRes.text();
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=3600'
    }
  });
}

  // nflverse proxy (GitHub releases block direct browser fetch in some envs)
  if (url.pathname.startsWith('/nflverse/')) {
    const file = url.pathname.replace('/nflverse/', '');
    // Extract season from filename like stats_team_week_2025.csv
    const seasonMatch = file.match(/(\d{4})/);
    const season = seasonMatch ? seasonMatch[1] : new Date().getFullYear();
    const nvUrl = `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
    try {
      const nvRes = await fetch(nvUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow'
      });
      const csv = await nvRes.text();
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'max-age=1800'
        }
      });
    } catch(e) {
      return new Response('fetch failed: ' + e.message, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
  }

  // ── NBA STATS PROXY (bypasses CORS on stats.nba.com) ──
  if (url.pathname.startsWith('/nba/stats/')) {
    const statsPath = url.pathname.replace('/nba/stats/', '');
    const statsUrl = `https://stats.nba.com/stats/${statsPath}?${url.searchParams.toString()}`;
    try {
      const nbRes = await fetch(statsUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://www.nba.com',
          'Referer': 'https://www.nba.com/',
          'x-nba-stats-origin': 'stats',
          'x-nba-stats-token': 'true',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      const body = await nbRes.text();
      return new Response(body, {
        status: nbRes.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'max-age=1800'
        }
      });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { ...cors } });
    }
  }

  if (url.pathname === '/linemate/token' && request.method === 'POST') {
    try {
      const body = await request.json();
      if (!body.refreshToken) return new Response(JSON.stringify({ ok: false, error: 'missing refreshToken' }), { headers: cors });
      await env.LINE_MONITOR_KV.put('linemate:refreshToken', body.refreshToken.trim());
      return new Response(JSON.stringify({ ok: true }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  if (url.pathname === '/linemate/token' && request.method === 'GET') {
    try {
      const refreshToken = await env.LINE_MONITOR_KV.get('linemate:refreshToken');
      if (!refreshToken) return new Response(JSON.stringify({ ok: false, error: 'no refresh token stored' }), { headers: cors });
      const r = await fetch('https://securetoken.googleapis.com/v1/token?key=AIzaSyB2FTPvlAWRSI71W7GlE5KzKmCpNoSnV-c', {
                method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://linemate.io/' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
      });
      const d = await r.json();
      if (d.error) return new Response(JSON.stringify({ ok: false, error: d.error.message }), { headers: cors });
      if (d.refresh_token) await env.LINE_MONITOR_KV.put('linemate:refreshToken', d.refresh_token);
      return new Response(JSON.stringify({ ok: true, accessToken: d.id_token }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  if (url.pathname === '/linemate/props' && request.method === 'GET') {
    try {
      const sport = url.searchParams.get('sport') || 'nba';
      const refreshToken = await env.LINE_MONITOR_KV.get('linemate:refreshToken');
      if (!refreshToken) return new Response(JSON.stringify({ ok: false, error: 'no refresh token stored' }), { headers: cors });
      const r = await fetch('https://securetoken.googleapis.com/v1/token?key=AIzaSyB2FTPvlAWRSI71W7GlE5KzKmCpNoSnV-c', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://linemate.io/' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
      });
      const d = await r.json();
      if (d.error) return new Response(JSON.stringify({ ok: false, error: d.error.message }), { headers: cors });
      if (d.refresh_token) await env.LINE_MONITOR_KV.put('linemate:refreshToken', d.refresh_token);
      const token = d.id_token;
      const lmUrl = `https://api.linemate.io/api/${sport}/v1/trends/straights?lineTypes=MAIN&trendTypes=PLAYER&limit=200`;
      const propsRes = await fetchWithTimeout(lmUrl, { headers: {
        'Origin': 'https://linemate.io',
        'Referer': 'https://linemate.io/',
        'linemate-client-country': 'US',
        'linemate-client-locale': 'en',
        'linemate-client-platform': 'web',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:158.0) Gecko/20100101 Firefox/158.0',
      } }, 10000);
      if (!propsRes.ok) return new Response(JSON.stringify({ ok: false, error: `Linemate ${propsRes.status}` }), { headers: cors });
      const props = await propsRes.json();
      return new Response(JSON.stringify({ ok: true, data: props }), { headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: cors });
    }
  }

  return new Response(JSON.stringify({ status: 'Line Monitor Worker v4 active — sharp money, props, bets, sim' }), { headers: cors });
}

export default {
  async fetch(request, env, ctx) { return handleRequest(request, env); },
  async scheduled(event, env, ctx) { ctx.waitUntil(runMonitor(env)); },
};