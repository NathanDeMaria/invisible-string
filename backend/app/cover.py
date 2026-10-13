"""Cover, push and lose at a line, from cassandra's margin kernel.

A release since cassandra #103 carries a `margin_kernel`: a probability on
every integer margin, fit on the whole history of final scores, for any
given win probability. That is what prices a spread properly. Comparing the
model's spread with the book's asks where the *mean* margin sits against the
line, and in football the mean is the wrong question -- games end on 3 and 7
far more than on the margins either side, so with the model at -7 against a
book at -7 the favourite covers well under half the time, and the rest is
push.

Nothing here does model math either: `kernel.distribution(p).p_cover(spread)`
is cassandra's, and numpy is all it needs. This module only decides when
there is no number -- no line, or a release from before kernels -- and turns
the answer around for the other side.
"""

from cassandra.predictor.distribution import Cover
from cassandra.prob_to_margin import MarginKernel


def cover(
    kernel: MarginKernel | None, home_win_prob: float, spread: float | None
) -> Cover | None:
    """The home side's cover, push and lose at `spread`, or None.

    `spread` is quoted the way `market_spread` is everywhere in this app: from
    the home side, negative when home is favoured. `cover` is P(home covers),
    `lose` is P(away covers), and a half-point line has no push.

    None without a line or without a kernel, the same rule as
    `predicted_spread`: an absent number beats a fabricated one.
    """
    if kernel is None or spread is None:
        return None
    return kernel.distribution(home_win_prob).p_cover(spread)


def flipped(home: Cover) -> Cover:
    """The same line, read from the away side.

    The away team covers exactly when the home team doesn't and the game
    isn't a push, so cover and lose swap and push stays where it is.
    """
    return Cover(cover=home.lose, push=home.push, lose=home.cover)
