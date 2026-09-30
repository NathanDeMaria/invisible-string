"""Reading one of gold-rush's day files into the markets' home win probability.

The rules are cassandra's (`cassandra.markets`), and the numbers here are
worked by hand so a drift between the two shows up as a failing test rather
than as a page and a release that disagree about the same game.
"""

import json
from datetime import UTC, datetime, timedelta

import pytest

from app.markets import MAX_OVERROUND, home_probabilities

FIELDS = ["at", "price", "bid", "ask", "volume"]
KICKOFF = datetime(2026, 9, 27, 20, 5, tzinfo=UTC)


def _hour(before: int, seconds: int = 0) -> int:
    top = KICKOFF.replace(minute=0) - timedelta(hours=before)
    return int(top.timestamp()) + seconds


def _day(*games: dict) -> bytes:
    return json.dumps({"fields": FIELDS, "games": list(games)}).encode()


def _game(home_rows: list, away_rows: list, game_id: str = "401") -> dict:
    return {
        "game_id": game_id,
        "kickoff": KICKOFF.isoformat(),
        "home": {"code": "SF", "prices": home_rows},
        "away": {"code": "ARI", "prices": away_rows},
    }


def _no_vig(home: float, away: float) -> float:
    return home / (home + away)


def _kalshi(ask: float) -> float:
    return ask + 0.07 * ask * (1 - ask)


def test_kalshi_is_its_ask_plus_the_fee_with_the_margin_taken_out() -> None:
    # The last trade (0.70) is stale and the bid isn't what buying costs.
    raw = _day(
        _game(
            [[_hour(1), 0.70, 0.77, 0.78, 1.0]],
            [[_hour(1), None, 0.22, 0.23, 1.0]],
        )
    )

    assert home_probabilities(raw, "kalshi") == {
        "401": pytest.approx(_no_vig(_kalshi(0.78), _kalshi(0.23)))
    }


def test_polymarket_is_its_one_price() -> None:
    # One book, so the sides already sum to one. Stamped a few seconds past
    # the hour and not quite together, which is still one hour.
    raw = _day(
        _game(
            [[_hour(1, 17), 0.37, None, None, None]],
            [[_hour(1, 20), 0.63, None, None, None]],
        )
    )

    assert home_probabilities(raw, "polymarket") == {"401": pytest.approx(0.37)}


def test_it_is_the_last_hour_before_kickoff() -> None:
    # The rows run through the game itself; those aren't a price anyone had
    # before it started.
    raw = _day(
        _game(
            [
                [_hour(3), 0.6, 0, 0, 0],
                [_hour(1), 0.7, 0, 0, 0],
                [_hour(-1), 0.99, 0, 0, 0],
            ],
            [
                [_hour(3), 0.4, 0, 0, 0],
                [_hour(1), 0.3, 0, 0, 0],
                [_hour(-1), 0.01, 0, 0, 0],
            ],
        )
    )

    assert home_probabilities(raw, "polymarket") == {"401": pytest.approx(0.7)}


def test_an_hour_too_wide_to_bet_is_passed_over() -> None:
    # The later hour has both asks near a dollar -- no market -- so the close
    # is the hour before it.
    raw = _day(
        _game(
            [[_hour(5), None, 0.6, 0.61, 1.0], [_hour(1), None, 0.05, 0.95, 1.0]],
            [[_hour(5), None, 0.38, 0.39, 1.0], [_hour(1), None, 0.04, 0.94, 1.0]],
        )
    )
    assert _kalshi(0.95) + _kalshi(0.94) > MAX_OVERROUND

    assert home_probabilities(raw, "kalshi") == {
        "401": pytest.approx(_no_vig(_kalshi(0.61), _kalshi(0.39)))
    }


def test_a_game_with_one_side_priced_has_no_number() -> None:
    raw = _day(_game([[_hour(1), 0.6, 0, 0, 0]], []))

    assert home_probabilities(raw, "polymarket") == {}


def test_one_malformed_game_costs_only_itself() -> None:
    good = _game([[_hour(1), 0.6, 0, 0, 0]], [[_hour(1), 0.4, 0, 0, 0]], game_id="1")
    bad = {"game_id": "2", "kickoff": "not a time", "home": {}, "away": {}}

    assert home_probabilities(_day(bad, good), "polymarket") == {
        "1": pytest.approx(0.6)
    }


@pytest.mark.parametrize("raw", [b"{not json", b"[]", b'{"fields": 1, "games": []}'])
def test_a_file_that_wont_parse_is_no_numbers(raw: bytes) -> None:
    assert home_probabilities(raw, "kalshi") == {}
