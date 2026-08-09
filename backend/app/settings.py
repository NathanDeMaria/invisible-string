from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INVISIBLE_STRING_", frozen=True)

    # Where release artifacts are read from. A local directory for now; the S3
    # store replaces this with a bucket name in a later change.
    releases_root: Path = Path("./data")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
