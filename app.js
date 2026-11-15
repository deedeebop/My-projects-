// Sport Stat UI. Renders from the data files and the prediction engine in model.js.
(function () {
  'use strict';
  const DATA = globalThis.SPORTSTAT_DATA || {};
  const { buildModel, util } = globalThis.SportModel;
  const { fmt, signed, pct } = util;
  const LEAGUES = ['nba', 'nfl', 'epl'].filter((k) => DATA[k]);
  const app = document.getElementById('app');

  const models = {};
  const M = () => (models[state.league] ||= buildModel(DATA[state.league]));
  const D = () => DATA[state.league];

  const state = { league: LEAGUES[0], view: 'games', id: null, lab: {}, filters: {}, ctx: null, shown: 60 };
  const charts = new Map();

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sf = (x) => (x == null || Number.isNaN(x) ? '–' : fmt(x, state.league === 'epl' || (state.league === 'nfl' && Math.abs(x) < 10) ? 2 : 1));
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (hex) => { const [r, g, b] = rgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const dist = (a, b) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  const chip = (t, big) => `<span class="chip${big ? ' big' : ''}" style="--c:#${t.color};--t:${lum(t.color) > 0.6 ? '#111' : '#fff'}">${esc(t.abbr)}</span>`;
  // Two colours for a face-off; fall back to the away side's second colour when the two clash.
  const pairColors = (h, a) => [`#${h.color}`, `#${dist(h.color, a.color) < 110 ? a.alt : a.color}`];
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(+d) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const teamBtn = (t) => (t.former ? `${chip(t)} ${esc(t.short)}` : `<button class="link" data-go="team-${t.id}">${chip(t)} ${esc(t.short)}</button>`);
  const playerBtn = (p) => `<button class="link" data-go="player-${p.id}">${esc(p.name)}</button>`;
  const formChips = (list) => `<span class="form" aria-label="Recent results, oldest first: ${list.join(' ')}">${list.map((r) => `<i class="${r}">${r}</i>`).join('')}</span>`;
  const poss = (s) => (/s$/i.test(s) ? `${s}'` : `${s}'s`);
  const venueWord = () => ({ nba: 'court', nfl: 'field', epl: 'pitch' }[state.league]);
  const opts = (items, sel) => items.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const teamOpts = (sel, skip) => opts(D().teams.filter((t) => t.id !== skip).sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.id, t.name]), sel);

  // ---------- routing ----------
  function parseHash() {
    const [lg, view, id] = location.hash.replace('#', '').split('-');
    if (LEAGUES.includes(lg)) state.league = lg;
    state.view = ['games', 'teams', 'team', 'players', 'player', 'lab'].includes(view) ? view : 'games';
    state.id = id || null;
  }
  function go(target) {
    const next = `#${state.league}-${target}`;
    if (location.hash === next) render(); else location.hash = next;
    window.scrollTo(0, 0);
  }

  // ---------- prediction block (shared by Games, Teams and the Lab) ----------
  function probBar(p) {
    const [hc, ac] = pairColors(p.home, p.away);
    const draw = p.pDraw > 0.001;
    return `<div class="prob" role="img" aria-label="${esc(p.home.short)} ${pct(p.pHome)}${draw ? `, draw ${pct(p.pDraw)}` : ''}, ${esc(p.away.short)} ${pct(p.pAway)}">
      <i style="flex:${p.pHome};background:${hc}"></i>${draw ? `<i class="dr" style="flex:${p.pDraw}"></i>` : ''}<i style="flex:${p.pAway};background:${ac}"></i></div>
      <div class="problabels"><span>${esc(p.home.abbr)} ${pct(p.pHome)}</span>${draw ? `<span>Draw ${pct(p.pDraw)}</span>` : ''}<span>${pct(p.pAway)} ${esc(p.away.abbr)}</span></div>`;
  }

  function predictionHTML(p, meta = {}) {
    const m = M(), soccer = m.cfg.soccer, u = m.cfg.unit;
    const [hc, ac] = pairColors(p.home, p.away);
    const scale = Math.max(...p.factors.map((f) => Math.abs(f.value)), 0.01);
    const fav = p.margin >= 0 ? p.home : p.away;
    const score = soccer ? `${fmt(p.homeScore)} – ${fmt(p.awayScore)}` : `${Math.round(p.homeScore)} – ${Math.round(p.awayScore)}`;
    const verdict = soccer
      ? (p.pHome >= p.pAway ? `${p.home.short} favoured, ${pct(p.pHome)} to win` : `${p.away.short} favoured, ${pct(p.pAway)} to win`) + ` · draw ${pct(p.pDraw)}`
      : `${fav.short} by ${fmt(Math.abs(p.margin))} · ${pct(Math.max(p.pHome, p.pAway))} to win`;
    const factors = p.factors.map((f) => {
      const w = Math.abs(f.value) / scale * 50;
      const toHome = f.value >= 0;
      const who = Math.abs(f.value) < (soccer ? 0.005 : 0.05) ? 'Even' : `${toHome ? p.home.abbr : p.away.abbr} ${signed(Math.abs(f.value), soccer ? 2 : 1)}`;
      return `<div class="factor"><span class="lab">${esc(f.label)}</span>
        <div class="dv"><i style="${toHome ? `right:50%` : `left:50%`};width:${w}%;background:${toHome ? hc : ac}"></i></div>
        <span class="val">${esc(who)}</span><p>${esc(f.detail)}</p></div>`;
    }).join('');
    const meets = p.h2h.meets.slice().reverse().map((g) => {
      const res = g.pf > g.pa ? 'W' : g.pf < g.pa ? 'L' : 'D';
      return `<tr><td class="l">${day(g.d)}</td><td class="l">${esc(g.neutral ? 'Neutral' : g.home ? `at ${p.home.abbr}` : `at ${p.away.abbr}`)}</td><td class="hi">${esc(p.home.abbr)} ${g.pf} – ${g.pa} ${esc(p.away.abbr)}</td><td>${formChips([res])}</td></tr>`;
    }).join('');
    return `
      <div class="face">
        <div class="t"><span class="tag">${p.neutral ? 'Neutral site' : 'Home'}</span>${chip(p.home, true)}<span class="name">${teamBtnPlain(p.home)}</span></div>
        <div class="mid"><div class="big num">${score}</div><div class="tag">Projected ${soccer ? 'goals' : 'score'}</div></div>
        <div class="t r"><span class="tag">${p.neutral ? 'Neutral site' : 'Away'}</span>${chip(p.away, true)}<span class="name">${teamBtnPlain(p.away)}</span></div>
      </div>
      ${meta.line ? `<p class="muted small">${esc(meta.line)}</p>` : ''}
      <div>${probBar(p)}</div>
      <p class="verdict">${esc(verdict)}</p>
      <h3>Predictions by category</h3>
      <div class="cats">${p.categories.map((c) => `<div class="cat"><span>${esc(c.label)}</span><b>${esc(c.value)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div>`).join('')}</div>
      <h3>Why</h3>
      <p class="muted small">Each bar pushes the projected margin toward one team, in ${u === 'pts' ? 'points' : 'goals'}. Left is ${esc(p.home.abbr)}, right is ${esc(p.away.abbr)}. They add up to ${esc(fav.abbr)} by ${fmt(Math.abs(p.margin), soccer ? 2 : 1)}.</p>
      <div class="why">${factors}</div>
      ${meets ? `<h3>Recent meetings</h3><div class="scroll"><table><thead><tr><th class="l">Date</th><th class="l">Where</th><th>Score</th><th>${esc(p.home.abbr)}</th></tr></thead><tbody>${meets}</tbody></table></div>` : ''}`;
  }
  const teamBtnPlain = (t) => `<button class="link" data-go="team-${t.id}">${esc(t.name)}</button>`;

  function trackRecord() {
    const b = M().backtest, soccer = M().cfg.soccer;
    return `<details class="how"><summary>How good are these predictions?</summary>
      <p>Tested on ${b.n.toLocaleString()} real ${esc(D().name)} games since ${esc(b.from)}, each predicted using only results from before it was played: the model picked the right ${soccer ? 'result (win, draw or loss)' : 'winner'} ${fmt(b.acc * 100)}% of the time. Always picking the home team would have been right ${fmt(b.homeAcc * 100)}% of the time. Its margin was off by ${fmt(b.mae, soccer ? 2 : 1)} ${M().cfg.unit === 'pts' ? 'points' : 'goals'} on average.</p>
      <p>It uses results only. It does not know about injuries, trades, rest days or suspensions, so treat it as a starting point, not a certainty.</p></details>`;
  }

  // ---------- views ----------
  function viewGames() {
    const games = M().upcoming(18);
    if (!games.length) return `<div class="panel"><p>No upcoming games in the data. Refresh the data to pull the latest schedule.</p></div>`;
    const cards = games.map(({ date, pred: p }) => {
      const soccer = M().cfg.soccer;
      const fav = p.pHome >= p.pAway ? p.home : p.away;
      return `<button class="game" data-lab-teams="${p.home.id},${p.away.id},${p.neutral ? 1 : 0}">
        <span class="muted small">${esc(when(date))}</span>
        <span class="teams"><span class="side">${chip(p.home)} ${esc(p.home.short)}</span><span class="score num">${soccer ? `${fmt(p.homeScore)} – ${fmt(p.awayScore)}` : `${Math.round(p.homeScore)} – ${Math.round(p.awayScore)}`}</span><span class="side">${esc(p.away.short)} ${chip(p.away)}</span></span>
        ${probBar(p)}
        <span class="small"><b>Pick: ${esc(fav.short)}</b> <span class="muted">· tap for the full breakdown</span></span></button>`;
    }).join('');
    return `<div class="stack"><div class="row"><h2>Upcoming games</h2><span class="muted">Home team on the left</span></div><div class="cards">${cards}</div><div class="panel">${trackRecord()}</div></div>`;
  }

  function viewTeams() {
    const m = M(), soccer = m.cfg.soccer;
    const rows = m.ranked.map((id) => {
      const t = m.team(id), n = t.next[0];
      return `<tr class="click" data-go="team-${id}"><td>${t.rank}</td><td class="l">${chip(t.info)} <b>${esc(t.info.short)}</b></td><td class="hi">${t.recStr(t.record)}</td><td>${Math.round(t.elo)}</td>
        <td>${t.recStr(t.homeRec)}</td><td>${t.recStr(t.awayRec)}</td><td>${fmt(t.ppg, soccer ? 2 : 1)}</td><td>${fmt(t.papg, soccer ? 2 : 1)}</td><td>${signed(t.homeEdge, soccer ? 2 : 1)}</td>
        <td class="l">${formChips(t.formList)}</td><td class="l">${n ? `${n.isHome ? 'vs' : 'at'} ${esc(n.opp.abbr)} · ${pct(n.pWin)}` : '–'}</td></tr>`;
    }).join('');
    return `<div class="stack"><div class="row"><h2>${esc(D().name)} power rankings</h2><span class="muted">${esc(D().seasonLabels[m.current])} season · tap a team for predictions</span></div>
      <div class="panel"><div class="scroll"><table><thead><tr><th>#</th><th class="l">Team</th><th>${soccer ? 'W-D-L' : 'W-L'}</th><th>Rating</th><th>Home</th><th>Away</th><th>${soccer ? 'Goals' : 'Pts'} for</th><th>Against</th><th>Home edge</th><th class="l">Form</th><th class="l">Next · win chance</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">Rating: 1500 is an average team. Home edge: extra ${m.cfg.unit === 'pts' ? 'points' : 'goals'} this team is worth on its own ${venueWord()}.</p></div></div>`;
  }

  function viewTeam() {
    const m = M(), soccer = m.cfg.soccer, d = soccer ? 2 : 1;
    if (!m.info.get(state.id) || m.info.get(state.id).former) return viewTeams();
    const t = m.team(state.id), i = t.info, u = m.cfg.unit === 'pts' ? 'points' : 'goals';
    charts.set('rating', ratingSpec(t));
    const next = t.next[0];
    const sched = t.next.map((n) => `<tr class="click" data-lab-teams="${n.pred.home.id},${n.pred.away.id},${n.neutral ? 1 : 0}"><td class="l">${esc(when(n.date))}</td><td class="l">${n.neutral ? 'vs' : n.isHome ? 'vs' : 'at'} ${chip(n.opp)} ${esc(n.opp.short)}</td><td class="hi">${pct(n.pWin)}</td>${soccer ? `<td>${pct(n.pDraw)}</td>` : ''}<td>${soccer ? `${fmt(n.isHome ? n.pred.homeScore : n.pred.awayScore)} – ${fmt(n.isHome ? n.pred.awayScore : n.pred.homeScore)}` : `${Math.round(n.isHome ? n.pred.homeScore : n.pred.awayScore)} – ${Math.round(n.isHome ? n.pred.awayScore : n.pred.homeScore)}`}</td></tr>`).join('');
    const last = t.last.map((g) => `<tr><td class="l">${day(g.d)}</td><td class="l">${g.home ? 'vs' : 'at'} ${teamBtn(g.oppInfo)}</td><td class="hi">${g.pf} – ${g.pa}</td><td>${formChips([g.pf > g.pa ? 'W' : g.pf < g.pa ? 'L' : 'D'])}</td><td>${signed(g.resid, d)}</td></tr>`).join('');
    const roster = allProjections().filter((r) => r.p.teamId === i.id).slice(0, 8);
    const lead = roster.map((r) => `<tr class="click" data-go="player-${r.p.id}"><td class="l"><b>${esc(r.p.name)}</b> <span class="muted">${esc(r.p.pos)}</span></td>${r.proj.stats.slice(0, 3).map((s) => `<td>${sf(s.proj)} <span class="muted small">${esc(s.label)}</span></td>`).join('')}</tr>`).join('');
    return `<div class="stack">
      <button class="back" data-go="teams">← All teams</button>
      <div class="panel">
        <div class="row">${chip(i, true)}<div><h2>${esc(i.name)}</h2><span class="muted">${esc(D().seasonLabels[m.current])} · ${esc(i.venue || '')}</span></div></div>
        <div class="tiles">
          <div class="tile"><span>Record</span><b>${t.recStr(t.record)}</b><small>${soccer ? 'W-D-L' : 'W-L'}</small></div>
          <div class="tile"><span>Power rank</span><b>#${t.rank}</b><small>Rating ${Math.round(t.elo)} of ${D().teams.length} teams</small></div>
          <div class="tile"><span>${soccer ? 'Goals' : 'Points'} per game</span><b>${fmt(t.ppg, d)}</b><small>Allows ${fmt(t.papg, d)}</small></div>
          <div class="tile"><span>At home</span><b>${t.recStr(t.homeRec)}</b><small>Away ${t.recStr(t.awayRec)}</small></div>
          <div class="tile"><span>Last ${t.formList.length}</span><b>${t.recStr(t.form)}</b><small>${formChips(t.formList)}</small></div>
        </div>
      </div>
      <div class="grid2">
        <div class="panel"><h3>Home ${venueWord()} advantage</h3>
          <div class="tiles"><div class="tile"><span>Worth at home</span><b>${signed(t.homeEdge, d)}</b><small>${u} per game</small></div>
          <div class="tile"><span>Margin at home</span><b>${signed(t.split.homeMargin, d)}</b><small>Away ${signed(t.split.awayMargin, d)}</small></div></div>
          <p class="small muted">The typical ${esc(D().name)} home team gains ${fmt(m.hfa, d)} ${u}. ${esc(poss(i.short))} own home/away gap adds ${signed(t.split.extra, d)} after discounting, because splits over ${t.split.n} games each way are mostly noise. Every prediction for a game ${i.venue ? `at ${esc(i.venue)}` : 'at home'} includes this.</p></div>
        <div class="panel"><h3>Rating over time</h3><div class="chart" data-chart="rating"></div><p class="small muted">Rating before each game since ${esc(D().seasonLabels[D().seasons[0]])}. 1500 is league average.</p></div>
      </div>
      ${next ? `<div class="panel"><div class="row"><h2>Next game</h2><button class="btn" data-lab-teams="${next.pred.home.id},${next.pred.away.id},${next.neutral ? 1 : 0}">Change the matchup</button></div>${predictionHTML(next.pred, { line: `${when(next.date)}${next.venue ? ` · ${next.venue}` : ''}` })}</div>` : ''}
      <div class="grid2">
        ${sched ? `<div class="panel"><h3>Coming up</h3><div class="scroll"><table><thead><tr><th class="l">When</th><th class="l">Opponent</th><th>Win</th>${soccer ? '<th>Draw</th>' : ''}<th>Projected</th></tr></thead><tbody>${sched}</tbody></table></div></div>` : ''}
        <div class="panel"><h3>Recent results</h3><div class="scroll"><table><thead><tr><th class="l">Date</th><th class="l">Opponent</th><th>Score</th><th></th><th>vs expected</th></tr></thead><tbody>${last}</tbody></table></div></div>
      </div>
      ${lead ? `<div class="panel"><h3>Players · projected next game</h3><div class="scroll"><table><tbody>${lead}</tbody></table></div></div>` : ''}
    </div>`;
  }

  function ratingSpec(t) {
    const labels = D().seasonLabels;
    const pts = t.history.map((h) => ({ y: h.elo, tip: `${h.d === 'now' ? 'Now' : day(h.d)}: ${Math.round(h.elo)}`, group: labels[h.season] }));
    return { pts, refs: [{ y: 1500, label: 'League average' }], color: `#${t.info.color}`, yfmt: (v) => Math.round(v) };
  }

  // Every player projected for their next game, cached per league.
  const projCache = {};
  function allProjections() {
    return (projCache[state.league] ||= D().players.map((p) => {
      const ng = M().nextGame(p.teamId);
      return { p, ng, proj: M().project(p, ng || {}) };
    }).sort((a, b) => b.proj.impact - a.proj.impact));
  }

  const TABLE_COLS = {
    nba: [['gp', 'GP'], ['min', 'MIN'], ['pts', 'PTS'], ['reb', 'REB'], ['ast', 'AST'], ['tpm', '3PM'], ['stl', 'STL'], ['blk', 'BLK']],
    nfl: [['gp', 'GP'], ['passYds', 'Pass yds'], ['passTD', 'Pass TD'], ['int', 'INT'], ['rushYds', 'Rush yds'], ['rushTD', 'Rush TD'], ['rec', 'Rec'], ['recYds', 'Rec yds'], ['recTD', 'Rec TD']],
    epl: [['gp', 'Apps'], ['goals', 'Goals'], ['assists', 'Assists'], ['shots', 'Shots'], ['sog', 'On target'], ['yc', 'Yellow']],
  };

  function viewPlayers() {
    const m = M(), f = (state.filters[state.league] ||= { q: '', team: '', pos: '', sort: 'impact' });
    const cols = TABLE_COLS[state.league];
    let rows = allProjections().filter((r) => (!f.team || r.p.teamId === f.team) && (!f.pos || r.p.pos === f.pos) && (!f.q || r.p.name.toLowerCase().includes(f.q.toLowerCase())));
    if (f.sort !== 'impact') rows = rows.slice().sort((a, b) => (b.p.cur[f.sort] || 0) - (a.p.cur[f.sort] || 0));
    const total = rows.length;
    rows = rows.slice(0, state.shown);
    const positions = [...new Set(D().players.map((p) => p.pos))].sort();
    const body = rows.map((r) => {
      const t = m.info.get(r.p.teamId), o = r.proj.opp, s = r.proj.stats[0];
      return `<tr class="click" data-go="player-${r.p.id}"><td class="l"><b>${esc(r.p.name)}</b></td><td class="l">${chip(t)}</td><td class="l">${esc(r.p.pos)}</td>
        ${cols.map(([k]) => `<td>${r.p.cur[k] ?? '–'}</td>`).join('')}
        <td class="l">${o ? `${r.ng.venue === 'home' ? 'vs' : 'at'} ${esc(o.abbr)}` : '–'}</td><td class="hi">${sf(s.proj)} <span class="muted small">${esc(s.label)}</span></td><td class="hi">${fmt(r.proj.impact, state.league === 'epl' ? 2 : 1)}</td></tr>`;
    }).join('');
    return `<div class="stack"><div class="row"><h2>${esc(D().name)} players</h2><span class="muted">${esc(D().seasonLabels[m.current])} ${state.league === 'nba' ? 'per-game averages' : 'season totals'} · tap a player for predictions</span></div>
      <div class="panel">
        <div class="controls">
          <div class="field"><label for="pq">Search</label><input type="search" id="pq" placeholder="Player name" value="${esc(f.q)}"></div>
          <div class="field"><label for="pteam">Team</label><select id="pteam"><option value="">All teams</option>${teamOpts(f.team)}</select></div>
          <div class="field"><label for="ppos">Position</label><select id="ppos"><option value="">All</option>${opts(positions.map((x) => [x, x]), f.pos)}</select></div>
          <div class="field"><label for="psort">Sort by</label><select id="psort">${opts([['impact', `Projected ${m.impactLabel.toLowerCase()}`], ...cols], f.sort)}</select></div>
        </div>
        <div class="scroll"><table><thead><tr><th class="l">Player</th><th class="l">Team</th><th class="l">Pos</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}<th class="l">Next</th><th>Projection</th><th>${esc(m.impactLabel)}</th></tr></thead><tbody>${body || `<tr><td class="l" colspan="${cols.length + 6}">No players match.</td></tr>`}</tbody></table></div>
        ${total > rows.length ? `<button class="btn" data-more="1">Show more (${total - rows.length} hidden)</button>` : ''}
        ${state.league === 'nfl' ? '<p class="muted small">Quarterbacks, running backs, receivers and tight ends. Defensive players and kickers are not included yet.</p>' : ''}
      </div></div>`;
  }

  function viewPlayer() {
    const m = M(), p = D().players.find((x) => x.id === state.id);
    if (!p) return viewPlayers();
    const team = m.info.get(p.teamId), ng = m.nextGame(p.teamId);
    if (!state.ctx || state.ctx.pid !== p.id) state.ctx = { pid: p.id, oppId: ng?.oppId || '', venue: ng?.venue || 'neutral' };
    const ctx = state.ctx, pr = m.project(p, ctx);
    const isNext = ng && ctx.oppId === ng.oppId && ctx.venue === ng.venue;
    const lead = pr.stats[0], K = D().logKeys;
    const col = K.indexOf(lead.key) + 3;
    const recent = p.log.slice(-20);
    if (recent.length > 1) {
      charts.set('plog', {
        pts: recent.map((r) => ({ y: r[col], tip: `${day(r[0])} ${r[2] ? 'vs' : 'at'} ${m.info.get(r[1])?.abbr || ''}: ${r[col]}` })),
        refs: [{ y: lead.proj, label: `Projection ${sf(lead.proj)}` }], color: `#${team.color}`, dots: true, zero: true, yfmt: (v) => (Math.abs(v) < 10 && v % 1 ? fmt(v) : Math.round(v)),
      });
    }
    const statRows = pr.stats.map((s) => `<tr><td class="l"><b>${esc(s.label)}</b></td><td class="hi">${sf(s.proj)}</td><td>${sf(s.season)}</td><td>${sf(s.last5)}</td><td>${sf(s.prevSeason)}</td><td>${sf(s.homeAvg)}</td><td>${sf(s.awayAvg)}</td><td>${pr.opp ? sf(s.vsOpp) : '–'}</td></tr>`).join('');
    const adjRows = pr.stats.map((s) => `<tr><td class="l"><b>${esc(s.label)}</b></td><td>${sf(s.base)}</td><td>${signed(s.oppAdj, 2)}</td><td>${signed(s.venueAdj, 2)}</td><td>${signed(s.h2hAdj, 2)}</td><td class="hi">${sf(s.proj)}</td></tr>`).join('');
    const logRows = p.log.slice(-8).reverse().map((r) => `<tr><td class="l">${day(r[0])}</td><td class="l">${r[2] ? 'vs' : 'at'} ${esc(m.info.get(r[1])?.abbr || '?')}</td>${pr.stats.map((s) => `<td>${r[K.indexOf(s.key) + 3]}</td>`).join('')}</tr>`).join('');
    return `<div class="stack">
      <button class="back" data-go="players">← All players</button>
      <div class="panel">
        <div class="row">${chip(team, true)}<div><h2>${esc(p.name)}</h2><span class="muted">${esc(p.pos)} · ${teamBtn(team)}${p.age ? ` · age ${p.age}` : ''} · ${p.cur.gp || 0} games this season</span></div>
          <button class="btn" data-lab-player="${p.id}" style="margin-left:auto">Compare with another player</button></div>
        <div class="controls">
          <div class="field"><label for="copp">Opponent</label><select id="copp"><option value="">No specific opponent</option>${teamOpts(ctx.oppId, p.teamId)}</select></div>
          <div class="field"><label for="cvenue">Where</label><select id="cvenue">${opts([['home', `Home (${team.abbr})`], ['away', 'Away'], ['neutral', 'Neutral']], ctx.venue)}</select></div>
          ${ng && !isNext ? `<button class="btn" data-reset-ctx="1">Back to next game</button>` : ''}
        </div>
        <p class="verdict">${isNext ? 'Next game' : 'Your matchup'}: ${pr.opp ? `${ctx.venue === 'away' ? 'at' : 'vs'} ${esc(pr.opp.name)}` : 'an average opponent'}${isNext ? ` · ${esc(when(ng.date))}` : ''}</p>
        <div class="tiles">
          ${pr.stats.slice(0, 4).map((s) => `<div class="tile"><span>${esc(s.label)}</span><b>${sf(s.proj)}</b><small>Season ${sf(s.season)}</small></div>`).join('')}
          <div class="tile"><span>${esc(m.impactLabel)}</span><b>${fmt(pr.impact, state.league === 'epl' ? 2 : 1)}</b><small>Projected</small></div>
          ${pr.extras.map((e) => `<div class="tile"><span>${esc(e.label)}</span><b>${esc(e.value)}</b><small>${e.value.includes('%') ? 'Chance' : 'Projected'}</small></div>`).join('')}
        </div>
        <h3>Why</h3><ul class="reasons">${pr.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>
      <div class="panel"><h3>Prediction for each category</h3>
        <div class="scroll"><table><thead><tr><th class="l">Category</th><th>Baseline</th><th>Opponent</th><th>Home/away</th><th>History vs opp</th><th>Projection</th></tr></thead><tbody>${adjRows}</tbody></table></div>
        <p class="muted small">Baseline blends this season, the last 5 games and last season. The next three columns are what this matchup adds or takes away.</p></div>
      <div class="panel"><h3>Historical averages per game</h3>
        <div class="scroll"><table><thead><tr><th class="l">Category</th><th>Projection</th><th>This season</th><th>Last 5</th><th>Last season</th><th>Home</th><th>Away</th><th>${pr.opp ? `vs ${esc(pr.opp.abbr)}` : 'vs opp'}</th></tr></thead><tbody>${statRows}</tbody></table></div></div>
      ${recent.length > 1 ? `<div class="panel"><h3>${esc(lead.label)}, last ${recent.length} games</h3><div class="chart" data-chart="plog"></div></div>` : ''}
      ${logRows ? `<div class="panel"><h3>Recent games</h3><div class="scroll"><table><thead><tr><th class="l">Date</th><th class="l">Opponent</th>${pr.stats.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${logRows}</tbody></table></div></div>` : ''}
    </div>`;
  }

  // ---------- matchup lab ----------
  function labState() {
    const m = M();
    return (state.lab[state.league] ||= (() => {
      const g = D().upcoming[0], top = allProjections();
      return { mode: 'teams', home: g ? g[2] : D().teams[0].id, away: g ? g[3] : D().teams[1].id, neutral: false, a: top[0].p.id, b: top[1].p.id, venue: 'neutral' };
    })());
  }
  function playerOpts(sel) {
    const m = M();
    return D().teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
      const ps = D().players.filter((p) => p.teamId === t.id).sort((a, b) => a.name.localeCompare(b.name));
      return ps.length ? `<optgroup label="${esc(t.name)}">${opts(ps.map((p) => [p.id, `${p.name} (${p.pos})`]), sel)}</optgroup>` : '';
    }).join('');
  }

  function viewLab() {
    const L = labState(), m = M();
    const head = `<div class="row"><h2>Matchup lab</h2><div class="seg" role="group" aria-label="What to match up"><button data-lab-mode="teams" aria-pressed="${L.mode === 'teams'}">Team vs team</button><button data-lab-mode="players" aria-pressed="${L.mode === 'players'}">Player vs player</button></div></div>
      <p class="muted">Pick any two ${L.mode === 'teams' ? 'teams' : 'players'}, choose where they play, and see the prediction and the history behind it.</p>`;
    if (L.mode === 'teams') {
      const p = m.predict(L.home, L.away, { neutral: L.neutral });
      return `<div class="stack">${head}<div class="panel">
        <div class="controls">
          <div class="field"><label for="lhome">${L.neutral ? 'Team 1' : 'Home team'}</label><select id="lhome">${teamOpts(L.home, L.away)}</select></div>
          <div class="field"><label for="laway">${L.neutral ? 'Team 2' : 'Away team'}</label><select id="laway">${teamOpts(L.away, L.home)}</select></div>
          <div class="field"><label for="lsite">Where</label><select id="lsite">${opts([['home', `${poss(m.info.get(L.home).short)} home ${venueWord()}`], ['neutral', 'Neutral site']], L.neutral ? 'neutral' : 'home')}</select></div>
          <button class="btn" data-lab-act="swap">Swap home and away</button><button class="btn primary" data-lab-act="shuffle">Shuffle</button>
        </div>
        ${predictionHTML(p)}</div><div class="panel">${trackRecord()}</div></div>`;
    }
    const a = D().players.find((x) => x.id === L.a), b = D().players.find((x) => x.id === L.b);
    const same = a.teamId === b.teamId;
    const ctxA = same ? { venue: 'neutral' } : { oppId: b.teamId, venue: L.venue === 'a' ? 'home' : L.venue === 'b' ? 'away' : 'neutral' };
    const ctxB = same ? { venue: 'neutral' } : { oppId: a.teamId, venue: L.venue === 'b' ? 'home' : L.venue === 'a' ? 'away' : 'neutral' };
    const c = m.compare(a, b, ctxA, ctxB);
    const ta = m.info.get(a.teamId), tb = m.info.get(b.teamId);
    const [ca, cb] = pairColors(ta, tb);
    const dI = state.league === 'epl' ? 2 : 1;
    const rows = c.rows.map((r) => {
      const aWins = r.edge === 'a';
      const pHigh = Math.max(r.pA, 1 - r.pA), higher = r.pA >= 0.5 ? a : b;
      return `<span class="n${aWins ? '' : ' lose'}">${sf(r.a.proj)}</span>
        <div class="mid"><span><b>${esc(r.label)}</b><span>${esc(higher.name.split(' ').slice(-1)[0])} higher ${pct(pHigh)}${r.low ? ' (lower is better)' : ''}</span></span>
        <div class="prob"><i style="flex:${r.pA};background:${ca}"></i><i style="flex:${1 - r.pA};background:${cb}"></i></div></div>
        <span class="n r${aWins ? ' lose' : ''}">${sf(r.b.proj)}</span>`;
    }).join('');
    // Games where each faced the other's current team on the same day.
    const K = D().logKeys, meets = [];
    if (!same) for (const ra of a.log) { if (ra[1] !== b.teamId) continue; const rb = b.log.find((x) => x[0] === ra[0] && x[1] === a.teamId); if (rb) meets.push([ra, rb]); }
    const line = (p, r) => m.statDefs(p).slice(0, 3).map((s) => `${r[K.indexOf(s.key) + 3]} ${s.label.toLowerCase()}`).join(', ');
    const meetRows = meets.slice(-6).reverse().map(([ra, rb]) => `<tr><td class="l">${day(ra[0])}</td><td class="l">${esc(line(a, ra))}</td><td class="l">${esc(line(b, rb))}</td></tr>`).join('');
    const winner = c.pick === 'a' ? a : b;
    return `<div class="stack">${head}<div class="panel">
      <div class="controls">
        <div class="field"><label for="lpa">Player 1</label><select id="lpa">${playerOpts(L.a)}</select></div>
        <div class="field"><label for="lpb">Player 2</label><select id="lpb">${playerOpts(L.b)}</select></div>
        <div class="field"><label for="lpv">Where</label><select id="lpv"${same ? ' disabled' : ''}>${opts([['a', `${poss(ta.short)} home`], ['neutral', 'Neutral site'], ['b', `${poss(tb.short)} home`]], L.venue)}</select></div>
        <button class="btn primary" data-lab-act="shuffle">Shuffle</button>
      </div>
      <div class="face">
        <div class="t">${chip(ta, true)}<span class="name">${playerBtn(a)}</span><span class="muted small">${esc(a.pos)} · ${esc(ta.short)}</span></div>
        <div class="mid"><div class="big num">${fmt(c.a.impact, dI)} – ${fmt(c.b.impact, dI)}</div><div class="tag">Projected ${esc(m.impactLabel.toLowerCase())}</div></div>
        <div class="t r">${chip(tb, true)}<span class="name">${playerBtn(b)}</span><span class="muted small">${esc(b.pos)} · ${esc(tb.short)}</span></div>
      </div>
      <p class="verdict">Overall edge: ${esc(winner.name)}${c.rows.length ? ` · shared categories split ${c.winsA}–${c.winsB}` : ''}</p>
      <p class="muted small">${same ? 'They are teammates, so each is projected against an average opponent.' : `Projected as if ${esc(ta.name)} played ${esc(tb.name)} ${L.venue === 'neutral' ? 'at a neutral site' : `at ${esc(poss((L.venue === 'a' ? ta : tb).short))} home`}. Each player is adjusted for the other team's defence.`}</p>
      ${rows ? `<h3>Predictions by category</h3><div class="cmp">${rows}</div><p class="muted small">The bar shows how often each player is expected to post the higher number, based on how much their game logs swing.</p>` : '<p>These two play different roles, so they share no stat categories. The overall projection above is the fair comparison.</p>'}
      <h3>Why</h3>
      <div class="grid2"><div><p><b>${esc(a.name)}</b></p><ul class="reasons">${c.a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>
      <div><p><b>${esc(b.name)}</b></p><ul class="reasons">${c.b.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div></div>
      ${meetRows ? `<h3>When they met</h3><div class="scroll"><table><thead><tr><th class="l">Date</th><th class="l">${esc(a.name)}</th><th class="l">${esc(b.name)}</th></tr></thead><tbody>${meetRows}</tbody></table></div>` : ''}
    </div></div>`;
  }

  // ---------- charts: one line, hover to read a value ----------
  function drawChart(el, spec) {
    const W = Math.max(el.clientWidth, 260), H = 200, mg = { l: 40, r: 14, t: 14, b: 24 };
    const ys = spec.pts.map((p) => p.y).concat(spec.refs.map((r) => r.y), spec.zero ? [0] : []);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo || 1) * 0.08; lo = spec.zero ? 0 : lo - pad; hi += pad;
    const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw);
    const x = (i) => mg.l + (spec.pts.length < 2 ? 0 : i / (spec.pts.length - 1)) * (W - mg.l - mg.r);
    const y = (v) => H - mg.b - (v - lo) / (hi - lo) * (H - mg.t - mg.b);
    let g = '';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${mg.l - 6}" y="${y(v) + 4}" text-anchor="end">${spec.yfmt(v)}</text>`;
    let prev = null;
    spec.pts.forEach((p, i) => { // season dividers
      if (p.group && p.group !== prev) { g += `${i ? `<line x1="${x(i)}" x2="${x(i)}" y1="${mg.t}" y2="${H - mg.b}" stroke="var(--line)" stroke-width="1"/>` : ''}<text x="${x(i) + 4}" y="${H - 6}">${esc(p.group)}</text>`; prev = p.group; }
    });
    for (const r of spec.refs) g += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(r.y)}" y2="${y(r.y)}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="4 4"/><text x="${mg.l + 4}" y="${y(r.y) - 5}" style="fill:var(--ink-2);font-weight:600;paint-order:stroke;stroke:var(--surface);stroke-width:4px">${esc(r.label)}</text>`;
    const path = spec.pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
    g += `<path d="${path}" fill="none" stroke="${spec.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="${path}" fill="none" stroke="var(--ink)" stroke-opacity="0.25" stroke-width="2"/>`;
    if (spec.dots) g += spec.pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="4" fill="${spec.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
    const last = spec.pts.length - 1;
    g += `<circle cx="${x(last)}" cy="${y(spec.pts[last].y)}" r="5" fill="${spec.color}" stroke="var(--surface)" stroke-width="2"/>`;
    g += `<g class="hov" visibility="hidden"><line y1="${mg.t}" y2="${H - mg.b}" stroke="var(--ink-3)" stroke-width="1"/><circle r="5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/></g>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">${g}</svg><div class="tip" hidden></div>`;
    const hov = el.querySelector('.hov'), tip = el.querySelector('.tip');
    const move = (ev) => {
      const box = el.getBoundingClientRect();
      const i = Math.round(Math.max(0, Math.min(1, (ev.clientX - box.left - mg.l) / (W - mg.l - mg.r))) * last);
      const px = x(i), py = y(spec.pts[i].y);
      hov.setAttribute('visibility', 'visible');
      hov.querySelector('line').setAttribute('x1', px); hov.querySelector('line').setAttribute('x2', px);
      hov.querySelector('circle').setAttribute('cx', px); hov.querySelector('circle').setAttribute('cy', py);
      tip.hidden = false; tip.textContent = spec.pts[i].tip;
      tip.style.left = Math.max(60, Math.min(W - 60, px)) + 'px'; tip.style.top = py + 'px';
    };
    el.onpointermove = move; el.onpointerdown = move;
    el.onpointerleave = () => { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  }
  function drawCharts() {
    app.querySelectorAll('[data-chart]').forEach((el) => { const spec = charts.get(el.dataset.chart); if (spec) drawChart(el, spec); });
  }

  // ---------- shell ----------
  function render() {
    if (!LEAGUES.length) { app.innerHTML = '<div class="panel"><p>No data found. Run <code>npm run data</code> to download it.</p></div>'; return; }
    charts.clear();
    const tab = { team: 'teams', player: 'players' }[state.view] || state.view;
    const views = { games: viewGames, teams: viewTeams, team: viewTeam, players: viewPlayers, player: viewPlayer, lab: viewLab };
    const focusId = document.activeElement?.id, caret = document.activeElement?.selectionStart;
    app.innerHTML = `
      <header class="top"><div class="brand">Sport<span>Stat</span></div>
        <div class="seg" role="group" aria-label="League">${LEAGUES.map((k) => `<button data-league="${k}" aria-pressed="${k === state.league}">${esc(DATA[k].league === 'epl' ? 'Premier League' : DATA[k].name)}</button>`).join('')}</div></header>
      <nav class="tabs" aria-label="Sections">${[['games', 'Games'], ['teams', 'Teams'], ['players', 'Players'], ['lab', 'Matchup lab']].map(([k, l]) => `<button data-go="${k}"${k === tab ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</nav>
      <main>${views[state.view]()}</main>
      <footer>Real results and player stats from ${esc(D().source)}, covering ${esc(D().seasonLabels[D().seasons[0]])} to ${esc(D().seasonLabels[M().current])}. Last updated ${esc(day(D().fetchedAt))}. Predictions are estimates from past results, for information only.</footer>`;
    drawCharts();
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch { /* not a text field */ } } }
  }

  app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-go],[data-league],[data-lab-teams],[data-lab-player],[data-lab-mode],[data-lab-act],[data-more],[data-reset-ctx]');
    if (!el) return;
    const d = el.dataset;
    if (d.go) { state.shown = 60; return go(d.go); }
    if (d.league) { state.league = d.league; state.shown = 60; const keep = ['team', 'player'].includes(state.view) ? state.view + 's' : state.view; return go(keep); }
    const L = labState();
    if (d.labTeams) { const [h, a, n] = d.labTeams.split(','); Object.assign(L, { mode: 'teams', home: h, away: a, neutral: n === '1' }); return go('lab'); }
    if (d.labPlayer) { L.mode = 'players'; L.a = d.labPlayer; if (L.b === L.a) L.b = allProjections().find((r) => r.p.id !== L.a).p.id; return go('lab'); }
    if (d.labMode) { L.mode = d.labMode; return render(); }
    if (d.labAct === 'swap') { [L.home, L.away] = [L.away, L.home]; return render(); }
    if (d.labAct === 'shuffle') {
      const pick = (arr, not) => { let x; do x = arr[Math.floor(Math.random() * arr.length)]; while (x === not); return x; };
      if (L.mode === 'teams') { const ids = D().teams.map((t) => t.id); L.home = pick(ids); L.away = pick(ids, L.home); }
      else { const ids = allProjections().slice(0, 120).map((r) => r.p.id); L.a = pick(ids); L.b = pick(ids, L.a); }
      return render();
    }
    if (d.more) { state.shown += 100; return render(); }
    if (d.resetCtx) { state.ctx = null; return render(); }
  });

  function onInput(ev) {
    const id = ev.target.id, v = ev.target.value;
    const f = state.filters[state.league], L = state.lab[state.league];
    if (id === 'pq') f.q = v; else if (id === 'pteam') f.team = v; else if (id === 'ppos') f.pos = v; else if (id === 'psort') f.sort = v;
    else if (id === 'copp') state.ctx.oppId = v; else if (id === 'cvenue') state.ctx.venue = v;
    else if (id === 'lhome') L.home = v; else if (id === 'laway') L.away = v; else if (id === 'lsite') L.neutral = v === 'neutral';
    else if (id === 'lpa') L.a = v; else if (id === 'lpb') L.b = v; else if (id === 'lpv') L.venue = v;
    else return;
    if (id.startsWith('p')) state.shown = 60;
    render();
  }
  app.addEventListener('change', (ev) => { if (ev.target.id !== 'pq') onInput(ev); });
  app.addEventListener('input', (ev) => { if (ev.target.id === 'pq') onInput(ev); });
  window.addEventListener('hashchange', () => { parseHash(); render(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawCharts, 150); });

  parseHash();
  render();
})();
