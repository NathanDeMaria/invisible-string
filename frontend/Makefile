# Mirrors backend/Makefile: `fmt` mutates, `lint` only checks.
fmt:
	npm run fmt

lint:
	npm run lint
	npm run typecheck

test:
	npm test

build:
	npm run build

# Regenerate the API client types and fail if they drifted from the committed
# schema. This is the one seam where the two stacks can silently disagree.
codegen-check:
	npm run codegen
	git diff --exit-code src/api/schema.d.ts
