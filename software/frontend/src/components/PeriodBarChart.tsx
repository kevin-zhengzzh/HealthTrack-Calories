import { useLayoutEffect, useRef, useState } from 'react'
import { axis, type Bar, type PeriodKind } from '../stats'

// One bar chart for intake and burn alike (only the colour changes): a bar
// per day (week, month) or per month (year, as a daily average), with the
// daily goal as a dashed line and the period's daily average as a dotted one.
// Hover (or tap) a bar for its figure.

const H = 240
const M = { top: 12, right: 8, bottom: 26, left: 46 }

export default function PeriodBarChart({
  bars,
  kind,
  color,
  goal,
  avg,
  todayKey,
}: {
  bars: Bar[]
  kind: PeriodKind
  color: string
  goal: number | null // kcal/day
  avg: number | null // kcal/day
  todayKey: string // yyyy-MM-dd or yyyy-MM: emphasised on the axis
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { top, step } = axis(Math.max(...bars.map((b) => b.value), goal ?? 0, avg ?? 0))
  const plotW = w - M.left - M.right
  const plotH = H - M.top - M.bottom
  const band = plotW / bars.length
  const barW = Math.min(36, Math.max(3, band - 2 * Math.max(1, band * 0.18)))
  const y = (v: number) => M.top + plotH - (v / top) * plotH
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  // Day numbers on a month axis would collide: label 1, 5, 10, … only
  const showLabel = (i: number) => kind !== 'month' || i === 0 || (i + 1) % 5 === 0
  const h = hover === null ? null : bars[hover]

  return (
    <div ref={wrap} className="relative w-full select-none">
      <svg width={w} height={H} role="img"
        aria-label={`Bar chart, ${bars.length} bars${avg !== null ? `, daily average ${avg} kcal` : ''}${goal !== null ? `, goal ${goal} kcal a day` : ''}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={w - M.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} className="fill-[var(--text-muted)] tabular-nums">
              {t.toLocaleString()}
            </text>
          </g>
        ))}

        {bars.map((b, i) => {
          const x = M.left + i * band + (band - barW) / 2
          const bh = (b.value / top) * plotH
          const r = Math.min(4, barW / 2, bh)
          const base = M.top + plotH
          return (
            <g key={b.key}>
              {bh > 0 && (
                <path
                  d={`M${x},${base} V${base - bh + r} Q${x},${base - bh} ${x + r},${base - bh} H${x + barW - r} Q${x + barW},${base - bh} ${x + barW},${base - bh + r} V${base} Z`}
                  fill={color}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                  className="transition-opacity"
                />
              )}
              {showLabel(i) && (
                <text x={M.left + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize={11}
                  className={b.key === todayKey ? 'fill-[var(--text-primary)] font-semibold' : 'fill-[var(--text-muted)]'}>
                  {b.label}
                </text>
              )}
              {/* Hit area: the whole column, bigger than the bar */}
              <rect x={M.left + i * band} y={M.top} width={band} height={plotH} fill="transparent"
                onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} onPointerLeave={() => setHover(null)} />
            </g>
          )
        })}

        {goal !== null && goal > 0 && (
          <line x1={M.left} x2={w - M.right} y1={y(goal)} y2={y(goal)} stroke="var(--text-secondary)" strokeWidth={1.5} strokeDasharray="6 4" pointerEvents="none" />
        )}
        {avg !== null && (
          <line x1={M.left} x2={w - M.right} y1={y(avg)} y2={y(avg)} stroke={color} strokeWidth={2} strokeDasharray="1.5 4" strokeLinecap="round" pointerEvents="none" />
        )}
      </svg>

      {h && (
        <div
          className="absolute pointer-events-none bg-[var(--bg-surface)] border border-[var(--border)] shadow-lg rounded-lg px-3 py-2 text-xs whitespace-nowrap z-10"
          style={{
            left: Math.min(Math.max(M.left + hover! * band + band / 2, 70), w - 70),
            top: Math.max(0, y(h.value) - 8),
            transform: 'translate(-50%, -100%)',
          }}
        >
          <p className="text-[var(--text-muted)]">{h.title}</p>
          <p className="font-semibold text-[var(--text-primary)] tabular-nums">
            {h.future ? 'Not yet' : h.loggedDays === 0 ? 'Nothing logged' : `${h.value.toLocaleString()} kcal${kind === 'year' ? '/day' : ''}`}
          </p>
          {kind === 'year' && h.loggedDays > 0 && <p className="text-[var(--text-muted)]">{h.loggedDays} day{h.loggedDays === 1 ? '' : 's'} logged</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--text-muted)] mt-1 pl-1">
        {avg !== null && (
          <span className="flex items-center gap-1.5">
            <svg width="18" height="4" aria-hidden><line x1="1" x2="17" y1="2" y2="2" stroke={color} strokeWidth={2} strokeDasharray="1.5 4" strokeLinecap="round" /></svg>
            Daily average <span className="tabular-nums font-semibold text-[var(--text-secondary)]">{avg.toLocaleString()}</span>
          </span>
        )}
        {goal !== null && goal > 0 && (
          <span className="flex items-center gap-1.5">
            <svg width="18" height="4" aria-hidden><line x1="0" x2="18" y1="2" y2="2" stroke="var(--text-secondary)" strokeWidth={1.5} strokeDasharray="6 4" /></svg>
            Daily goal <span className="tabular-nums font-semibold text-[var(--text-secondary)]">{goal.toLocaleString()}</span>
          </span>
        )}
      </div>
    </div>
  )
}
