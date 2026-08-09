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
FROM python:3.14-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    POETRY_VIRTUALENVS_CREATE=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install --no-cache-dir poetry==2.2.1

WORKDIR /srv

# Dependencies before source, so editing a handler doesn't re-resolve the
# whole tree on every build.
COPY backend/pyproject.toml backend/poetry.lock ./
RUN poetry install --only main --no-root

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
