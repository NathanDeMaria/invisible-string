"""In-game win probability, from the-lucky-ones' shipped fits.

DESIGN.md section 16. `app.releases` reads cassandra's model out of a bucket;
this one arrives inside a package. That is the-lucky-ones' own trade and it is
the right one for a fit that changes a few times a season: the coefficients
ship in the wheel, so pinning the package by rev pins the model with it, and
"which curve is this drawing?" has one answer instead of depending on what was
at an S3 key when the process started. The cost is that a retrain is a bump
here rather than a file copy -- which is the same shape as the cassandra pin
two sections up.

What this module is for is the join, which is the part neither package can do
alone: a league name from a request, a game's plays out of endgame's bucket,
and the fit that turns one into the other. Three rules shape it.

**A league without a fit is not an error.** Only football has one -- there is
no such thing as an in-game win probability model for a basketball game here --
and the games page lists every league. So `fit_for` answers None and the game
page simply has no chart, which is the same degradation `app.api.games` gives
a league with no readable release.

**A game without a curve is not an error either.** ESPN has no play-by-play
for most of an NCAAFB week, none for a game that hasn't kicked off, and none
for a week the transform hasn't run over. All of those come back as a curve
with no points rather than as a 404: the game page still has a game on it.

**A game is read once.** Everything below -- the curve, the same curve with
the bounces split, the share of the game each side held either way, what the
bounces were worth, and what each offense did with the ball -- comes off one
walk of the plays and the states it builds. That is what upstream's
`*_from_states` entry points are for (DESIGN.md 16.7), and it is the
difference between five passes over a game and one.
"""

import logging
from dataclasses import dataclass
from typing import Sequence

from lucky_ones import MODELS, CurvePoint, EpaPerPlay, GameControl, group_by_game
from lucky_ones.bundled import BundledModel
from lucky_ones.curve import game_control
from lucky_ones.epa import epa_per_play_from_states
from lucky_ones.luck import (
    LuckyWP,
    adjusted_curve_from_states,
    find_lucky_plays,
    lucky_wp_from_states,
    records_defended_passes,
)
from lucky_ones.plays import Play
from lucky_ones.points import scoring_plays
from lucky_ones.release import ExpectedPointsRelease
from lucky_ones.state import iter_states

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Curve:
    """One game's win probability over time, and what it adds up to.

    `home_team_id` and `away_team_id` are ESPN's numeric ids, which is what
    the plays carry -- not the display names the schedule carries. Nothing
    joins the two (see `lucky_ones.game`), so they are here as provenance
    rather than as something to render: the home side is *inferred from the
    scoring drives*, and a page saying "the model had the home team at 62%"
    should be able to say which id it decided that was.

    Both are None on an empty curve, which is every case where there was
    nothing to score.

    `points` and `adjusted` are the same snaps twice -- what happened, and
    what the model makes of it with the fifty-fifty balls split evenly -- so
    they are the same length and in the same order, and the API sends them as
    two numbers on one point rather than as two series to line up.
    """

    home_team_id: str | None
    away_team_id: str | None
    points: list[CurvePoint]
    adjusted: list[CurvePoint]
    control: GameControl | None
    adjusted_control: GameControl | None
    luck: LuckyWP | None
    epa: EpaPerPlay | None
    """What each offense did with the ball, in points per snap.

    The number on this page that isn't about who won. `game_control` and its
    adjusted twin both measure the *game*; this measures the football, and the
    two genuinely disagree about a team that keeps winning close ones.

    None on a game with no snaps to average -- and, for the same reason
    `fit_for` answers None, on a league whose expected points fit isn't in
    this install. Upstream ships the two fits as two files precisely so one
    can be missing without taking the other down, and a curve is worth
    drawing without a number under it.
    """

    records_defended_passes: bool
    """Whether this game's feed writes down the passes a defender got to.

    The gate upstream puts on the interception half of the adjustment, and a
    fact about *the feed* rather than about the football: whether a broken-up
    pass is recorded follows the venue in NCAAFB and the era in the NFL. A
    game that only records one side of that coin has its fumbles split and its
    interceptions left alone, which is a smaller adjustment rather than a
    fabricated one -- and the page says so, because "no interception was
    adjusted here" and "nothing was intercepted" are different games.
    """


EMPTY = Curve(
    home_team_id=None,
    away_team_id=None,
    points=[],
    adjusted=[],
    control=None,
    adjusted_control=None,
    luck=None,
    epa=None,
    records_defended_passes=False,
)
"""A game with nothing to draw. See `curve_for` for the three ways to get one."""


def fit_for(league: str) -> BundledModel | None:
    """The bundled fit for a league, or None if there isn't one.

    None covers both halves of "there isn't one": a league the package has no
    attribute for (every basketball league here), and one it names but whose
    JSON isn't in the install -- which would be a build that dropped the
    package's data files. The second is worth a warning and is still not worth
    a 500: the rest of the game page doesn't depend on it.
    """
    try:
        model = MODELS[league]
    except KeyError:
        return None
    try:
        # Forces the lazy read, so a fit that can't be loaded is discovered
        # here rather than halfway through rendering a response.
        model.release
    except Exception:  # noqa: BLE001 - a missing or unreadable data file
        log.warning("no win probability fit for %s", league, exc_info=True)
        return None
    return model


def expected_points_for(fit: BundledModel) -> ExpectedPointsRelease | None:
    """The league's expected points release, or None if it isn't shipped.

    The second fit, and the second file: upstream keeps `{league}.json` and
    `{league}-ep.json` apart because they are fit separately and move
    separately, which means a build can have one and not the other. So this
    gets the same treatment `fit_for` gives the first -- a warning and a None,
    not a 500. EPA per play is the only thing downstream of it, and a game
    page without that number is still a game page.
    """
    try:
        return fit.expected_points_release
    except Exception:  # noqa: BLE001 - a missing or unreadable data file
        log.warning("no expected points fit for %s", fit.league, exc_info=True)
        return None


def curve_for(fit: BundledModel, plays: Sequence[Play]) -> Curve:
    """The curve for the one game `plays` belongs to, both ways.

    `EMPTY` when there was nothing to draw. Three different reasons reach it
    and none of them is an error:

    - no plays at all: ESPN has none for this game, or the week hasn't been
      processed yet.
    - a game `group_by_game` dropped, because the scoring drives don't say
      which team the home score belongs to. Guessing would sign-flip every
      feature in the game, so it doesn't guess and neither does this.
    - plays that are all kickoffs and clock stoppages, which `iter_states`
      drops -- so a game whose play-by-play is a stub scores no snaps.

    Otherwise it is one walk of the game and five questions of the fit:
    `find_lucky_plays` reads the play text once, and both luck metrics are
    handed that same list, so they can differ about what a bounce was worth
    but never about which plays bounced. The `*_from_states` trio each
    re-score the realized curve, which is a matrix multiply over a few hundred
    rows and is the price of upstream's entry points staying independent.

    The fifth is EPA per play, and it is the one that reads the *other* fit:
    expected points to price each snap, the win probability already in hand to
    say how much the game it happened in was still in doubt. Same states, one
    more pass over the plays to find which of them put points on the board --
    a snap that scored has no next snap to be priced against.
    """
    games = group_by_game(plays)
    if not games:
        return EMPTY
    if len(games) > 1:
        # One game's plays went in, so more than one coming out means the
        # filter that read them didn't filter. Worth saying out loud rather
        # than silently drawing whichever sorted first.
        log.warning(
            "%d games in one game's plays: %s",
            len(games),
            ", ".join(game.game_id for game in games),
        )
    game = games[0]
    states = list(iter_states(game))
    lucky = find_lucky_plays(game.plays)
    adjusted = adjusted_curve_from_states(fit.model, states, lucky)
    points = expected_points_for(fit)
    return Curve(
        home_team_id=game.home_team_id,
        away_team_id=game.away_team_id,
        points=adjusted.realized,
        adjusted=adjusted.points,
        control=game_control(adjusted.realized),
        adjusted_control=game_control(adjusted.points),
        # None rather than a pair of zeroes on a game with no snaps: "nothing
        # bounced" is a real reading of a game that was played, and a stub
        # play-by-play must not render as one.
        luck=lucky_wp_from_states(fit.model, states, lucky) if states else None,
        # None on the same games `luck` is None on, and on a league whose
        # second fit isn't in the install. Upstream's own None -- an offense
        # with nothing to average -- is inside the tuple rather than instead
        # of it, since "the home team never had the ball" is a fact about the
        # game worth carrying.
        epa=(
            epa_per_play_from_states(
                # `fit.expected_points` rather than `points.to_model()`: it is
                # the same fit off the same release, cached on the model the
                # way `fit.model` is, so serving a second game doesn't rebuild
                # it.
                fit.expected_points,
                fit.model,
                states,
                scoring_plays(list(game.plays)),
            )
            if states and points is not None
            else None
        ),
        records_defended_passes=records_defended_passes(game.plays),
    )
