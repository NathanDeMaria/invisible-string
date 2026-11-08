# One image serves the API and the built SPA (DESIGN.md section 4): no CORS, no
# CDN, one thing to deploy. Built from the repo root because it needs both
# frontend/ and backend/.

# ------------------------------------------------------------------------------
# Build the SPA. `npm run build` compiles the committed schema.d.ts, so this
# stage needs no openapi.json and no Python.
# ------------------------------------------------------------------------------
FROM node:22-slim AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ------------------------------------------------------------------------------
# Runtime
# ------------------------------------------------------------------------------
# ------------------------------------------------------------------------------
# Install the Python dependencies
# ------------------------------------------------------------------------------
# A stage of its own, on the full python image, because two of the dependencies
# are git checkouts (cassandra, the-lucky-ones) and uv clones them with the git
# binary the -slim image the app runs on doesn't have. Only the finished
# virtualenv crosses into the runtime stage, so git never ships.
#
# The digest of the *index* for python:3.14-bookworm, the same one cassandra's
# Batch image builds on. Same distro and minor version as the runtime below,
# which is what lets the venv's interpreter and compiled wheels carry over.
FROM python@sha256:b3c121f5b6b446c964c6ea924d9a099e259b29d7b56df82729e33572a31eadcc AS deps

# uv at the version mirrorball pins, copied out of its own image
COPY --from=ghcr.io/astral-sh/uv@sha256:af22a52f5eafef3d78e551599d405c02df61919d18028f0cea8eda93bc9986d0 /uv /uvx /usr/local/bin/

ENV UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /srv

# Dependencies before source, so editing a handler doesn't re-resolve the
# whole tree on every build. `--no-dev` and no project: the app is copied in
# below, not installed.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

# ------------------------------------------------------------------------------
# Runtime
# ------------------------------------------------------------------------------
FROM python:3.14-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/srv/.venv/bin:$PATH

WORKDIR /srv

COPY --from=deps /srv/.venv ./.venv
COPY backend/app ./app
COPY --from=frontend /build/dist ./static

# Where the app reads releases and the SPA from. compose mounts the fixtures
# over the first one for local runs.
ENV INVISIBLE_STRING_RELEASES_ROOT=/srv/data \
    INVISIBLE_STRING_STATIC_DIR=/srv/static

# Non-root: nothing here needs to write to the filesystem.
RUN useradd --system --uid 10001 app && chown -R app:app /srv
USER app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
