"""One game's win probability over time.

DESIGN.md section 16. Three things have to meet for this to answer: a game
(from the same window `/api/games` serves), a fit for its league (bundled
inside the-lucky-ones), and that game's play-by-play (endgame's processed
parquet). Any of the three can be missing, and only one of those is an error.

**Its own endpoint, not a field on the game.** The game page's two halves read
two different upstreams -- the season pickle for the schedule, a parquet
object for the plays -- and the rule `app.api.jobs` already follows applies
here: one being slow, or missing, must not blank the other. A game with no
chart still has a score, a line and a model's number on it.

**A game with no curve is a 200.** Most of an NCAAFB week has no play-by-play
at all, a game that hasn't kicked off has none yet, and a week the transform
hasn't run over has none stored. None of those is a failure to report; they
are all "no points", and the page says so in words. What *is* a 502 is the
bucket refusing to be read, exactly as on the games page.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from lucky_ones import GameControl as LuckyOnesGameControl
from pydantic import BaseModel

from app.games import GamesSource, GamesUnavailable, find_game, get_games_source
from app.plays import PlaysSource, PlaysUnavailable, get_plays_source
from app.win_probability import curve_for, fit_for

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


class CurvePoint(BaseModel):
    """One snap of the curve.

    Everything an axis label or a tooltip needs, so the page never goes back
    to the plays: `period` and `clock_seconds` are what a point is *called*
    ("Q3 7:22"), `seconds_remaining` is where it sits on the time axis, and
    the two scores are what makes a step in the line legible.

    `home_win_prob` is named for `GamePrediction.home_win_prob` beside it,
    which is the same quantity asked before the game rather than during it.
    """

    play_id: str
    play_number: int
    period: int
    clock_seconds: int
    # Left in regulation. 0 in overtime, which has no clock the model reads --
    # so overtime snaps stack at the end of the axis rather than running off
    # it.
    seconds_remaining: int
    home_score: int
    away_score: int
    home_win_prob: float
    # The same snap with the game's coin flips split evenly rather than
    # credited to whoever they fell to, carried forward from every bounce
    # before it. Two numbers on one point rather than two series, because they
    # are the same snaps in the same order and lining them up on the page
    # would be work the wire can do once.
    adjusted_win_prob: float


class GameControl(BaseModel):
    """Share of the game each team spent winning it, weighted by the clock.

    Not a win probability: 0.68 doesn't say the home team was ever 68% to
    win, it says that averaged over the minutes, that's where the model had
    them. `seconds` is what the average covers -- regulation only, since
    college overtime has no clock to weight by -- and is on the wire so the
    page can say so rather than implying a full sixty minutes.
    """

    home: float
    away: float
    seconds: int


class LuckySwing(BaseModel):
    """One play whose result was decided by a bounce, priced both ways.

    `realized` and `counterfactual` are the two branches as home win
    probability: what the model made of the snap that followed, and what it
    makes of the snap that would have followed had the ball gone the other
    way. `retained` is how often the outcome that happened happens -- half a
    fumble either way, a fifth of the contested passes -- so `home_delta` is
    the part of the gap between the branches the *bounce* handed out rather
    than the offense earning it.

    `kind` is upstream's `LuckKind` on the wire: `fumble_lost`, `fumble_kept`,
    `pass_defended_interception`, `pass_defended_incomplete`. Sent as its own
    string rather than as prose so the page can name it in the page's own
    words.
    """

    play_id: str
    play_number: int
    kind: str
    retained: float
    realized: float
    counterfactual: float
    # `realized - expected`: win probability the bounce handed the home team,
    # negative when it went the other way.
    home_delta: float


class LuckyBounces(BaseModel):
    """What the bounces were worth to each team over the game.

    The accounting beside `adjusted_control`'s rewrite, and deliberately not a
    share of anything: **`home` and `away` do not sum to 1**. Each is a total
    of win probability in the units the curve is drawn in, so 0.18 reads as
    "the breaks that went their way were worth eighteen points of win
    probability more than those same plays were worth before the ball
    landed". Two totals rather than one signed number because "both teams got
    a big break" and "neither got one" are different games.
    """

    home: float
    away: float
    swings: list[LuckySwing]


class WinProbabilityFit(BaseModel):
    """Which fit drew this, and how much to trust it.

    The counterpart of `GamePrediction`'s `model`/`run_id`: a number on a page
    should say where it came from. `brier_score` and `log_loss` are the
    package's own holdout scores, held out *by game* rather than by snap.
    """

    league: str
    run_id: str
    seasons: list[int]
    n_games: int
    brier_score: float
    log_loss: float


class WinProbabilityResponse(BaseModel):
    league: str
    game_id: str
    home: str
    away: str
    # ESPN's numeric ids, which is what the plays carry -- and which side is
    # home is *inferred* from the scoring drives, since nothing in the data
    # ties a team id to the home score. Sent so the page can show its work.
    # None on an empty curve.
    home_team_id: str | None
    away_team_id: str | None
    fit: WinProbabilityFit
    # None when there was no elapsed regulation clock to average over, which
    # is any game with no curve and a game whose only snaps were in overtime.
    control: GameControl | None
    # The same share of the game with the fumbles and the contested passes
    # split evenly -- what the game looks like without the breaks. None
    # wherever `control` is None, and equal to it on a game where nothing
    # bounced.
    adjusted_control: GameControl | None
    # How big the breaks were, which is the other thing to say about them.
    # None on a game with no snaps to account for, where a pair of zeroes
    # would read as "nothing bounced" rather than "there was no game here".
    luck: LuckyBounces | None
    # Whether this game's feed records the passes a defender got to, which is
    # the gate on the interception half of the adjustment. False means the
    # fumbles were split and the interceptions were left alone -- a smaller
    # adjustment rather than a fabricated one -- and the page says so.
    records_defended_passes: bool
    # Empty for a game with no play-by-play, which is normal rather than
    # exceptional -- see the module docstring.
    points: list[CurvePoint]
    # Whether the fit was trained on games from this game's season. Weaker
    # than `GamePrediction.in_sample`, and deliberately not called that: the
    # fit's own record is a list of seasons, not of game ids, so this says
    # "the model has seen this season" rather than "the model has seen this
    # game". A season it was fit on still holds the games it held out.
    trained_on_this_season: bool


@router.get("/games/{league}/{game_id}/win-probability")
def get_win_probability(
    league: str,
    game_id: str,
    source: GamesSource = Depends(get_games_source),
    plays_source: PlaysSource = Depends(get_plays_source),
) -> WinProbabilityResponse:
    fit = fit_for(league)
    if fit is None:
        # Not a degradation -- there is no such thing as an in-game win
        # probability model for a basketball game here, and a caller asking
        # for one is asking about a league this can never answer for.
        raise HTTPException(
            status_code=404, detail=f"no win probability model for {league}"
        )

    try:
        game = find_game(source, league, game_id)
    except GamesUnavailable as exc:
        log.warning("serving 502 for %s/%s win probability: %s", league, game_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if game is None:
        raise HTTPException(
            status_code=404,
            detail=f"no {league} game {game_id} in the week either side of today",
        )

    release = fit.release
    answer = WinProbabilityResponse(
        league=league,
        game_id=game_id,
        home=game.home,
        away=game.away,
        home_team_id=None,
        away_team_id=None,
        fit=WinProbabilityFit(
            league=release.league,
            run_id=release.run_id,
            seasons=list(release.trained_on.seasons),
            n_games=release.trained_on.n_games,
            brier_score=release.metrics.brier_score,
            log_loss=release.metrics.log_loss,
        ),
        control=None,
        adjusted_control=None,
        luck=None,
        records_defended_passes=False,
        points=[],
        trained_on_this_season=game.season in release.trained_on.seasons,
    )

    if game.season is None or game.week is None:
        # The season file this game came from didn't say which week it filed
        # the game under, which is the one way the partition can be unknown.
        # There is nowhere to look, so the answer is an empty curve.
        log.info("no partition for %s/%s; no plays to read", league, game_id)
        return answer

    try:
        plays = plays_source.game(league, game.season, game.week, game_id)
    except PlaysUnavailable as exc:
        log.warning("serving 502 for %s/%s win probability: %s", league, game_id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    curve = curve_for(fit, plays)
    return answer.model_copy(
        update={
            "home_team_id": curve.home_team_id,
            "away_team_id": curve.away_team_id,
            "control": _control(curve.control),
            "adjusted_control": _control(curve.adjusted_control),
            "luck": (
                None
                if curve.luck is None
                else LuckyBounces(
                    home=curve.luck.home,
                    away=curve.luck.away,
                    swings=[
                        LuckySwing(
                            play_id=swing.play_id,
                            play_number=swing.play_number,
                            kind=str(swing.kind),
                            retained=swing.retained,
                            realized=swing.realized,
                            counterfactual=swing.counterfactual,
                            home_delta=swing.home_delta,
                        )
                        for swing in curve.luck.swings
                    ],
                )
            ),
            "records_defended_passes": curve.records_defended_passes,
            # Zipped rather than sent as two series: upstream promises the
            # adjusted curve is the same snaps in the same order, and this is
            # the one place that promise is cheap to keep.
            "points": [
                CurvePoint(
                    play_id=point.play_id,
                    play_number=point.play_number,
                    period=point.period,
                    clock_seconds=point.clock_seconds,
                    seconds_remaining=point.seconds_remaining,
                    home_score=point.home_score,
                    away_score=point.away_score,
                    home_win_prob=point.home_win_probability,
                    adjusted_win_prob=adjusted.home_win_probability,
                )
                for point, adjusted in zip(curve.points, curve.adjusted)
            ],
        }
    )


def _control(control: LuckyOnesGameControl | None) -> GameControl | None:
    """Upstream's tuple as this API's model, or None straight through."""
    if control is None:
        return None
    return GameControl(home=control.home, away=control.away, seconds=control.seconds)
