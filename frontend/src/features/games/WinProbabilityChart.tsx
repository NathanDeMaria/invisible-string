import { useRef, useState } from "react";

import type { WinProbabilityResponse } from "../../services/api";
import { probability, score } from "./format";
import {
  PERIOD_SECONDS,
  VIEWBOX,
  adjustedLinePath,
  clockLabel,
  gapPath,
  kindLabel,
  linePath,
  nearest,
  place,
  placeAdjusted,
  plotBox,
  probabilityY,
  railTicks,
  railY,
  scoreChanges,
  secondsX,
} from "./curve";

interface Props {
  curve: WinProbabilityResponse;
}

/**
 * The home team's win probability over the course of a game, twice: what
 * happened, and what the model makes of it with the game's fifty-fifty balls
 * split evenly.
 *
 * The axis is labelled with both team names rather than with a legend, which
 * says what up and down mean without asking the reader to match a colour to a
 * name. 50% is a rule across the middle rather than a gridline among others --
 * it is the only value on the axis that means anything on its own, and every
 * reading of the chart is "which side of it, and by how much".
 *
 * **The two lines are one line and its dashed twin, not two colours.** This
 * app colours exactly two things for meaning -- a job that needs looking at,
 * and whether a number beat the line -- and a third hue here would spend that
 * budget on a chart that doesn't need it. The realized curve is the solid
 * one, because it is what happened; the adjusted one is dashed, because it is
 * a rewrite. The wash between them is the gap, which is the reading.
 *
 * **The bounces are a rail under the plot, not marks on the line.** A break is
 * a thing that happened at a moment, not a value on the win probability axis.
 * Each tick sits at its snap and stands up for a break that went the home
 * team's way, down for one that went the other, at a height scaled to the
 * biggest bounce in this game.
 *
 * The marks on the line itself are the snaps where the scoreboard had just
 * changed -- the only points where the curve moves for a reason a reader can
 * name. They are unlabelled here and spelled out in the tables below: seven
 * or eight labels on a 640-unit axis is a chart you read by squinting.
 *
 * Hover gives a crosshair and a readout. Nothing about the chart *depends* on
 * hovering -- the shape, the rail and the tables say it all without -- but a
 * line chart in a browser that can't be interrogated is a picture of a chart.
 */
export function WinProbabilityChart({ curve }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const box = plotBox();
  const points = curve.points;
  const changes = scoreChanges(points);
  const ticks = railTicks(points, curve.luck?.swings ?? []);
  const middle = probabilityY(0.5);
  const rail = railY();
  const active = hovered === null ? null : (points[hovered] ?? null);

  // The pointer's place across the plot, as a fraction. Read off the
  // bounding rect rather than the event's offset: the SVG is scaled to its
  // container, so viewBox units and CSS pixels are not the same thing.
  const track = (clientX: number) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const units = ((clientX - rect.left) / rect.width) * VIEWBOX.width;
    setHovered(nearest(points, (units - box.x) / box.width));
  };

  return (
    <figure className="wp">
      {/* Which way is up, and which line is which, said in words above the
          chart rather than as labels down the left-hand side. A team name is
          as long as it is -- "North Carolina State" doesn't fit a gutter that
          "Duke" fits -- so the axis holds the one word that never grows, and
          the direction is a caption. It sits inside the figure, so it travels
          with the chart rather than being a sentence somewhere near it. */}
      <figcaption className="wp-key">
        Up is <strong>{curve.home}</strong>, down is{" "}
        <strong>{curve.away}</strong>. The solid line is what happened; the{" "}
        <span className="wp-key-dashed">dashed</span> one is the same game with
        its bounces split evenly.
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        role="img"
        aria-label={summary(curve)}
        onPointerMove={(event) => track(event.clientX)}
        onPointerLeave={() => setHovered(null)}
      >
        {/* Quarters, as separators rather than as a grid: they are the only
            marks on the x axis a reader needs, and a full grid behind a line
            this busy is noise. */}
        {[1, 2, 3].map((quarter) => (
          <line
            key={quarter}
            className="wp-grid"
            x1={secondsX(quarter * PERIOD_SECONDS)}
            x2={secondsX(quarter * PERIOD_SECONDS)}
            y1={box.y}
            y2={box.y + box.height}
          />
        ))}
        {[1, 2, 3, 4].map((quarter) => (
          <text
            key={quarter}
            className="wp-axis"
            x={secondsX((quarter - 0.5) * PERIOD_SECONDS)}
            y={box.y + box.height + 15}
            textAnchor="middle"
          >
            Q{quarter}
          </text>
        ))}

        {/* The one value on the y axis that means something by itself. */}
        <line
          className="wp-even"
          x1={box.x}
          x2={box.x + box.width}
          y1={middle}
          y2={middle}
        />
        <text className="wp-axis" x={box.x - 6} y={middle + 4} textAnchor="end">
          even
        </text>

        {/* The gap first, so both lines draw over their own wash. */}
        <path className="wp-gap" d={gapPath(points)} />
        <path className="wp-adjusted" d={adjustedLinePath(points)} />
        <path className="wp-line" d={linePath(points)} />

        {changes.map((point) => {
          const at = place(point);
          return (
            <circle
              key={point.play_id}
              className="wp-score"
              cx={at.x}
              cy={at.y}
              r="3.5"
            >
              <title>
                {clockLabel(point)} —{" "}
                {score(point.away_score, point.home_score)}
              </title>
            </circle>
          );
        })}

        {/* The rail. Drawn whenever there is a curve, even with nothing on it:
            an absent rail would read as a chart that doesn't have one, and
            "nothing in this game turned on a bounce" is a fact about the
            game worth a place to be absent from. */}
        <line
          className="wp-grid"
          x1={box.x}
          x2={box.x + box.width}
          y1={rail}
          y2={rail}
        />
        <text className="wp-axis" x={box.x - 6} y={rail + 4} textAnchor="end">
          luck
        </text>
        {ticks.map((tick) => (
          <line
            key={tick.swing.play_id}
            className="wp-tick"
            x1={tick.x}
            x2={tick.x}
            y1={rail}
            y2={rail - tick.height}
          >
            <title>
              {clockLabel(tick.point)} — {kindLabel(tick.swing.kind)},{" "}
              {handed(tick.swing.home_delta, curve)}
            </title>
          </line>
        ))}

        {active && (
          <g className="wp-cursor">
            <line
              x1={place(active).x}
              x2={place(active).x}
              y1={box.y}
              y2={rail}
            />
            <circle cx={place(active).x} cy={place(active).y} r="4.5" />
            <circle
              className="wp-cursor-adjusted"
              cx={placeAdjusted(active).x}
              cy={placeAdjusted(active).y}
              r="4"
            />
          </g>
        )}
      </svg>

      {/* The readout, in HTML rather than in the SVG: it has to be readable
          at the page's own font size, and an SVG tooltip would scale with the
          chart. Held in the layout rather than floating, so the chart doesn't
          change height when the pointer enters it. */}
      <p className="wp-readout" role="status">
        {active ? (
          <>
            <span className="wp-when">{clockLabel(active)}</span>{" "}
            <span className="wp-score-read">
              {curve.away} {active.away_score}, {curve.home} {active.home_score}
            </span>{" "}
            <span className="wp-prob">
              {curve.home} {probability(active.home_win_prob)}
            </span>{" "}
            <span className="wp-prob-adjusted">
              {probability(active.adjusted_win_prob)} split
            </span>
          </>
        ) : (
          <span className="wp-hint">
            Hover the chart for the model&rsquo;s number at any snap, both ways.
          </span>
        )}
      </p>
    </figure>
  );
}

/** Which team a bounce went to, and what it was worth to them. */
function handed(delta: number, curve: WinProbabilityResponse): string {
  const team = delta >= 0 ? curve.home : curve.away;
  return `${Math.abs(delta).toFixed(2)} of win probability to ${team}`;
}

/**
 * The chart said out loud, for a reader who gets the label instead of the
 * picture.
 *
 * Its shape, not its data: where it started, where it ended, how many times
 * the scoreboard moved, and how many of those moves turned on a bounce. The
 * tables under the chart are where the numbers are, and repeating a hundred
 * of them here would be worse than either.
 */
function summary(curve: WinProbabilityResponse): string {
  const points = curve.points;
  if (points.length === 0) return "No play-by-play for this game.";
  const first = points[0];
  const last = points[points.length - 1];
  const bounces = curve.luck?.swings.length ?? 0;
  return (
    `${curve.home}'s win probability across ${points.length} snaps: ` +
    `${probability(first.home_win_prob)} at kickoff, ` +
    `${probability(last.home_win_prob)} at the last snap, ` +
    `over ${scoreChanges(points).length} changes of score. ` +
    `With the bounces split evenly it ends at ` +
    `${probability(last.adjusted_win_prob)}, over ${bounces} ` +
    `${bounces === 1 ? "play" : "plays"} decided by one.`
  );
}

/** One row per change of score: the table under the chart, and its text. */
export function ScoringTable({ curve }: Props) {
  const changes = scoreChanges(curve.points);
  if (changes.length === 0) return null;
  return (
    <table className="ratings wp-table">
      <caption className="sr-only">
        Every change of score, with the model&rsquo;s number just after it
      </caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col" className="num">
            Score
          </th>
          <th scope="col" className="num">
            {curve.home}
          </th>
          <th scope="col" className="num">
            Split
          </th>
        </tr>
      </thead>
      <tbody>
        {changes.map((point) => (
          <tr key={point.play_id}>
            <td>{clockLabel(point)}</td>
            <td className="num">{score(point.away_score, point.home_score)}</td>
            <td className="num">{probability(point.home_win_prob)}</td>
            <td className="num quiet">
              {probability(point.adjusted_win_prob)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One row per play the game turned on a bounce, which is the list behind the
 * rail.
 *
 * Both branches, because that is what makes the number checkable rather than
 * asserted: the model's own price for the snap that followed and for the one
 * that would have followed, and the share of the gap the bounce -- rather
 * than the offense -- handed out.
 */
export function LuckyPlaysTable({ curve }: Props) {
  const ticks = railTicks(curve.points, curve.luck?.swings ?? []);
  if (ticks.length === 0) return null;
  return (
    <table className="ratings wp-table">
      <caption className="sr-only">
        Every play decided by a bounce, priced against the branch that
        didn&rsquo;t happen
      </caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Play</th>
          <th scope="col" className="num">
            Happened
          </th>
          <th scope="col" className="num">
            Didn&rsquo;t
          </th>
          <th scope="col" className="num">
            Handed
          </th>
        </tr>
      </thead>
      <tbody>
        {ticks.map(({ swing, point }) => (
          <tr key={swing.play_id}>
            <td>{clockLabel(point)}</td>
            <td>{kindLabel(swing.kind)}</td>
            <td className="num">{probability(swing.realized)}</td>
            <td className="num quiet">{probability(swing.counterfactual)}</td>
            {/* The team is named rather than left to a sign: a signed number
                on a two-team page is a convention the reader has to hold, and
                the whole column is four rows long. */}
            <td className="num">
              {Math.abs(swing.home_delta).toFixed(2)}{" "}
              <span className="of">
                {swing.home_delta >= 0 ? curve.home : curve.away}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
