import json
from collections.abc import Iterator
from datetime import date
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.main import create_app
from app.players import (
    LocalPlayersStore,
    PlayersUnreadable,
    S3PlayersStore,
    default_season,
    get_players_store,
)

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


class TestTheEndpoint:
    def test_a_season_when_asked(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/players?season=2025").json()
        assert body["season"] == 2025 and body["as_of"] is None
        assert body["seasons"] == [2025, 2026]
        assert [p["player"] for p in body["players"]] == ["Pat Star", "Sam Deep"]

    def test_the_players_a_floor_would_hide_still_arrive(
        self, client: TestClient
    ) -> None:
        body = client.get("/api/leagues/mens/players?season=2025").json()
        assert min(p["share"] for p in body["players"]) == 0.05

    def test_a_player_yet_to_play_is_marked(self, client: TestClient) -> None:
        body = client.get("/api/leagues/mens/players?season=2026").json()
        assert body["as_of"] == "2026-11-05"
        assert [p["projected"] for p in body["players"]] == [False, True]

    def test_a_league_with_no_players_is_empty(self, client: TestClient) -> None:
        body = client.get("/api/leagues/nfl/players").json()
        assert body["season"] is None and body["players"] == []

    def test_a_season_with_no_file_is_a_404(self, client: TestClient) -> None:
        assert client.get("/api/leagues/mens/players?season=1999").status_code == 404

    def test_an_unreadable_file_is_a_503(self, tmp_path: Any) -> None:
        (tmp_path / "models" / "mens").mkdir(parents=True)
        (tmp_path / "models" / "mens" / "players_2025.json").write_text("{}")
        app = create_app()
        app.dependency_overrides[get_players_store] = lambda: LocalPlayersStore(
            tmp_path
        )
        response = TestClient(app).get("/api/leagues/mens/players?season=2025")
        assert response.status_code == 503


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
                Key=f"models/mens/{path.name}",
                Body=path.read_bytes(),
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
        assert found is not None and found.players[1].player == "New Guy"
        assert store.get_players("mens", 1999) is None

    def test_a_morning_shows_after_the_ttl(self, s3: Any) -> None:
        store = S3PlayersStore(BUCKET, ttl_seconds=0.0, client=s3)
        assert store.get_players("mens", 2026) is not None
        assert store.get_players("mens", 2026) is not None
        body = {"league": "mens", "season": 2026, "as_of": "2026-11-06", "players": []}
        s3.put_object(
            Bucket=BUCKET,
            Key="models/mens/players_2026.json",
            Body=json.dumps(body).encode(),
        )
        found = store.get_players("mens", 2026)
        assert found is not None and found.as_of == date(2026, 11, 6)

    def test_an_unreadable_file_is_not_cached_as_a_season(self, s3: Any) -> None:
        s3.put_object(Bucket=BUCKET, Key="models/mens/players_2024.json", Body=b"{}")
        store = S3PlayersStore(BUCKET, client=s3)
        with pytest.raises(PlayersUnreadable):
            store.get_players("mens", 2024)
