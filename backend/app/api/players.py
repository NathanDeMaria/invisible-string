from datetime import date

from cassandra.players import PlayerRow
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.players import (
    PlayersStore,
    PlayersUnreadable,
    default_season,
    get_players_store,
)

router = APIRouter(prefix="/api")


class PlayersResponse(BaseModel):
    league: str
    # Named for the year it starts; None for a league with no players at all.
    season: int | None
    default_season: int | None
    seasons: list[int]
    # The morning this table stands for; None for a finished season.
    as_of: date | None
    # Everyone, however little he's played: the page's floor is a reader's to
    # move, so it's applied there rather than here.
    players: list[PlayerRow]


@router.get("/leagues/{league}/players")
def get_players(
    league: str,
    season: int | None = Query(
        default=None, description="Defaults to the current season."
    ),
    store: PlayersStore = Depends(get_players_store),
) -> PlayersResponse:
    seasons = store.list_seasons(league)
    default = default_season(seasons, date.today())
    chosen = default if season is None else season
    if chosen is None:
        return PlayersResponse(
            league=league,
            season=None,
            default_season=None,
            seasons=[],
            as_of=None,
            players=[],
        )
    try:
        stored = store.get_players(league, chosen)
    except PlayersUnreadable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if stored is None:
        raise HTTPException(status_code=404, detail=f"no players for {league} {chosen}")
    return PlayersResponse(
        league=league,
        season=chosen,
        default_season=default,
        seasons=seasons,
        as_of=stored.as_of,
        players=stored.players,
    )
