"""What the ratings table means by "since last week" (`app.movement`).

Every case here is a decision about when *not* to show a number, which is why
they're tested against frames built inline rather than through the API: the
question is what the rule says, not what the endpoint does with it.
"""

from datetime import UTC, datetime

import pandas as pd
import pytest

from app.movement import Standing, movement, previous_week


def history(*rows: tuple[str, int, int, str, float, int, int]) -> pd.DataFrame:
    """History rows, in the file's columns. `(team, year, week, date, ...)`."""
    return pd.DataFrame(
        [
            {
                "team": team,
                "year": year,
                "week": week,
                "date": pd.Timestamp(date),
                "rating": rating,
                "rd": 70.0,
                "wins": wins,
                "losses": losses,
                "run_id": "2026-08-08T09:00:12Z",
            }
            for team, year, week, date, rating, wins, losses in rows
        ]
    )


WEEK1 = "2026-07-31T23:00:00Z"
WEEK2 = "2026-08-07T23:15:00Z"


class TestPreviousWeek:
    def test_no_history_means_no_comparison(self) -> None:
        assert previous_week(pd.DataFrame()) is None

    def test_one_week_means_no_comparison(self) -> None:
        """Week one of a season has nothing behind it. A zero would be a claim
        that nothing moved, which is a different statement."""
        rows = history(("Duke", 2026, 1, WEEK1, 1810.0, 22, 5))
        assert previous_week(rows) is None

    def test_the_week_before_the_latest_one(self) -> None:
        rows = history(
            ("Duke", 2026, 1, WEEK1, 1810.0, 22, 5),
            ("Duke", 2026, 2, WEEK2, 1834.2, 24, 5),
        )
        window = previous_week(rows)
        assert window is not None
        assert (window.year, window.week) == (2026, 1)
        assert window.date == datetime(2026, 7, 31, 23, 0, tzinfo=UTC)

    def test_a_season_boundary_ends_it(self) -> None:
        """Across the offseason a rating moves because `pass_season` regressed
        it, not because anybody played. There is no week to attribute that to,
        so the column stays empty."""
        rows = history(
            ("Duke", 2025, 20, "2026-03-30T23:00:00Z", 1770.0, 30, 6),
            ("Duke", 2026, 1, WEEK1, 1650.0, 1, 0),
        )
        assert previous_week(rows) is None

    def test_a_week_takes_the_last_day_it_was_written_on(self) -> None:
        """The daily refresh upserts the current week as its games land, so one
        week can hold rows stamped on different days. The last of them is when
        the week got to where it is."""
        rows = history(
            ("Duke", 2026, 1, WEEK1, 1810.0, 22, 5),
            ("Houston", 2026, 1, "2026-08-01T02:00:00Z", 1800.0, 24, 4),
            ("Duke", 2026, 2, WEEK2, 1834.2, 24, 5),
        )
        window = previous_week(rows)
        assert window is not None
        assert window.date == datetime(2026, 8, 1, 2, 0, tzinfo=UTC)

    def test_a_week_with_no_date_is_not_offered(self) -> None:
        rows = history(
            ("Duke", 2026, 1, WEEK1, 1810.0, 22, 5),
            ("Duke", 2026, 2, WEEK2, 1834.2, 24, 5),
        )
        rows.loc[rows["week"] == 1, "date"] = pd.NaT
        assert previous_week(rows) is None


TODAY = [
    Standing(team="Duke", rank=1, rating=1834.2, wins=24, losses=5),
    Standing(team="Houston", rank=2, rating=1834.2, wins=26, losses=4),
    Standing(team="North Carolina", rank=3, rating=1790.0, wins=22, losses=8),
]

LAST_WEEK = history(
    ("Duke", 2026, 1, WEEK1, 1810.0, 22, 5),
    ("Houston", 2026, 1, WEEK1, 1800.0, 24, 4),
    ("North Carolina", 2026, 1, WEEK1, 1800.5, 21, 7),
    ("Duke", 2026, 2, WEEK2, 1834.2, 24, 5),
    ("Houston", 2026, 2, WEEK2, 1834.2, 26, 4),
    ("North Carolina", 2026, 2, WEEK2, 1790.0, 22, 8),
)


class TestMovement:
    def test_the_rating_delta_is_against_the_release(self) -> None:
        """The number in the column has to reconcile with the number beside
        it, so the subtraction starts from the standing the table printed."""
        _, moved = movement(LAST_WEEK, TODAY)
        assert moved["Houston"].rating == pytest.approx(34.2)
        assert moved["North Carolina"].rating == pytest.approx(-10.5)

    def test_rank_is_positive_when_a_team_moved_up(self) -> None:
        """Third to second is +1, even though the rank itself went down. The
        sign follows the team, not the integer."""
        _, moved = movement(LAST_WEEK, TODAY)
        assert moved["Houston"].rank == 1
        assert moved["North Carolina"].rank == -1
        assert moved["Duke"].rank == 0

    def test_the_record_is_what_the_week_produced(self) -> None:
        _, moved = movement(LAST_WEEK, TODAY)
        assert (moved["North Carolina"].wins, moved["North Carolina"].losses) == (1, 1)
        assert (moved["Duke"].wins, moved["Duke"].losses) == (2, 0)

    def test_a_team_with_no_row_last_week_has_no_movement(self) -> None:
        """Its first game was this week. "Up 1500 points" is not what
        happened."""
        standings = [*TODAY, Standing("Vermont", 4, 1500.0, 1, 0)]
        _, moved = movement(LAST_WEEK, standings)
        assert "Vermont" not in moved

    def test_last_week_is_ranked_over_the_teams_shown_today(self) -> None:
        """A team that has since dropped off the table can't be counted in a
        rank the reader is meant to check against the page. Houston was third
        of three by rating last week; adding a fourth team that isn't in
        today's standings must not make it fourth."""
        with_ghost = pd.concat(
            [LAST_WEEK, history(("Chicago State", 2026, 1, WEEK1, 1820.0, 20, 6))],
            ignore_index=True,
        )
        _, moved = movement(with_ghost, TODAY)
        assert moved["Houston"].rank == 1

    def test_no_comparison_week_means_no_movement_at_all(self) -> None:
        only_week = history(("Duke", 2026, 1, WEEK1, 1810.0, 22, 5))
        window, moved = movement(only_week, TODAY)
        assert window is None
        assert moved == {}

    def test_a_week_sharing_no_teams_with_the_table_is_not_a_comparison(
        self,
    ) -> None:
        """A model whose history is about somebody else entirely -- the wrong
        file, or a league renamed under it. Ranking one against the other
        would produce a full column of nonsense."""
        elsewhere = history(
            ("Vermont", 2026, 1, WEEK1, 1500.0, 1, 0),
            ("Vermont", 2026, 2, WEEK2, 1510.0, 2, 0),
        )
        window, moved = movement(elsewhere, TODAY)
        assert window is None
        assert moved == {}
