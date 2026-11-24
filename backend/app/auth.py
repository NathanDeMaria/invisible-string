"""One shared password in front of the whole site (DESIGN.md section 3, Auth).

Everything but `/healthz` and the login page itself needs a session cookie.
The cookie is `<issued-at>.<hmac>`, signed with a key derived from the
password, so there is no second secret to keep: changing the password changes
the key, and every cookie signed with the old one stops verifying. That is the
logout-everyone switch, and it's the only revocation there is.

Not logged in, a page request is sent to `/login`, and an API request gets a
401 -- JSON callers want a status to act on, not an HTML form. The SPA turns
that 401 into the same redirect (frontend `services/api.ts`).

Guessing is left to the password's length: it is generated, not chosen
(`infra/login.tf`), so there is nothing to guess. The per-address lockout below
is a backstop against a script hammering the form, not the defence.
"""

import hashlib
import hmac
import time
from collections import deque
from html import escape
from threading import Lock
from urllib.parse import parse_qs, quote

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

COOKIE_NAME = "is_session"
SESSION_SECONDS = 30 * 24 * 3600

# Five wrong passwords from one address in fifteen minutes and that address
# waits out the rest of the window.
MAX_FAILURES = 5
FAILURE_WINDOW_SECONDS = 15 * 60

# Reachable without a session: App Runner's health check, and the way in.
OPEN_PATHS = frozenset({"/healthz", "/login"})


def _signing_key(password: str) -> bytes:
    return hashlib.sha256(b"invisible-string session\0" + password.encode()).digest()


def _sign(key: bytes, issued: int) -> str:
    mac = hmac.new(key, str(issued).encode(), hashlib.sha256).hexdigest()
    return f"{issued}.{mac}"


def session_valid(key: bytes, cookie: str | None, now: float) -> bool:
    if not cookie:
        return False
    issued_text, _, _ = cookie.partition(".")
    if not issued_text.isdigit():
        return False
    issued = int(issued_text)
    if not hmac.compare_digest(_sign(key, issued), cookie):
        return False
    # A cookie from the future is a clock problem or a forgery; neither gets in.
    return issued <= now + 60 and now - issued < SESSION_SECONDS


def safe_next(target: str | None) -> str:
    """Where to send someone after logging in, if it stays on this site.

    `next` comes off the wire, so anything that isn't a plain local path --
    `//evil.example`, `https://...`, `/\\evil.example` -- falls back to `/`
    rather than becoming an open redirect.
    """
    if (
        not target
        or not target.startswith("/")
        or target.startswith("//")
        or "\\" in target
    ):
        return "/"
    return target


def client_address(request: Request) -> str:
    # App Runner's proxy appends the address it saw to X-Forwarded-For, so the
    # last entry is the one a client can't write. Earlier entries are whatever
    # the request arrived with.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


class FailureLimiter:
    """Wrong passwords per address over a sliding window, held in memory.

    Per instance: App Runner can run more than one, and each counts on its
    own. That only multiplies an attacker's guesses by the instance count,
    which against a generated password changes nothing.
    """

    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = {}
        self._lock = Lock()

    def _recent(self, address: str, now: float) -> deque[float]:
        failures = self._failures.setdefault(address, deque())
        while failures and now - failures[0] >= FAILURE_WINDOW_SECONDS:
            failures.popleft()
        return failures

    def blocked(self, address: str, now: float) -> bool:
        with self._lock:
            return len(self._recent(address, now)) >= MAX_FAILURES

    def record(self, address: str, now: float) -> None:
        with self._lock:
            self._recent(address, now).append(now)
            # Drop addresses whose failures have all aged out, so a long-lived
            # instance doesn't keep one entry per address it has ever seen.
            stale = [a for a, f in self._failures.items() if not self._recent(a, now)]
            for a in stale:
                del self._failures[a]


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>invisible-string</title>
<style>
  body {{ font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #f6f6f4; color: #1d1d1b; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1b1b1a; color: #ececea; }}
    input {{ background: #2a2a28; color: inherit; border-color: #555; }}
  }}
  form {{ display: grid; gap: 0.75rem; width: min(20rem, 85vw); }}
  input, button {{ font: inherit; padding: 0.6rem 0.75rem; border-radius: 6px; }}
  input {{ border: 1px solid #bbb; }}
  button {{ border: 0; background: #3b5bdb; color: white; cursor: pointer; }}
  p {{ margin: 0; color: #c92a2a; }}
</style>
</head>
<body>
<form method="post" action="/login">
  <label for="password">Password</label>
  <input id="password" name="password" type="password"
         autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="{next}">
  {message}
  <button type="submit">Log in</button>
</form>
</body>
</html>
"""


def _page(next_path: str, message: str = "", status_code: int = 200) -> HTMLResponse:
    body = _PAGE.format(
        next=escape(next_path, quote=True),
        message=f"<p>{escape(message)}</p>" if message else "",
    )
    return HTMLResponse(body, status_code=status_code)


def install_login(app: FastAPI, password: str, *, secure_cookie: bool = True) -> None:
    """Gate every route on `app` behind `password`.

    Call before the SPA is mounted: its catch-all would otherwise answer
    `/login` with index.html.
    """
    key = _signing_key(password)
    limiter = FailureLimiter()

    @app.get("/login", include_in_schema=False)
    def login_page(request: Request) -> Response:
        next_path = safe_next(request.query_params.get("next"))
        if session_valid(key, request.cookies.get(COOKIE_NAME), time.time()):
            return RedirectResponse(next_path, status_code=303)
        return _page(next_path)

    @app.post("/login", include_in_schema=False)
    async def login(request: Request) -> Response:
        # A plain urlencoded form, parsed by hand: FastAPI's `Form` would pull
        # in python-multipart for one field.
        fields = parse_qs((await request.body()).decode(errors="replace"))
        given = fields.get("password", [""])[0]
        next_path = safe_next(fields.get("next", ["/"])[0])

        now = time.time()
        address = client_address(request)
        if limiter.blocked(address, now):
            return _page(next_path, "Too many attempts. Try again later.", 429)
        if not hmac.compare_digest(given.encode(), password.encode()):
            limiter.record(address, now)
            return _page(next_path, "Wrong password.", 401)

        response = RedirectResponse(next_path, status_code=303)
        response.set_cookie(
            COOKIE_NAME,
            _sign(key, int(now)),
            max_age=SESSION_SECONDS,
            httponly=True,
            secure=secure_cookie,
            samesite="lax",
        )
        return response

    @app.post("/logout", include_in_schema=False)
    def logout() -> Response:
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie(COOKIE_NAME, httponly=True, secure=secure_cookie)
        return response

    async def require_session(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        path = request.url.path
        if path in OPEN_PATHS or session_valid(
            key, request.cookies.get(COOKIE_NAME), time.time()
        ):
            return await call_next(request)
        if path == "/api" or path.startswith("/api/"):
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        target = path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login?next={quote(target)}", status_code=303)

    app.add_middleware(BaseHTTPMiddleware, dispatch=require_session)
