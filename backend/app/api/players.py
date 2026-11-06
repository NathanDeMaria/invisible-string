import gzip
from datetime import date

from cassandra.players import PlayersFile
from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel

from app.players import PlayersStore, default_season, get_players_store

router = APIRouter(prefix="/api")


class PlayerSeasons(BaseModel):
    league: str
    # Each named for the year it starts. Empty for a league with no players.
    seasons: list[int]
    default_season: int | None


@router.get("/leagues/{league}/players/seasons")
def get_player_seasons(
    league: str, store: PlayersStore = Depends(get_players_store)
) -> PlayerSeasons:
    seasons = store.list_seasons(league)
    return PlayerSeasons(
        league=league,
        seasons=seasons,
        default_season=default_season(seasons, date.today()),
    )


@router.get("/leagues/{league}/players/{season}", response_model=PlayersFile)
def get_players(
    league: str,
    season: int,
    accept_encoding: str = Header(default=""),
    store: PlayersStore = Depends(get_players_store),
) -> Response:
    """Everyone, however little he's played: the page's floor is a reader's to
    move, so it's applied there. The published bytes as they are (`app.players`),
    unzipped only for a client that can't take them."""
    body = store.get_players(league, season)
    if body is None:
        raise HTTPException(status_code=404, detail=f"no players for {league} {season}")
    headers = {"Vary": "Accept-Encoding"}
    if "gzip" in accept_encoding:
        headers["Content-Encoding"] = "gzip"
    else:
        body = gzip.decompress(body)
    return Response(body, media_type="application/json", headers=headers)
