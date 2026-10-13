"""Writes `margin_kernel.json`, the kernel the test releases carry.

Fitting needs scipy, which this app's image doesn't have and shouldn't
(`app.schema`), so the fit is checked in and this is how it was made. Run it
from an environment with cassandra's `fit` group installed:

    python tests/fixtures/kernel/make_margin_kernel.py

The games are synthetic and football-shaped on purpose: a normal margin
around the win probability's logit, with a share of the close games snapped
onto 3 and 7 and no ties. That is enough for the fit to find key numbers, so
a whole-number line on 3 or 7 carries a visible push and the tests can tell a
push from a rounding error.
"""

import json
from pathlib import Path

import numpy as np
from cassandra.prob_to_margin import MarginKernelFitter

KEYS = np.array([3, 7])


def games(n: int = 20_000, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    probs = rng.uniform(0.05, 0.95, n)
    centre = 8.0 * np.log(probs / (1 - probs))
    margins = np.rint(rng.normal(centre, 13.0)).astype(int)

    sizes = np.abs(margins)
    nearest = KEYS[np.abs(sizes[:, None] - KEYS[None, :]).argmin(axis=1)]
    snap = (np.abs(sizes - nearest) <= 2) & (rng.uniform(size=n) < 0.5)
    margins = np.where(snap, np.sign(margins) * nearest, margins)
    margins = np.where(margins == 0, rng.choice([-1, 1], n), margins)
    return probs, margins


if __name__ == "__main__":
    probs, margins = games()
    kernel = MarginKernelFitter(max_margin=30).fit(probs, margins)
    out = Path(__file__).with_name("margin_kernel.json")
    out.write_text(json.dumps(kernel.to_dict(), indent=2) + "\n")
