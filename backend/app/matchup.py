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

from cassandra.predictor import QB_LEAGUES, MatchupSources, QbOutIndex, StatedRest
from pydantic import BaseModel

from app.games import ScheduledGame


class MatchupFacts(BaseModel):
    """What the matchup terms say about one game.

    Signed per side rather than as cassandra's single differential, because a
    page renders two teams and "the home team is missing its quarterback" is
    the fact a reader has; that both being out is worth nothing to either side
    is the model's business, not the page's.

    `rest_home` and `rest_away` are None when nobody can say. That is every
    completed game today: deciding who came off a bye needs when each side last
    played, and the games source keeps a window of days around today rather
    than a season -- see `app.seasons`, whose season cache is deliberately
    trimmed to that horizon. A team on a normal week played inside it and one
    off a bye did not, so walking what is there would answer "nobody was
    rested" for precisely the games where somebody was. None says "not known"
    instead, which is the one honest answer available until that cache is
    widened.
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


def played_facts(game: ScheduledGame) -> MatchupFacts:
    """What was true of a game that has been played.

    The quarterback index is keyed by ESPN's own game id and ships in the
    package, so this is a dict lookup and costs no request to anything. Rest is
    None: see `MatchupFacts`.
    """
    index = QbOutIndex.for_league(game.league)
    return MatchupFacts(
        qb_out_home=index.is_out(game.game_id, game.home),
        qb_out_away=index.is_out(game.game_id, game.away),
        rest_home=None,
        rest_away=None,
    )
