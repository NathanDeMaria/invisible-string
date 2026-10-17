import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { TeamRow } from "../../services/api";
import {
  METRICS,
  VIEWBOX,
  axisTitle,
  dots,
  median,
  nearestDot,
  plotBox,
  scale,
  summary,
  tickLabel,
  ticks,
  toX,
  toY,
  type Metric,
} from "./scatter";

interface Props {
  /** Every team in the table, not just the ones the filter matched. */
  rows: TeamRow[];
  league: string;
  x: Metric;
  y: Metric;
  /**
   * The teams the filter box matched, or null with nothing typed. Matched
   * teams stay in the accent and get their names; the rest fade back rather
   * than leave, so a team is still read against the whole league.
   */
  matched: Set<string> | null;
}

/** More matches than this and the names would be a pile rather than labels. */
const LABEL_LIMIT = 12;

/**
 * Any two of the table's numbers against each other, a dot per team.
 *
 * One series, so one colour and no legend: the accent, as on every other
 * chart here. The dashed lines are the league's medians on each axis, which
 * cut the plot into the four quadrants a reader is looking for -- good at
 * both, good at one, neither. Every axis runs better-up and better-right (see
 * `scatter.ts`), so the top-right is always the good corner.
 *
 * Hover names the nearest team; a click opens it, the same way its row in
 * the table does.
 */
export function RatingsScatter({ rows, league, x, y, matched }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<number | null>(null);

  const box = plotBox();
  const all = dots(rows, x, y);
  const xScale = scale(
    all.map((d) => d.x),
    METRICS[x].reversed,
  );
  const yScale = scale(
    all.map((d) => d.y),
    METRICS[y].reversed,
  );
  const placed = all.map((d) => ({
    ...d,
    px: toX(d.x, xScale, box),
    py: toY(d.y, yScale, box),
    lit: matched == null || matched.has(d.row.team),
  }));
  // Faded dots first, so the matched ones are drawn on top of them.
  const order = [...placed.keys()].sort(
    (a, b) => Number(placed[a].lit) - Number(placed[b].lit),
  );
  const labelled =
    matched != null && placed.filter((d) => d.lit).length <= LABEL_LIMIT;

  const xMid = median(all.map((d) => d.x));
  const yMid = median(all.map((d) => d.y));
  const active = hovered === null ? null : (placed[hovered] ?? null);

  // Read off the bounding rect, not the event's offset: the SVG is scaled to
  // its container, so viewBox units and CSS pixels are not the same thing.
  const track = (clientX: number, clientY: number) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const ux = ((clientX - rect.left) / rect.width) * VIEWBOX.width;
    const uy = ((clientY - rect.top) / rect.height) * VIEWBOX.height;
    setHovered(
      nearestDot(
        ux,
        uy,
        placed.map((d) => ({ x: d.px, y: d.py })),
      ),
    );
  };

  if (all.length === 0) {
    return (
      <p className="empty">No team has both of those numbers in this model.</p>
    );
  }

  return (
    <figure className="scatter">
      <svg
        ref={svg}
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        role="img"
        aria-label={summary(all.length, x, y)}
        onPointerMove={(event) => track(event.clientX, event.clientY)}
        onPointerLeave={() => setHovered(null)}
        onClick={() => {
          if (active) {
            navigate(`/${league}/teams/${encodeURIComponent(active.row.team)}`);
          }
        }}
        style={{ cursor: active ? "pointer" : undefined }}
      >
        {ticks(xScale).map((value) => (
          <g key={`x${value}`}>
            <line
              className="timeline-grid"
              x1={toX(value, xScale, box)}
              x2={toX(value, xScale, box)}
              y1={box.y}
              y2={box.y + box.height}
            />
            <text
              className="timeline-axis"
              x={toX(value, xScale, box)}
              y={box.y + box.height + 14}
              textAnchor="middle"
            >
              {tickLabel(x, value, xScale.step)}
            </text>
          </g>
        ))}
        {ticks(yScale).map((value) => (
          <g key={`y${value}`}>
            <line
              className="timeline-grid"
              x1={box.x}
              x2={box.x + box.width}
              y1={toY(value, yScale, box)}
              y2={toY(value, yScale, box)}
            />
            <text
              className="timeline-axis"
              x={box.x - 6}
              y={toY(value, yScale, box) + 3.5}
              textAnchor="end"
            >
              {tickLabel(y, value, yScale.step)}
            </text>
          </g>
        ))}

        {xMid != null && (
          <line
            className="scatter-median"
            x1={toX(xMid, xScale, box)}
            x2={toX(xMid, xScale, box)}
            y1={box.y}
            y2={box.y + box.height}
          />
        )}
        {yMid != null && (
          <line
            className="scatter-median"
            x1={box.x}
            x2={box.x + box.width}
            y1={toY(yMid, yScale, box)}
            y2={toY(yMid, yScale, box)}
          />
        )}

        <text
          className="scatter-title"
          x={box.x + box.width / 2}
          y={VIEWBOX.height - 4}
          textAnchor="middle"
        >
          {axisTitle(x)} &rarr;
        </text>
        <text
          className="scatter-title"
          transform={`translate(12 ${box.y + box.height / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {axisTitle(y)} &rarr;
        </text>

        {order.map((index) => {
          const d = placed[index];
          return (
            <circle
              key={d.row.team}
              className={d.lit ? "scatter-dot" : "scatter-dot faded"}
              cx={d.px}
              cy={d.py}
              r={4}
            >
              <title>{d.row.team}</title>
            </circle>
          );
        })}

        {labelled &&
          placed
            .filter((d) => d.lit)
            .map((d) => (
              <text
                key={`label-${d.row.team}`}
                className="scatter-label"
                x={d.px + 7}
                y={d.py + 3.5}
              >
                {d.row.team}
              </text>
            ))}

        {active && (
          <circle
            className="scatter-cursor"
            cx={active.px}
            cy={active.py}
            r={6}
          />
        )}
      </svg>

      {/* Held rather than shown-and-hidden, so the figure keeps its height
          as the pointer crosses it -- see the rating timeline's readout. */}
      <figcaption className="timeline-readout" role="status">
        {active ? (
          <>
            <strong>{active.row.team}</strong> &middot; #{active.row.rank}{" "}
            &middot; {METRICS[x].label} {METRICS[x].format(active.x)} &middot;{" "}
            {METRICS[y].label} {METRICS[y].format(active.y)}
          </>
        ) : (
          <span className="quiet">
            {all.length} teams &middot; dashed lines are the medians &middot;
            hover for a team, click to open it
          </span>
        )}
      </figcaption>
    </figure>
  );
}
