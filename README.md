# invisible-string

A webapp over [cassandra](https://github.com/NathanDeMaria/cassandra) model
results: current ratings per league, and win probability / predicted spread for
a hypothetical matchup. See [DESIGN.md](./DESIGN.md).

```
infra/      terraform: CI OIDC roles now; App Runner, ECR, Batch to come
backend/    FastAPI, serves the API and the built SPA
frontend/   React + Redux Toolkit (RTK Query)
```

## Running it locally

Both modes read the test fixtures in `backend/tests/fixtures`, so neither needs
AWS or a cassandra run.

### Production shape — one container, one port

```sh
docker compose up app          # http://localhost:8000
```

This is the real image: the SPA is built and served by FastAPI from the same
origin, which is what App Runner runs.

### Hot reload

```sh
docker compose --profile dev up      # http://localhost:5173
```

vite on :5173 proxying `/api` to `uvicorn --reload` on :8000.

### Without docker

```sh
cd backend && poetry install
INVISIBLE_STRING_RELEASES_ROOT=tests/fixtures poetry run uvicorn app.main:app --reload

cd frontend && npm install && npm run dev    # proxies /api to :8000
```

To check the production shape without docker, build the frontend into the
backend's static dir first:

```sh
cd frontend && npm run build && cp -r dist ../backend/static
cd ../backend && INVISIBLE_STRING_RELEASES_ROOT=tests/fixtures poetry run uvicorn app.main:app
```

## Checks

Each directory has the same Makefile targets. `fmt` rewrites, `lint` only
checks, which is what CI runs.

```sh
cd backend  && make fmt lint test
cd frontend && make fmt lint test codegen-check
```

`openapi.json` at the repo root is the contract between the two stacks. The
backend exports it (`make openapi`); the frontend generates its API types from
it (`make codegen`). CI checks both are current, so a renamed response field
fails a build instead of becoming `undefined` in the browser.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INVISIBLE_STRING_RELEASES_ROOT` | `./data` | Directory holding `models/{league}/{model}/latest.json` |
| `INVISIBLE_STRING_STATIC_DIR` | `./static` | Built SPA. Skipped when absent, which is the local-dev case. |
