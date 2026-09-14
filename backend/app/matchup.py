"""The game-level facts the football models price, read and stated.

Two of cassandra's three matchup terms are things a person knows about a
specific game rather than about either team: whether a side is missing its
starting quarterback, and whether one came off the longer break. This module
is the seam between those and the API -- it reads them for a game that has
been played, and builds the `MatchupSources` that state them for one that
hasn't.

**Why `predict_game` never learns a new argument.** cassandra asks these
questions of a source (`QbOutIndex`, `RestSource`) that the predictor is built
with, so a what-if is the same call against a differently-built predictor.
Everything here is about assembling that bundle; nothing here does model math,
and nothing downstream of it knows whether the answer was looked up or typed.

**Football only.** `QB_LEAGUES` is the leagues with play-by-play to build an
index from, and the rest term was measured on ncaafb. Other leagues get None
rather than four `false`s: "this model has no such signal" and "nobody is out"
are different claims, and a basketball game page should say the first by
showing nothing at all.
"""

from datetime import datetime
from typing import NamedTuple

from cassandra.predictor import (
    QB_LEAGUES,
    MatchupSources,
    QbOutIndex,
    RestLedger,
    StatedRest,
)
from endgame.types import Game
from pydantic import BaseModel

from app.games import PlayedGame, ScheduledGame


class MatchupFacts(BaseModel):
    """What the matchup terms say about one game.

    Signed per side rather than as cassandra's single differential, because a
    page renders two teams and "the home team is missing its quarterback" is
    the fact a reader has; that both being out is worth nothing to either side
    is the model's business, not the page's.

    `rest_home` and `rest_away` are None when nobody can say, which is a
    narrow case and not the same as False. Both are False for two sides on
    level rest -- an ordinary week, which is most games. Both are None for a
    game either side is playing first this season: `RestLedger` prices that at
    0 because "we have no idea" and "level" are the same number to a model
    about to add nothing either way, but a page that rendered a season opener
    as "nobody was rested" would be stating a fact it doesn't have. Also None
    for a game whose season the source has no schedule for.
    """

    qb_out_home: bool
    qb_out_away: bool
    rest_home: bool | None
    rest_away: bool | None


class MatchupOverrides(BaseModel):
    """What a reader has said about a game nobody has played yet.

    All four default to False, which is the same game the model already
    predicts: an index that has never heard of a fixture reports both
    quarterbacks fine, and a ledger that has walked nothing reports level rest.
    So `stated()` being false means the caller changed nothing, and the request
    takes the untouched predictor rather than an equivalent rebuilt one.
    """

    qb_out_home: bool = False
    qb_out_away: bool = False
    rest_home: bool = False
    rest_away: bool = False

    def stated(self) -> bool:
        """Whether any of this differs from the model's own default."""
        return any((self.qb_out_home, self.qb_out_away, self.rest_home, self.rest_away))

    def facts(self) -> MatchupFacts:
        """The same four values, as the page reads them back."""
        return MatchupFacts(
            qb_out_home=self.qb_out_home,
            qb_out_away=self.qb_out_away,
            rest_home=self.rest_home,
            rest_away=self.rest_away,
        )


def has_matchup_terms(league: str) -> bool:
    """Whether this league's model prices any of these at all."""
    return league in QB_LEAGUES


def matchup_game_id(game: ScheduledGame) -> str:
    """The game id the sources must be keyed by.

    Not `game.game_id`. `predict_matchup` builds the pre-game half of a Game
    itself and names it `{away}@{home}`, so a source keyed by ESPN's id would
    be looked up under a key that never arrives and would silently price at
    zero -- a what-if that quietly does nothing, which is the worst way for
    this to fail. Defined once so the two sides cannot drift.
    """
    return f"{game.away}@{game.home}"


def stated_sources(game: ScheduledGame, overrides: MatchupOverrides) -> MatchupSources:
    """The sources that make the model see the game the reader described.

    Built from nothing rather than from the league's own: a fixture is not in
    the stored quarterback index and the ledger has walked no games, so the
    league's sources have nothing to say about this game and there is nothing
    to lose by replacing them. Starting empty also keeps the answer a function
    of the four flags alone, which is what makes the toggles legible.
    """
    game_id = matchup_game_id(game)

    out = [
        team
        for team, is_out in (
            (game.home, overrides.qb_out_home),
            (game.away, overrides.qb_out_away),
        )
        if is_out
    ]
    # Both rested is nobody rested -- the same answer a ledger gives when the
    # two sides' breaks are level, and the reason this is a single stated team
    # rather than one per side.
    rested = {
        (True, False): game.home,
        (False, True): game.away,
    }.get((overrides.rest_home, overrides.rest_away))

    return MatchupSources(
        qb_out=QbOutIndex({game_id: out} if out else {}),
        rest=StatedRest({game_id: rested} if rested else {}),
    )


def played_facts(
    game: ScheduledGame, schedule: list[PlayedGame], index: QbOutIndex
) -> MatchupFacts:
    """What was true of a game that has been played.

    `index` is the league's published quarterback index, keyed by ESPN's own
    game id -- `ReleaseStore.get_qb_out`, read from the bucket beside the
    releases. Handed in rather than looked up here because the lookup that
    used to be here, `QbOutIndex.for_league`, reads a file under
    `~/.cassandra` that only exists on a machine that ran the sweep: in the
    container it was empty, and every played game read "Both started".

    Rest is worked out by walking `schedule` -- the season this game belongs
    to -- into a real `RestLedger` and asking it, rather than by comparing
    dates here. The ledger is where the thresholds live: five days to count as
    a bye, twenty for a gap that is more likely a missing row than a rest, and
    "no idea" rather than "extremely rested" for a side whose first game this
    is. Re-deriving any of that here would be a second copy to drift from the
    one the model actually prices with.
    """
    rested = _rested_side(game, schedule)
    return MatchupFacts(
        qb_out_home=index.is_out(game.game_id, game.home),
        qb_out_away=index.is_out(game.game_id, game.away),
        rest_home=None if rested is None else rested > 0,
        rest_away=None if rested is None else rested < 0,
    )


def _rested_side(game: ScheduledGame, schedule: list[PlayedGame]) -> float | None:
    """+1 if the home side came off the longer break, -1 the away, 0 neither.

    None when nobody can say, which is not the same as 0 and must not render
    as one. Two ways to get there: a source with no schedule for this season at
    all, and a game where either side hasn't played yet -- a season opener,
    where `RestLedger` answers 0 because "we have no idea" and "level" are the
    same number to a model that is about to add zero either way. The page has
    to tell them apart, so this asks the ledger what it knows first.

    Games on the day itself are left out rather than filtered by id. A team
    does not play twice in a day, so the only same-day game either side is in
    is this one -- and the replay records a game *after* predicting it, so
    counting it here would be the game contributing to its own rest.
    """
    if not schedule:
        return None

    ledger = RestLedger()
    seen: set[str] = set()
    for played in schedule:
        if played.completed and played.date < game.start:
            ledger.record(_as_game(played))
            seen.update((played.home, played.away))

    # Asked of what was recorded rather than of the ledger, whose own answer
    # for a team it has never seen is 0 -- the same 0 it gives two sides on
    # level rest, because a model adding zero either way has no reason to
    # separate them. A page does.
    if game.home not in seen or game.away not in seen:
        return None
    return ledger.rested_side(_Played(home=game.home, away=game.away, date=game.start))


def _as_game(played: PlayedGame) -> Game:
    """A `PlayedGame` in the shape `RestLedger.record` is typed for.

    `record` notes that both sides played on a date and reads nothing else --
    which is why `PlayedGame` carries nothing else. The scores and the id here
    are placeholders for fields that are never looked at, and `completed` is
    True because the caller has already filtered to games that were.
    """
    return Game(
        home=played.home,
        home_score=0,
        away=played.away,
        away_score=0,
        neutral_site=False,
        completed=True,
        date=played.date,
        game_id="",
        status="",
    )


class _Played(NamedTuple):
    """The pre-game half of a played game, as `RestLedger` reads it."""

    home: str
    away: str
    date: datetime

    @property
    def neutral_site(self) -> bool:
        """Unread by the rest term, which applies at a neutral site too."""
        return False

    @property
    def game_id(self) -> str:
        """Unread by the rest term, which is keyed by team and date."""
        return ""
