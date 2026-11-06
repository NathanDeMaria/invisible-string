import gzip
import json
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.players import S3PlayersStore, default_season

from .conftest import FIXTURES

BUCKET = "invisible-string-artifacts"


class TestDefaultSeason:
    """A season opens in November, and the page moves a month before."""

    @pytest.mark.parametrize(
        ("today", "expected"),
        [
            (date(2026, 9, 30), 2025),
            (date(2026, 10, 1), 2026),
            (date(2026, 11, 6), 2026),
            (date(2027, 3, 15), 2026),
            (date(2027, 9, 30), 2026),
        ],
    )
    def test_it_moves_in_october(self, today: date, expected: int) -> None:
        assert default_season([2024, 2025, 2026, 2027], today) == expected

    def test_a_late_file_leaves_last_season_up(self) -> None:
        assert default_season([2024, 2025], date(2026, 11, 6)) == 2025

    def test_no_seasons_is_no_default(self) -> None:
        assert default_season([], date(2026, 11, 6)) is None


class TestTheEndpoints:
    def test_the_seasons_a_league_has(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/players/seasons").json()
        assert body["seasons"] == [2025, 2026]
        assert body["default_season"] in body["seasons"]

    def test_a_league_with_no_players_has_no_seasons(self, client: TestClient) -> None:
        body = client.get("/api/leagues/nfl/players/seasons").json()
        assert body["seasons"] == [] and body["default_season"] is None

    def test_a_season(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/players/2025").json()
        assert body["season"] == 2025 and body["as_of"] is None
        assert [p["player"] for p in body["players"]] == ["Pat Star", "Sam Deep"]

    def test_the_players_a_floor_would_hide_still_arrive(
        self, client: TestClient
    ) -> None:
        body = client.get("/api/leagues/mens/players/2025").json()
        assert min(p["share"] for p in body["players"]) == 0.05

    def test_a_player_yet_to_play_is_marked(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/players/2026").json()
        assert body["as_of"] == "2026-11-05"
        assert [p["projected"] for p in body["players"]] == [False, True]

    def test_a_season_with_no_file_is_a_404(self, client: TestClient) -> None:
        assert client.get("/api/leagues/mens/players/1999").status_code == 404

    def test_a_browser_gets_the_published_bytes(
        self, client: TestClient, players_root: Path
    ) -> None:
        with client.stream(
            "GET",
            "/api/leagues/mens/players/2025",
            headers={"Accept-Encoding": "gzip"},
        ) as response:
            assert response.headers["content-encoding"] == "gzip"
            sent = b"".join(response.iter_raw())
        stored = players_root / "models" / "mens" / "players_2025.json.gz"
        assert sent == stored.read_bytes()

    def test_a_client_that_cant_take_gzip_gets_json(self, client: TestClient) -> None:
        response = client.get(
            "/api/leagues/mens/players/2025", headers={"Accept-Encoding": "identity"}
        )
        assert "content-encoding" not in response.headers
        assert response.json()["season"] == 2025

    def test_the_schema_still_says_what_a_season_is(self, client: TestClient) -> None:
        paths = client.get("/openapi.json").json()["paths"]
        found = paths["/api/leagues/{league}/players/{season}"]["get"]["responses"]
        schema = found["200"]["content"]["application/json"]["schema"]
        assert schema["$ref"].endswith("/PlayersFile")


def _gz(path: Path) -> bytes:
    return gzip.compress(path.read_bytes())


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-2")
        client.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-east-2"},
        )
        for path in (FIXTURES / "models" / "mens").glob("players_*.json"):
            client.put_object(
                Bucket=BUCKET,
                Key=f"models/mens/{path.name}.gz",
                Body=_gz(path),
            )
        client.put_object(Bucket=BUCKET, Key="models/mens/elo/latest.json", Body=b"{}")
        yield client


class TestS3:
    def test_seasons_are_the_files_and_not_the_models(self, s3: Any) -> None:
        store = S3PlayersStore(BUCKET, client=s3)
        assert store.list_seasons("mens") == [2025, 2026]
        assert store.list_seasons("nfl") == []

    def test_a_season_reads_and_a_missing_one_is_none(self, s3: Any) -> None:
        store = S3PlayersStore(BUCKET, client=s3)
        found = store.get_players("mens", 2026)
        assert found is not None
        assert json.loads(gzip.decompress(found))["players"][1]["player"] == "New Guy"
        assert store.get_players("mens", 1999) is None

    def test_within_the_ttl_s3_is_left_alone(self, s3: Any) -> None:
        store = S3PlayersStore(BUCKET, client=s3)
        first = store.get_players("mens", 2026)
        s3.put_object(
            Bucket=BUCKET, Key="models/mens/players_2026.json.gz", Body=b"new"
        )
        assert store.get_players("mens", 2026) == first

    def test_a_morning_shows_after_the_ttl(self, s3: Any) -> None:
        store = S3PlayersStore(BUCKET, ttl_seconds=0.0, client=s3)
        first = store.get_players("mens", 2026)
        assert store.get_players("mens", 2026) == first
        s3.put_object(
            Bucket=BUCKET, Key="models/mens/players_2026.json.gz", Body=b"new"
        )
        assert store.get_players("mens", 2026) == b"new"
