"""Whether the site has a login, so the SPA knows to offer a way out of it.

Behind the login itself when there is one (`app.auth`), so answering at all
means the reader is logged in. Without a password -- tests, local dev -- it
says so, and the SPA draws no log-out button that would have nothing to do.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.settings import Settings, get_settings

router = APIRouter(prefix="/api")


class SessionInfo(BaseModel):
    login_enabled: bool


@router.get("/session")
def get_session(settings: Settings = Depends(get_settings)) -> SessionInfo:
    return SessionInfo(login_enabled=settings.password is not None)
