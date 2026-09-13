import type { GameDetail } from "../../services/api";
import { Explainer } from "./Explainer";

export interface Stated {
  qbOutHome: boolean;
  qbOutAway: boolean;
  restHome: boolean;
  restAway: boolean;
}

interface Props {
  detail: GameDetail;
  /** What the URL asks for, which is what the boxes show. */
  stated: Stated;
  /** Whether the number beside them is still being recomputed. */
  pending: boolean;
  /** Merges into the query string, the way MatchupPage's pickers do. */
  onChange: (next: Record<string, string | null>) => void;
}

/**
 * The two game-level things the football models price, read or stated.
 *
 * A game that has been played shows what was true of it. One that hasn't is a
 * what-if: tick a box and the number above moves, because the request goes
 * back to the API and the model is rebuilt having been told.
 *
 * **The boxes read the URL, the number reads the response.** Ticking one is a
 * round trip, so a box that waited for its own answer would sit unticked under
 * the cursor for as long as the API took -- which reads as a broken control
 * rather than a slow one. The cost of showing the ask immediately is the
 * moment where the ticks and the number beside them disagree, so that moment
 * says so: `pending` marks the prediction stale until the answer that matches
 * these boxes arrives. Silently pairing a new tick with an old number is the
 * one thing this must not do.
 *
 * **Nothing at all for most leagues.** `matchup` is null wherever the models
 * price none of this, and an empty section reading "both quarterbacks played"
 * under a basketball game would be a claim about a signal that doesn't exist.
 */
export function MatchupTerms({ detail, stated, pending, onChange }: Props) {
  const facts = detail.matchup;
  if (!facts) return null;

  if (detail.completed) {
    return (
      <>
        <h3>Matchup</h3>
        <dl className="facts">
          <div>
            <dt>Quarterbacks</dt>
            <dd>
              {quarterbackLabel(detail)}
              <span className="of">
                read from the index built off this game&rsquo;s play-by-play
              </span>
            </dd>
          </div>
          <div>
            <dt>Rest</dt>
            <dd>
              {restLabel(detail)}
              <span className="of">
                {facts.rest_home === null
                  ? "nobody had played yet, so there is no gap to compare"
                  : "worked out from when each side last played this season"}
              </span>
            </dd>
          </div>
        </dl>
        <Explainer summary="What counts as a bye">
          A side has to have had five days more than the other before this says
          anything &mdash; college football is Saturday to Saturday, so a
          Thursday game is a different fact from a week off and, measured, it
          doesn&rsquo;t run the same way. Past twenty days it stops counting
          too: a team is not off for three weeks mid-season, and far more often
          the game it played is a row the schedule doesn&rsquo;t have.
        </Explainer>
      </>
    );
  }

  return (
    <>
      <h3>Matchup</h3>
      <p className="meta">
        What the model is told about the game itself. Change one and the
        prediction above is recomputed
        {pending && <span className="quiet"> &mdash; recomputing&hellip;</span>}
      </p>
      {/* Two captioned rows rather than four long labels: the question is the
          same for both sides, so asking it once and naming the teams under it
          is shorter to read and stops the row wrapping three-and-one. */}
      <div className="terms" aria-busy={pending}>
        <span className="caption">Quarterback out</span>
        <Toggle
          label={detail.home}
          aria={`${detail.home} QB out`}
          checked={stated.qbOutHome}
          onChange={(on) => onChange({ qb_out_home: on ? "1" : null })}
        />
        <Toggle
          label={detail.away}
          aria={`${detail.away} QB out`}
          checked={stated.qbOutAway}
          onChange={(on) => onChange({ qb_out_away: on ? "1" : null })}
        />
      </div>
      <div className="terms" aria-busy={pending}>
        <span className="caption">Off a bye</span>
        <Toggle
          label={detail.home}
          aria={`${detail.home} off a bye`}
          checked={stated.restHome}
          onChange={(on) => onChange({ rest_home: on ? "1" : null })}
        />
        <Toggle
          label={detail.away}
          aria={`${detail.away} off a bye`}
          checked={stated.restAway}
          onChange={(on) => onChange({ rest_away: on ? "1" : null })}
        />
      </div>
      <Explainer summary="What these do to the number">
        Each is worth a flat number of rating points to the side it favours,
        added before the ratings are read &mdash; so ticking both quarterbacks,
        or both byes, is worth nothing to anybody, which is the model&rsquo;s
        own answer rather than a quirk of this page. Rest is a threshold and not
        a slope: a bye is a bye, and thirteen days better rested is not twice
        seven. How much each is worth is fit per model, and a model that prices
        one at zero will not move at all when you tick it.
      </Explainer>
    </>
  );
}

/**
 * `aria` is the whole question and `label` just the team, because the caption
 * that makes the short label readable is only next to it on screen -- a
 * screen reader arriving at "Detroit Lions" with no more than that would have
 * to go looking for which of the two questions it answers.
 */
function Toggle({
  label,
  aria,
  checked,
  onChange,
}: {
  label: string;
  aria: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        aria-label={aria}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * Who came off the longer break, said out loud.
 *
 * An em dash only when nobody can say -- a season opener, or a season the
 * schedule didn't cover. "Level" is a real answer and gets words, because a
 * blank there would read as the page not knowing rather than as the two sides
 * having arrived on the same rest.
 */
function restLabel(detail: GameDetail): string {
  const facts = detail.matchup;
  if (!facts || facts.rest_home === null || facts.rest_away === null)
    return "—";
  if (facts.rest_home) return `${detail.home} off the longer break`;
  if (facts.rest_away) return `${detail.away} off the longer break`;
  return "Level";
}

/** Which side was missing its starter, said out loud. */
function quarterbackLabel(detail: GameDetail): string {
  const out = [
    detail.matchup?.qb_out_home ? detail.home : null,
    detail.matchup?.qb_out_away ? detail.away : null,
  ].filter((team): team is string => team !== null);

  if (out.length === 0) return "Both started";
  if (out.length === 2) return "Both were out";
  return `${out[0]} was out`;
}
