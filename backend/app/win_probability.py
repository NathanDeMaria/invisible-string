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
and the fit that turns one into the other. Two rules shape it.

**A league without a fit is not an error.** Only football has one -- there is
no such thing as an in-game win probability model for a basketball game here --
and the games page lists every league. So `fit_for` answers None and the game
page simply has no chart, which is the same degradation `app.api.games` gives
a league with no readable release.

**A game without a curve is not an error either.** ESPN has no play-by-play
for most of an NCAAFB week, none for a game that hasn't kicked off, and none
for a week the transform hasn't run over. All of those come back as a curve
with no points rather than as a 404: the game page still has a game on it.
"""

import logging
from dataclasses import dataclass
from typing import Sequence

from lucky_ones import MODELS, CurvePoint, GameControl, group_by_game
from lucky_ones.bundled import BundledModel
from lucky_ones.curve import game_control
from lucky_ones.plays import Play

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
    """

    home_team_id: str | None
    away_team_id: str | None
    points: list[CurvePoint]
    control: GameControl | None


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


def curve_for(fit: BundledModel, plays: Sequence[Play]) -> Curve:
    """The curve for the one game `plays` belongs to.

    Empty when there was nothing to draw. Three different reasons reach it and
    none of them is an error:

    - no plays at all: ESPN has none for this game, or the week hasn't been
      processed yet.
    - a game `group_by_game` dropped, because the scoring drives don't say
      which team the home score belongs to. Guessing would sign-flip every
      feature in the game, so it doesn't guess and neither does this.
    - plays that are all kickoffs and clock stoppages, which `iter_states`
      drops -- so a game whose play-by-play is a stub scores no snaps.
    """
    games = group_by_game(plays)
    if not games:
        return Curve(None, None, [], None)
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
    points = fit.curve(game)
    return Curve(
        home_team_id=game.home_team_id,
        away_team_id=game.away_team_id,
        points=points,
        control=game_control(points),
    )
