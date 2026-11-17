import React, { useState, useMemo } from 'react';
import type {
  ForecastDay,
  HeatmapCell,
  IntervalBucket,
  MaturityCounts,
  RetentionPoint,
  WordsLearnedPoint,
} from '../../core/statsEngine';

// ============================================================================
// 1. 12-Month Calendar Heatmap (GitHub-style)
// ============================================================================

export const CalendarHeatmapSvg: React.FC<{
  cells: HeatmapCell[];
}> = ({ cells }) => {
  const [hovered, setHovered] = useState<HeatmapCell | null>(null);

  const weeks = useMemo(() => {
    const cols: HeatmapCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) {
      cols.push(cells.slice(i, i + 7));
    }
    return cols;
  }, [cells]);

  const monthMarkers = useMemo(() => {
    const markers: { colIndex: number; label: string }[] = [];
    let lastMonth = '';
    weeks.forEach((week, colIdx) => {
      const first = week[0];
      if (!first) return;
      const monthKey = first.dateKey.slice(0, 7);
      if (monthKey !== lastMonth) {
        lastMonth = monthKey;
        const [y, m] = monthKey.split('-').map(Number);
        const label = new Date(y, (m || 1) - 1, 1).toLocaleDateString([], { month: 'short' });
        if (markers.length === 0 || colIdx - markers[markers.length - 1].colIndex >= 3) {
          markers.push({ colIndex: colIdx, label });
        }
      }
    });
    return markers;
  }, [weeks]);

  const cellSize = 11;
  const gap = 3;
  const step = cellSize + gap;
  const leftPad = 26;
  const topPad = 18;
  const width = leftPad + weeks.length * step + 4;
  const height = topPad + 7 * step + 6;

  const levelFills: Record<number, string> = {
    0: 'var(--surface-muted)',
    1: 'rgba(99, 102, 241, 0.30)',
    2: 'rgba(99, 102, 241, 0.54)',
    3: 'rgba(79, 70, 229, 0.78)',
    4: '#4f46e5',
  };

  return (
    <div className="space-y-2.5">
      <div className="overflow-x-auto pb-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full min-w-[660px] h-auto select-none"
          role="img"
          aria-label="12-month review activity calendar heatmap"
        >
          {/* Month headers */}
          {monthMarkers.map((m) => (
            <text
              key={`${m.colIndex}-${m.label}`}
              x={leftPad + m.colIndex * step}
              y={11}
              fontSize={9}
              fill="var(--text-muted)"
              className="font-medium"
            >
              {m.label}
            </text>
          ))}

          {/* Weekday labels */}
          {[
            { row: 1, text: 'Mon' },
            { row: 3, text: 'Wed' },
            { row: 5, text: 'Fri' },
          ].map((d) => (
            <text
              key={d.row}
              x={0}
              y={topPad + d.row * step + 9}
              fontSize={9}
              fill="var(--text-muted)"
            >
              {d.text}
            </text>
          ))}

          {/* Day cells */}
          {weeks.map((week, colIdx) =>
            week.map((cell, rowIdx) => (
              <rect
                key={cell.dateKey}
                x={leftPad + colIdx * step}
                y={topPad + rowIdx * step}
                width={cellSize}
                height={cellSize}
                rx={2.5}
                fill={levelFills[cell.level]}
                stroke={hovered?.dateKey === cell.dateKey ? 'var(--text)' : 'var(--border-subtle)'}
                strokeWidth={hovered?.dateKey === cell.dateKey ? 1.2 : 0.6}
                tabIndex={0}
                aria-label={`${cell.dateKey}: ${cell.count} reviews`}
                className="cursor-pointer outline-none"
                onMouseEnter={() => setHovered(cell)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(cell)}
                onClick={() => setHovered(cell)}
              />
            ))
          )}
        </svg>
      </div>

      {/* Tooltip / Legend Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
        <div className="min-h-[18px] tabular-nums">
          {hovered ? (
            <span className="font-semibold text-[var(--text)]">
              {hovered.dateKey}: {hovered.count} {hovered.count === 1 ? 'review' : 'reviews'}
            </span>
          ) : (
            <span>Hover or tap a day cell to inspect exact review count</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((lvl) => (
            <span
              key={lvl}
              className="w-2.5 h-2.5 rounded-[2px] border border-[var(--border)]"
              style={{ backgroundColor: levelFills[lvl] }}
              aria-hidden="true"
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 2. True Retention Line Chart (with Desired Retention target line)
// ============================================================================

export const RetentionLineChartSvg: React.FC<{
  series: RetentionPoint[];
  desiredPct: number;
}> = ({ series, desiredPct }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 620;
  const height = 210;
  const pad = { top: 16, right: 16, bottom: 28, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const minY = useMemo(() => {
    const lowest = series.reduce((m, p) => Math.min(m, p.retentionPct), desiredPct);
    return Math.max(0, Math.floor(Math.min(60, lowest - 10) / 10) * 10);
  }, [series, desiredPct]);

  const yFor = (pct: number) => {
    const clamped = Math.max(minY, Math.min(100, pct));
    return pad.top + ((100 - clamped) / (100 - minY)) * plotH;
  };

  const xFor = (idx: number) => {
    if (series.length <= 1) return pad.left + plotW / 2;
    return pad.left + (idx / (series.length - 1)) * plotW;
  };

  const linePath = useMemo(() => {
    return series
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(pt.retentionPct).toFixed(1)}`)
      .join(' ');
  }, [series, minY]);

  const yTicks = useMemo(() => {
    const step = (100 - minY) / 4;
    return [0, 1, 2, 3, 4].map((i) => Math.round(minY + i * step));
  }, [minY]);

  const desiredY = yFor(desiredPct);
  const labelStride = Math.max(1, Math.ceil(series.length / 7));
  const activePoint = hoverIdx !== null ? series[hoverIdx] : null;

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label="True retention percentage over time compared with desired retention"
      >
        {/* Grid lines */}
        {yTicks.map((tick) => {
          const y = yFor(tick);
          return (
            <g key={tick}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-muted)"
                className="tabular-nums"
              >
                {tick}%
              </text>
            </g>
          );
        })}

        {/* Desired retention reference line */}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={desiredY}
          y2={desiredY}
          stroke="#f59e0b"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
        <text
          x={width - pad.right - 2}
          y={desiredY - 5}
          textAnchor="end"
          fontSize={10}
          fill="#d97706"
          className="font-semibold tabular-nums"
        >
          Target {desiredPct}%
        </text>

        {/* Line path */}
        {series.length > 1 && (
          <path
            d={linePath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Interactive points & X labels */}
        {series.map((pt, idx) => {
          const cx = xFor(idx);
          const cy = yFor(pt.retentionPct);
          const showLabel = idx % labelStride === 0 || idx === series.length - 1;
          return (
            <g key={pt.dateKey}>
              {showLabel && (
                <text
                  x={cx}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="var(--text-muted)"
                  className="tabular-nums"
                >
                  {pt.label}
                </text>
              )}
              <circle
                cx={cx}
                cy={cy}
                r={hoverIdx === idx ? 5 : series.length > 45 ? 2.2 : 3.2}
                fill={hoverIdx === idx ? '#10b981' : 'var(--accent)'}
                stroke="var(--surface)"
                strokeWidth={1.5}
                className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => setHoverIdx(idx)}
              />
            </g>
          );
        })}
      </svg>

      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] min-h-[18px] tabular-nums">
        {activePoint ? (
          <span className="font-semibold text-[var(--text)]">
            {activePoint.dateKey}: {activePoint.retentionPct}% retention ({activePoint.sampleCount} reviews)
          </span>
        ) : (
          <span>Hover or tap points for daily/bucket details</span>
        )}
        <span className="text-amber-600 dark:text-amber-400 font-semibold">
          Dashed: Desired {desiredPct}%
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// 3. 30-Day Review Forecast Bar Chart (Daily / Cumulative)
// ============================================================================

export const ForecastBarChartSvg: React.FC<{
  days: ForecastDay[];
  cumulative: boolean;
}> = ({ days, cumulative }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 620;
  const height = 210;
  const pad = { top: 14, right: 12, bottom: 28, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxY = useMemo(() => {
    const peak = days.reduce(
      (m, d) => Math.max(m, cumulative ? d.cumulativeDue : d.totalDue),
      0
    );
    return Math.max(4, Math.ceil(peak * 1.15));
  }, [days, cumulative]);

  const barStep = plotW / Math.max(1, days.length);
  const barW = Math.max(5, barStep * 0.68);
  const activeDay = hoverIdx !== null ? days[hoverIdx] : null;

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label="30-day review forecast bar chart"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const val = Math.round(maxY * frac);
          const y = pad.top + plotH * (1 - frac);
          return (
            <g key={frac}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-muted)"
                className="tabular-nums"
              >
                {val}
              </text>
            </g>
          );
        })}

        {days.map((d, idx) => {
          const val = cumulative ? d.cumulativeDue : d.totalDue;
          const barH = (val / maxY) * plotH;
          const x = pad.left + idx * barStep + (barStep - barW) / 2;
          const y = pad.top + plotH - barH;
          const showLabel = idx === 0 || idx === 6 || idx === 13 || idx === 20 || idx === 29;

          return (
            <g key={d.dateKey}>
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="var(--text-muted)"
                  className="tabular-nums"
                >
                  {d.label}
                </text>
              )}

              {cumulative ? (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(1, barH)}
                  rx={2}
                  fill={hoverIdx === idx ? '#4f46e5' : 'rgba(99, 102, 241, 0.72)'}
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverIdx(idx)}
                  onMouseLeave={() => setHoverIdx(null)}
                  onClick={() => setHoverIdx(idx)}
                />
              ) : (
                <>
                  {/* Review portion (indigo) + Learning portion (amber) */}
                  {d.reviewCount > 0 && (
                    <rect
                      x={x}
                      y={pad.top + plotH - (d.reviewCount / maxY) * plotH}
                      width={barW}
                      height={Math.max(1, (d.reviewCount / maxY) * plotH)}
                      rx={1.5}
                      fill={hoverIdx === idx ? '#4338ca' : 'var(--accent)'}
                      className="cursor-pointer"
                      onMouseEnter={() => setHoverIdx(idx)}
                      onMouseLeave={() => setHoverIdx(null)}
                      onClick={() => setHoverIdx(idx)}
                    />
                  )}
                  {d.learningCount > 0 && (
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(1, (d.learningCount / maxY) * plotH)}
                      rx={1.5}
                      fill="#f59e0b"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoverIdx(idx)}
                      onMouseLeave={() => setHoverIdx(null)}
                      onClick={() => setHoverIdx(idx)}
                    />
                  )}
                  {d.totalDue === 0 && (
                    <rect
                      x={x}
                      y={pad.top + plotH - 2}
                      width={barW}
                      height={2}
                      fill="var(--border)"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoverIdx(idx)}
                      onMouseLeave={() => setHoverIdx(null)}
                      onClick={() => setHoverIdx(idx)}
                    />
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)] min-h-[18px] tabular-nums">
        {activeDay ? (
          <span className="font-semibold text-[var(--text)]">
            {activeDay.dateKey}: {cumulative ? `${activeDay.cumulativeDue} cumulative` : `${activeDay.totalDue} due`} ({activeDay.reviewCount} review, {activeDay.learningCount} learning)
          </span>
        ) : (
          <span>Hover or tap a bar for exact due counts</span>
        )}
        {!cumulative && (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-xs bg-[var(--accent)]" /> Review
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-xs bg-amber-500" /> Learning
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 4. Card Maturity Donut & Interval Distribution Histogram
// ============================================================================

export const MaturityDonutSvg: React.FC<{
  maturity: MaturityCounts;
}> = ({ maturity }) => {
  const segments = [
    { key: 'New', count: maturity.newCount, color: '#0ea5e9' },
    { key: 'Learning', count: maturity.learningCount, color: '#f59e0b' },
    { key: 'Young (<21d)', count: maturity.youngCount, color: '#6366f1' },
    { key: 'Mature (21d+)', count: maturity.matureCount, color: '#10b981' },
    { key: 'Suspended', count: maturity.suspendedCount, color: '#94a3b8' },
  ];

  const total = Math.max(1, maturity.totalCards);
  const size = 148;
  const stroke = 20;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-col sm:flex-row items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-label="Card maturity breakdown donut chart"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--surface-muted)"
            strokeWidth={stroke}
          />
          {maturity.totalCards > 0 &&
            segments.map((seg) => {
              if (seg.count === 0) return null;
              const segLen = (seg.count / total) * circ;
              const el = (
                <circle
                  key={seg.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={stroke}
                  strokeDasharray={`${segLen} ${circ - segLen}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += segLen;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center tabular-nums">
          <span className="text-xl font-black text-[var(--text)] leading-none">
            {maturity.totalCards}
          </span>
          <span className="text-[10px] text-[var(--text-muted)] mt-1">Cards</span>
        </div>
      </div>

      <div className="flex-1 w-full space-y-1.5 text-xs tabular-nums">
        {segments.map((seg) => {
          const pct = maturity.totalCards > 0 ? Math.round((seg.count / maturity.totalCards) * 100) : 0;
          return (
            <div key={seg.key} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                <span
                  className="w-2.5 h-2.5 rounded-xs shrink-0"
                  style={{ backgroundColor: seg.color }}
                  aria-hidden="true"
                />
                <span>{seg.key}</span>
              </div>
              <span className="font-semibold text-[var(--text)]">
                {seg.count} <span className="text-[var(--text-muted)] font-normal">({pct}%)</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const IntervalHistogramSvg: React.FC<{
  buckets: IntervalBucket[];
}> = ({ buckets }) => {
  const width = 420;
  const height = 165;
  const pad = { top: 18, right: 10, bottom: 26, left: 32 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxVal = Math.max(2, ...buckets.map((b) => b.count));
  const step = plotW / Math.max(1, buckets.length);
  const barW = Math.max(16, step * 0.56);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-auto"
      role="img"
      aria-label="Interval distribution histogram"
    >
      {[0, 0.5, 1].map((frac) => {
        const val = Math.round(maxVal * frac);
        const y = pad.top + plotH * (1 - frac);
        return (
          <g key={frac}>
            <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="var(--border)" />
            <text
              x={pad.left - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={9.5}
              fill="var(--text-muted)"
              className="tabular-nums"
            >
              {val}
            </text>
          </g>
        );
      })}

      {buckets.map((b, idx) => {
        const barH = (b.count / maxVal) * plotH;
        const x = pad.left + idx * step + (step - barW) / 2;
        const y = pad.top + plotH - barH;
        const isMature = idx >= 4;
        return (
          <g key={b.label}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(1, barH)}
              rx={3}
              fill={isMature ? '#10b981' : 'var(--accent)'}
            />
            {b.count > 0 && (
              <text
                x={x + barW / 2}
                y={Math.max(11, y - 4)}
                textAnchor="middle"
                fontSize={9.5}
                fill="var(--text)"
                className="font-semibold tabular-nums"
              >
                {b.count}
              </text>
            )}
            <text
              x={x + barW / 2}
              y={height - 8}
              textAnchor="middle"
              fontSize={9.5}
              fill="var(--text-muted)"
              className="tabular-nums"
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ============================================================================
// 5. Words Learned Over Time (Cumulative Dual Line: Mature Cards & Known Words)
// ============================================================================

export const WordsLearnedChartSvg: React.FC<{
  series: WordsLearnedPoint[];
}> = ({ series }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Downsample visually to <= 90 points for crisp SVG rendering while preserving endpoints
  const displaySeries = useMemo(() => {
    if (series.length <= 90) return series;
    const step = Math.ceil(series.length / 90);
    return series.filter((_, idx) => idx % step === 0 || idx === series.length - 1);
  }, [series]);

  const width = 620;
  const height = 210;
  const pad = { top: 14, right: 16, bottom: 28, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxY = useMemo(() => {
    const peak = displaySeries.reduce(
      (m, p) => Math.max(m, p.matureCards, p.knownWords),
      0
    );
    return Math.max(4, Math.ceil(peak * 1.15));
  }, [displaySeries]);

  const xFor = (idx: number) =>
    displaySeries.length <= 1
      ? pad.left + plotW / 2
      : pad.left + (idx / (displaySeries.length - 1)) * plotW;

  const yFor = (val: number) => pad.top + plotH - (val / maxY) * plotH;

  const maturePath = displaySeries
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.matureCards).toFixed(1)}`)
    .join(' ');
  const knownPath = displaySeries
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.knownWords).toFixed(1)}`)
    .join(' ');

  const stride = Math.max(1, Math.ceil(displaySeries.length / 7));
  const activePt = hoverIdx !== null ? displaySeries[hoverIdx] : null;

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label="Cumulative mature cards and known words over time"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const val = Math.round(maxY * frac);
          const y = pad.top + plotH * (1 - frac);
          return (
            <g key={frac}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="var(--border)" />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-muted)"
                className="tabular-nums"
              >
                {val}
              </text>
            </g>
          );
        })}

        {displaySeries.length > 1 && (
          <>
            <path d={knownPath} fill="none" stroke="#0ea5e9" strokeWidth={2.2} strokeLinejoin="round" />
            <path d={maturePath} fill="none" stroke="#10b981" strokeWidth={2.2} strokeLinejoin="round" />
          </>
        )}

        {displaySeries.map((pt, idx) => {
          const cx = xFor(idx);
          const showLabel = idx % stride === 0 || idx === displaySeries.length - 1;
          return (
            <g key={pt.dateKey}>
              {showLabel && (
                <text
                  x={cx}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="var(--text-muted)"
                  className="tabular-nums"
                >
                  {pt.label}
                </text>
              )}
              <rect
                x={cx - plotW / Math.max(20, displaySeries.length * 2)}
                y={pad.top}
                width={Math.max(6, plotW / Math.max(1, displaySeries.length))}
                height={plotH}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => setHoverIdx(idx)}
              />
              {hoverIdx === idx && (
                <>
                  <circle cx={cx} cy={yFor(pt.knownWords)} r={4} fill="#0ea5e9" />
                  <circle cx={cx} cy={yFor(pt.matureCards)} r={4} fill="#10b981" />
                </>
              )}
            </g>
          );
        })}
      </svg>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)] min-h-[18px] tabular-nums">
        {activePt ? (
          <span className="font-semibold text-[var(--text)]">
            {activePt.dateKey}: {activePt.matureCards} mature cards · {activePt.knownWords} known words
          </span>
        ) : (
          <span>Hover or tap along timeline to inspect cumulative totals</span>
        )}
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500" /> Mature cards
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-xs bg-sky-500" /> Known words
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 6. Generic Daily Bar Chart (Study Time & Lookups)
// ============================================================================

export const DailyMetricBarChartSvg: React.FC<{
  points: { dateKey: string; label: string; value: number }[];
  unitLabel: string;
  barColor: string;
  ariaLabel: string;
}> = ({ points, unitLabel, barColor, ariaLabel }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Aggregate weekly if > 95 days so bars stay clearly visible on 1y/all
  const bars = useMemo(() => {
    if (points.length <= 95) {
      return points.map((p) => ({ ...p, rangeLabel: p.dateKey }));
    }
    const grouped: { dateKey: string; label: string; value: number; rangeLabel: string }[] = [];
    for (let i = 0; i < points.length; i += 7) {
      const slice = points.slice(i, i + 7);
      const sum = slice.reduce((a, b) => a + b.value, 0);
      grouped.push({
        dateKey: slice[0].dateKey,
        label: slice[0].label,
        value: Number(sum.toFixed(1)),
        rangeLabel: `${slice[0].dateKey} .. ${slice[slice.length - 1].dateKey}`,
      });
    }
    return grouped;
  }, [points]);

  const width = 620;
  const height = 190;
  const pad = { top: 14, right: 12, bottom: 26, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const maxY = Math.max(2, ...bars.map((b) => b.value)) * 1.15;
  const step = plotW / Math.max(1, bars.length);
  const barW = Math.max(3, step * 0.68);
  const labelStride = Math.max(1, Math.ceil(bars.length / 7));
  const activeBar = hoverIdx !== null ? bars[hoverIdx] : null;

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label={ariaLabel}>
        {[0, 0.5, 1].map((frac) => {
          const val = Math.round(maxY * frac);
          const y = pad.top + plotH * (1 - frac);
          return (
            <g key={frac}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="var(--border)" />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-muted)"
                className="tabular-nums"
              >
                {val}
              </text>
            </g>
          );
        })}

        {bars.map((b, idx) => {
          const barH = (b.value / maxY) * plotH;
          const x = pad.left + idx * step + (step - barW) / 2;
          const y = pad.top + plotH - barH;
          const showLabel = idx % labelStride === 0 || idx === bars.length - 1;
          return (
            <g key={b.dateKey}>
              {showLabel && (
                <text
                  x={x + barW / 2}
                  y={height - 7}
                  textAnchor="middle"
                  fontSize={9.5}
                  fill="var(--text-muted)"
                  className="tabular-nums"
                >
                  {b.label}
                </text>
              )}
              <rect
                x={x}
                y={b.value > 0 ? y : pad.top + plotH - 1.5}
                width={barW}
                height={b.value > 0 ? Math.max(2, barH) : 1.5}
                rx={1.5}
                fill={b.value > 0 ? barColor : 'var(--border)'}
                opacity={hoverIdx !== null && hoverIdx !== idx ? 0.6 : 1}
                className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => setHoverIdx(idx)}
              />
            </g>
          );
        })}
      </svg>

      <div className="text-[11px] text-[var(--text-muted)] min-h-[18px] tabular-nums">
        {activeBar ? (
          <span className="font-semibold text-[var(--text)]">
            {activeBar.rangeLabel}: {activeBar.value} {unitLabel}
          </span>
        ) : (
          <span>Hover or tap a bar for exact values</span>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 7. Card Types Breakdown Chart
// ============================================================================

export const CardTypeBreakdownChart: React.FC<{
  rows: {
    cardType: string;
    label: string;
    totalCards: number;
    newCount: number;
    learningCount: number;
    youngCount: number;
    matureCount: number;
    reviews: number;
    retentionPct: number | null;
  }[];
}> = ({ rows }) => {
  const maxTotal = Math.max(1, ...rows.map((r) => r.totalCards));

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const pct = Math.round((row.totalCards / maxTotal) * 100);
        const activeCount = row.newCount + row.learningCount + row.youngCount + row.matureCount;
        const matureW = activeCount > 0 ? (row.matureCount / row.totalCards) * 100 : 0;
        const youngW = activeCount > 0 ? (row.youngCount / row.totalCards) * 100 : 0;
        const learnW = activeCount > 0 ? (row.learningCount / row.totalCards) * 100 : 0;
        const newW = Math.max(0, 100 - matureW - youngW - learnW);

        return (
          <div key={row.cardType} className="space-y-1.5 text-xs tabular-nums">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-[var(--text)]">{row.label}</span>
              <span className="text-[11px] text-[var(--text-muted)]">
                <strong className="text-[var(--text)]">{row.totalCards}</strong>{' '}
                {row.totalCards === 1 ? 'card' : 'cards'} · {row.reviews} reviews
                {row.retentionPct !== null ? ` · ${row.retentionPct}% retention` : ''}
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-[var(--surface-muted)] overflow-hidden">
              {row.totalCards > 0 && (
                <div
                  className="h-full flex overflow-hidden rounded-full"
                  style={{ width: `${Math.max(4, pct)}%` }}
                >
                  {matureW > 0 && (
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${matureW}%` }}
                      title={`Mature: ${row.matureCount}`}
                    />
                  )}
                  {youngW > 0 && (
                    <div
                      className="h-full bg-indigo-500"
                      style={{ width: `${youngW}%` }}
                      title={`Young: ${row.youngCount}`}
                    />
                  )}
                  {learnW > 0 && (
                    <div
                      className="h-full bg-amber-500"
                      style={{ width: `${learnW}%` }}
                      title={`Learning: ${row.learningCount}`}
                    />
                  )}
                  {newW > 0 && (
                    <div
                      className="h-full bg-sky-500/80"
                      style={{ width: `${newW}%` }}
                      title={`New: ${row.newCount}`}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="pt-1 flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500" /> Mature
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-xs bg-indigo-500" /> Young
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-xs bg-amber-500" /> Learning
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-xs bg-sky-500/80" /> New
        </span>
      </div>
    </div>
  );
};
