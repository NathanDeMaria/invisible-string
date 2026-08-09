# invisible-string

A webapp over [cassandra](https://github.com/NathanDeMaria/cassandra) model
results: current ratings per league, and win probability / predicted spread for
a hypothetical matchup. See [DESIGN.md](./DESIGN.md).

```
infra/      terraform: CI OIDC roles now; App Runner, ECR, Batch to come
backend/    FastAPI, serves the API and the built SPA
frontend/   React + Redux Toolkit (RTK Query)
```

## Devcontainer

`.devcontainer/` has python 3.14, node 22, terraform and the aws CLI pinned to
the versions CI uses. "Reopen in Container" in VS Code, or
`devcontainer up --workspace-folder .` with the CLI.

`~/.aws` is mounted the way cassandra's devcontainer does it: `config` and
`credentials` read-only, `sso/` and `login/` writable. So the container can use
your credentials without being able to rewrite them, and `aws sso login` still
works from inside. An `initializeCommand` creates those paths first, since a
bind mount whose source is missing stops the container from starting.

This is the easiest way to run the one-time infra bootstrap:

```sh
cd infra && make init && make apply
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
| `INVISIBLE_STRING_RELEASES_BUCKET` | unset | Read releases from this S3 bucket. Unset means read from disk instead, which is what tests and local dev use. |
| `INVISIBLE_STRING_RELEASES_PREFIX` | `models/` | Key prefix within the bucket |
| `INVISIBLE_STRING_RELEASES_CACHE_TTL_SECONDS` | `60` | How long a release is served from memory before S3 is re-checked |
| `INVISIBLE_STRING_RELEASES_ROOT` | `./data` | Directory holding `models/{league}/{model}/latest.json`. Used only when no bucket is set. |
| `INVISIBLE_STRING_STATIC_DIR` | `./static` | Built SPA. Skipped when absent, which is the local-dev case. |

Releases are cached in-process for the TTL, then revalidated with a conditional
GET — S3 answers `304` when nothing changed, which is the usual case. So a new
release is picked up within a TTL of being written, with no shared cache and
nothing to invalidate. The flip side is a bounded staleness window; both
directions are covered by tests.
