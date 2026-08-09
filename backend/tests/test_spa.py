from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.ratings import router as ratings_router
from app.releases import ReleaseStore, get_release_store
from app.spa import mount_spa


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div>")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    # Something outside the static dir for the traversal test to aim at.
    (tmp_path.parent / "secret.txt").write_text("do not serve me")
    return tmp_path


@pytest.fixture
def spa_client(static_dir: Path, store: ReleaseStore) -> TestClient:
    app = FastAPI()
    app.include_router(ratings_router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    mount_spa(app, static_dir)
    app.dependency_overrides[get_release_store] = lambda: store
    return TestClient(app)


def test_serves_index_at_root(spa_client: TestClient) -> None:
    response = spa_client.get("/")
    assert response.status_code == 200
    assert "id=root" in response.text


def test_serves_hashed_assets(spa_client: TestClient) -> None:
    assert spa_client.get("/assets/index-abc123.js").status_code == 200


def test_serves_real_files_from_the_root(spa_client: TestClient) -> None:
    assert spa_client.get("/favicon.svg").status_code == 200


def test_client_routes_fall_back_to_index(spa_client: TestClient) -> None:
    """Deep links have to work -- shareable URLs are the point (section 4)."""
    response = spa_client.get("/ratings/mens")
    assert response.status_code == 200
    assert "id=root" in response.text


def test_api_still_wins_over_the_catch_all(spa_client: TestClient) -> None:
    body = spa_client.get("/api/leagues/mens/ratings").json()
    assert body["model"] == "glicko_tuned"


def test_healthz_still_wins_over_the_catch_all(spa_client: TestClient) -> None:
    assert spa_client.get("/healthz").json() == {"status": "ok"}


def test_unknown_api_route_404s_instead_of_serving_html(
    spa_client: TestClient,
) -> None:
    """A catch-all that swallows /api turns every typo into a 200 of HTML,
    which the client then fails to parse somewhere far from the cause."""
    response = spa_client.get("/api/nope")
    assert response.status_code == 404
    assert "id=root" not in response.text


def test_does_not_serve_files_outside_the_static_dir(spa_client: TestClient) -> None:
    """Percent-encoded, because a literal /../ is collapsed by the client
    before it ever reaches the app -- so that spelling tests nothing. Encoded
    dots survive to the route and are decoded into the path parameter, which
    is what the containment check is actually there for.
    """
    response = spa_client.get("/%2e%2e/secret.txt")
    assert "do not serve me" not in response.text
    assert "id=root" in response.text
