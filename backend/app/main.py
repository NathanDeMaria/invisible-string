from fastapi import FastAPI

from app.api.games import router as games_router
from app.api.jobs import router as jobs_router
from app.api.predict import router as predict_router
from app.api.ratings import router as ratings_router
from app.settings import get_settings
from app.spa import mount_spa


def create_app() -> FastAPI:
    app = FastAPI(title="invisible-string", version="0.1.0")
    app.include_router(ratings_router)
    app.include_router(predict_router)
    app.include_router(jobs_router)
    app.include_router(games_router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    # Only when a build is present. Running the API bare (tests, `make run`
    # alongside the vite dev server) is the normal local case.
    static_dir = get_settings().static_dir
    if static_dir.is_dir():
        mount_spa(app, static_dir)

    return app


app = create_app()
