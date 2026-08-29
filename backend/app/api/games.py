"""The games around today, each with the best model's number beside it.

DESIGN.md section 13. Three things a reader wants in one row: what's on, what
the model thinks, and what the market thinks -- plus the score once it exists.
The schedule and the line come from `app.games`; the prediction is the same
call `/api/predict` makes, run once per game against the league's default
release.

Two deliberate choices about the prediction.

**One model per league, and it's the default one.** "The best model for this
league" already has a definition here -- `pick_default`, lowest Brier
(section 11.1) -- and a games page that let you pick per league would be a
model comparison wearing a scoreboard's clothes. The response names the model
and run it used, so it's never a mystery which one answered.

**A prediction for a game the model has already trained on says so.** Releases
are rebuilt nightly, so by the time last night's score is on this page, last
night's result is usually already in the ratings that predicted it. That
number is still worth showing -- it's what the model says about the matchup --
but it is not a forecast, and `in_sample` is the flag that keeps the page from
implying it was.

A league whose release is missing, stale, or ratingless still gets its games:
the prediction is None and the row renders without one. Only the *games* half
failing is a 502, because that's the half with nothing to show.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime

import numpy as np
from cassandra.predictor import (
    Predictor,
    RatingsUnsupported,
    UnknownPredictorClass,
    predict_matchup,
)
from cassandra.prob_to_margin import BaseProbToMarginPredictor
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.games import (
    DEFAULT_DAYS_AHEAD,
    DEFAULT_DAYS_BACK,
    MAX_DAYS_AHEAD,
    MAX_DAYS_BACK,
    GamesSource,
    GamesUnavailable,
    ScheduledGame,
    get_games_source,
)
from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    ReleaseUnreadable,
    get_release_store,
    resolve_release,
)
from app.schema import ModelRelease

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


class GamePrediction(BaseModel):
    """What one league's default release says about one game."""

    model_config = ConfigDict(protected_namespaces=())

    model: str
    run_id: str
    home_win_prob: float
    # None when the release carries no margin fit, exactly as in
    # `/api/predict`: better an absent number than a fabricated one.
    predicted_spread: float | None
    # True when the ratings behind this number already include this game's
    # result. Hindsight, not a forecast -- see the module docstring.
    in_sample: bool


class GameRow(BaseModel):
    league: str
    game_id: str
    start: datetime
    # The day the game belongs to, in US Central -- the zone endgame's jobs
    # think in, and the one `since` and `until` are counted in. Sent rather
    # than derived from `start` in the browser so the page groups games on the
    # same boundary the window was cut on, whatever zone the reader is in.
    day: date
    home: str
    away: str
    neutral: bool
    completed: bool
    home_score: int | None
    away_score: int | None
    market_spread: float | None
    # None for a league with no readable release, and for a game whose teams
    # that release has never rated.
    prediction: GamePrediction | None


class GamesResponse(BaseModel):
    days_back: int
    days_ahead: int
    since: date
    until: date
    games: list[GameRow]


_back = Query(
    default=DEFAULT_DAYS_BACK,
    ge=0,
    le=MAX_DAYS_BACK,
    description="Days of finished games to include, counted in US Central time.",
)

_ahead = Query(
    default=DEFAULT_DAYS_AHEAD,
    ge=0,
    le=MAX_DAYS_AHEAD,
    description="Days of upcoming games beyond today. 0 is the rest of today.",
)


@router.get("/games")
def get_games(
    back: int = _back,
    ahead: int = _ahead,
    source: GamesSource = Depends(get_games_source),
    store: ReleaseStore = Depends(get_release_store),
) -> GamesResponse:
    try:
        window = source.window(back, ahead)
    except GamesUnavailable as exc:
        # 502 for the reason an unreadable release is one (see api/ratings):
        # nothing the caller can change, and nothing a retry fixes.
        log.warning("serving 502 for games: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    models = _Models(store)
    return GamesResponse(
        days_back=back,
        days_ahead=ahead,
        since=window.since,
        until=window.until,
        games=[
            GameRow(
                **game.model_dump(),
                day=game.day,
                prediction=models.predict(game),
            )
            for game in window.games
        ],
    )


@dataclass
class _LeagueModel:
    """A league's default release, rebuilt once for the whole window.

    Rebuilding the predictor is a dict assignment, but the margin fit and the
    processed-id set aren't -- and a busy night is several hundred games
    against a handful of leagues.
    """

    release: ModelRelease
    predictor: Predictor
    margin: BaseProbToMarginPredictor | None
    processed: frozenset[str]


class _Models:
    """The per-league releases this request predicts from, resolved lazily.

    A league that can't be predicted from is remembered as None so a window
    full of its games doesn't re-resolve, re-log and re-fail once per row.
    """

    def __init__(self, store: ReleaseStore) -> None:
        self._store = store
        self._by_league: dict[str, _LeagueModel | None] = {}
        # Leagues whose predictor has already thrown, so a window full of
        # their games logs one traceback rather than one per row.
        self._logged: set[str] = set()

    def predict(self, game: ScheduledGame) -> GamePrediction | None:
        model = self._for(game.league)
        if model is None:
            return None

        # The same guard `/api/predict` makes a 404 of: every predictor
        # defaults an unseen team to its base rating, so a team the release
        # has never rated would come back as a confident number computed
        # against a ghost. Here the honest answer is a row without a
        # prediction -- a game the model can't speak to shouldn't take the
        # score beside it off the page.
        if game.home not in model.release.ratings:
            return None
        if game.away not in model.release.ratings:
            return None

        try:
            prob = predict_matchup(
                model.predictor,
                home=game.home,
                away=game.away,
                neutral_site=game.neutral,
                date=game.start,
            ).team1_win_prob

            return GamePrediction(
                model=model.release.model,
                run_id=model.release.run_id,
                home_win_prob=prob,
                predicted_spread=_spread(model.margin, prob),
                in_sample=_in_sample(model, game),
            )
        except Exception:  # noqa: BLE001 - see below
            # A predictor that raises on a matchup its own ratings cover is a
            # bug somewhere upstream, and there is no list of exception types
            # to enumerate: it is cassandra's code, over a release this build
            # didn't write. What matters is that it costs this row its
            # prediction and nothing else -- the rule every other failure on
            # this page already follows, and the one an unguarded call here
            # broke by turning one bad matchup into a 500 for the whole
            # window.
            #
            # Logged once per league, with the traceback, because the count
            # alone is what made the first outage here so slow to place.
            if game.league not in self._logged:
                self._logged.add(game.league)
                log.warning(
                    "predictor failed for %s (%s at %s); dropping predictions "
                    "for this league's games",
                    game.league,
                    game.away,
                    game.home,
                    exc_info=True,
                )
            return None

    def _for(self, league: str) -> _LeagueModel | None:
        if league not in self._by_league:
            self._by_league[league] = self._build(league)
        return self._by_league[league]

    def _build(self, league: str) -> _LeagueModel | None:
        try:
            release = resolve_release(self._store, league, None)
        except (ReleaseNotFound, ReleaseUnreadable) as exc:
            # A league endgame scrapes that nothing has published a model for
            # yet is the normal case here, not an error -- this page lists
            # every league's games, and the releases are a separate pipeline.
            log.info("no prediction for %s: %s", league, exc)
            return None

        try:
            predictor = release.rating_predictor()
        except RatingsUnsupported:
            log.info(
                "no prediction for %s: its default model doesn't rate teams", league
            )
            return None
        except UnknownPredictorClass as exc:
            # A release written by a newer cassandra than this image. Same
            # shape as a stale artifact, and the same degradation: that
            # league's rows lose their prediction, the page keeps its games.
            log.warning("no prediction for %s: %s", league, exc)
            return None
        except Exception:  # noqa: BLE001 - see below
            # Every `from_ratings` ends in `cls(league, **release.params)`,
            # and `params` is whatever the artifact happens to carry -- so a
            # release written against a different constructor signature comes
            # back as a bare TypeError from inside cassandra rather than as
            # one of the three errors above. There is no useful list to
            # enumerate, because the failure is "this build's classes and
            # that bucket's data disagree", which is open-ended by nature.
            #
            # This is what 500'd the whole window on the first deploy: one
            # league's release couldn't be rebuilt, and every other league's
            # games went down with it. The message names the class and the
            # param keys, because that pair is the answer.
            log.warning(
                "no prediction for %s: %s could not be rebuilt from its "
                "release (predictor_class=%s, params=%s)",
                league,
                release.model,
                release.predictor_class,
                sorted(release.params),
                exc_info=True,
            )
            return None

        return _LeagueModel(
            release=release,
            predictor=predictor,
            margin=release.margin_predictor(),
            processed=frozenset(release.trained_through.processed_game_ids),
        )


def _spread(margin: BaseProbToMarginPredictor | None, prob: float) -> float | None:
    """The market-facing number, which is the negation of the model's.

    Identical to `/api/predict`'s: the calibration predicts margin of victory
    for the home team, and the wire format is the market's, where negative
    means home is favoured. Same convention as `market_spread` beside it,
    which is the whole point of putting them in one row.
    """
    if margin is None:
        return None
    return -float(margin.predict_margins(np.array([prob]))[0])


def _in_sample(model: _LeagueModel, game: ScheduledGame) -> bool:
    """Whether the ratings behind the prediction already include this result.

    The id list is the exact answer where it applies -- it's the refresh job's
    idempotency marker, so a game in it has been folded in. It only covers the
    current season, so the watermark date is the fallback, and a release
    carrying neither says "no" rather than guessing.
    """
    if game.game_id in model.processed:
        return True
    watermark = model.release.trained_through.last_game_date
    if watermark is None:
        return False
    return game.start <= _utc(watermark)


def _utc(moment: datetime) -> datetime:
    """A watermark as an instant, so it can be compared to a kickoff.

    Releases are written with an offset, but a naive one would raise on the
    comparison rather than sort wrong, and taking a bare watermark as UTC is
    both the likeliest reading and the conservative one: it puts the boundary
    earlier than a local reading would, so a game near it is called a forecast
    rather than hindsight.
    """
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment
