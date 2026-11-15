#!/usr/bin/env node
// Pulls real NBA, NFL and Premier League data from ESPN's public feeds and
// writes one compact file per league into data/. No API key, no dependencies.
//
//   node scripts/fetch-data.mjs            # all leagues
//   node scripts/fetch-data.mjs nba epl    # just some
//
// Set SPORTSTAT_CACHE=/some/dir to cache raw responses between runs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.SPORTSTAT_CACHE || '';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';

// ESPN labels a season by the year it ends for the NBA and by the year it
// starts for the NFL and the Premier League.
const LEAGUES = {
  nba: {
    name: 'NBA', path: 'basketball/nba', seasons: [2025, 2026, 2027],
    label: (y) => `${y - 1}-${String(y).slice(2)}`,
    logKeys: ['min', 'pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to'],
  },
  nfl: {
    name: 'NFL', path: 'football/nfl', seasons: [2024, 2025, 2026],
    label: (y) => `${y}`,
    logKeys: ['passYds', 'passTD', 'int', 'rushAtt', 'rushYds', 'rushTD', 'rec', 'tgt', 'recYds', 'recTD'],
  },
  epl: {
    name: 'Premier League', path: 'soccer/eng.1', seasons: [2024, 2025, 2026],
    label: (y) => `${y}-${String(y + 1).slice(2)}`,
    logKeys: ['goals', 'assists', 'shots', 'sog', 'yc'],
  },
};

// ---------- fetching ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, { optional = false } = {}) {
  let cacheFile = '';
  if (CACHE) {
    cacheFile = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
    try { return JSON.parse(await readFile(cacheFile, 'utf8')); } catch { /* miss */ }
  }
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
      if (res.status === 404 || res.status === 400) {
        if (optional) return null;
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (cacheFile) await writeFile(cacheFile, JSON.stringify(json));
      return json;
    } catch (err) {
      lastErr = err;
      if (/HTTP 40[04]/.test(err.message)) break;
      await sleep(600 * 2 ** attempt);
    }
  }
  if (optional) return null;
  throw new Error(`${url}: ${lastErr.message}`);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const num = (v) => {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- teams and games ----------

async function fetchTeams(cfg) {
  const j = await getJSON(`${SITE}/${cfg.path}/teams?limit=100`);
  return j.sports[0].leagues[0].teams.map(({ team: t }) => ({
    id: t.id, abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName || t.name,
    color: t.color || '555555', alt: t.alternateColor || 'ffffff',
  }));
}

async function fetchGames(cfg, teams) {
  const done = new Map();
  const upcoming = new Map();
  const extraTeams = {};
  const known = new Set(teams.map((t) => t.id));
  const venues = {};
  const jobs = [];
  for (const season of cfg.seasons) for (const t of teams) jobs.push({ season, t });
  const current = cfg.seasons.at(-1);
  // Soccer keeps results and fixtures in separate feeds.
  if (cfg.path.startsWith('soccer')) for (const t of teams) jobs.push({ season: current, t, fixture: true });

  await pool(jobs, 8, async ({ season, t, fixture }) => {
    const url = `${SITE}/${cfg.path}/teams/${t.id}/schedule?season=${season}${fixture ? '&fixture=true' : ''}`;
    const j = await getJSON(url, { optional: true });
    for (const ev of j?.events || []) {
      const c = ev.competitions?.[0];
      if (!c) continue;
      const home = c.competitors.find((x) => x.homeAway === 'home');
      const away = c.competitors.find((x) => x.homeAway === 'away');
      if (!home || !away) continue;
      for (const side of [home, away]) {
        if (!known.has(side.team.id)) {
          extraTeams[side.team.id] = { abbr: side.team.abbreviation, name: side.team.displayName };
        }
      }
      const neutral = c.neutralSite ? 1 : 0;
      const state = c.status?.type?.state;
      if (c.status?.type?.completed && home.score && away.score) {
        done.set(ev.id, [ev.id, ev.date, season, home.team.id, away.team.id, num(home.score.value), num(away.score.value), neutral]);
        if (!neutral && c.venue?.fullName && season === current) venues[home.team.id] = c.venue.fullName;
      } else if (state === 'pre' && season === current) {
        upcoming.set(ev.id, [ev.id, ev.date, home.team.id, away.team.id, neutral, c.venue?.fullName || '']);
      }
    }
  });
  for (const t of teams) t.venue = venues[t.id] || '';
  const byDate = (a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  return {
    games: [...done.values()].sort(byDate),
    upcoming: [...upcoming.values()].filter((g) => !done.has(g[0])).sort(byDate),
    extraTeams,
  };
}

// ---------- player season stats ----------

async function fetchByAthlete(cfg, season, extra = '') {
  const rows = [];
  let cats = null;
  for (let page = 1; page < 40; page++) {
    const j = await getJSON(`${WEB}/${cfg.path}/statistics/byathlete?season=${season}&seasontype=2&limit=200&page=${page}${extra}`, { optional: true });
    if (!j?.athletes?.length) break;
    cats = j.categories;
    rows.push(...j.athletes);
    if (page >= (j.pagination?.pages || 1)) break;
  }
  // Flatten each athlete's category arrays into { statName: number }.
  return rows.map((r) => {
    const stats = {};
    for (const cat of r.categories || []) {
      const def = cats.find((c) => c.name === cat.name);
      // First category wins: passing 'interceptions' must not be overwritten by the defensive one.
      def?.names.forEach((n, i) => { if (!(n in stats)) stats[n] = num(cat.totals?.[i]); });
    }
    const a = r.athlete;
    return {
      id: a.id, name: a.displayName, pos: a.position?.abbreviation || '', age: a.age || null,
      teamId: a.teamId || a.teams?.at(-1)?.id || null, stats,
    };
  });
}

const NBA_SEASON = (s) => ({
  gp: s.gamesPlayed, min: s.avgMinutes, pts: s.avgPoints, reb: s.avgRebounds, ast: s.avgAssists,
  stl: s.avgSteals, blk: s.avgBlocks, tpm: s.avgThreePointFieldGoalsMade, to: s.avgTurnovers,
  fgp: s.fieldGoalPct, tpp: s.threePointFieldGoalPct, ftp: s.freeThrowPct,
});

const NFL_SEASON = (s) => ({
  gp: s.gamesPlayed, cmp: s.completions, att: s.passingAttempts, passYds: s.passingYards,
  passTD: s.passingTouchdowns, int: s.interceptions, rushAtt: s.rushingAttempts, rushYds: s.rushingYards,
  rushTD: s.rushingTouchdowns, rec: s.receptions, tgt: s.receivingTargets, recYds: s.receivingYards,
  recTD: s.receivingTouchdowns,
});

async function nbaPlayers(cfg) {
  const [cur, prev] = await Promise.all([fetchByAthlete(cfg, cfg.seasons.at(-1)), fetchByAthlete(cfg, cfg.seasons.at(-2))]);
  const prevById = new Map(prev.map((p) => [p.id, p]));
  return cur.map((p) => ({
    id: p.id, name: p.name, pos: p.pos, age: p.age, teamId: p.teamId,
    cur: NBA_SEASON(p.stats), prev: prevById.has(p.id) ? NBA_SEASON(prevById.get(p.id).stats) : null,
  }));
}

async function nflPlayers(cfg) {
  const cats = ['offense:passing', 'offense:rushing', 'offense:receiving'];
  const load = async (season) => {
    const lists = await Promise.all(cats.map((c) => fetchByAthlete(cfg, season, `&category=${encodeURIComponent(c)}`)));
    const byId = new Map();
    for (const list of lists) for (const p of list) if (!byId.has(p.id)) byId.set(p.id, p);
    return byId;
  };
  const [cur, prev] = await Promise.all([load(cfg.seasons.at(-1)), load(cfg.seasons.at(-2))]);
  return [...cur.values()]
    .filter((p) => ['QB', 'RB', 'WR', 'TE', 'FB'].includes(p.pos))
    .map((p) => ({
      id: p.id, name: p.name, pos: p.pos, age: p.age, teamId: p.teamId,
      cur: NFL_SEASON(p.stats), prev: prev.has(p.id) ? NFL_SEASON(prev.get(p.id).stats) : null,
    }));
}

async function eplPlayers(cfg, teams) {
  const load = async (season) => {
    const byId = new Map();
    await pool(teams, 6, async (t) => {
      const j = await getJSON(`${SITE}/${cfg.path}/teams/${t.id}/roster?season=${season}`, { optional: true });
      for (const a of j?.athletes || []) {
        const s = {};
        for (const cat of a.statistics?.splits?.categories || []) for (const st of cat.stats) s[st.name] = num(st.value);
        byId.set(a.id, {
          id: a.id, name: a.displayName, pos: a.position?.abbreviation || '', age: a.age || null, teamId: t.id,
          season: {
            gp: s.appearances || 0, subs: s.subIns || 0, goals: s.totalGoals || 0, assists: s.goalAssists || 0,
            shots: s.totalShots || 0, sog: s.shotsOnTarget || 0, yc: s.yellowCards || 0, rc: s.redCards || 0,
            fouls: s.foulsCommitted || 0, saves: s.saves || 0, conceded: s.goalsConceded || 0,
          },
        });
      }
    });
    return byId;
  };
  const [cur, prev] = await Promise.all([load(cfg.seasons.at(-1)), load(cfg.seasons.at(-2))]);
  return [...cur.values()].map((p) => ({
    id: p.id, name: p.name, pos: p.pos, age: p.age, teamId: p.teamId,
    cur: p.season, prev: prev.get(p.id)?.season || null,
  }));
}

// ---------- player game logs ----------

const made = (v) => num(String(v ?? '').split('-')[0]);

const LOG_PARSERS = {
  nba: (get) => [num(get('minutes')), num(get('points')), num(get('totalRebounds')), num(get('assists')), num(get('steals')),
    num(get('blocks')), made(get('threePointFieldGoalsMade-threePointFieldGoalsAttempted')), num(get('turnovers'))],
  nfl: (get) => ['passingYards', 'passingTouchdowns', 'interceptions', 'rushingAttempts', 'rushingYards', 'rushingTouchdowns',
    'receptions', 'receivingTargets', 'receivingYards', 'receivingTouchdowns'].map((k) => num(get(k))),
  epl: (get) => ['totalGoals', 'goalAssists', 'totalShots', 'shotsOnTarget', 'yellowCards'].map((k) => num(get(k))),
};

async function fetchLog(key, cfg, player, season) {
  // For soccer, naming the current season returns European cup games instead of league games, so leave it off.
  const q = key === 'epl' && season === cfg.seasons.at(-1) ? '' : `?season=${season}`;
  const j = await getJSON(`${WEB}/${cfg.path}/athletes/${player.id}/gamelog${q}`, { optional: true });
  if (!j?.seasonTypes || !j.names) return [];
  const idx = Object.fromEntries(j.names.map((n, i) => [n, i]));
  const wanted = key === 'epl' ? /premier league/i : /regular season/i;
  const rows = [];
  for (const st of j.seasonTypes) {
    if (!wanted.test(st.displayName || '')) continue;
    for (const cat of st.categories || []) {
      if (cat.type !== 'event') continue;
      for (const e of cat.events || []) {
        const meta = j.events?.[e.eventId];
        if (!meta?.opponent?.id) continue;
        const get = (name) => e.stats[idx[name]];
        rows.push([meta.gameDate.slice(0, 10), meta.opponent.id, meta.atVs === 'vs' ? 1 : 0, ...LOG_PARSERS[key](get)]);
      }
    }
  }
  return rows;
}

async function attachLogs(key, cfg, players) {
  const jobs = [];
  for (const p of players) {
    if (p.cur?.gp > 0) jobs.push({ p, season: cfg.seasons.at(-1) });
    if (p.prev?.gp > 0) jobs.push({ p, season: cfg.seasons.at(-2) });
  }
  let failed = 0;
  await pool(jobs, 10, async ({ p, season }) => {
    try {
      const rows = await fetchLog(key, cfg, p, season);
      (p.log ||= []).push(...rows);
    } catch { failed++; }
  });
  for (const p of players) {
    p.log = (p.log || []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  if (failed) console.warn(`  ${failed} game logs could not be loaded`);
}

// ---------- assemble ----------

async function build(key) {
  const cfg = LEAGUES[key];
  console.log(`${cfg.name}: teams and results`);
  const teams = await fetchTeams(cfg);
  const { games, upcoming, extraTeams } = await fetchGames(cfg, teams);
  console.log(`  ${teams.length} teams, ${games.length} finished games, ${upcoming.length} upcoming`);

  console.log(`${cfg.name}: players`);
  let players = key === 'nba' ? await nbaPlayers(cfg) : key === 'nfl' ? await nflPlayers(cfg) : await eplPlayers(cfg, teams);
  const known = new Set(teams.map((t) => t.id));
  players = players.filter((p) => known.has(p.teamId));
  await attachLogs(key, cfg, players);
  for (const p of players) for (const s of [p.cur, p.prev]) if (s) for (const k in s) s[k] = round(s[k], 1);
  console.log(`  ${players.length} players, ${players.reduce((n, p) => n + p.log.length, 0)} game-log rows`);

  const data = {
    league: key, name: cfg.name, fetchedAt: new Date().toISOString(), source: 'ESPN public feeds',
    seasons: cfg.seasons, seasonLabels: Object.fromEntries(cfg.seasons.map((y) => [y, cfg.label(y)])),
    teams, extraTeams, games, upcoming, logKeys: cfg.logKeys, players,
  };
  await mkdir(join(ROOT, 'data'), { recursive: true });
  const body = `(globalThis.SPORTSTAT_DATA = globalThis.SPORTSTAT_DATA || {}).${key} = ${JSON.stringify(data)};\n`;
  await writeFile(join(ROOT, 'data', `${key}.js`), body);
  console.log(`  wrote data/${key}.js (${(body.length / 1e6).toFixed(2)} MB)`);
}

const wanted = process.argv.slice(2).filter((k) => LEAGUES[k]);
if (CACHE) await mkdir(CACHE, { recursive: true });
for (const key of wanted.length ? wanted : Object.keys(LEAGUES)) await build(key);
