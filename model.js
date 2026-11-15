// Prediction engine. Pure functions over the data files, no DOM.
// Works as a plain <script> (window.SportModel) and under Node (module.exports).
(function (root) {
  'use strict';

  const LEAGUE = {
    nba: {
      unit: 'pts', k: 20, hfaElo: 60, carry: 0.75, formN: 10, rateN: 30, close: 5, blowout: 15, splitShrink: 40, newElo: 1500,
      mov: (m, d) => Math.pow(m + 3, 0.8) / (7.5 + 0.006 * d),
    },
    nfl: {
      unit: 'pts', k: 20, hfaElo: 45, carry: 0.67, formN: 5, rateN: 12, close: 8, blowout: 14, splitShrink: 30, newElo: 1500,
      mov: (m, d) => Math.log(m + 1) * 2.2 / (0.001 * d + 2.2),
    },
    epl: {
      unit: 'goals', k: 20, hfaElo: 55, carry: 0.8, formN: 6, rateN: 19, splitShrink: 30, newElo: 1420, soccer: true,
      mov: (m) => (m <= 1 ? 1 : m === 2 ? 1.5 : 1.75 + (m - 3) / 8),
    },
  };

  // ---------- small maths ----------
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const sdev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function phi(z) { // standard normal CDF
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  const pois = (k, lam) => { let p = Math.exp(-lam); for (let i = 1; i <= k; i++) p *= lam / i; return p; };
  const fmt = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
  const signed = (x, d = 1) => (x >= 0 ? '+' : '−') + fmt(Math.abs(x), d);
  const pct = (p) => Math.round(p * 100) + '%';

  // ---------- team model ----------
  function buildModel(data) {
    const cfg = LEAGUE[data.league];
    const info = new Map();
    for (const t of data.teams) info.set(t.id, t);
    for (const id in data.extraTeams || {}) info.set(id, { id, ...data.extraTeams[id], short: data.extraTeams[id].name, color: '777777', alt: 'ffffff', former: true });
    const state = new Map();
    const S = (id) => {
      if (!state.has(id)) state.set(id, { id, elo: info.get(id)?.former ? cfg.newElo : 1500, season: null, games: [] });
      return state.get(id);
    };
    const current = data.seasons[data.seasons.length - 1];

    // Pass 1: Elo ratings, walking forward through every finished game.
    const fit = [];
    for (const g of data.games) {
      const [id, date, season, hId, aId, hs, as, neutral] = g;
      const H = S(hId), A = S(aId);
      for (const t of [H, A]) {
        if (t.season !== null && t.season !== season) t.elo = 1505 * (1 - cfg.carry) + t.elo * cfg.carry;
        if (t.season === null && season !== data.seasons[0]) t.elo = cfg.newElo; // promoted side
        t.season = season;
      }
      const diff = H.elo - A.elo;
      const withHfa = diff + (neutral ? 0 : cfg.hfaElo);
      const expH = 1 / (1 + Math.pow(10, -withHfa / 400));
      const margin = hs - as;
      const actual = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
      const winnerDiff = margin >= 0 ? withHfa : -withHfa;
      const delta = cfg.k * cfg.mov(Math.abs(margin), winnerDiff) * (actual - expH);
      if (!neutral) fit.push([diff, margin]);
      const rec = { id, d: date, season, neutral, diff };
      H.games.push({ ...rec, opp: aId, home: 1, pf: hs, pa: as, eloPre: H.elo });
      A.games.push({ ...rec, opp: hId, home: 0, pf: as, pa: hs, eloPre: A.elo });
      H.elo += delta; A.elo -= delta;
    }
    // If the newest season has no games yet for a team, still apply the carry-over.
    for (const t of state.values()) if (t.season !== null && t.season !== current && info.get(t.id) && !info.get(t.id).former) {
      t.elo = 1505 * (1 - cfg.carry) + t.elo * cfg.carry; t.season = current;
    }

    // How many points (or goals) one rating point is worth, and the league-wide home edge.
    const mx = mean(fit.map((f) => f[0])), my = mean(fit.map((f) => f[1]));
    let sxy = 0, sxx = 0;
    for (const [x, y] of fit) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const hfa = my - slope * mx;
    const perTeam = data.games.filter((g) => g[2] >= data.seasons[data.seasons.length - 2]);
    const avgPts = mean(perTeam.map((g) => (g[5] + g[6]) / 2));

    // Expected margin for each stored game, from each side's point of view.
    for (const t of state.values()) for (const g of t.games) {
      const sign = g.home ? 1 : -1;
      g.exp = sign * (slope * g.diff + (g.neutral ? 0 : hfa));
      g.resid = (g.pf - g.pa) - g.exp;
    }

    const model = { data, cfg, info, state, slope, hfa, avgPts, current, sd: 12, totalSd: 18 };

    // A team's history as it stood before a given date (for honest back-testing).
    function view(id, asOf) {
      const t = S(id);
      if (!asOf) return { elo: t.elo, games: t.games };
      let n = t.games.length;
      while (n > 0 && t.games[n - 1].d >= asOf) n--;
      return { elo: n < t.games.length ? t.games[n].eloPre : t.elo, games: t.games.slice(0, n) };
    }

    function rates(games) {
      const recent = games.slice(-cfg.rateN);
      if (!recent.length) return { off: avgPts, def: avgPts, n: 0 };
      let w = 0, off = 0, def = 0;
      recent.forEach((g, i) => { const wt = 0.5 + (i + 1) / recent.length; w += wt; off += wt * g.pf; def += wt * g.pa; });
      // Pull thin samples toward the league average.
      const k = recent.length / (recent.length + 4);
      return { off: avgPts + k * (off / w - avgPts), def: avgPts + k * (def / w - avgPts), n: recent.length };
    }

    // Home/road split: how much better this team plays at home than away, beyond the league norm.
    function venueSplit(games) {
      const recent = games.filter((g) => !g.neutral).slice(-cfg.rateN * 3);
      const h = recent.filter((g) => g.home), a = recent.filter((g) => !g.home);
      const n = Math.min(h.length, a.length);
      if (n < 3) return { extra: 0, n, homeMargin: 0, awayMargin: 0 };
      const hm = mean(h.map((g) => g.pf - g.pa)), am = mean(a.map((g) => g.pf - g.pa));
      const raw = (hm - am) / 2 - hfa;
      return { extra: raw * n / (n + cfg.splitShrink), raw, n, homeMargin: hm, awayMargin: am };
    }

    function form(games) {
      const recent = games.slice(-cfg.formN);
      const w = recent.filter((g) => g.pf > g.pa).length, l = recent.filter((g) => g.pf < g.pa).length;
      return { n: recent.length, w, l, d: recent.length - w - l, resid: mean(recent.map((g) => g.resid)), margin: mean(recent.map((g) => g.pf - g.pa)) };
    }

    function headToHead(hGames, awayId) {
      const meets = hGames.filter((g) => g.opp === awayId).slice(-6);
      const w = meets.filter((g) => g.pf > g.pa).length, l = meets.filter((g) => g.pf < g.pa).length;
      return { meets, n: meets.length, w, l, d: meets.length - w - l, resid: mean(meets.map((g) => g.resid)), margin: mean(meets.map((g) => g.pf - g.pa)) };
    }

    function predict(homeId, awayId, opts = {}) {
      const neutral = !!opts.neutral;
      const H = view(homeId, opts.asOf), A = view(awayId, opts.asOf);
      const hi = info.get(homeId), ai = info.get(awayId);
      const u = cfg.unit;
      const factors = [];

      const gap = slope * (H.elo - A.elo);
      factors.push({
        key: 'rating', label: 'Overall strength', value: gap,
        detail: `${hi.short} are rated ${Math.round(H.elo)}, ${ai.short} ${Math.round(A.elo)}. Ratings are built from every result since ${data.seasonLabels[data.seasons[0]]}, weighted by margin and opponent quality. That gap is worth ${fmt(Math.abs(gap))} ${u} to ${gap >= 0 ? hi.short : ai.short}.`,
      });

      const hs = venueSplit(H.games), as = venueSplit(A.games);
      if (!neutral) {
        factors.push({
          key: 'home', label: `Home ${data.league === 'nba' ? 'court' : data.league === 'nfl' ? 'field' : 'pitch'}`, value: hfa,
          detail: `Across the ${data.name}, home teams have won by ${fmt(hfa)} ${u} more than their rating alone predicts.`,
        });
        // Splits can shrink the home edge but never turn it into a handicap.
        const extra = Math.max(hs.extra + as.extra, -hfa);
        factors.push({
          key: 'split', label: 'Home/road splits', value: extra,
          detail: `${hi.short} average ${signed(hs.homeMargin)} at home and ${signed(hs.awayMargin)} away; ${ai.short} average ${signed(as.homeMargin)} at home and ${signed(as.awayMargin)} away. ` +
            `Compared with a typical team that ${Math.abs(extra) < 0.05 ? 'changes nothing' : `moves this game ${fmt(Math.abs(extra))} ${u} toward ${extra >= 0 ? hi.short : ai.short}`} (splits are noisy, so they are heavily discounted).`,
        });
      }

      const hf = form(H.games), af = form(A.games);
      const formAdj = 0.25 * (hf.resid - af.resid);
      const rec = (f) => (cfg.soccer ? `${f.w}-${f.d}-${f.l} (W-D-L)` : `${f.w}-${f.l}`);
      factors.push({
        key: 'form', label: `Last ${cfg.formN} games`, value: formAdj,
        detail: `${hi.short} are ${rec(hf)} lately and have ${hf.resid >= 0 ? 'beaten' : 'fallen short of'} expectations by ${fmt(Math.abs(hf.resid))} ${u} a game; ${ai.short} are ${rec(af)} and ${af.resid >= 0 ? 'beat' : 'fell short of'} expectations by ${fmt(Math.abs(af.resid))}.`,
      });

      const h2h = headToHead(H.games, awayId);
      const h2hAdj = h2h.n ? 0.3 * (h2h.n / (h2h.n + 4)) * h2h.resid : 0;
      factors.push({
        key: 'h2h', label: 'Head-to-head', value: h2hAdj,
        detail: h2h.n
          ? `${hi.short} are ${rec(h2h)} in the last ${h2h.n} meeting${h2h.n > 1 ? 's' : ''}, with an average margin of ${signed(h2h.margin)}. That is ${fmt(Math.abs(h2h.resid))} ${u} ${h2h.resid >= 0 ? 'better' : 'worse'} than their ratings predicted at the time.`
          : `No meetings between these teams since ${data.seasonLabels[data.seasons[0]]}, so history adds nothing here.`,
      });

      let margin = factors.reduce((s, f) => s + f.value, 0);
      const hr = rates(H.games), ar = rates(A.games);
      let total = hr.off + hr.def + ar.off + ar.def - 2 * avgPts;
      let homeScore = (total + margin) / 2, awayScore = (total - margin) / 2;

      const out = { home: hi, away: ai, neutral, factors, h2h, margin, form: { home: hf, away: af }, rates: { home: hr, away: ar }, elo: { home: H.elo, away: A.elo } };
      const cats = [];
      if (cfg.soccer) {
        homeScore = clamp(homeScore, 0.2, 5); awayScore = clamp(awayScore, 0.2, 5);
        total = homeScore + awayScore;
        let pH = 0, pD = 0, pA = 0, over = 0, btts = 0;
        const lines = [];
        for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) {
          const p = pois(i, homeScore) * pois(j, awayScore);
          if (i > j) pH += p; else if (i < j) pA += p; else pD += p;
          if (i + j > 2.5) over += p;
          if (i && j) btts += p;
          lines.push([p, `${i}-${j}`]);
        }
        const z = pH + pD + pA; pH /= z; pD /= z; pA /= z;
        lines.sort((a, b) => b[0] - a[0]);
        Object.assign(out, { pHome: pH, pDraw: pD, pAway: pA });
        cats.push(
          { label: 'Result', value: `${hi.abbr} ${pct(pH)} · Draw ${pct(pD)} · ${ai.abbr} ${pct(pA)}`, detail: 'From the projected goals for each side.' },
          { label: 'Projected goals', value: `${hi.abbr} ${fmt(homeScore)} – ${fmt(awayScore)} ${ai.abbr}`, detail: `${hi.short} score ${fmt(hr.off, 2)} and concede ${fmt(hr.def, 2)} a game lately; ${ai.short} score ${fmt(ar.off, 2)} and concede ${fmt(ar.def, 2)}. League average is ${fmt(avgPts, 2)}.` },
          { label: 'Most likely scores', value: lines.slice(0, 3).map((l) => `${l[1]} (${pct(l[0])})`).join(' · '), detail: `Shown as ${hi.abbr}–${ai.abbr}.` },
          { label: 'Over 2.5 goals', value: pct(over), detail: `Projected total is ${fmt(total)} goals.` },
          { label: 'Both teams score', value: pct(btts), detail: '' },
          { label: 'Clean sheet', value: `${hi.abbr} ${pct(pois(0, awayScore))} · ${ai.abbr} ${pct(pois(0, homeScore))}`, detail: '' },
        );
      } else {
        const pH = phi(margin / model.sd);
        Object.assign(out, { pHome: pH, pDraw: 0, pAway: 1 - pH });
        const fav = margin >= 0 ? hi : ai, am = Math.abs(margin);
        const pClose = phi((cfg.close + 0.5 - margin) / model.sd) - phi((-cfg.close - 0.5 - margin) / model.sd);
        const pBlow = 1 - phi((cfg.blowout - 0.5 - am) / model.sd);
        cats.push(
          { label: 'Winner', value: `${fav.abbr} ${pct(Math.max(pH, 1 - pH))}`, detail: `A ${fmt(am)}-point edge, with past misses of about ${fmt(model.sd)} points either way.` },
          { label: 'Projected score', value: `${hi.abbr} ${Math.round(homeScore)} – ${Math.round(awayScore)} ${ai.abbr}`, detail: `${hi.short} score ${fmt(hr.off)} and allow ${fmt(hr.def)} a game lately; ${ai.short} score ${fmt(ar.off)} and allow ${fmt(ar.def)}. League average is ${fmt(avgPts)}.` },
          { label: 'Margin', value: `${fav.abbr} by ${fmt(am)}`, detail: 'Sum of the factors listed under “Why”.' },
          { label: 'Total points', value: fmt(total), detail: `Typical range ${Math.round(total - model.totalSd)}–${Math.round(total + model.totalSd)}.` },
          { label: data.league === 'nfl' ? 'One-score game (8 or fewer)' : `Close game (${cfg.close} or fewer)`, value: pct(pClose), detail: '' },
          { label: `${fav.abbr} win by ${cfg.blowout}+`, value: pct(pBlow), detail: '' },
        );
      }
      Object.assign(out, { total, homeScore, awayScore, categories: cats });
      return out;
    }

    // Back-test: predict every game from the second season on, using only what was known before it.
    function backtest() {
      const start = data.seasons[1];
      let n = 0, correct = 0, homePick = 0, absErr = 0; const errs = [], terrs = [];
      for (const g of data.games) {
        if (g[2] < start) continue;
        const p = predict(g[3], g[4], { neutral: g[7], asOf: g[1] });
        const m = g[5] - g[6];
        const actual = m > 0 ? 'H' : m < 0 ? 'A' : 'D';
        const pick = cfg.soccer ? (p.pHome >= p.pDraw && p.pHome >= p.pAway ? 'H' : p.pAway >= p.pDraw ? 'A' : 'D') : (p.margin >= 0 ? 'H' : 'A');
        n++; if (pick === actual) correct++; if (actual === 'H') homePick++;
        absErr += Math.abs(m - p.margin); errs.push(m - p.margin); terrs.push(g[5] + g[6] - p.total);
      }
      return { n, correct, acc: n ? correct / n : 0, homeAcc: n ? homePick / n : 0, mae: n ? absErr / n : 0, sd: Math.sqrt(mean(errs.map((e) => e * e))), totalSd: Math.sqrt(mean(terrs.map((e) => e * e))), from: data.seasonLabels[start] };
    }

    model.predict = predict;
    model.view = view;
    const bt = backtest();
    if (bt.n > 50) { model.sd = bt.sd; model.totalSd = bt.totalSd; }
    model.backtest = bt;

    // ---------- team profiles ----------
    const active = data.teams.map((t) => t.id);
    const ranked = [...active].sort((a, b) => S(b).elo - S(a).elo);
    model.rank = (id) => ranked.indexOf(id) + 1;
    model.ranked = ranked;

    model.team = function (id) {
      const t = S(id), i = info.get(id);
      const season = t.games.filter((g) => g.season === current);
      const tally = (gs) => { const w = gs.filter((g) => g.pf > g.pa).length, l = gs.filter((g) => g.pf < g.pa).length; return { w, l, d: gs.length - w - l, n: gs.length }; };
      const recStr = (r) => (cfg.soccer ? `${r.w}-${r.d}-${r.l}` : `${r.w}-${r.l}`);
      const home = season.filter((g) => g.home && !g.neutral), away = season.filter((g) => !g.home && !g.neutral);
      const split = venueSplit(t.games);
      const next = data.upcoming.filter((g) => g[2] === id || g[3] === id).slice(0, 5).map((g) => {
        const p = predict(g[2], g[3], { neutral: g[4] });
        const isHome = g[2] === id;
        return { id: g[0], date: g[1], opp: info.get(isHome ? g[3] : g[2]), isHome, neutral: g[4], venue: g[5], pWin: isHome ? p.pHome : p.pAway, pDraw: p.pDraw, pred: p };
      });
      return {
        info: i, elo: t.elo, rank: model.rank(id), record: tally(season), recStr,
        homeRec: tally(home), awayRec: tally(away),
        ppg: mean(season.map((g) => g.pf)), papg: mean(season.map((g) => g.pa)),
        form: form(t.games), formList: t.games.slice(-cfg.formN).map((g) => (g.pf > g.pa ? 'W' : g.pf < g.pa ? 'L' : 'D')),
        split, homeEdge: hfa + split.extra, rates: rates(t.games),
        history: t.games.map((g) => ({ d: g.d, elo: g.eloPre, season: g.season })).concat([{ d: 'now', elo: t.elo, season: current }]),
        last: t.games.slice(-6).reverse().map((g) => ({ ...g, oppInfo: info.get(g.opp) })),
        next,
      };
    };

    model.upcoming = function (limit = 16) {
      return data.upcoming.slice(0, limit).map((g) => ({ id: g[0], date: g[1], venue: g[5], pred: predict(g[2], g[3], { neutral: g[4] }) }));
    };

    // ---------- players ----------
    const seasonStart = (data.games.find((g) => g[2] === current) || [0, '9999'])[1].slice(0, 10);
    const K = Object.fromEntries(data.logKeys.map((k, i) => [k, i + 3]));

    // Which stats we project, by league and position. `el` = how strongly the stat follows opponent defence.
    function statDefs(p) {
      if (data.league === 'nba') return [
        { key: 'pts', label: 'Points', el: 0.8 }, { key: 'reb', label: 'Rebounds', el: 0.3 }, { key: 'ast', label: 'Assists', el: 0.6 },
        { key: 'tpm', label: '3-pointers', el: 0.6 }, { key: 'stl', label: 'Steals', el: 0 }, { key: 'blk', label: 'Blocks', el: 0 }, { key: 'to', label: 'Turnovers', el: 0, low: true },
      ];
      if (data.league === 'nfl') {
        if (p.pos === 'QB') return [
          { key: 'passYds', label: 'Pass yards', el: 0.5 }, { key: 'passTD', label: 'Pass TDs', el: 0.9 }, { key: 'int', label: 'Interceptions', el: 0, low: true },
          { key: 'rushYds', label: 'Rush yards', el: 0.4 }, { key: 'rushTD', label: 'Rush TDs', el: 0.9 },
        ];
        if (p.pos === 'RB' || p.pos === 'FB') return [
          { key: 'rushYds', label: 'Rush yards', el: 0.5 }, { key: 'rushAtt', label: 'Carries', el: 0 }, { key: 'rushTD', label: 'Rush TDs', el: 0.9 },
          { key: 'rec', label: 'Receptions', el: 0.2 }, { key: 'recYds', label: 'Rec yards', el: 0.5 }, { key: 'recTD', label: 'Rec TDs', el: 0.9 },
        ];
        return [
          { key: 'recYds', label: 'Rec yards', el: 0.5 }, { key: 'rec', label: 'Receptions', el: 0.2 }, { key: 'tgt', label: 'Targets', el: 0 }, { key: 'recTD', label: 'Rec TDs', el: 0.9 },
        ];
      }
      return [
        { key: 'goals', label: 'Goals', el: 0.9 }, { key: 'assists', label: 'Assists', el: 0.9 }, { key: 'shots', label: 'Shots', el: 0.6 }, { key: 'sog', label: 'Shots on target', el: 0.6 },
      ];
    }
    model.statDefs = statDefs;

    // Season average per game for one stat.
    function seasonAvg(p, which, key) {
      const s = p[which];
      if (!s || !s.gp) return null;
      if (!(key in s)) return null;
      return data.league === 'nba' ? s[key] : s[key] / s.gp;
    }
    model.seasonAvg = seasonAvg;

    function impact(v) {
      if (data.league === 'nba') return v.pts + 1.2 * v.reb + 1.5 * v.ast + 3 * v.stl + 3 * v.blk - v.to;
      if (data.league === 'nfl') return (v.passYds || 0) / 25 + 4 * (v.passTD || 0) - 2 * (v.int || 0) + ((v.rushYds || 0) + (v.recYds || 0)) / 10 + 6 * ((v.rushTD || 0) + (v.recTD || 0)) + 0.5 * (v.rec || 0);
      return (v.goals || 0) + (v.assists || 0);
    }
    model.impactLabel = data.league === 'epl' ? 'Goal involvements' : 'Fantasy points';

    // Project one player's next game. ctx: { oppId, venue: 'home' | 'away' | 'neutral' }.
    model.project = function (p, ctx = {}) {
      const log = p.log || [];
      const cur = log.filter((r) => r[0] >= seasonStart), prev = log.filter((r) => r[0] < seasonStart);
      const last5 = log.slice(-5);
      const opp = ctx.oppId ? info.get(ctx.oppId) : null;
      const oppRates = opp ? rates(S(opp.id).games) : null;
      const defRatio = oppRates ? oppRates.def / avgPts : 1;
      const vsOpp = opp ? log.filter((r) => r[1] === opp.id) : [];
      const home = log.filter((r) => r[2] === 1), away = log.filter((r) => r[2] === 0);
      const stats = statDefs(p).map((def) => {
        const col = K[def.key];
        const vals = (rows) => rows.map((r) => r[col]);
        let base;
        const sCur = seasonAvg(p, 'cur', def.key), sPrev = seasonAvg(p, 'prev', def.key);
        if (log.length) {
          let w = 0, sum = 0;
          const recent = new Set(last5);
          for (const r of log) {
            const wt = (r[0] >= seasonStart ? 1 : 0.3) + (recent.has(r) ? 0.5 : 0);
            w += wt; sum += wt * r[col];
          }
          if (!prev.length && sPrev != null) { const pw = 0.3 * p.prev.gp; w += pw; sum += pw * sPrev; }
          base = sum / w;
        } else base = sCur ?? sPrev ?? 0;
        const oppAdj = base * def.el * (defRatio - 1);
        const nSplit = Math.min(home.length, away.length);
        const splitRaw = nSplit >= 3 ? (mean(vals(home)) - mean(vals(away))) / 2 : 0;
        const venueAdj = ctx.venue === 'neutral' || !ctx.venue ? 0 : (ctx.venue === 'home' ? 1 : -1) * splitRaw * nSplit / (nSplit + 30);
        const all = mean(vals(log));
        const h2hAdj = vsOpp.length ? 0.5 * (vsOpp.length / (vsOpp.length + 6)) * (mean(vals(vsOpp)) - all) : 0;
        const proj = Math.max(0, base + oppAdj + venueAdj + h2hAdj);
        return {
          ...def, proj, base, oppAdj, venueAdj, h2hAdj,
          season: sCur, prevSeason: sPrev, last5: last5.length ? mean(vals(last5)) : null,
          homeAvg: home.length ? mean(vals(home)) : null, awayAvg: away.length ? mean(vals(away)) : null,
          vsOpp: vsOpp.length ? mean(vals(vsOpp)) : null,
          sd: sdev(vals(log.slice(-40))) || Math.sqrt(Math.max(proj, 0.05)),
        };
      });
      const v = Object.fromEntries(stats.map((s) => [s.key, s.proj]));
      const lead = stats[0];
      const reasons = [];
      if (log.length) {
        reasons.push(`Baseline of ${fmt(lead.base, lead.base < 3 ? 2 : 1)} ${lead.label.toLowerCase()} blends this season (${cur.length} game${cur.length === 1 ? '' : 's'}${lead.season != null ? `, ${fmt(lead.season, lead.season < 3 ? 2 : 1)} a game` : ''}), the last 5 (${fmt(lead.last5, lead.last5 < 3 ? 2 : 1)}) and last season (${prev.length || p.prev?.gp || 0} games${lead.prevSeason != null ? `, ${fmt(lead.prevSeason, lead.prevSeason < 3 ? 2 : 1)}` : ''}) with recent games counting most.`);
      } else reasons.push('No game log yet, so this uses season totals only.');
      if (opp) {
        const d = (defRatio - 1) * 100;
        reasons.push(`${opp.short} allow ${fmt(oppRates.def, cfg.soccer ? 2 : 1)} ${cfg.unit} a game lately, ${Math.abs(d) < 1 ? 'right at' : `${fmt(Math.abs(d), 0)}% ${d > 0 ? 'more' : 'fewer'} than`} the league average, which moves ${lead.label.toLowerCase()} by ${signed(lead.oppAdj, Math.abs(lead.oppAdj) < 1 ? 2 : 1)}.`);
        reasons.push(vsOpp.length
          ? `In ${vsOpp.length} game${vsOpp.length > 1 ? 's' : ''} against ${opp.short} since ${data.seasonLabels[data.seasons[1]]}: ${fmt(lead.vsOpp, lead.vsOpp < 3 ? 2 : 1)} ${lead.label.toLowerCase()} a game (${signed(lead.h2hAdj, Math.abs(lead.h2hAdj) < 1 ? 2 : 1)} after discounting the small sample).`
          : `No games against ${opp.short} in the log, so there is no head-to-head adjustment.`);
      }
      if (ctx.venue && ctx.venue !== 'neutral' && lead.homeAvg != null && lead.awayAvg != null) {
        reasons.push(`Averages ${fmt(lead.homeAvg, lead.homeAvg < 3 ? 2 : 1)} at home and ${fmt(lead.awayAvg, lead.awayAvg < 3 ? 2 : 1)} away; playing ${ctx.venue === 'home' ? 'at home' : 'on the road'} moves the projection by ${signed(lead.venueAdj, Math.abs(lead.venueAdj) < 1 ? 2 : 1)}.`);
      }
      const extras = [];
      if (data.league === 'nba') extras.push({ label: 'Points + rebounds + assists', value: fmt(v.pts + v.reb + v.ast) });
      if (data.league === 'nfl') {
        if (p.pos === 'QB') extras.push({ label: '2+ passing TDs', value: pct(1 - pois(0, v.passTD) - pois(1, v.passTD)) });
        const td = (v.rushTD || 0) + (v.recTD || 0);
        extras.push({ label: 'Scores a touchdown', value: pct(1 - Math.exp(-td)) });
      }
      if (data.league === 'epl') {
        extras.push({ label: 'Scores', value: pct(1 - Math.exp(-v.goals)) }, { label: 'Assists', value: pct(1 - Math.exp(-v.assists)) });
        if (opp && (p.pos === 'G' || p.pos === 'D')) {
          const isHome = ctx.venue !== 'away';
          const g = predict(isHome ? p.teamId : opp.id, isHome ? opp.id : p.teamId, { neutral: ctx.venue === 'neutral' });
          extras.push({ label: 'Team clean sheet', value: pct(pois(0, isHome ? g.awayScore : g.homeScore)) });
        }
      }
      return { player: p, opp, venue: ctx.venue || 'neutral', stats, impact: impact(v), reasons, extras, games: log.length, vsOpp };
    };

    // Compare two players category by category.
    model.compare = function (a, b, ctxA, ctxB) {
      const pa = model.project(a, ctxA), pb = model.project(b, ctxB);
      const rows = [];
      for (const sa of pa.stats) {
        const sb = pb.stats.find((s) => s.key === sa.key);
        if (!sb) continue;
        const z = (sa.proj - sb.proj) / Math.sqrt(sa.sd ** 2 + sb.sd ** 2 || 1);
        const pA = phi(z);
        rows.push({ key: sa.key, label: sa.label, low: !!sa.low, a: sa, b: sb, pA, edge: sa.low ? (pA < 0.5 ? 'a' : 'b') : (pA >= 0.5 ? 'a' : 'b') });
      }
      const winsA = rows.filter((r) => r.edge === 'a').length;
      return { a: pa, b: pb, rows, winsA, winsB: rows.length - winsA, pick: pa.impact >= pb.impact ? 'a' : 'b' };
    };

    model.nextGame = function (teamId) {
      const g = data.upcoming.find((x) => x[2] === teamId || x[3] === teamId);
      if (!g) return null;
      const isHome = g[2] === teamId;
      return { date: g[1], oppId: isHome ? g[3] : g[2], venue: g[4] ? 'neutral' : isHome ? 'home' : 'away' };
    };

    return model;
  }

  const api = { buildModel, LEAGUE, util: { fmt, signed, pct, mean } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SportModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
