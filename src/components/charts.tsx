// Small, dependency-free inline-SVG charts for the dashboard. Presentational
// only (no hooks), so they render on the server. Responsive via viewBox +
// width:100%. Colours come from the design tokens.

const ACCENT = "#2f86d6";

/**
 * A 30-day area/line trend. `values` is one number per day, oldest → newest.
 * Renders flat along the bottom when every value is 0.
 */
export function AreaChart({
  values,
  ariaLabel,
}: {
  values: number[];
  ariaLabel: string;
}) {
  const W = 300;
  const H = 90;
  const pad = 6;
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n <= 1 ? 0 : (i * W) / (n - 1));
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);

  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const linePath = `M ${line.join(" L ")}`;
  const areaPath = `${linePath} L ${W},${H} L 0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      className="h-32 w-full"
    >
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.28" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#areaFill)" />
      <path
        d={linePath}
        fill="none"
        stroke={ACCENT}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

/** A donut chart with an inline legend. Shows an empty ring when the total is 0. */
export function DonutChart({ segments }: { segments: DonutSegment[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const size = 120;
  const cx = size / 2;
  const cy = size / 2;
  const r = 46;
  const C = 2 * Math.PI * r;
  const stroke = 16;

  let acc = 0;

  return (
    <div className="flex items-center gap-5">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-28 w-28 shrink-0"
        role="img"
        aria-label="File types distribution"
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={stroke}
        />
        {total > 0 &&
          segments.map((s) => {
            if (s.value === 0) return null;
            const frac = s.value / total;
            const before = acc;
            acc += frac;
            return (
              <circle
                key={s.label}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={stroke}
                strokeDasharray={`${frac * C} ${C}`}
                transform={`rotate(${before * 360 - 90} ${cx} ${cy})`}
              />
            );
          })}
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-slate-800"
          fontSize="20"
          fontWeight="600"
        >
          {total}
        </text>
      </svg>

      <ul className="space-y-1.5 text-sm">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-slate-700">{s.label}</span>
            <span className="ml-auto tabular-nums text-muted-500">
              {s.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
