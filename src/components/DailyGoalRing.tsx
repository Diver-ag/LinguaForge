import React from 'react';

interface DailyGoalRingProps {
  reviewed: number;
  goal: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
}

export const DailyGoalRing: React.FC<DailyGoalRingProps> = ({
  reviewed,
  goal,
  size = 76,
  strokeWidth = 7,
  label = 'Daily goal',
}) => {
  const safeGoal = Math.max(1, goal);
  const pct = Math.min(100, Math.round((reviewed / safeGoal) * 100));
  const ratio = Math.min(1, reviewed / safeGoal);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const completed = reviewed >= safeGoal;

  return (
    <div className="flex items-center gap-3.5" aria-label={`${label}: ${reviewed} of ${safeGoal} reviews (${pct}%)`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-hidden="true"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--border)"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={completed ? '#10b981' : 'var(--accent)'}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-[stroke-dashoffset] duration-300"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center tabular-nums">
          <span className="text-xs font-black text-[var(--text)] leading-none">{pct}%</span>
        </div>
      </div>

      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-bold text-[var(--text)]">{label}</div>
        <div className="text-xs text-[var(--text-secondary)] tabular-nums">
          <span className="font-bold text-[var(--text)]">{reviewed}</span> / {safeGoal} reviews
        </div>
        <div className="text-[11px] text-[var(--text-muted)]">
          {completed ? 'Goal reached today' : `${safeGoal - reviewed} more to reach goal`}
        </div>
      </div>
    </div>
  );
};
