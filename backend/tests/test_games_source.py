"""The AWS games source: season pickles in, a window of games out.

moto rather than a stub, for the reason `test_batch_source` uses it: the code
under test is made of listing semantics -- delimiters, common prefixes, ETags,
LastModified ordering -- and a stub of those would only prove the stub matched
itself. The season pickles are real ones built from endgame's own
`Season`/`Week`/`Game`, because this unpickles a foreign object graph.
"""

import json
import pickle
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError
from endgame.ncaabb.ncaabb import Season
from endgame.types import Game, Week
from moto import mock_aws

from app.games import (
    GAME_TZ,
    MAX_DAYS_AHEAD,
    MAX_DAYS_BACK,
    GamesUnavailable,
    window_bounds,
)
from app.seasons import AwsGamesSource

BUCKET = "endgame-data"


def game(
    day: datetime,
    *,
    gid: str,
    completed: bool = True,
    home: str = "Duke",
    away: str = "North Carolina",
) -> Game:
    return Game(
        home=home,
        home_score=78 if completed else 0,
        away=away,
        away_score=71 if completed else 0,
        neutral_site=False,
        completed=completed,
        date=day,
        game_id=gid,
    )


def season_pickle(games: list[Game], year: int = 2026) -> bytes:
    """What `save_to_s3` writes: a pickled *list* of seasons."""
    return pickle.dumps([Season([Week(games, 1)], year)])


def odds_pull(*entries: tuple[str, float]) -> bytes:
    """What an `odds` job writes: endgame's `espn_odds.Odds` entries."""
    return json.dumps(
        [
            {"competition_id": gid, "odds": [{"spread": spread, "details": "x"}]}
            for gid, spread in entries
        ]
    ).encode()


class CountingS3:
    """Passes everything through to moto, counting reads by key prefix."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.gets: list[str] = []

    def gets_under(self, prefix: str) -> int:
        return sum(1 for key in self.gets if key.startswith(prefix))

    def get_object(self, **kwargs: Any) -> Any:
        self.gets.append(kwargs["Key"])
        return self._inner.get_object(**kwargs)

    def get_paginator(self, name: str) -> Any:
        return self._inner.get_paginator(name)


class DeniesGetsUnder:
    """Reads everything except one prefix, the way a missing grant would."""

    def __init__(self, inner: Any, prefix: str) -> None:
        self._inner = inner
        self._prefix = prefix

    def get_object(self, **kwargs: Any) -> Any:
        if kwargs["Key"].startswith(self._prefix):
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        return self._inner.get_object(**kwargs)

    def get_paginator(self, name: str) -> Any:
        return self._inner.get_paginator(name)


class BrokenS3:
    def get_paginator(self, name: str) -> Any:
        raise ClientError({"Error": {"Code": "AccessDenied"}}, "ListObjectsV2")


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-2")
        client.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-east-2"},
        )
        today = datetime.now(GAME_TZ).date()
        yesterday = today - timedelta(days=1)

        def put(key: str, body: bytes) -> None:
            client.put_object(Bucket=BUCKET, Key=key, Body=body)

        # Naive datetimes, which is how a season file can carry them.
        midnight = datetime.combine(today, datetime.min.time())
        put(
            "seasons/2026/mens.pkl",
            season_pickle(
                [
                    game(midnight.replace(hour=19), gid="tonight", completed=False),
                    game(midnight.replace(hour=13), gid="today"),
                    game(midnight - timedelta(days=1), gid="yesterday"),
                    game(midnight + timedelta(days=1), gid="tomorrow", completed=False),
                    game(midnight - timedelta(days=30), gid="ancient"),
                ]
            ),
        )
        put(
            "seasons/2026/nfl.pkl",
            season_pickle(
                [game(midnight.replace(hour=12), gid="nfl-today")],
            ),
        )
        # An older season, still in the bucket. Nothing in it is in the window.
        put(
            "seasons/2025/mens.pkl",
            season_pickle([game(midnight - timedelta(days=300), gid="last-season")]),
        )
        # The CSVs beside a season. Not games, and never opened.
        put("seasons/2026/mens.csv", b"a,b\n1,2\n")

        # Two pulls yesterday: the first has a game the last one had already
        # dropped, which is the case `_first_and_last` exists for.
        put(f"odds/ncaabb/{yesterday}/10-00.json", odds_pull(("yesterday", -6.5)))
        put(f"odds/ncaabb/{yesterday}/22-00.json", odds_pull(("today", -3.0)))
        # Today's board, posted after yesterday's: it re-prices "today".
        put(f"odds/ncaabb/{today}/10-00.json", odds_pull(("today", -4.5)))
        put(f"odds/nfl/{today}/10-00.json", odds_pull(("nfl-today", 2.5)))

        yield client


@pytest.fixture
def source(s3: Any) -> AwsGamesSource:
    return AwsGamesSource(bucket=BUCKET, s3_client=s3)


def ids(source: AwsGamesSource, back: int = 2, ahead: int = 1) -> set[str]:
    return {g.game_id for g in source.window(back, ahead).games}


class TestGames:
    def test_reads_the_window_out_of_the_season_files(
        self, source: AwsGamesSource
    ) -> None:
        assert ids(source) == {
            "tonight",
            "today",
            "yesterday",
            "tomorrow",
            "nfl-today",
        }

    def test_leaves_the_rest_of_the_season_alone(self, source: AwsGamesSource) -> None:
        # A season file is the whole schedule; the window is the point.
        assert "ancient" not in ids(source)
        assert "last-season" not in ids(source)

    def test_the_league_comes_from_the_key(self, source: AwsGamesSource) -> None:
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["today"].league == "mens"
        assert by_id["nfl-today"].league == "nfl"

    def test_unplayed_games_have_no_score(self, source: AwsGamesSource) -> None:
        """The season file stores 0-0 for them, and 0-0 is a score."""
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["tonight"].home_score is None
        assert by_id["today"].home_score == 78

    def test_games_are_chronological(self, source: AwsGamesSource) -> None:
        starts = [g.start for g in source.window(2, 1).games]
        assert starts == sorted(starts)

    def test_a_season_that_wont_unpickle_costs_only_its_league(self, s3: Any) -> None:
        s3.put_object(Bucket=BUCKET, Key="seasons/2026/mens.pkl", Body=b"not a pickle")
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        assert ids(source) == {"nfl-today"}

    def test_a_denied_season_get_costs_only_its_league(self, s3: Any) -> None:
        # What a missing `s3:GetObject` on seasons/* looks like: the odds and
        # the other leagues still render.
        source = AwsGamesSource(
            bucket=BUCKET, s3_client=DeniesGetsUnder(s3, "seasons/2026/mens")
        )
        assert ids(source) == {"nfl-today"}

    def test_a_denied_listing_is_not_an_empty_window(self) -> None:
        with pytest.raises(GamesUnavailable):
            AwsGamesSource(bucket=BUCKET, s3_client=BrokenS3()).window(2, 1)


class TestSpreads:
    def test_joins_the_line_by_game_id(self, source: AwsGamesSource) -> None:
        """No mapping between the two ways ncaabb is keyed.

        Games come from `mens.pkl` and odds from `odds/ncaabb/`; the
        competition id is the same on both sides.
        """
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["yesterday"].market_spread == -6.5
        assert by_id["nfl-today"].market_spread == 2.5

    def test_the_freshest_pull_wins(self, source: AwsGamesSource) -> None:
        # "today" was priced at -3.0 in yesterday's last pull and -4.5 in
        # today's, and days are walked oldest first.
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["today"].market_spread == -4.5

    def test_a_game_with_no_line_says_so(self, source: AwsGamesSource) -> None:
        # None rather than 0.0: a missing line and a pick'em are different
        # claims, and only one of them is a bet.
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["tomorrow"].market_spread is None

    def test_a_pull_that_wont_parse_costs_only_its_line(self, s3: Any) -> None:
        today = datetime.now(GAME_TZ).date()
        s3.put_object(
            Bucket=BUCKET, Key=f"odds/nfl/{today}/10-00.json", Body=b"{not json"
        )
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["nfl-today"].market_spread is None
        assert by_id["today"].market_spread == -4.5

    def test_an_entry_without_a_spread_is_skipped(self, s3: Any) -> None:
        today = datetime.now(GAME_TZ).date()
        s3.put_object(
            Bucket=BUCKET,
            Key=f"odds/nfl/{today}/10-00.json",
            # A game on the board with no line posted yet -- ESPN's own shape.
            Body=json.dumps([{"competition_id": "nfl-today", "odds": []}]).encode(),
        )
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        by_id = {g.game_id: g for g in source.window(2, 1).games}
        assert by_id["nfl-today"].market_spread is None


class TestCaching:
    def test_a_season_is_read_once_across_windows(self, s3: Any) -> None:
        """The ETag, not the TTL, is what makes this page affordable.

        A season object is rewritten once a day; between rewrites moving the
        window picker must not re-download twenty megabytes.
        """
        counting = CountingS3(s3)
        source = AwsGamesSource(bucket=BUCKET, ttl_seconds=0, s3_client=counting)
        source.window(2, 1)
        first = counting.gets_under("seasons/")
        source.window(1, 0)
        assert counting.gets_under("seasons/") == first

    def test_a_rewritten_season_is_read_again(self, s3: Any) -> None:
        counting = CountingS3(s3)
        source = AwsGamesSource(bucket=BUCKET, ttl_seconds=0, s3_client=counting)
        source.window(2, 1)
        before = counting.gets_under("seasons/")

        midnight = datetime.combine(datetime.now(GAME_TZ).date(), datetime.min.time())
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/mens.pkl",
            Body=season_pickle([game(midnight, gid="rescraped")]),
        )
        assert "rescraped" in ids(source)
        assert counting.gets_under("seasons/") > before

    def test_the_window_itself_is_cached(self, s3: Any) -> None:
        counting = CountingS3(s3)
        source = AwsGamesSource(bucket=BUCKET, ttl_seconds=300, s3_client=counting)
        source.window(2, 1)
        before = len(counting.gets)
        source.window(2, 1)
        # Not even the odds, which have no ETag check in front of them.
        assert len(counting.gets) == before

    def test_only_two_pulls_a_day_are_opened(self, s3: Any) -> None:
        """Thirteen hourly pulls a day per league, across four days, is ~200
        objects for a number that moves by half a point."""
        today = datetime.now(GAME_TZ).date()
        for hour in range(10, 23):
            s3.put_object(
                Bucket=BUCKET,
                Key=f"odds/nfl/{today}/{hour}-00.json",
                Body=odds_pull(("nfl-today", 2.5)),
            )
        counting = CountingS3(s3)
        source = AwsGamesSource(bucket=BUCKET, s3_client=counting)
        source.window(0, 0)
        assert counting.gets_under(f"odds/nfl/{today}/") == 2


class TestOnlyReadsTheWindow:
    """The bug that took the endpoint down in production.

    A season file is the whole schedule, and no request this API accepts can
    reach past a week either side of today. Building a row for every game in
    the file spent hundreds of megabytes on a 0.5 GB service to answer about
    fifteen days of it -- and the cache held them, for every league and both
    seasons, so the first request killed the container every time.

    `app.batch` walks these same objects without trouble because it keeps a
    count per day and drops the graph. These assert this one keeps as little.
    """

    def test_a_game_outside_the_horizon_is_never_materialized(self, s3: Any) -> None:
        today = datetime.now(GAME_TZ).date()
        midnight = datetime.combine(today, datetime.min.time())
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/mens.pkl",
            Body=season_pickle(
                [
                    game(midnight, gid="today"),
                    game(midnight - timedelta(days=200), gid="november"),
                    game(midnight + timedelta(days=100), gid="march"),
                ]
            ),
        )
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        horizon = window_bounds(MAX_DAYS_BACK, MAX_DAYS_AHEAD)
        season = source._read_season("seasons/2026/mens.pkl", "mens", horizon)

        assert season is not None
        # Not "filtered out of the response" -- never built at all, which is
        # the difference between 3 MB and 300 MB on a full season.
        kept = {row.game_id for rows in season.by_day.values() for row in rows}
        assert kept == {"today"}

    def test_the_cache_is_bounded_by_the_window_cap(self, s3: Any) -> None:
        today = datetime.now(GAME_TZ).date()
        midnight = datetime.combine(today, datetime.min.time())
        # A season's worth of games, one an hour across a year.
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/mens.pkl",
            Body=season_pickle(
                [
                    game(
                        midnight - timedelta(days=180) + timedelta(hours=i), gid=str(i)
                    )
                    for i in range(0, 24 * 360, 6)
                ]
            ),
        )
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        source.window(MAX_DAYS_BACK, MAX_DAYS_AHEAD)

        _, season = source._seasons["seasons/2026/mens.pkl"]
        span = MAX_DAYS_BACK + MAX_DAYS_AHEAD + 1
        assert len(season.by_day) <= span

    def test_a_widened_horizon_is_re_read(self, s3: Any) -> None:
        """The horizon moves at midnight, and the ETag doesn't.

        A cache entry that still matches on ETag can stop covering the days
        being asked about, which would quietly serve an empty day.
        """
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        today = datetime.now(GAME_TZ).date()
        narrow = (today, today)
        source._season_games("seasons/2026/mens.pkl", "mens", "etag", narrow)

        wide = window_bounds(MAX_DAYS_BACK, MAX_DAYS_AHEAD)
        season = source._season_games("seasons/2026/mens.pkl", "mens", "etag", wide)

        assert season is not None
        assert season.covers(wide)
        assert "yesterday" in {
            row.game_id for rows in season.by_day.values() for row in rows
        }


class TestOneBadGame:
    """A `Game` this build can't read costs that game, not the page.

    The walk used to sit outside every guard, so one field changing type
    upstream would escape as a 500 from an endpoint whose whole design is to
    degrade instead.
    """

    def test_a_game_that_wont_convert_is_skipped(self, s3: Any) -> None:
        today = datetime.now(GAME_TZ).date()
        midnight = datetime.combine(today, datetime.min.time())
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/mens.pkl",
            Body=season_pickle(
                [
                    game(midnight, gid="fine"),
                    # What a field changing type upstream looks like from
                    # here. The checker is right that this is ill-typed --
                    # that is the point, and the bucket holds what it holds.
                    game(midnight, gid="fine")._replace(game_id=90210),  # ty: ignore[invalid-argument-type]
                ]
            ),
        )
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        assert "fine" in ids(source)

    def test_a_season_that_wont_walk_costs_only_its_league(self, s3: Any) -> None:
        today = datetime.now(GAME_TZ).date()
        midnight = datetime.combine(today, datetime.min.time())
        # A week whose games aren't iterable: the shape is wrong rather than
        # the bytes, which unpickles fine and then explodes.
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/mens.pkl",
            Body=pickle.dumps(
                [Season([Week(None, 1)], 2026)]  # ty: ignore[invalid-argument-type]
            ),
        )
        s3.put_object(
            Bucket=BUCKET,
            Key="seasons/2026/nfl.pkl",
            Body=season_pickle([game(midnight, gid="nfl-today")]),
        )
        source = AwsGamesSource(bucket=BUCKET, s3_client=s3)
        assert ids(source) == {"nfl-today"}
