"""Serving the built React app from FastAPI.

One container serves both the API and the SPA (DESIGN.md section 4), so there's
no CORS, no CloudFront, and one thing to deploy.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def mount_spa(app: FastAPI, static_dir: Path) -> None:
    """Serve `static_dir` at /, falling back to index.html for client routes.

    Must be called *after* the API routers are registered: FastAPI matches in
    registration order, and the catch-all below would otherwise swallow them.
    """
    index = static_dir / "index.html"
    assets = static_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{requested_path:path}", include_in_schema=False)
    def spa(requested_path: str) -> FileResponse:
        # /api/does-not-exist should 404 as JSON, not hand back the HTML shell.
        # Without this the catch-all turns every API typo into a 200 that the
        # client then fails to parse.
        if requested_path == "api" or requested_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")

        candidate = (static_dir / requested_path).resolve()
        # `requested_path` comes off the wire, so confirm it stayed inside
        # static_dir before serving it -- otherwise ../ walks out of the mount.
        inside = candidate.is_relative_to(static_dir.resolve())
        if requested_path and inside and candidate.is_file():
            return FileResponse(candidate)

        # Anything else is a client-side route; React Router sorts it out.
        return FileResponse(index)
