"""A basketball release rebuilt with the league's home crowds prices the big
building's home side higher, as the model that was scored did."""

import json

import pytest
from cassandra.predictor import (
    GlickoPredictor,
    PlayerRatingIndex,
    Predictor,
    predict_matchup,
)
from cassandra.predictor.crowds import CrowdIndex

from app.releases import ReleaseUnreadable, parse_crowds, with_players
from app.schema import ModelRelease


def _crowds(teams: dict[str, float]) -> CrowdIndex:
    return parse_crowds(
        json.dumps({"league": "mens", "as_of": "2026-11-12", "teams": teams}), "mens"
    )


def test_a_malformed_file_is_unreadable() -> None:
    with pytest.raises(ReleaseUnreadable):
        parse_crowds("{}", "mens")


def test_the_crowd_scales_the_home_edge() -> None:
    plain = GlickoPredictor("mens", home_crowd_slope=15)
    release = ModelRelease.model_construct(
        league="mens", params={"home_crowd_slope": 15}
    )
    predictor = with_players(
        release, plain, PlayerRatingIndex(), _crowds({"Duke": 1.0})
    )
    assert predictor is not plain

    def prob(p: Predictor, home: str) -> float:
        return predict_matchup(p, home=home, away="Away").team1_win_prob

    assert prob(predictor, "Duke") > prob(predictor, "Other")


def test_nothing_to_read_leaves_the_predictor_alone() -> None:
    plain = GlickoPredictor("mens")
    release = ModelRelease.model_construct(league="mens", params={})
    assert with_players(release, plain, PlayerRatingIndex(), CrowdIndex()) is plain
