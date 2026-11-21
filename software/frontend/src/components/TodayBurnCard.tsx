import { Link } from 'react-router-dom'
import { useGoals } from '../goals'
import InfoTip from './InfoTip'
import { useStore } from '../store'
import type { WorkoutRecord } from '../types'
import TodayCard from './TodayCard'

// Today's workouts against the daily burn goal (weekly burn goal ÷ 7, set on
// the Plan page), with this week's progress underneath.
// today: today's workouts; weekTotal: kcal burned since Monday.
export default function TodayBurnCard({
  today,
  weekTotal,
  base,
  loading,
}: {
  today: WorkoutRecord[]
  weekTotal: number
  base: number | null // base burn kcal/day, null = body details incomplete
  loading: boolean
}) {
  const workouts = today.reduce((s, r) => s + r.calories, 0)
  const { burn } = useGoals()
  const setRecordModalOpen = useStore((s) => s.setRecordModalOpen)
  const weekGoal = burn?.perWeek ?? null
  const weekPct = weekGoal ? Math.min(100, (weekTotal / weekGoal) * 100) : 0

  return (
    <TodayCard
      title="Today's burn"
      headerAction={
        <button
          onClick={() => setRecordModalOpen(true)}
          className="text-sm font-medium hover:underline cursor-pointer"
          style={{ color: 'var(--primary)' }}
        >
          + Record workout
        </button>
      }
      color="var(--primary)"
      entries={loading ? null : today.map((r) => ({ id: r.id, label: r.workoutType, time: r.createdAt, kcal: r.calories }))}
      goal={burn?.perDay ?? null}
      noun="burned"
      noGoal="No burn goal yet."
      emptyText="No workouts yet today."
      footer={
        <div className="flex flex-col gap-3">
          <p className="text-xs text-[var(--text-muted)]">
            {base === null ? (
              <>
                Add your body details on the <Link to="/plan" className="underline">Plan</Link> page to count your base
                burn too.
              </>
            ) : (
              <>
                With base burn {base.toLocaleString()}:{' '}
                <span className="tabular-nums font-semibold text-[var(--text-secondary)]">{(base + workouts).toLocaleString()} kcal</span>{' '}
                today{' '}
                <InfoTip label="About base burn">
                  The energy your body uses in a whole day without workouts (resting metabolism × everyday activity),
                  estimated from your body details on the <Link to="/plan" className="underline">Plan</Link> page. It
                  counts towards Burned and Net, but not towards your burn goal, which is for workouts.
                </InfoTip>
              </>
            )}
          </p>
          {weekGoal !== null && (
          <div>
            <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
              <span>This week</span>
              <span className="tabular-nums">
                {weekTotal.toLocaleString()} / {weekGoal.toLocaleString()} kcal
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--bg-inset)] overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${weekPct}%`, backgroundColor: 'var(--primary)' }}
              />
            </div>
          </div>
          )}
        </div>
      }
    />
  )
}
