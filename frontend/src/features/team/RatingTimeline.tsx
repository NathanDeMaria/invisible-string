import { useRef, useState } from "react";

import type { HistoryPoint } from "../../services/api";
import { weekEnding } from "../ratings/movement";
import {
  MARKER_LIMIT,
  VIEWBOX,
  bounds,
  linePath,
  nearest,
  plotBox,
  pointX,
  ratingY,
  seasons,
  summary,
  ticks,
} from "./timeline";

interface Props {
  team: string;
  points: HistoryPoint[];
}

/**
 * One team's rating, week by week, for as long as the model has rated it.
 *
 * One line and no legend: there is one series and the heading above it names
 * the team, so a legend box would be a key to a single thing. It is drawn in
 * the accent, like the win probability curve, rather than in a hue of its own
 * -- this app colours exactly two things for meaning, and a chart with one
 * series has no identity to encode.
 *
 * **The offseason is a gap, not a slope.** Each season is its own path. The
 * jump between a team's last week and its first is `pass_season` regressing
 * the rating toward its anchor, and a segment across it would show a slide no
 * game produced. The separator and the year under it are what say the gap is
 * a summer rather than missing data.
 *
 * **The y axis doesn't start at zero, and the gridlines say so.** A rating
 * scale has no meaningful zero -- 1500 is the middle of it by construction --
 * so every value on the axis is labelled rather than left to be read off a
 * baseline that isn't there.
 *
 * Markers only when there are few enough weeks to see them (`MARKER_LIMIT`).
 * A dot on every week of sixteen seasons is a second, thicker line.
 *
 * Hover gives a crosshair and a readout. Nothing about the chart depends on
 * it -- the shape and the season table below say it without -- but a line
 * chart in a browser that can't be interrogated is a picture of a chart.
 */
export function RatingTimeline({ team, points }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const box = plotBox();
  const scale = bounds(points);
  const runs = seasons(points);
  const count = points.length;
  const active = hovered === null ? null : (points[hovered] ?? null);
  const markers = count <= MARKER_LIMIT;

  // The pointer's place across the plot, as a fraction. Read off the bounding
  // rect rather than the event's offset: the SVG is scaled to its container,
  // so viewBox units and CSS pixels are not the same thing.
  const track = (clientX: number) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const units = ((clientX - rect.left) / rect.width) * VIEWBOX.width;
    setHovered(nearest((units - box.x) / box.width, count));
  };

  return (
    <figure className="timeline">
      <svg
        ref={svg}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        role="img"
        aria-label={summary(team, points)}
        onPointerMove={(event) => track(event.clientX)}
        onPointerLeave={() => setHovered(null)}
      >
        {/* Rating levels, labelled. Behind the line and in the line colour's
            absence: a grid a reader has to look past is a grid drawn too
            dark. */}
        {ticks(scale).map((value) => (
          <g key={value}>
            <line
              className="timeline-grid"
              x1={box.x}
              x2={box.x + box.width}
              y1={ratingY(value, scale, box)}
              y2={ratingY(value, scale, box)}
            />
            <text
              className="timeline-axis"
              x={box.x - 8}
              y={ratingY(value, scale, box) + 3.5}
              textAnchor="end"
            >
              {value}
            </text>
          </g>
        ))}

        {/* One separator per season boundary, and the year under each run.
            The label sits over its own weeks rather than centred on the
            chart, so a short season reads as a short stretch of the axis. */}
        {runs.map((season, index) => {
          const start = pointX(season.from, count, box);
          const end = pointX(season.to, count, box);
          return (
            <g key={`${season.year}-${season.from}`}>
              {index > 0 && (
                <line
                  className="timeline-break"
                  x1={(start + pointX(season.from - 1, count, box)) / 2}
                  x2={(start + pointX(season.from - 1, count, box)) / 2}
                  y1={box.y}
                  y2={box.y + box.height}
                />
              )}
              <text
                className="timeline-axis"
                x={(start + end) / 2}
                y={box.y + box.height + 18}
                textAnchor="middle"
              >
                {season.year}
              </text>
            </g>
          );
        })}

        {runs.map((season) => (
          <path
            key={`line-${season.year}-${season.from}`}
            className="timeline-line"
            d={linePath(season, count, scale, box)}
          />
        ))}

        {/* A season of one week has no line to draw, so its marker is the
            only thing that puts it on the chart. */}
        {points.map((point, index) =>
          markers || runs.some((s) => s.from === index && s.to === index) ? (
            <circle
              key={`dot-${point.year}-${point.week}`}
              className="timeline-dot"
              cx={pointX(index, count, box)}
              cy={ratingY(point.rating, scale, box)}
              r={2.5}
            />
          ) : null,
        )}

        {active && hovered !== null && (
          <g className="timeline-cursor">
            <line
              x1={pointX(hovered, count, box)}
              x2={pointX(hovered, count, box)}
              y1={box.y}
              y2={box.y + box.height}
            />
            <circle
              cx={pointX(hovered, count, box)}
              cy={ratingY(active.rating, scale, box)}
              r={4}
            />
          </g>
        )}
      </svg>

      {/* Held rather than shown-and-hidden, so the figure doesn't change
          height as the pointer crosses it -- the chart jumping under the
          cursor is worse than a line of placeholder text.

          A live region, like the win probability chart's readout: hovering a
          line is a way of asking what a point is, and the answer should reach
          a reader who isn't looking at where the pointer happens to be. */}
      <figcaption className="timeline-readout" role="status">
        {active ? (
          <>
            <strong>{active.rating.toFixed(1)}</strong> &middot; week{" "}
            {active.week} of {active.year} &middot; {weekEnding(active.date)}{" "}
            &middot; {active.wins}-{active.losses}
            {active.rd != null && <> &middot; RD {active.rd.toFixed(1)}</>}
          </>
        ) : (
          <span className="quiet">
            {points.length} weeks &middot; hover for a week&rsquo;s rating
          </span>
        )}
      </figcaption>
    </figure>
  );
}
