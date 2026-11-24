from fastapi import FastAPI

from app.api.distributions import router as distributions_router
from app.api.games import router as games_router
from app.api.history import router as history_router
from app.api.jobs import router as jobs_router
from app.api.players import router as players_router
from app.api.predict import router as predict_router
from app.api.ratings import router as ratings_router
from app.api.session import router as session_router
from app.api.team_games import router as team_games_router
from app.api.win_probability import router as win_probability_router
from app.auth import install_login
from app.settings import get_settings
from app.spa import mount_spa


def create_app() -> FastAPI:
    app = FastAPI(title="invisible-string", version="0.1.0")
    app.include_router(ratings_router)
    app.include_router(history_router)
    app.include_router(predict_router)
    app.include_router(jobs_router)
    app.include_router(games_router)
    app.include_router(team_games_router)
    app.include_router(distributions_router)
    app.include_router(win_probability_router)
    app.include_router(players_router)
    app.include_router(session_router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # Before the SPA: its catch-all would otherwise answer /login.
    settings = get_settings()
    if settings.password is not None:
        install_login(
            app,
            settings.password.get_secret_value(),
            secure_cookie=settings.secure_cookie,
        )
    elif settings.login_required:
        raise RuntimeError(
            "INVISIBLE_STRING_LOGIN_REQUIRED is set but INVISIBLE_STRING_PASSWORD "
            "is not; refusing to serve the site without a login"
        )

    # Only when a build is present. Running the API bare (tests, `make run`
    # alongside the vite dev server) is the normal local case.
    static_dir = settings.static_dir
    if static_dir.is_dir():
        mount_spa(app, static_dir)

    return app


app = create_app()
