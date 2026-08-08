# invisible-string

A small webapp over [cassandra](https://github.com/NathanDeMaria/cassandra) model
results: current ratings per league, and win probability / predicted spread for a
hypothetical matchup.

```
infra/      terraform: ECR, Fargate service + ALB, Batch refresh job, IAM
backend/    FastAPI, depends on cassandra as a git dependency
frontend/   React + Redux Toolkit (RTK Query), built into backend's static dir
```

---

## 1. What cassandra gives us today

Worth being precise about this, because most of the design follows from the gaps.

**Ratings** live inside a predictor instance as a plain dict, with a shape that
varies by class:

| Predictor | rating shape | extra state |
|---|---|---|
| `EloPredictor` | `dict[str, float]` | `home_advantage`, `k` |
| `Elo538Predictor` | `dict[str, float]` | `home_advantage`, `k`, prior manager |
| `GlickoPredictor` | `dict[str, (rating, rd)]` | `home_advantage`, `k`, RD inflation params, `scoring_method`, prior manager |
| `FlatPredictor` | — (returns 0.5) | — |

`save_state(path)` writes that to local JSON; `load_state(path)` reads it back.
`evaluate_models.py` is the only thing that calls `save_state`, and it writes to
`~/.cassandra/models/<league>/<name>_result_state.json` — **on the machine that ran
the job**. Nothing about ratings currently reaches S3.

**Predictions** are `predict_game(game: Game) -> Prediction(team1_win_prob)`. It
takes a whole `endgame.types.Game`, not two team names — deliberately, per the
comment in `base_predictor.py`. For a hypothetical matchup we have to synthesize a
`Game`, which is fine (Elo/Elo538/Glicko only read `home`, `away`, `neutral_site`
in `predict_game`) but shouldn't be re-invented by every caller.

**Spreads are not part of the predictor.** `evaluate_model` fits an
`IsotonicRegression` from win prob → market spread, uses it to compute
against-the-spread accuracy, and then **throws it away**. There is no persisted
prob→spread mapping anywhere. This is the single biggest gap for the matchup
feature.

**Everything is expensive.** `read_all_seasons` pulls 16 years of season pickles;
`OddsDatabase.from_s3` lists and reads *every* odds key in the bucket. This is
minutes of work and hundreds of MB. It must never happen inside a request.

**Sign conventions** (adopt these verbatim so nothing flips):
- `team1` == home. `team1_win_prob` is the home team's win probability.
- `spread` is the market handicap applied to home: `team1_covered = spread + (home_score - away_score) > 0`. So **negative spread = home favored**, and a
  predicted spread of `-6.5` renders as "Duke -6.5".

---

## 2. The core decision: a `ModelRelease` artifact in S3

The webapp never runs the model. A batch job produces a self-contained,
versioned JSON artifact; the API reads it, caches it, and serves everything from
it. This is the contract between cassandra and the webapp, and it's the only one.

```mermaid
flowchart LR
  subgraph batch["AWS Batch (existing pattern)"]
    EG["endgame daily games job<br/>8am CT"] --> S3G[("s3://bucket/seasons/…")]
    OPT["cassandra optimize<br/>(manual / rare)"] --> REL
    REF["refresh job<br/>9am CT + on demand"] --> REL
    S3G --> REF
  end
  REL[("s3://bucket/models/{league}/{model}/<br/>runs/{run_id}.json + latest.json")]
  REL --> API["FastAPI on Fargate<br/>(cached, 60s TTL + ETag)"]
  API --> UI["React SPA<br/>(served by the same container)"]
  API -->|"SubmitJob"| REF
```

Why an artifact rather than the API loading predictor state directly: it lets the
API stay ignorant of predictor internals, it makes "which model is live" an
explicit, revertible pointer, and it gives the refresh job an idempotency
watermark to work against.

### Schema

Defined as pydantic in cassandra (`cassandra/serving/release.py`), imported by the
backend — one definition, no drift.

```jsonc
{
  "schema_version": 1,
  "run_id": "2026-08-08T09:00:12Z",          // also the S3 object name
  "league": "mens",
  "model": "glicko_tuned",                    // config stem from optimize.py
  "predictor_class": "GlickoPredictor",

  // exactly what save_state() writes, minus ratings — enough to rebuild the
  // predictor for predict_game()
  "params": { "home_advantage": 95.0, "k": 65.0, "initial_rd": 216.0,
              "scoring_method": "binary", "weekly_rd_increase": 1.0,
              "season_rd_increase": 120.0 },

  "ratings": {
    "Duke": { "rating": 1834.2, "rd": 71.4, "wins": 24, "losses": 5 },
    "…":    { "rating": 1500.0, "rd": 216.0, "wins": 0, "losses": 0 }
  },

  // isotonic fit serialized as knots; np.interp at serve time, no sklearn,
  // no pickle-version fragility
  "spread_calibration": {
    "kind": "isotonic",
    "x_thresholds": [0.02, 0.05, ...],   // ascending win probs
    "y_thresholds": [21.5, 18.0, ...]    // descending spreads (increasing=False)
  },

  "metrics": { "brier_score": 0.1782, "against_spread_accuracy": 0.514,
               "n_games": 98342, "n_spread_games": 21150 },

  "trained_through": {
    "season_year": 2026,
    "last_game_date": "2026-08-07T23:15:00Z",
    "processed_game_ids": ["401710...", "..."]  // current season only
  },

  "created_at": "2026-08-08T09:00:12Z",
  "created_by": "refresh|optimize|post",
  "parent_run_id": "2026-08-07T09:00:08Z"      // null for a full retrain
}
```

Layout: `models/{league}/{model}/runs/{run_id}.json` plus
`models/{league}/{model}/latest.json` (a copy, not a pointer — one GET to serve).
Keeping every run means rollback is `aws s3 cp runs/<old>.json latest.json`.

`ratings` includes W-L because the refresh job already has the season in memory and
the API otherwise would have to read season pickles just to fill a table column.

---

## 3. Backend (`backend/`)

FastAPI, depends on cassandra as a git dep the same way cassandra depends on
endgame. Python 3.14 (cassandra pins `^3.14`).

```
backend/
  app/
    main.py            # app factory, static mount + SPA fallback
    api/
      ratings.py
      predict.py
      admin.py
    releases.py        # S3 fetch + in-process cache
    settings.py        # pydantic-settings: bucket, batch queue/def, admin token
  Dockerfile           # multi-stage: node build → python runtime
  pyproject.toml
```

### Endpoints

```
GET  /api/leagues
       -> [{league, models: [{name, is_default, run_id, created_at, metrics}]}]

GET  /api/leagues/{league}/ratings?model=&limit=&offset=
       -> {run_id, created_at, trained_through, metrics,
           ratings: [{rank, team, rating, rd?, wins, losses, delta_7d?}]}

GET  /api/predict?league=&model=&home=&away=&neutral=false&home_advantage=
       -> {home, away, neutral, home_win_prob, away_win_prob,
           predicted_spread, home_rating, away_rating, run_id, model}

POST /api/admin/releases            (auth)  # push a run from a laptop
POST /api/admin/refresh             (auth)  -> {job_id}
GET  /api/admin/refresh/{job_id}    (auth)  -> {status, ...}

GET  /healthz   /readyz
```

`predict` is a **GET** on purpose: a matchup is a shareable, cacheable, linkable
thing, and RTK Query caches it for free. `home_advantage` is an optional override
for what-ifs — it's a constructor kwarg on every predictor, so it costs nothing to
support.

### How `predict` works

1. Fetch the cached `ModelRelease`.
2. `release.to_predictor()` — rebuilds e.g. `GlickoPredictor(league, **params, ratings=...)`.
3. `predictor.predict_game(synthetic_game(home, away, neutral))`, where the synthetic
   `Game` is `home_score=0, away_score=0, completed=False, date=now, game_id="synthetic"`.
   That helper belongs in cassandra, not here.
4. `predicted_spread = float(np.interp(p, x_thresholds, y_thresholds))`.
   (`np.interp` needs ascending `xp`, which `X_thresholds_` is; a decreasing `fp` is
   fine.) Clamp `p` into `[x[0], x[-1]]` so extreme mismatches don't extrapolate.

Rebuilding the predictor per request is microseconds — it's a dict assignment. Cache
the constructed predictor per `run_id` anyway.

### Caching

In-process, keyed by `(league, model)`, 60s TTL, refreshed with a conditional GET on
`latest.json`'s ETag. That makes multiple Fargate tasks converge within a minute of
any write without needing shared state, a cache-bust endpoint, or sticky routing.
Ratings change at most once a day.

### Auth

Single bearer token from Secrets Manager, checked by a FastAPI dependency on
`/api/admin/*`. Everything else is public read. If you'd rather not have a public
write path at all, drop `POST /api/admin/releases` — the jobs already write to S3
directly with their own role (see §5).

---

## 4. Frontend (`frontend/`)

Vite + React + TypeScript + Redux Toolkit. **All server data through RTK Query** —
the whole app is a server cache with two filters on top; hand-rolled thunks would be
pure overhead. Plain slices only for UI state.

```
frontend/src/
  app/store.ts
  services/api.ts          # RTK Query: getLeagues, getRatings, getPrediction
  features/ratings/        # RatingsTable, league picker, search
  features/matchup/        # team comboboxes, neutral toggle, ResultCard
  ui/                      # shared bits
```

Two routes:

- **`/ratings/:league`** — sortable table (rank, team, rating, RD, W-L, 7-day
  change). TanStack Table for sort/filter. ~360 D1 teams per league, so virtualize
  the rows but don't paginate — a scannable single list is the point.
- **`/matchup`** — two team comboboxes fed from the ratings response already in the
  RTK Query cache (no extra endpoint), a neutral-site toggle, and a result card:
  win probability for each side plus the spread rendered in familiar form
  ("Duke -6.5"). Mirror the form state into the query string so a matchup is a
  shareable link.

Header carries model + `trained_through` date, so it's always obvious how fresh the
numbers are.

Build output goes into the backend image and is served by FastAPI `StaticFiles` with
an SPA fallback — one container, one deploy, no CORS, no CloudFront. Worth splitting
later only if the frontend starts needing its own release cadence.

---

## 5. Update paths

Three ways a new release appears, all producing the same artifact.

### a. Nightly refresh (the "live update" feature)

EventBridge Scheduler → Batch, 9am CT, after endgame's 8am games job.

1. Read `latest.json` for each `(league, model)`.
2. Rehydrate the predictor from `ratings` + `params`.
3. Read **only the current season** from S3 (`seasons/{year}/{gender}.pkl`) — not all 16.
4. Take completed games whose `game_id` is not in `processed_game_ids`, walk them in
   `iter_weeks` / `games_in_order` order, calling `update_game`, with `pass_week()` at
   week boundaries.
5. Recompute W-L, write a new run, flip `latest.json`.

**This is exact, not an approximation.** Elo, Elo538 and Glicko updates are a pure
fold over the game sequence, and Glicko's RD inflation is per-week/per-season — so
incrementally applying today's games to yesterday's state gives bit-for-bit what a
full replay would, *provided* the games go in the same order and week boundaries are
honored. Two things to be careful about:

- **Never call `postrun_callback()` in this job.** It calls
  `OpponentPriorManager.save`, which raises if the priors file already exists, and
  those priors are a full-history artifact that a daily job has no business rewriting.
  `update_game` also calls `_prior_manager.add_game`, but that's in-memory counting
  only — harmless.
- **`processed_game_ids`, not a timestamp watermark.** Games get re-fetched and
  scores corrected; endgame's own `calendar_weeks` de-dupes by `game_id` for exactly
  this reason. An id set makes the job idempotent and safe to re-run.

Guardrail: a weekly full replay that diffs against the incremental ratings and alerts
on divergence beyond a threshold. Cheap, and it catches an ordering bug before it
compounds over a season.

### b. Admin-triggered refresh

`POST /api/admin/refresh` calls `batch:SubmitJob` on the same job definition and
returns the job id; `GET /api/admin/refresh/{job_id}` polls `DescribeJobs`. The API
stays small, no long work in the web task, and it reuses infra that already exists.

### c. Posting a new model run

After `optimize.py` / `evaluate_models.py`, you have a fresh model. **Preferred: the
job writes the release to S3 itself** — it already holds S3 credentials via the Batch
job role, and then there is exactly one write path and no "which source wins"
question. `POST /api/admin/releases` is a thin authenticated wrapper doing the same
write, for pushing a run from a laptop that isn't running in Batch. Both validate
against the same pydantic model. A posted run always starts a fresh lineage
(`parent_run_id: null`), and the next nightly refresh continues from it.

---

## 6. Infra (`infra/`)

Follows the endgame `jobs/` conventions: `us-east-2`, S3 backend in the
`nathan-terraform` bucket (key `invisible-string/terraform.tfstate`), a `Makefile`
with `plan`/`apply`, `scheduled_job`-style module for the Batch piece.

- ECR repo for the app image.
- ECS cluster + Fargate service, 1 task at 0.25 vCPU / 0.5 GB (the release JSON is a
  few MB at most).
- ALB + ACM cert + Route53 record.
- Task role: `s3:GetObject`/`ListBucket` on `models/*` in the endgame bucket,
  `s3:PutObject` on the same prefix (only if keeping the POST endpoint),
  `batch:SubmitJob` + `batch:DescribeJobs`, `secretsmanager:GetSecretValue` for the
  admin token.
- Batch job definition + EventBridge Scheduler rule for the refresh job, reusing the
  existing job queue.
- Reuse endgame's SNS failure topic pattern for refresh-job alerts.

**Cost note:** the ALB is ~$16/mo and will dominate — the Fargate task itself is a
couple of dollars. If that's annoying for a personal app, the same container runs on
App Runner with no ALB, or the FastAPI app runs on Lambda behind a function URL via
Mangum. Fargate + ALB is the right call if you want it to look like the rest of your
infra; it just isn't the cheapest shape.

---

## 7. Changes needed in cassandra

The webapp shouldn't reimplement any model math, which means a handful of small
additions upstream. Roughly in dependency order:

1. **Persist the prob→spread calibration.** `BaseProbToSpreadPredictor` gets
   `to_dict()` / `from_dict()`; `IsotonicProbToSpreadPredictor` serializes
   `X_thresholds_` / `y_thresholds_`. `evaluate_model` currently fits and discards
   the calibrator — return it instead. **Blocking for the matchup feature.**
2. **`cassandra/serving/`**: the `ModelRelease` pydantic model, `to_predictor()`,
   S3 read/write helpers, and a `predict_matchup(predictor, home, away, neutral_site)`
   that builds the synthetic `Game` in one place.
3. **State as a dict, not a path.** `save_state`/`load_state` are file-based; add
   `state_dict()` / `from_state_dict()` and let the file versions delegate. Avoids
   round-tripping through a temp file in a request handler.
4. **Make `postrun_callback` re-runnable.** `OpponentPriorManager.save` raising when
   priors exist means any second run with `post_callbacks=True` crashes. Either
   overwrite behind an explicit flag, or version the priors file.
5. **`read_all_seasons` hard-codes `range(2010, 2026)`** — it silently stops picking
   up seasons in 2026. Its own TODO. The refresh job reads the current season
   directly and doesn't hit this, but the optimizer does.
6. **`league` shouldn't be `NcaabbGender`.** `optimize.py` does
   `NcaabbGender[config.league]`, which locks everything to mens/womens even though
   endgame also has nfl and ncaafb. The API treats league as an opaque string; a
   small registry upstream would let the webapp pick up football for free.
7. **Bug, unrelated but noticed:** `_serialize_predictions` writes a 7-column header
   for a 9-field dataclass and does `",".join(asdict(result).values())` on a dict of
   ints/floats/bools, which raises `TypeError`. `main.py` is the only caller.
8. **`FlatPredictor` has no ratings** — the ratings table should only offer models
   that expose them. Worth a capability flag rather than a hardcoded class list.

---

## 8. Phasing

| Phase | Scope |
|---|---|
| 1 | cassandra: calibration persistence + `serving/` + state dicts. One release JSON in S3, written by hand from a local `evaluate_models.py` run. |
| 2 | `backend/`: ratings + predict endpoints reading that JSON. Run locally. |
| 3 | `frontend/`: ratings table + matchup page. Still local. |
| 4 | `infra/`: ECR, Fargate, ALB, DNS. Ship it. |
| 5 | Refresh job + scheduler + admin endpoints. This is where the "live update" lands. |
| 6 | Nice-to-haves: 7-day rating deltas, weekly full-replay guardrail, upcoming games with predictions attached. |

Phases 2–4 need nothing from phase 5, so the app is useful — just manually refreshed
— from phase 4 on.

---

## 9. Open questions

1. **Which model is "the" model per league?** The ratings table needs a default.
   Simplest is a `default_model` field in the release index (or just "highest
   against-spread accuracy"), but it should be an explicit choice you control, not
   inferred.
2. **Same bucket as endgame, or a separate one?** Sharing means one IAM policy and
   no cross-account anything; separating keeps model outputs from raw data. I'd share
   it under a `models/` prefix unless you want a different lifecycle policy.
3. **How much history do you want?** `delta_7d` in the ratings table needs
   yesterday's-ish release to diff against. Keeping every run makes that free, but
   if you want a rating *chart* per team, that wants a different storage shape
   (timeseries per team, not a snapshot per run) — worth deciding before phase 5
   rather than after.
4. **Public or private?** Everything above assumes public reads and an
   authenticated admin path. If the whole app should be private, an ALB listener
   rule on source IP is less work than real auth.
