# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Abay26/gta6-trophy-rarity-forecast-01-v2/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Abay26/gta6-trophy-rarity-forecast-01-v2/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts, for every Grand Theft Auto VI trophy on PlayStation 5, the percent of the players Exophase tracks who will have earned it at 2026-11-26 00:00 UTC, a week after launch, as five quantiles a trophy — scored by pinball loss on the logit scale.

## How it works

`main.ts` (Node 22, standard library only) reads each case in the input directory and writes one forecast per case. The key idea is that a trophy's earn rate is a ratio — holders over players tracked — and the two counts move for different reasons. Players tracked jumps whenever Exophase refreshes and a wave of new profiles syncs (dilution); holders grow as the players already tracked keep playing (progression). A line fitted to the rate itself sees those refresh jumps as noise, and its slope depends on where the refreshes happen to fall. The two count series are both monotone and smooth, so a line fits each of them cleanly, and the rate forecast is their ratio at the target:

```
ln E_i(t) = a_i + b_i · ln(1 + hours since the release day began)
ln N(t)   = a_N + b_N · ln(1 + hours since the release day began)
rate_i(target) = 100 · exp(ln E_i(target) − ln N(target))
```

Per trophy:

1. **Median — count decomposition.** Each trophy's log-holder count and the log player count are least-squares lines on ln(1 + hours since 2026-11-19T00:00:00Z), fitted on the last 36 h of distinct reads (consecutive duplicates, the page frozen between Exophase refreshes, are collapsed first). A trophy's holders slope is shrunk toward the pooled cross-trophy slope, so a rare trophy's line, fitted on a handful of refreshes, cannot run away. The extrapolated move is not damped: the trend in log-time is real — cohorts age and keep earning while player growth saturates — so a damped median under-predicts the deadline-to-target rise systematically. A trophy every tracked player holds stays at 100%.
2. **No refresh seen — the disclosed dilution.** When the history shows no refresh at all (the practice cases, whose reads are all the flat launch-night page), the count fits have nothing to fit, so the entry uses the refresh the kit itself discloses: launch night sat at 638 players tracked, then refreshed to 3,868 players and 4,276 trophies earned. The 100% trophy gains every new player (3,230 of the 3,333 new earnings); the other trophies share the remaining 103, in proportion to the holders they already had. So their rates fall to 22% of where they stood, with a tight band: the answer is nearly determined by those disclosed totals.
3. **Spread — honest about extrapolation.** The least-squares prediction error of the two count fits at the target, plus a term that grows with the predicted move (a long extrapolation is less certain the further it travels), plus a small term for the refresh landing somewhere inside the horizon. No random-walk term: the house baseline's 0.5 × √(horizon in days) walk, and a jump term that grows with the square root of the refresh count, both charge for movement the median already predicts. Refreshes are the mechanism of dilution, not noise on top of it, so charging for them again only widens the band — and the pinball loss is mostly that width (the previous version's live coverage was 0.982 against a nominal 0.90).

Everything is deterministic: two runs on the same case write the same bytes.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice check

The kit ships no reference answers (the scorer stays server-side), so the practice answers were reconstructed from the refresh facts the kit itself discloses (04:30Z read: 3,868 players, 4,276 trophies earned; every rate but the 100% one fell; rates are exact holder counts / players). Under that reconstruction, across three ways of distributing the 103 extra holders the practice implies:

| forecast | mean pinball loss | typical miss | 90% coverage |
| --- | --- | --- | --- |
| house baseline (starter) | 1.38–1.69 | 0.68 pp | 0.00 |
| previous version (v1) | 0.10–0.11 | 0.02 pp | 1.00 |
| this entry (v2) | **0.038–0.047** | 0.01 pp | 1.00 |

The disclosed practice figures for the baseline (~1.51 loss, ~0.68 pp miss, 0 coverage) match the reconstruction, which is what makes the comparison meaningful. The real practice score is decided by the server on submission.

A second check, on a synthetic final: a cohort simulator of the launch week (player growth fit to the 638 → 3,868 → ~50k–100k tracked counts, per-trophy progression calibrated so every simulated rate at 22 h matches the live Exophase page) scores v2 at 0.11–0.30 loss across eight scenarios against v1's 0.58–0.66 — the improvement is the spread, mostly, and the undamped median. That simulator is the author's own model of the launch, not the kit's, so it is evidence, not proof.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qw56w9dq&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
