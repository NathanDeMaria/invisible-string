"""Reading endgame's season pickles without depending on endgame's classes.

DESIGN.md section 13.5. Two places here unpickle endgame's object graph --
`app.seasons` for the games page and `app.batch` for the volume counts -- and
section 14 already names the coupling that creates as "load-bearing and
silent". This module is where it stops being silent.

**The problem is that `Game` is a `NamedTuple`.** A namedtuple pickles as its
values and nothing else, and unpickles by calling the *current* class with the
*stored* ones. So a field added upstream isn't a missing attribute on the way
back in -- it is a hard `TypeError` out of `__new__`, on every season file
written since the field appeared. Both readers catch that per file and log it,
which means the failure mode is the whole games page quietly empty and every
volume count blank, with one warning per league to say so.

That is not hypothetical: endgame's jobs now write the games ESPN hasn't
finished as well as the ones it has, and `Game` gained a `status` alongside
them. The pinned class had eight fields and the new files carry nine.

**And the pin cannot simply be bumped.** endgame arrives transitively --
cassandra depends on endgame-aws depends on endgame -- and poetry refuses two
git revs of one package, so a direct pin here fails to resolve until cassandra
bumps endgame-aws first. Waiting for two upstream bumps to land is not what
should stand between this app and a bucket it can already read.

**So this app reads a `Game` by field order rather than by class.** The values
come off the wire positionally either way; all `RawGame` does is name them
itself, tolerate more of them than it knows about, and default the ones that
aren't there. Both eras of file then read the same way, which they have to:
`seasons/` holds files from before the flip and after it, and the previous
year's is only rewritten when that year is pulled.

The cost is that the field *order* is mirrored here, so a field inserted
anywhere but the end would be read as the wrong one. That is the trade --
against a hard failure on every append, which is the change upstream actually
makes. `tests/test_endgame_pickle.py` pins the order against the installed
`endgame.types.Game`, so a reordering is a red check rather than a wrong
number.

Only `Game` is intercepted. `Season` and `Week` resolve to endgame's own
classes as before: this walks them (`season.weeks`, `week.games`) rather than
reading fields off them, so their layout isn't something this app has an
opinion about.

`numbered_weeks` is the one place that reads a few of their fields, and it is
here rather than in `app.seasons` for the same reason `RawGame` is: it mirrors
a rule endgame owns -- how a week is numbered -- because that number is a key
into another prefix of the same bucket, and getting it wrong draws a curve
from the wrong week's plays.
"""

import io
import logging
import pickle
from collections.abc import Iterator
from datetime import date, datetime, timedelta
from typing import Any

log = logging.getLogger(__name__)


class RawGame:
    """One endgame `Game`, rebuilt from a season pickle by field order.

    Reads as the namedtuple it stands in for -- `game.completed`, `game.date`,
    `game.home_score` -- so nothing downstream needs to know the difference.
    """

    # endgame's `Game`, in the order it declares them. Appended to, never
    # reordered or inserted into: see the module docstring for why that
    # distinction is the whole trade.
    FIELDS: tuple[str, ...] = (
        "home",
        "home_score",
        "away",
        "away_score",
        "neutral_site",
        "completed",
        "date",
        "game_id",
        # ESPN's `status.type.name` verbatim -- STATUS_FINAL,
        # STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_POSTPONED,
        # STATUS_CANCELED. New with the jobs that write unplayed games:
        # `completed` says result / not-a-result, and this says why not.
        "status",
    )

    # The trailing fields upstream added with a default of their own, so a
    # file written before they existed reads the same way there and here. A
    # game saved before `status` gets "" rather than STATUS_FINAL: those games
    # really are all final, but writing a status nothing ever observed is how
    # a wrong invariant gets baked in -- endgame's own reasoning, kept.
    DEFAULTS: dict[str, Any] = {"status": ""}

    __slots__ = FIELDS

    home: str
    home_score: int
    away: str
    away_score: int
    neutral_site: bool
    completed: bool
    date: datetime
    game_id: str
    status: str

    def __new__(cls, *values: Any) -> "RawGame":
        """The call the unpickler makes: `Game(*stored_values)`.

        Extra values are dropped rather than raising -- that is the whole
        point, and it is what a field appended upstream looks like from here.
        Too *few* still raises, because a game missing one of the fields
        endgame has always had isn't a version skew, it's a broken object; the
        readers catch that per game and skip it.
        """
        required = len(cls.FIELDS) - len(cls.DEFAULTS)
        if len(values) < required:
            raise TypeError(
                f"a season pickle's Game carried {len(values)} values, "
                f"fewer than the {required} endgame has always written"
            )

        game = object.__new__(cls)
        for name, value in zip(cls.FIELDS, values):
            object.__setattr__(game, name, value)
        for name in cls.FIELDS[len(values) :]:
            object.__setattr__(game, name, cls.DEFAULTS[name])
        return game

    def __repr__(self) -> str:
        fields = ", ".join(f"{name}={getattr(self, name)!r}" for name in self.FIELDS)
        return f"RawGame({fields})"


class _SeasonUnpickler(pickle.Unpickler):
    """endgame's pickles, with `Game` answered by this app rather than imported.

    No wider than that on purpose. This is not a sandbox -- the objects come
    from endgame's own bucket, at the same trust level the plain `pickle.loads`
    it replaces already assumed -- it is one substitution, so that one class's
    layout stops being a deployment-time dependency.
    """

    def find_class(self, module: str, name: str) -> Any:
        if (module, name) == ("endgame.types", "Game"):
            return RawGame
        return super().find_class(module, name)


def load_seasons(raw: bytes) -> list[Any]:
    """The seasons in one `seasons/{year}/{league}.pkl` body.

    `save_to_s3` writes a list of seasons; a bare one is tolerated because a
    file written by hand or by an older job is still worth reading.

    Raises whatever unpickling raises. Every caller treats that as "no games
    from this file" and says so in a log line, which is the degradation
    sections 12.4 and 13.2 both specify.
    """
    loaded = _SeasonUnpickler(io.BytesIO(raw)).load()
    return loaded if isinstance(loaded, list) else [loaded]


def _week_end(day: date) -> date:
    """The Monday that closes the calendar week `day` falls in.

    endgame's rule, mirrored: the AP poll is released on Monday-Sunday games,
    so a week is keyed by the Monday after it.
    """
    return day + timedelta(days=7 - day.weekday())


def week_number(moment: datetime, year: int, season_start: tuple[int, int]) -> int:
    """Which calendar week of a season a game belongs to.

    endgame's `_week_number`, mirrored here for the same reason `RawGame`
    mirrors the field order: the number is a *key* into another prefix of the
    bucket, and the class that computes it is the one this image can't pin.
    `tests/test_endgame_pickle.py` pins the arithmetic against endgame's own
    `group_games_into_weeks`, so a rule that moves upstream is a red check
    rather than a curve drawn from the wrong week's plays.
    """
    return (
        _week_end(moment.date()) - _week_end(date(year, *season_start))
    ).days // 7 + 1


def numbered_weeks(season: Any) -> Iterator[tuple[int, list[Any]]]:
    """A season's weeks under the numbers endgame's own jobs key them by.

    This is what makes a game's play-by-play findable. The processed plays
    live at `processed/plays/league=.../season=.../week=NN/`, and endgame
    writes them under "the week numbers `iter_weeks` walks" -- which is the
    source's own numbering for the NFL, whose weeks are already chronological,
    and calendar weeks counted from the start of the season for NCAAFB, whose
    source numbering isn't. A season file says which it is: `season_start` is
    set exactly when the games have to be regrouped.

    Deliberately not `season.calendar_weeks`. Walking `season.weeks` is the
    one thing this app already does to a `Season` (see the module docstring),
    and reaching for a *property* that rebuilds the season through endgame's
    `Week`, `supersedes` and `group_games_into_weeks` would make three more
    pieces of a transitively-pinned package load-bearing for the games page.
    The regrouping itself is two dates and a subtraction.

    Games are pooled by id first when there is regrouping to do, exactly as
    `calendar_weeks` pools them: the same game comes back under more than one
    division, and two copies in two calendar weeks would be two rows.
    """
    weeks = getattr(season, "weeks", [])
    season_start = getattr(season, "season_start", None)
    if season_start is None:
        for week in weeks:
            yield week.number, list(week.games)
        return

    year = season.year
    pooled: dict[str, Any] = {}
    for week in weeks:
        for game in week.games:
            seen = pooled.get(game.game_id)
            # `supersedes`, in the one form this needs: later wins, except
            # that a final is never walked back to a game still in progress.
            if seen is None or game.completed or not seen.completed:
                pooled[game.game_id] = game

    grouped: dict[int, list[Any]] = {}
    for game in pooled.values():
        grouped.setdefault(week_number(game.date, year, season_start), []).append(game)
    yield from grouped.items()
