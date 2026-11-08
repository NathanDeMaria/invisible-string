# This repo's own make targets. The Makefile beside this one belongs to the
# mirrorball template and includes this file; this one is never touched by
# `copier update`.

run:
	uv run uvicorn app.main:app --reload

# The OpenAPI schema is committed at the repo root because it's the contract
# between the two stacks: backend CI checks it's current, frontend CI checks
# its generated types match it. Neither job needs the other's toolchain.
openapi:
	uv run python -m app.openapi ../openapi.json


.PHONY: run openapi
