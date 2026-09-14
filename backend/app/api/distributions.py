"""The shape of a league's metrics, so a page can say where a game sits.

One small object per league, served whole. The page holds the metrics already
-- they come back inside the win probability response it had to fetch anyway
-- so what it is missing is only the population to measure them against, and
that is the same hundred checkpoints for every game of the season.

**Served rather than applied.** This endpoint hands over the distribution and
the browser does the lookup, which is what makes it cost one cached request
per league instead of one computation per number: a game page labels EPA,
control and anything added later off a single fetch, and this layer never has
to know which metrics that page happens to show. The arithmetic is a search
through a sorted array and an interpolation between two neighbours, which is
not the kind of thing worth a round trip.

**A league with none is a 404, and that is not an error.** Only football has
the play-level metrics these describe; every basketball league here will 404
forever, and the page renders its numbers without labels. Saying so with a
status code rather than an empty body keeps "this league has no
distributions" distinct from "it has some and they are all empty", which is
what a half-built artifact would look like.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from app.distributions import (
    DistributionsNotFound,
    DistributionStore,
    DistributionsUnreadable,
    LeagueDistributions,
    get_distribution_store,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.get("/leagues/{league}/distributions")
def get_distributions(
    league: str,
    store: DistributionStore = Depends(get_distribution_store),
) -> LeagueDistributions:
    """Every metric this league has a published shape for.

    The artifact goes out as it was stored, `seasons` included. A percentile
    is meaningless without the population behind it, and a page that says
    "83rd percentile" while declining to say what of is making a claim it
    can't support -- so the window travels with the numbers rather than being
    a constant the page also happens to know.
    """
    try:
        return store.get(league)
    except DistributionsNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except DistributionsUnreadable as exc:
        # The same 502 the other artifact readers serve: the object is there,
        # we fetched it, and it is the upstream data that's wrong. Nothing a
        # retry fixes and nothing the caller can change.
        log.warning("serving 502 for %s distributions: %s", league, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
