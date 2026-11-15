const test = require('node:test');
const assert = require('node:assert/strict');
const { buildModel } = require('../model.js');
for (const k of ['nba', 'nfl', 'epl']) require(`../data/${k}.js`);

for (const k of ['nba', 'nfl', 'epl']) {
  const data = globalThis.SPORTSTAT_DATA[k];
  const m = buildModel(data);
  const [a, b] = [data.teams[0].id, data.teams[1].id];

  test(`${k}: outcome probabilities sum to 1`, () => {
    const p = m.predict(a, b);
    assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - 1) < 1e-9);
  });

  test(`${k}: factors add up to the margin and scores match it`, () => {
    const p = m.predict(a, b);
    assert.ok(Math.abs(p.factors.reduce((s, f) => s + f.value, 0) - p.margin) < 1e-9);
    if (!m.cfg.soccer) assert.ok(Math.abs(p.homeScore - p.awayScore - p.margin) < 1e-9);
  });

  test(`${k}: playing at home helps, and a neutral site removes it`, () => {
    const home = m.predict(a, b), away = m.predict(b, a), neutral = m.predict(a, b, { neutral: true });
    assert.ok(home.pHome > away.pAway, 'team A should be likelier to win at home than away');
    assert.ok(!neutral.factors.some((f) => f.key === 'home'));
    assert.ok(neutral.pHome < home.pHome);
  });

  test(`${k}: back-test beats always picking the home team`, () => {
    assert.ok(m.backtest.n > 300);
    assert.ok(m.backtest.acc > m.backtest.homeAcc + 0.03, `${m.backtest.acc} vs ${m.backtest.homeAcc}`);
  });

  test(`${k}: back-test predictions never see the game they predict`, () => {
    const g = data.games[data.games.length - 1];
    const v = m.view(g[3], g[1]);
    assert.ok(v.games.every((x) => x.d < g[1]));
  });

  test(`${k}: every player projects to finite, non-negative numbers`, () => {
    for (const p of data.players) {
      const pr = m.project(p, m.nextGame(p.teamId) || {});
      for (const s of pr.stats) assert.ok(Number.isFinite(s.proj) && s.proj >= 0, `${p.name} ${s.key}`);
      assert.ok(Number.isFinite(pr.impact));
    }
  });

  test(`${k}: a tougher defence lowers a scorer's projection`, () => {
    const lead = (x) => m.project(x, {}).stats[0].proj;
    const p = data.players.filter((x) => x.log.length > 10).sort((x, y) => lead(y) - lead(x))[0];
    const others = data.teams.filter((t) => t.id !== p.teamId).map((t) => ({ id: t.id, proj: m.project(p, { oppId: t.id, venue: 'neutral' }).stats[0] }));
    const adj = others.map((o) => o.proj.oppAdj);
    assert.ok(Math.max(...adj) > 0 && Math.min(...adj) < 0);
  });

  test(`${k}: comparing a player with themself is a coin flip`, () => {
    const p = data.players.find((x) => x.log.length > 10);
    const c = m.compare(p, p, {}, {});
    for (const r of c.rows) assert.ok(Math.abs(r.pA - 0.5) < 1e-6);
  });
}
