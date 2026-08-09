# `fmt` mutates, `lint` only checks. CI runs `lint` so it can never "pass" by
# rewriting code nobody reviewed.
fmt:
	poetry run ruff format .
	poetry run ruff check --fix .

lint:
	poetry run ruff format --check .
	poetry run ruff check .
	poetry run ty check .

test:
	poetry run pytest

run:
	poetry run uvicorn app.main:app --reload
