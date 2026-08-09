from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.releases import LocalReleaseStore, ReleaseStore, get_release_store

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def store() -> ReleaseStore:
    return LocalReleaseStore(FIXTURES)


@pytest.fixture
def client(store: ReleaseStore) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: store
    return TestClient(app)
