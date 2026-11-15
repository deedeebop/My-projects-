# Sport Stat

Stats and explained predictions for the **NBA, NFL and Premier League**, built on real results and player game logs.

- **Games** – every upcoming game with a win chance and projected score.
- **Teams** – power rankings, then a page per team: record, home/away splits, home court or field advantage, rating history, next-game prediction and upcoming schedule.
- **Players** – searchable list, then a page per player: a projection for every stat category, the history behind it, and controls to change the opponent and venue.
- **Matchup lab** – pick any two teams or any two players, choose home, away or neutral, or hit Shuffle.

Every prediction comes with a "Why" section showing which factors moved it and by how much.

## Run it

Open `index.html` in a browser. Nothing to install.

To get one self-contained file you can share or host anywhere:

```
npm run build        # writes dist/sportstat.html
```

## Refresh the data

```
npm run data         # needs Node 22+, downloads the latest from ESPN's public feeds
```

This rewrites `data/nba.js`, `data/nfl.js` and `data/epl.js` with the two previous seasons plus the current one. No API key is needed.

## How the predictions work

Team games (`model.js`):

1. **Overall strength** – an Elo rating updated after every game since 2024, weighted by margin of victory and opponent quality.
2. **Home advantage** – the league-wide home edge measured from the results, plus each team's own home/road split (heavily discounted, because splits are noisy).
3. **Recent form** – how far a team has beaten or missed expectations lately.
4. **Head-to-head** – the last six meetings, discounted for small samples.

Those add up to a projected margin. Scoring rates give the total, and from there the app derives win chance, projected score and the other categories (for soccer: win/draw/loss, likely scorelines, over 2.5 goals, both teams to score, clean sheets).

Player projections blend this season, the last five games and last season, then adjust for the opponent's defence, home or away, and the player's own history against that opponent.

**Accuracy.** The app back-tests itself: each past game is predicted using only what was known before it. At the last data refresh it picked 68% of NBA winners, 63% of NFL winners and 47% of Premier League results (win/draw/loss), against 55%, 52% and 42% for always picking the home team. The live figures are shown in the app under "How good are these predictions?".

**Limits.** The model only sees results. It knows nothing about injuries, trades, rest days or suspensions. NFL players cover quarterbacks, running backs, receivers and tight ends only.

## Tests

```
npm test
```
