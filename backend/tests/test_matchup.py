"""The matchup terms as the API states and reads them.

These assert against cassandra's own sources rather than against the dicts
handed to them: what matters is that a predictor asking "is this side's
quarterback out?" gets the answer the reader gave, and the key those questions
are asked under is exactly the thing most likely to drift.
"""

from datetime import UTC, datetime

from app.games import ScheduledGame
from app.matchup import (
    MatchupOverrides,
    has_matchup_terms,
    matchup_game_id,
    played_facts,
    stated_sources,
)

HOME = "Kansas City Chiefs"
AWAY = "Buffalo Bills"


def game(league: str = "nfl", completed: bool = False) -> ScheduledGame:
    return ScheduledGame(
        league=league,
        game_id="401752708",
        start=datetime(2026, 9, 13, 19, 0, tzinfo=UTC),
        home=HOME,
        away=AWAY,
        neutral=False,
        completed=completed,
    )


class Matchup:
    """What `predict_matchup` builds, as the sources will be asked about it."""

    def __init__(self, home: str = HOME, away: str = AWAY) -> None:
        self.home, self.away = home, away
        self.neutral_site = False
        self.date = datetime(2026, 9, 13, 19, 0, tzinfo=UTC)
        self.game_id = f"{away}@{home}"


class TestWhichLeagues:
    def test_football_has_these_terms(self) -> None:
        assert has_matchup_terms("nfl")
        assert has_matchup_terms("ncaafb")

    def test_nothing_else_does(self) -> None:
        """A basketball page should show nothing, not four falses."""
        assert not has_matchup_terms("mens")
        assert not has_matchup_terms("wnba")


class TestTheKey:
    def test_it_is_the_one_predict_matchup_invents(self) -> None:
        """Not ESPN's id. A source keyed by that is never looked up at all.

        The failure this guards is silent: the toggles would move nothing and
        the page would look like a model that ignores quarterbacks.
        """
        assert matchup_game_id(game()) == f"{AWAY}@{HOME}"
        assert matchup_game_id(game()) == Matchup().game_id


class TestStatedQuarterbacks:
    def test_an_out_home_quarterback_is_signed_against_the_home_side(self) -> None:
        sources = stated_sources(game(), MatchupOverrides(qb_out_home=True))
        assert sources.qb_out.differential(Matchup()) == -1.0

    def test_an_out_away_quarterback_is_signed_toward_it(self) -> None:
        sources = stated_sources(game(), MatchupOverrides(qb_out_away=True))
        assert sources.qb_out.differential(Matchup()) == 1.0

    def test_two_missing_quarterbacks_are_nobody_s_edge(self) -> None:
        sources = stated_sources(
            game(), MatchupOverrides(qb_out_home=True, qb_out_away=True)
        )
        assert sources.qb_out.differential(Matchup()) == 0.0

    def test_saying_nothing_leaves_both_fine(self) -> None:
        sources = stated_sources(game(), MatchupOverrides())
        assert sources.qb_out.differential(Matchup()) == 0.0


class TestStatedRest:
    def test_a_rested_home_side_is_signed_toward_it(self) -> None:
        sources = stated_sources(game(), MatchupOverrides(rest_home=True))
        assert sources.rest.rested_side(Matchup()) == 1.0

    def test_a_rested_away_side_is_signed_against_it(self) -> None:
        sources = stated_sources(game(), MatchupOverrides(rest_away=True))
        assert sources.rest.rested_side(Matchup()) == -1.0

    def test_both_off_a_bye_is_neither(self) -> None:
        """Which is what a ledger says when the two breaks are level."""
        sources = stated_sources(
            game(), MatchupOverrides(rest_home=True, rest_away=True)
        )
        assert sources.rest.rested_side(Matchup()) == 0.0

    def test_saying_nothing_leaves_rest_level(self) -> None:
        sources = stated_sources(game(), MatchupOverrides())
        assert sources.rest.rested_side(Matchup()) == 0.0


class TestStatedIsOnlyAboutThisGame:
    def test_another_game_is_untouched(self) -> None:
        """The sources replace the league's, so they must not answer widely."""
        sources = stated_sources(
            game(), MatchupOverrides(qb_out_home=True, rest_home=True)
        )
        other = Matchup(home="Denver Broncos", away="Las Vegas Raiders")

        assert sources.qb_out.differential(other) == 0.0
        assert sources.rest.rested_side(other) == 0.0


class TestWhetherAnythingWasStated:
    def test_all_false_is_the_model_s_own_default(self) -> None:
        """So the request takes the untouched predictor, not a rebuilt one."""
        assert not MatchupOverrides().stated()

    def test_any_flag_counts(self) -> None:
        assert MatchupOverrides(qb_out_home=True).stated()
        assert MatchupOverrides(rest_away=True).stated()


class TestWhatWasTrue:
    def test_a_game_the_index_never_saw_has_both_quarterbacks(self) -> None:
        """Every fixture, and every game of a league with no index built."""
        facts = played_facts(game(completed=True))
        assert (facts.qb_out_home, facts.qb_out_away) == (False, False)

    def test_rest_is_not_known_for_a_played_game(self) -> None:
        """Not False. The window has no room for a bye -- see `MatchupFacts`."""
        facts = played_facts(game(completed=True))
        assert facts.rest_home is None
        assert facts.rest_away is None
