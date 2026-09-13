"""Every game one team has played, out of `predictions.parquet`.

The third reader of that file, after the games table and the game page. Those
two ask it what the model said about *these days*; this asks what it said
about *this team*, ever -- which is the list a team page wants under its
chart, and the way into the game pages from it.

Out of the predictions artifact rather than out of endgame's season files,
which is what makes it affordable at all. A season pickle is the whole
schedule and costs ~15x its size once its games are rows (`app.seasons`), so
"every game Duke has played since 2011" read that way is sixteen of them.
The predictions file already has one row per game, with the teams, the date,
the final score and the two numbers the model and the market put on it -- so
a team's whole career is a filtered read of one file, and the answer is
richer than the schedule alone: what was forecast, beside what happened.

**Every number is from this team's side.** The file stores a game once, under
whichever team was home, and its `team1_win_prob`, `predicted_margin` and
`spread` are all quoted from the home team's side. A page listing Duke's
season wants Duke's win probability and the points Duke laid, not the home
team's -- so an away row is flipped here rather than in the browser, where
the convention would have to be re-derived by every reader. `home` says which
way it went, so nothing downstream has to guess.

**A team with no rows is an empty list, not a 404.** The same reasoning
`app.api.history` gives: this file cannot tell a team that doesn't exist from
one whose model hasn't published predictions yet, and the caller is holding
the ratings table, which can.
"""

import logging
import math
from datetime import datetime

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from app.artifacts import ArtifactStore, get_artifact_store
from app.releases import (
    ReleaseNotFound,
    ReleaseStore,
    ReleaseUnreadable,
    get_release_store,
    resolve_release,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


class TeamGameRow(BaseModel):
    """One game, as the team this list is about played it.

    `season` and `week` are the model's own partition for the game, which is
    what the game page needs to find it outside the days the schedule source
    keeps in reach (`app.games.find_game`). They are on the wire so a link
    into that page can carry the season rather than making it search.

    `team_score` and `opponent_score` are None together for a game that hasn't
    been played -- a run predicts fixtures as well as results, so the newest
    rows in the file are often games with nothing to report yet.

    `win_prob` is this team's, and `predicted_spread` and `market_spread` are
    quoted from its side in the market's convention: negative means this team
    was favoured. The same convention `/api/games` uses for a row, turned
    around for whichever team the page is about.
    """

    game_id: str
    date: datetime
    season: int
    week: int
    opponent: str
    # Which side of the fixture this team was on. A neutral-site game still
    # has one, because the file and the scores are stored that way; `neutral`
    # is what says the venue didn't mean anything.
    home: bool
    neutral: bool
    team_score: int | None
    opponent_score: int | None
    # None where the run stored no usable forecast for the game: a row written
    # before the model had a margin fit, or one whose numbers didn't survive
    # it. Absent rather than zero, which is a forecast.
    win_prob: float | None
    predicted_spread: float | None
    # The line the run was graded against, where the game had one. Most games
    # in these leagues never get a number from a book.
    market_spread: float | None


class TeamGamesResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    league: str
    model: str
    run_id: str
    team: str
    games: list[TeamGameRow]


def _number(value: object) -> float | None:
    """A parquet float that might be NaN, as something JSON can carry.

    The same conversion `app.api.history` makes for a missing RD and
    `app.api.games` makes for a margin that didn't survive the fit: NaN is not
    valid JSON, browsers reject it, and null is what "the file didn't say"
    looks like on the wire.
    """
    if value is None:
        return None
    number = float(value)  # ty: ignore[invalid-argument-type]
    return None if math.isnan(number) else number


def _score(value: object) -> int | None:
    number = _number(value)
    return None if number is None else int(number)


def _row(record: dict[str, object], team: str) -> TeamGameRow:
    """One stored prediction, turned around to face `team`.

    The three flips are the whole of it, and they are all the same flip: the
    file quotes the home team, so an away row reads the other end of every
    number. A win probability becomes its complement, and the two spreads
    change sign because a spread is already a signed quantity from one side.
    """
    home = str(record["home_team"]) == team
    win_prob = _number(record["team1_win_prob"])
    margin = _number(record["predicted_margin"])
    spread = _number(record["spread"])
    home_score = _score(record["home_score"])
    away_score = _score(record["away_score"])

    return TeamGameRow(
        game_id=str(record["game_id"]),
        date=record["date"],  # ty: ignore[invalid-argument-type]
        season=int(record["year"]),  # ty: ignore[invalid-argument-type]
        week=int(record["week"]),  # ty: ignore[invalid-argument-type]
        opponent=str(record["away_team"] if home else record["home_team"]),
        home=home,
        neutral=bool(record["neutral_site"]),
        team_score=home_score if home else away_score,
        opponent_score=away_score if home else home_score,
        win_prob=(None if win_prob is None else win_prob if home else 1.0 - win_prob),
        # `predicted_margin` is the home team's margin of victory and the wire
        # format is the market's, where a favourite lays points -- so the home
        # side's spread is the negated margin (`app.api.games._spread`) and the
        # away side's is the margin itself.
        predicted_spread=(None if margin is None else -margin if home else margin),
        market_spread=(None if spread is None else spread if home else -spread),
    )


def _rows(predictions: pd.DataFrame, team: str) -> list[TeamGameRow]:
    """A team's stored predictions, newest first.

    Newest first because this is a page about a season in progress: the game a
    reader came to look up is last night's, not the 2011 opener. The opposite
    order from `/api/leagues/{league}/history`, which is drawing a line and has
    to walk it forwards.

    A game with no date can't be placed in that order and is dropped rather
    than sorted to an arbitrary end -- it is a row the writer shouldn't have
    been able to produce, and one missing game is better than a list whose
    order is a lie.
    """
    if predictions.empty:
        return []

    dated = predictions[predictions["date"].notna()]
    ordered = dated.sort_values("date", ascending=False, kind="stable")
    return [_row(record, team) for record in ordered.to_dict("records")]


@router.get("/leagues/{league}/teams/{team}/games")
def get_team_games(
    league: str,
    team: str,
    model: str | None = Query(
        default=None,
        description="Defaults to the league's lowest-Brier model.",
    ),
    store: ReleaseStore = Depends(get_release_store),
    artifacts: ArtifactStore = Depends(get_artifact_store),
) -> TeamGamesResponse:
    """Every game this model has a stored prediction for, for one team.

    The whole career in one response, for the reason the history endpoint
    serves a whole line: it is a few hundred rows, which is smaller than the
    ratings table the page was reached from, and a season picker that went
    back to the network to narrow what it already had would be slower and no
    smaller.

    The model follows the page's selection, like the chart above it. A game
    list showing elo's forecasts under glicko's rank would be two models
    wearing one heading.
    """
    try:
        release = resolve_release(store, league, model)
    except ReleaseNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReleaseUnreadable as exc:
        # The same 502 `/ratings` and `/history` serve: the artifact is there,
        # and it is the upstream data that's wrong.
        log.warning("serving 502 for %s team games: %s", league, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    predictions = artifacts.team_predictions(release.league, release.model, team)
    return TeamGamesResponse(
        league=release.league,
        model=release.model,
        run_id=release.run_id,
        team=team,
        games=_rows(predictions, team),
    )
