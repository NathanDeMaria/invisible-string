from fastapi import FastAPI

from app.api.ratings import router as ratings_router


def create_app() -> FastAPI:
    app = FastAPI(title="invisible-string", version="0.1.0")
    app.include_router(ratings_router)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
