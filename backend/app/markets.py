"""The prediction markets' number on a game: gold-rush's prices, as a probability.

gold-rush writes Kalshi's and Polymarket's hourly prices on every game it
matched to ESPN into the same bucket as the seasons and odds:

    markets/{venue}/{league}/{YYYY-MM-DD}.json     one ESPN game day, US Eastern

keyed by ESPN's game id, so a market price joins a season file's game the way
an odds pull does -- by id, with no mapping in between. This reads one day's
file into `game_id -> the market's home win probability`.

The number is cassandra's, computed the same way so the page and a release's
`market_brier_score` agree (`cassandra.markets`, which the webapp can't import:
it reads the bucket through `endgame_aws`, which a serving install leaves out):

- **The price a bettor would pay.** Kalshi's ask plus its taker fee, since
  Kalshi keeps an order book per team and the ask is what buying costs;
  Polymarket's one number, since that's all it keeps.
- **With the margin taken out.** The two sides' costs sum past a dollar on
  Kalshi, so the home side's share of the sum is the probability -- the same
  no-vig normalization a sportsbook's two prices get.
- **At the last hour before kickoff** that has both sides, skipping any hour
  whose two sides cost more than `MAX_OVERROUND` together: a Kalshi market
  opens days out with asks near a dollar both ways, and no-vig on that is a
  coin flip whatever the game.

For a game that hasn't started, "the last hour before kickoff" is the latest
one there is, so a file written during the day carries the current price. As
of this writing gold-rush pulls each day's games the morning after, so in
practice only finished games have a number; a pull that writes today's file
fills the rest in with nothing here changing.
"""

import json
import logging
from datetime import datetime
from typing import Any

log = logging.getLogger(__name__)

# Preference order: a game both venues priced takes Kalshi's number. Its close
# is an ask on a quoted book, a price somebody could have paid.
VENUES = ("kalshi", "polymarket")

# Kalshi's taker fee is this times price times (1 - price), per contract.
KALSHI_TAKER_FEE_RATE = 0.07

# The most a game's two sides may cost together for the hour to count as a
# price. Closes run 1.02-1.07; a market nobody is making yet runs to 1.9.
MAX_OVERROUND = 1.10

_HOUR = 3600


def home_probabilities(raw: bytes, venue: str) -> dict[str, float]:
    """One day file, as game_id -> the market's home win probability.

    Best-effort in the way `app.seasons._parse_odds` is: a file or a game that
    doesn't have the expected shape costs those games their number and nothing
    else, since the schedule and scores around them still render.
    """
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    fields = parsed.get("fields")
    games = parsed.get("games")
    if not isinstance(fields, list) or not isinstance(games, list):
        return {}
    probabilities: dict[str, float] = {}
    for game in games:
        try:
            found = _close(game, venue, fields)
        except (KeyError, TypeError, ValueError, IndexError):
            found = None
        if found is not None:
            probabilities[str(game["game_id"])] = found
    return probabilities


def _close(game: dict[str, Any], venue: str, fields: list[str]) -> float | None:
    kickoff = datetime.fromisoformat(game["kickoff"]).timestamp()
    at = fields.index("at")
    column = fields.index("ask" if venue == "kalshi" else "price")

    hours: dict[int, dict[str, tuple[float, float]]] = {}
    for side in ("home", "away"):
        for row in game[side]["prices"]:
            stamp, value = float(row[at]), row[column]
            if value is None or not 0 < value < 1:
                continue
            cost = value + _fee(value) if venue == "kalshi" else float(value)
            hours.setdefault(round(stamp / _HOUR), {})[side] = (stamp, cost)

    close = None
    for hour in sorted(hours):
        sides = hours[hour]
        if "home" not in sides or "away" not in sides:
            continue
        (home_at, home), (away_at, away) = sides["home"], sides["away"]
        if max(home_at, away_at) >= kickoff or home + away > MAX_OVERROUND:
            continue
        close = home / (home + away)
    return close


def _fee(price: float) -> float:
    return KALSHI_TAKER_FEE_RATE * price * (1 - price)
