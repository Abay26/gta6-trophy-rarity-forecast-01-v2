// gta6-trophy-rarity-forecast-01 v2: a trophy-rarity forecaster (Node 22, standard
// library only). For every trophy it forecasts the earn rate on Exophase at the
// case's target as five quantiles, from the case's history of reads of the game's
// trophy page.
//
// The model counts holders and players separately, instead of fitting one line
// to the rate. A trophy's earn rate is holders / players-tracked, and the two
// counts move for different reasons: players-tracked jumps whenever Exophase
// refreshes and a wave of new profiles syncs (dilution), while holders grow as
// the players already tracked keep playing (progression). A line fitted to the
// rate itself sees those refresh jumps as noise and its slope depends on where
// the refreshes happen to fall; the two count series are both monotone and
// smooth, so a line fits each of them cleanly, and the rate forecast is their
// ratio at the target:
//
//   ln E_i(t) = a_i + b_i * ln(1 + hours since the release day began)
//   ln N(t)   = a_N + b_N * ln(1 + hours since the release day began)
//   rate_i(target) = 100 * exp(ln E_i(target) - ln N(target))
//
// Per trophy, the holders slope is shrunk toward the pooled cross-trophy slope
// (a rare trophy's own line, fitted on a handful of refreshes, must not run
// away). The extrapolated move is not damped: the trend in log-time is real --
// cohorts age and keep earning while player growth saturates -- so a damped
// median under-predicts the deadline-to-target rise systematically. The spread
// is the honest prediction error of the two count fits at the target, plus a
// term that grows with the predicted move (a long extrapolation is less
// certain the further it travels), plus a small term for the refresh landing
// somewhere inside the horizon -- no random-walk term. The house baseline's
// 0.5 * sqrt(days) walk, and a jump term that grows with the square root of
// the refresh count, both charge for movement the median already predicts:
// refreshes are the mechanism of dilution, not noise on top of it, so
// charging for them again only widens the band. (v1's live coverage was 0.982
// against a nominal 0.90: its band was far too wide, and the pinball loss is
// mostly that width.)
//
// When the history shows no refresh at all -- the practice cases, whose reads
// are all the flat launch-night page -- the count fits have nothing to fit, so
// the entry uses the refresh the kit itself discloses: launch night sat at 638
// players tracked, then refreshed to 3,868 players and 4,276 trophies earned.
// The 100% trophy gains every new player (3,230 of the 3,333 new earnings);
// the other trophies share the remaining 103, in proportion to the holders
// they already had. So their rates fall to 22% of where they stood, and the
// band stays tight: the answer is nearly determined by those disclosed totals.
//
// A trophy every tracked player holds stays at 100%. Everything is
// deterministic: two runs on the same case write the same bytes.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The release day began at 2026-11-19T00:00:00Z; the trend's clock runs from there. */
const RELEASE_MS = Date.parse('2026-11-19T00:00:00Z');
/** The count trends are fitted on the last 36 h of distinct reads: the launch
    night's explosive growth does not describe the deadline's, and 36 h still
    holds several refreshes to fit on. Fewer than 3 distinct reads in the
    window falls back to all of them. */
const FIT_WINDOW_HOURS = 36;
/** How strongly a trophy's holders slope is shrunk toward the pooled slope
    (pseudo-points). */
const SHRINK_K = 3;
/** The extrapolated move is NOT damped. Damping was tried: halving the move
    costs about half the true deadline-to-target rise (the trend in log-time
    is real -- cohorts age and keep earning while player growth saturates --
    so a damped median under-predicts it systematically). The log-time trend
    is the model's whole point; it is trusted as fitted. */
/** Floor and cap on a trophy's total spread, in logit units. */
const SIGMA_FLOOR = 0.15;
const SIGMA_CAP = 0.8;
/** Spread for the refresh landing somewhere inside the horizon, in logit units. */
const SIGMA_REFRESH = 0.1;
/** How much of the predicted logit move counts as spread: a trophy the model
    moves a long way is one the model is less sure of, because the move is an
    extrapolation and the trend's shape can change on the way there. */
const MOVE_FRAC = 0.20;
/** The launch-night refresh the kit discloses: 638 -> 3,868 players tracked,
    943 -> 4,276 trophies earned, the 100% trophy taking 3,230 of the 3,333
    new earnings and the rest sharing 103. */
const PRIOR_N_OLD = 638;
const PRIOR_N_NEW = 3868;
const PRIOR_HOLDERS_OLD = 943;
const PRIOR_HOLDERS_NEW = 4276;
/** Spread for the no-refresh branch: the disclosed totals nearly determine the
    answer; what is left is how the 103 extra earnings distribute. */
const PRIOR_SIGMA = 0.15;

interface Case {
  id: string;
  at: string;
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Array<{ id: number }>;
  history: Array<{ at: string; players_tracked: number; rates: Array<number | null> }>;
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clamp(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface State {
  /** Hours from the release day's start to the read. */
  t: number;
  /** Epoch ms of the read, for the fit window. */
  atMs: number;
  /** Holder counts, one per trophy, null where the read lacked the trophy. */
  holders: Array<number | null>;
  /** Players tracked by the read. */
  players: number;
}

/** Collapse consecutive duplicate reads (same players and rates) to one state each. */
function distinctStates(c: Case): State[] {
  const out: State[] = [];
  for (const h of c.history) {
    const t = (Date.parse(h.at) - RELEASE_MS) / 3_600_000;
    const holders = h.rates.map((r) =>
      typeof r === 'number' ? Math.max(0.5, (r / 100) * h.players_tracked) : null,
    );
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.players === h.players_tracked &&
      prev.holders.every((v, i) => v === holders[i])
    ) {
      continue;
    }
    out.push({ t, atMs: Date.parse(h.at), holders, players: h.players_tracked });
  }
  return out;
}

interface LineFit {
  /** Slope of the least-squares line. */
  slope: number;
  /** Intercept of the least-squares line. */
  intercept: number;
  /** Mean of the fitted x values. */
  meanX: number;
  /** Mean of the fitted y values. */
  meanY: number;
  /** Sum of squared x deviations. */
  sxx: number;
  /** Residual variance (mean squared residual, denominator n - 2). */
  residVar: number;
  /** Number of points fitted. */
  n: number;
  /** Last y value in the fit (the most recent read). */
  lastY: number;
}

/** Least-squares line of y on x for the given points. */
function fitLine(pts: Array<[number, number]>): LineFit {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) * (x - mx);
    sxy += (x - mx) * (y - my);
  }
  const slope = sxx > 1e-9 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let ss = 0;
  for (const [x, y] of pts) ss += (y - (intercept + slope * x)) ** 2;
  return {
    slope,
    intercept,
    meanX: mx,
    meanY: my,
    sxx,
    residVar: n > 2 ? ss / (n - 2) : 0,
    n,
    lastY: pts[pts.length - 1][1],
  };
}

/** Median of a list of numbers. */
function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const states = distinctStates(c);
  const last = states[states.length - 1];
  if (last === undefined) throw new Error(`${c.id} has no history`);
  const xTarget = Math.log(1 + Math.max(0, (Date.parse(c.target) - RELEASE_MS) / 3_600_000));
  const xLast = Math.log(1 + Math.max(0, last.t));
  const nT = c.trophies.length;

  // No refresh seen yet: the disclosed launch-night refresh is the forecast.
  // Holders of every trophy but the 100% one scale by the share of the 103
  // extra earnings they already hold; players jump to the disclosed 3,868.
  if (states.length === 1) {
    const extraScale =
      (PRIOR_HOLDERS_NEW - PRIOR_N_NEW) / (PRIOR_HOLDERS_OLD - PRIOR_N_OLD);
    return c.trophies.map((t, i) => {
      const r = last.holders[i] === null ? 0 : (last.holders[i] as number) / last.players;
      if (r >= 0.9999) return { id: t.id, q: [100, 100, 100, 100, 100] };
      const centre =
        logit(100 * r) +
        Math.log(extraScale) -
        Math.log(PRIOR_N_NEW / PRIOR_N_OLD);
      const q = Z.map((z) => round4(Math.min(100, Math.max(0, invLogit(centre + z * PRIOR_SIGMA)))));
      for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
      return { id: t.id, q };
    });
  }

  // The count trends are fitted on the last 36 h of distinct reads.
  const atMs = Date.parse(c.at);
  const fitStates = (() => {
    const win = states.filter((s) => (s.atMs - atMs) / 3_600_000 >= -FIT_WINDOW_HOURS);
    return win.length >= 3 ? win : states;
  })();
  const xOf = (s: State): number => Math.log(1 + Math.max(0, s.t));

  // Players-tracked trend: one clean series, fitted on the window.
  const nFit = fitLine(fitStates.map((s) => [xOf(s), Math.log(s.players)] as [number, number]));
  const logNTarget = Math.log(last.players) + nFit.slope * (xTarget - xLast);
  const sigmaNPred =
    Math.sqrt(Math.max(0, nFit.residVar)) *
    Math.sqrt(1 + 1 / nFit.n + (xTarget - nFit.meanX) ** 2 / Math.max(1e-9, nFit.sxx));

  // Per-trophy holders trends, shrunk toward the pooled slope.
  const fits: Array<LineFit | null> = [];
  for (let i = 0; i < nT; i++) {
    const pts: Array<[number, number]> = [];
    for (const s of fitStates) {
      const v = s.holders[i];
      if (v !== null) pts.push([xOf(s), Math.log(v)]);
    }
    fits.push(pts.length >= 2 ? fitLine(pts) : null);
  }
  const pooledSlope = median(fits.filter((f): f is LineFit => f !== null).map((f) => f.slope));
  const pooledResid = Math.sqrt(
    fits.reduce((a, f) => a + (f !== null && f.n > 2 ? f.residVar * (f.n - 2) : 0), 0) /
      Math.max(
        1,
        fits.reduce((a, f) => a + (f !== null && f.n > 2 ? f.n - 2 : 0), 0),
      ),
  );

  return c.trophies.map((t, i) => {
    const lastHolders = last.holders[i];
    const lastRate = lastHolders === null ? 0 : (lastHolders / last.players) * 100;
    // A trophy every tracked player holds stays held.
    if (lastRate >= 99.99) return { id: t.id, q: [100, 100, 100, 100, 100] };
    const f = fits[i];
    const n = f !== null ? f.n : 1;
    // Shrink the slope toward the pooled slope; anchor the line at the last read.
    const slope = f !== null ? (n * f.slope + SHRINK_K * pooledSlope) / (n + SHRINK_K) : pooledSlope;
    const base = lastHolders === null ? Math.log(0.5) : Math.log(lastHolders);
    const logETarget = base + slope * (xTarget - xLast);
    // Prediction error of the holders fit at the target, pooled with the rest.
    const resid = f !== null
      ? Math.sqrt((f.residVar * Math.max(0, f.n - 2) + pooledResid ** 2 * SHRINK_K) / (Math.max(0, f.n - 2) + SHRINK_K))
      : pooledResid;
    const sigmaEPred =
      f !== null && f.sxx > 1e-9
        ? resid * Math.sqrt(1 + 1 / f.n + (xTarget - f.meanX) ** 2 / f.sxx)
        : resid;
    const centre = (() => {
      const p = Math.min(0.9999, Math.max(0.0001, Math.exp(logETarget - logNTarget)));
      return Math.log(p / (1 - p));
    })();
    // The band grows with the predicted move: an extrapolation is less certain
    // the further it travels, and the fit residuals alone (measured on a few
    // smooth points inside the window) say almost nothing about that.
    const move = centre - logit(Math.max(0.01, lastRate));
    const sigma = Math.min(
      SIGMA_CAP,
      Math.max(
        SIGMA_FLOOR,
        Math.sqrt(
          sigmaEPred ** 2 + sigmaNPred ** 2 + SIGMA_REFRESH ** 2 + (MOVE_FRAC * move) ** 2,
        ),
      ),
    );
    const q = Z.map((z) =>
      round4(Math.min(100, Math.max(0, invLogit(centre + z * sigma)))),
    );
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: forecastCase(c) })}\n`);
}
