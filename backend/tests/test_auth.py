"""The shared-password login in front of the site (`app.auth`)."""

from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import auth
from app.auth import (
    COOKIE_NAME,
    MAX_FAILURES,
    SESSION_SECONDS,
    _sign,
    _signing_key,
    install_login,
    safe_next,
    session_valid,
)
from app.main import create_app
from app.settings import get_settings
from app.spa import mount_spa

PASSWORD = "correct horse battery staple"


def _app(static_dir: Path) -> FastAPI:
    app = FastAPI()

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/leagues")
    def leagues() -> list[str]:
        return ["ncaafb"]

    install_login(app, PASSWORD, secure_cookie=False)
    mount_spa(app, static_dir)
    return app


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div>")
    return TestClient(_app(tmp_path), follow_redirects=False)


def _log_in(client: TestClient, password: str = PASSWORD, next_path: str = "/"):
    return client.post(
        "/login",
        data={"password": password, "next": next_path},
        headers={"x-forwarded-for": "203.0.113.7"},
    )


def test_health_check_needs_no_login(client: TestClient) -> None:
    assert client.get("/healthz").status_code == 200


def test_api_without_session_is_401_json(client: TestClient) -> None:
    response = client.get("/api/leagues")
    assert response.status_code == 401
    assert response.json() == {"detail": "Not logged in"}


def test_page_without_session_redirects_to_login(client: TestClient) -> None:
    response = client.get("/ncaafb/teams/42?model=x")
    assert response.status_code == 303
    assert response.headers["location"] == "/login?next=/ncaafb/teams/42%3Fmodel%3Dx"


def test_login_page_is_the_form_not_the_spa(client: TestClient) -> None:
    response = client.get("/login?next=/games")
    assert response.status_code == 200
    assert 'name="password"' in response.text
    assert 'value="/games"' in response.text
    assert "id=root" not in response.text


def test_wrong_password_sets_no_cookie(client: TestClient) -> None:
    response = _log_in(client, "nope")
    assert response.status_code == 401
    assert COOKIE_NAME not in response.cookies
    assert client.get("/api/leagues").status_code == 401


def test_right_password_lets_everything_through(client: TestClient) -> None:
    response = _log_in(client, next_path="/games")
    assert response.status_code == 303
    assert response.headers["location"] == "/games"
    assert client.get("/api/leagues").json() == ["ncaafb"]
    assert "id=root" in client.get("/games").text


def test_cookie_flags(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("")
    app = FastAPI()
    install_login(app, PASSWORD)  # secure by default
    response = TestClient(app, follow_redirects=False).post(
        "/login", data={"password": PASSWORD}
    )
    header = response.headers["set-cookie"].lower()
    assert "httponly" in header
    assert "secure" in header
    assert "samesite=lax" in header
    assert f"max-age={SESSION_SECONDS}" in header


def test_logout_clears_the_session(client: TestClient) -> None:
    _log_in(client)
    response = client.post("/logout")
    assert response.headers["location"] == "/login"
    assert client.get("/api/leagues").status_code == 401


def test_login_page_skips_the_form_when_already_in(client: TestClient) -> None:
    _log_in(client)
    response = client.get("/login?next=/games")
    assert response.status_code == 303
    assert response.headers["location"] == "/games"


def test_lockout_after_repeated_failures(client: TestClient) -> None:
    for _ in range(MAX_FAILURES):
        assert _log_in(client, "nope").status_code == 401
    # Locked out: even the right password is refused for the window.
    response = _log_in(client)
    assert response.status_code == 429
    assert COOKIE_NAME not in response.cookies


def test_lockout_is_per_address(client: TestClient) -> None:
    for _ in range(MAX_FAILURES):
        _log_in(client, "nope")
    response = client.post(
        "/login",
        data={"password": PASSWORD},
        headers={"x-forwarded-for": "198.51.100.9"},
    )
    assert response.status_code == 303


def test_lockout_reads_the_address_the_proxy_appended(client: TestClient) -> None:
    # A client can prepend whatever it likes; the proxy's entry is the last.
    for i in range(MAX_FAILURES):
        client.post(
            "/login",
            data={"password": "nope"},
            headers={"x-forwarded-for": f"10.0.0.{i}, 203.0.113.7"},
        )
    assert _log_in(client).status_code == 429


def test_lockout_expires(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    now = 1_800_000_000.0
    monkeypatch.setattr(auth.time, "time", lambda: now)
    for _ in range(MAX_FAILURES):
        _log_in(client, "nope")
    assert _log_in(client).status_code == 429
    now += auth.FAILURE_WINDOW_SECONDS
    assert _log_in(client).status_code == 303


@pytest.mark.parametrize(
    "target",
    [None, "", "games", "//evil.example", "https://evil.example", "/\\evil.example"],
)
def test_next_never_leaves_the_site(target: str | None) -> None:
    assert safe_next(target) == "/"


def test_next_keeps_a_local_path() -> None:
    assert safe_next("/ncaafb/teams/42?model=x") == "/ncaafb/teams/42?model=x"


def test_session_expires() -> None:
    key = _signing_key(PASSWORD)
    issued = 1_800_000_000
    cookie = _sign(key, issued)
    assert session_valid(key, cookie, issued + SESSION_SECONDS - 1)
    assert not session_valid(key, cookie, issued + SESSION_SECONDS)


def test_session_from_the_future_is_refused() -> None:
    key = _signing_key(PASSWORD)
    assert not session_valid(key, _sign(key, 1_800_000_000), 1_700_000_000)


@pytest.mark.parametrize(
    "cookie", [None, "", "garbage", "123.", ".abc", "1800000000.deadbeef"]
)
def test_malformed_session_is_refused(cookie: str | None) -> None:
    assert not session_valid(_signing_key(PASSWORD), cookie, 1_800_000_000)


def test_changing_the_password_logs_everyone_out() -> None:
    cookie = _sign(_signing_key(PASSWORD), 1_800_000_000)
    assert not session_valid(_signing_key("a new one"), cookie, 1_800_000_000)


@pytest.fixture
def fresh_settings() -> Generator[None]:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_create_app_refuses_required_login_without_password(
    monkeypatch: pytest.MonkeyPatch, fresh_settings: None
) -> None:
    monkeypatch.setenv("INVISIBLE_STRING_LOGIN_REQUIRED", "true")
    monkeypatch.delenv("INVISIBLE_STRING_PASSWORD", raising=False)
    with pytest.raises(RuntimeError, match="refusing"):
        create_app()


def test_create_app_gates_when_password_set(
    monkeypatch: pytest.MonkeyPatch, fresh_settings: None
) -> None:
    monkeypatch.setenv("INVISIBLE_STRING_PASSWORD", PASSWORD)
    client = TestClient(create_app())
    assert client.get("/healthz").status_code == 200
    assert client.get("/api/leagues").status_code == 401


def test_session_says_login_is_off_without_a_password(
    monkeypatch: pytest.MonkeyPatch, fresh_settings: None
) -> None:
    monkeypatch.delenv("INVISIBLE_STRING_PASSWORD", raising=False)
    client = TestClient(create_app())
    assert client.get("/api/session").json() == {"login_enabled": False}


def test_session_says_login_is_on_once_logged_in(
    monkeypatch: pytest.MonkeyPatch, fresh_settings: None
) -> None:
    monkeypatch.setenv("INVISIBLE_STRING_PASSWORD", PASSWORD)
    monkeypatch.setenv("INVISIBLE_STRING_SECURE_COOKIE", "false")
    client = TestClient(create_app())
    assert client.get("/api/session").status_code == 401
    client.post("/login", data={"password": PASSWORD})
    assert client.get("/api/session").json() == {"login_enabled": True}
