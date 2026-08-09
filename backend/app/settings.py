from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INVISIBLE_STRING_", frozen=True)

    # Set this and releases are read from S3; leave it unset and they're read
    # from `releases_root` on disk. Local is what tests and `make run` use, so
    # neither needs AWS.
    releases_bucket: str | None = None
    releases_prefix: str = "models/"

    # How long a cached release is served before S3 is re-checked. The
    # re-check is a conditional GET, so a cheap 304 in the common case.
    releases_cache_ttl_seconds: float = 60.0

    # Used only when releases_bucket is unset.
    releases_root: Path = Path("./data")

    # The built frontend. Present in the container image; absent in local
    # dev, where vite serves the app and proxies /api here.
    static_dir: Path = Path("./static")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
