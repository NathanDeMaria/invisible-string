"""Writes the OpenAPI schema to a file.

Committed to the repo so the frontend can generate types from it without
running Python, and so a change to a response model that nobody regenerated
shows up as a diff in CI rather than as `undefined` in a browser.
"""

import json
import sys
from pathlib import Path

from app.main import create_app


def main(destination: str) -> None:
    schema = create_app().openapi()
    Path(destination).write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
