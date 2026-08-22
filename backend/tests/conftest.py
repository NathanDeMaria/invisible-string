from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.jobs import JobsSource, LocalJobsSource, get_jobs_source
from app.main import create_app
from app.releases import LocalReleaseStore, ReleaseStore, get_release_store

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def store() -> ReleaseStore:
    return LocalReleaseStore(FIXTURES)


@pytest.fixture
def jobs_source() -> JobsSource:
    return LocalJobsSource(FIXTURES)


@pytest.fixture
def client(store: ReleaseStore, jobs_source: JobsSource) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_release_store] = lambda: store
    app.dependency_overrides[get_jobs_source] = lambda: jobs_source
    return TestClient(app)
