import { useId, useRef, useState } from "react";

import type { WinProbabilityResponse } from "../../services/api";
import { probability, score } from "./format";
import {
  PERIOD_SECONDS,
  VIEWBOX,
  clockLabel,
  areaPath,
  linePath,
  nearest,
  place,
  plotBox,
  probabilityY,
  scoreChanges,
  secondsX,
} from "./curve";

interface Props {
  curve: WinProbabilityResponse;
}

/**
 * The home team's win probability over the course of a game.
 *
 * One series, so no legend: the axis is labelled with both team names, which
 * says what up and down mean without asking the reader to match a colour to a
 * name. 50% is a rule across the middle rather than a gridline among others --
 * it is the only value on the axis that means anything on its own, and every
 * reading of the chart is "which side of it, and by how much".
 *
 * The marks on the line are the snaps where the scoreboard had just changed,
 * which are the only points where the curve moves for a reason a reader can
 * name. They are unlabelled on the chart and spelled out in the table below
 * it: seven or eight labels on a 640-unit axis is a chart you read by
 * squinting, and the swings are worth a real list.
 *
 * Hover gives a crosshair and a readout. Nothing about the chart *depends* on
 * hovering -- the shape, the scoring marks and the table say it all without --
 * but a line chart in a browser that can't be interrogated is a picture of a
 * chart.
 */
export function WinProbabilityChart({ curve }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const gradient = useId();
  const box = plotBox();
  const points = curve.points;
  const changes = scoreChanges(points);
  const middle = probabilityY(0.5);
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
      {/* Which way is up, said in words above the chart rather than as two
          labels down the left-hand side. A team name is as long as it is --
          "North Carolina State" doesn't fit a gutter that "Duke" fits -- so
          the axis holds the one word that never grows, and the direction is
          a caption. It sits inside the figure, so it travels with the chart
          rather than being a sentence somewhere near it. */}
      <figcaption className="wp-key">
        Up is <strong>{curve.home}</strong>, down is{" "}
        <strong>{curve.away}</strong>.
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        role="img"
        aria-label={summary(curve)}
        onPointerMove={(event) => track(event.clientX)}
        onPointerLeave={() => setHovered(null)}
      >
        <defs>
          {/* The fill is there to say which side of even the line is on, not
              to carry a value: it fades out downward so it can't be read as a
              second series stacked under the first. */}
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

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

        <path
          className="wp-area"
          d={areaPath(points)}
          fill={`url(#${gradient})`}
        />
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

        {active && (
          <g className="wp-cursor">
            <line
              x1={place(active).x}
              x2={place(active).x}
              y1={box.y}
              y2={box.y + box.height}
            />
            <circle cx={place(active).x} cy={place(active).y} r="4.5" />
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
            </span>
          </>
        ) : (
          <span className="wp-hint">
            Hover the chart for the model&rsquo;s number at any snap.
          </span>
        )}
      </p>
    </figure>
  );
}

/**
 * The chart said out loud, for a reader who gets the label instead of the
 * picture.
 *
 * Its shape, not its data: where it started, where it ended, and how many
 * times the scoreboard moved. The table under the chart is where the numbers
 * are, and repeating a hundred of them here would be worse than either.
 */
function summary(curve: WinProbabilityResponse): string {
  const points = curve.points;
  if (points.length === 0) return "No play-by-play for this game.";
  const first = points[0];
  const last = points[points.length - 1];
  return (
    `${curve.home}'s win probability across ${points.length} snaps: ` +
    `${probability(first.home_win_prob)} at kickoff, ` +
    `${probability(last.home_win_prob)} at the last snap, ` +
    `over ${scoreChanges(points).length} changes of score.`
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
        </tr>
      </thead>
      <tbody>
        {changes.map((point) => (
          <tr key={point.play_id}>
            <td>{clockLabel(point)}</td>
            <td className="num">{score(point.away_score, point.home_score)}</td>
            <td className="num">{probability(point.home_win_prob)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
