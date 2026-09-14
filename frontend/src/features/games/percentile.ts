/**
 * Where one number sits among every other game like it.
 *
 * The API sends a league's metric distributions as 101 checkpoints -- the
 * value at each percentile from 0 to 100, over the last five seasons
 * (`app.distributions`) -- and the lookup happens here rather than on the
 * server. One cached request per league then labels every number the page
 * already holds, and the backend never has to know which metrics this page
 * shows.
 *
 * The whole of it is a search through a sorted array and an interpolation
 * between two neighbours. What makes that trustworthy is that the array is
 * validated as sorted upstream: an unsorted one wouldn't fail here, it would
 * quietly answer the wrong percentile.
 */

/** How many checkpoints an artifact carries. See `app.distributions`. */
export const CHECKPOINTS = 101;

/**
 * The percentile of `value`, from 0 to 100, or null if it can't be placed.
 *
 * Three cases, and the middle one is the one worth knowing about.
 *
 * **Off either end** clamps. p0 and p100 are single extreme games that move
 * every time the artifact is rebuilt, so they are boundaries rather than
 * numbers to read -- a value past one of them is "as extreme as this
 * population has seen", not a 137th percentile.
 *
 * **Exactly on a run of equal checkpoints** reads as the middle of that run.
 * A metric with a mass of ties -- a luck total that is 0 for most games --
 * repeats one value across many percentiles, and a game sitting in that mass
 * is neither at the bottom of it nor the top. Taking the lower edge would say
 * a perfectly ordinary game beat nobody.
 *
 * **Between two checkpoints** interpolates linearly, which is accurate to
 * well under a percentile anywhere the population is dense.
 */
export function percentileOf(
  values: number[] | null | undefined,
  value: number | null | undefined,
): number | null {
  if (!values || value == null || !Number.isFinite(value)) return null;
  const last = values.length - 1;
  if (last < 1) return null;

  // Strictly outside, so that a value equal to an endpoint falls through to
  // the tie handling below rather than being clamped. That matters for the
  // metrics most likely to have a mass of ties: a luck total is 0 for most
  // games *and* 0 is the floor, so clamping equality would report the modal
  // game as the worst one in five seasons.
  if (value < values[0]) return 0;
  if (value > values[last]) return 100;

  // Percentiles per index. 1 for a 101-point artifact, and written out so a
  // differently sized one still reads correctly rather than silently scaling
  // wrong.
  const per = 100 / last;

  const first = values.indexOf(value);
  if (first !== -1) {
    let end = first;
    while (end < last && values[end + 1] === value) end += 1;
    return ((first + end) / 2) * per;
  }

  // `value` is strictly inside the range and matches no checkpoint, so this
  // lands on a real bracket and the span below is never zero.
  let above = 0;
  while (values[above] < value) above += 1;
  const below = above - 1;
  const span = values[above] - values[below];
  return (below + (value - values[below]) / span) * per;
}

/**
 * A percentile as the page says it: "93rd", "1st", "50th".
 *
 * Rounded to a whole number, because the underlying resolution is a hundred
 * checkpoints and a decimal would claim precision the artifact doesn't carry.
 */
export function percentileLabel(percentile: number | null): string | null {
  if (percentile == null) return null;
  const whole = Math.round(percentile);
  return `${whole}${ordinalSuffix(whole)}`;
}

/** English ordinals, including the three teens that don't follow the rule. */
function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  if (n % 10 === 1) return "st";
  if (n % 10 === 2) return "nd";
  if (n % 10 === 3) return "rd";
  return "th";
}
