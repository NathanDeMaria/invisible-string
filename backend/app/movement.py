"""What the last week did to a team, read out of `history.parquet`.

DESIGN.md section 6: "with history on hand it's a lookup, not a diff against
yesterday's release". This is the lookup. A release says where every team
stands; the history file says where they stood at the end of every week, and
the difference between the two is the column the ratings table has been
missing -- forty points and four places, since Sunday.

Three decisions are worth stating, because each of them is a choice about what
"since last week" means and each could plausibly have gone the other way.

**The comparison is a week, not seven days.** The file is weekly, so the row
to diff against is the previous *snapshot*, and its date is published rather
than assumed. That keeps the answer a property of the data rather than of the
clock the request arrived on, and it means a league that plays Tuesday to
Tuesday gets the same treatment as one that plays Saturdays.

**A season boundary ends it.** Between two seasons a rating moves because
`pass_season` regressed it toward its anchor, not because anybody played, and
a record resets. Diffing across that boundary would put a number in the column
that no game produced, so the first snapshot of a season simply has no
movement -- which is also the honest thing to show in week one.

**Rank movement is computed over today's table.** The previous week is ranked
using the same teams the current leaderboard shows, so "up four places" is
four places *on this page*. Ranking it over whoever happened to have a row
back then would count a team that has since folded, and the reader would be
left subtracting a rank they can't see from one they can.
"""

import logging
from datetime import datetime
from typing import NamedTuple, cast

import pandas as pd
from pydantic import BaseModel

log = logging.getLogger(__name__)


class Standing(NamedTuple):
    """One team's current row, as the leaderboard already worked it out.

    Taken from the ranked table rather than recomputed, so the rank a movement
    is measured against is the rank printed beside it.
    """

    team: str
    rank: int
    rating: float
    wins: int
    losses: int


class Movement(BaseModel):
    """What changed for one team since the comparison week.

    `rank` is positive when a team moved *up*, which is the opposite sign to
    the rank itself: 4th from 8th is +4, and the arrow beside it points the
    way the team went rather than the way the number did.

    `wins` and `losses` are what the team went in between, from the records
    the history carries season-to-date.
    """

    rating: float
    rank: int
    wins: int
    losses: int


class MovementWindow(BaseModel):
    """The snapshot everything is measured against.

    Published so the page can name the day rather than say "last week" and
    hope. `date` is the last game played in that week (cassandra's
    `WeekSnapshot.date`), so it is a day something actually happened on.
    """

    year: int
    week: int
    date: datetime


def _weeks(history: pd.DataFrame) -> pd.DataFrame:
    """One row per snapshot week, in order, with the day it ended on.

    `max` over the dates rather than `first`: an upsert can leave a week
    holding rows written on different days -- the daily refresh rewrites the
    current week as its games land -- and the last of them is when the week
    got to where it is.
    """
    return (
        history.groupby(["year", "week"], as_index=False)["date"]
        .max()
        .sort_values(["year", "week"], kind="stable")
    )


def previous_week(history: pd.DataFrame) -> MovementWindow | None:
    """The snapshot to measure movement against, or None if there isn't one.

    None covers three cases that all mean the same thing to a reader -- no
    history published, only one week of it, or a previous week that belongs to
    the season before this one.
    """
    if history.empty:
        return None
    weeks = _weeks(history)
    if len(weeks) < 2:
        return None
    latest, prior = weeks.iloc[-1], weeks.iloc[-2]
    if int(prior["year"]) != int(latest["year"]):
        # See the module docstring: across a season boundary the movement is
        # the offseason's, not the week's.
        return None
    ended = pd.Timestamp(prior["date"])
    if pd.isna(ended):
        # A week whose rows carry no date at all. Nothing to name the
        # comparison after, and naming it wrongly is worse than not offering
        # it -- the page prints this date beside every number in the column.
        log.warning("history week %s/%s has no date", prior["year"], prior["week"])
        return None
    return MovementWindow(
        year=int(prior["year"]),
        week=int(prior["week"]),
        # Guarded against NaT just above; `to_pydatetime` is typed as if it
        # weren't.
        date=cast(datetime, ended.to_pydatetime()),
    )


def movement(
    history: pd.DataFrame, standings: list[Standing]
) -> tuple[MovementWindow | None, dict[str, Movement]]:
    """Every team's movement since the previous snapshot week.

    Returns the week it measured against and the movements by team. A team
    with no row in that week isn't in the mapping: its first game was this
    week, and "up 1500 points" is not what happened.

    The rating delta is taken against the *release's* rating rather than the
    latest history row, so the number in the column always reconciles with the
    number beside it. The two are the same rating in a healthy publish -- both
    come out of one replay -- and where they aren't, the one on the page is
    the one worth explaining.
    """
    window = previous_week(history)
    if window is None:
        return None, {}

    shown = {standing.team for standing in standings}
    rows = history[(history["year"] == window.year) & (history["week"] == window.week)]
    before = {
        str(row["team"]): row
        for row in rows.to_dict("records")
        # A team the leaderboard doesn't show can't move on it. See the
        # module docstring on ranking over today's table.
        if str(row["team"]) in shown
    }
    if not before:
        log.info(
            "history week %s/%s has no team in common with the current table",
            window.year,
            window.week,
        )
        return None, {}

    # The tie rule `app.api.ratings._rank` uses, applied to the same teams, so
    # a rank difference is never an artifact of two different orderings.
    ordered = sorted(
        before.values(), key=lambda row: (-float(row["rating"]), str(row["team"]))
    )
    ranks = {str(row["team"]): rank for rank, row in enumerate(ordered, start=1)}

    moved: dict[str, Movement] = {}
    for standing in standings:
        row = before.get(standing.team)
        if row is None:
            continue
        moved[standing.team] = Movement(
            rating=standing.rating - float(row["rating"]),
            rank=ranks[standing.team] - standing.rank,
            wins=standing.wins - int(row["wins"]),
            losses=standing.losses - int(row["losses"]),
        )
    return window, moved
