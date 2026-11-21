import { Link } from 'react-router-dom'
import { INTAKE_COLOR, useGoals } from '../goals'
import { useStore } from '../store'
import type { IntakeRecord } from '../types'
import TodayCard, { type Period } from './TodayCard'

// Food intake for today or this week against the intake goal (Plan page).
// records: the period's meals, null while loading.
export default function TodayIntakeCard({ records, period }: { records: IntakeRecord[] | null; period: Period }) {
  const { intake } = useGoals()
  const setMealModalOpen = useStore((s) => s.setMealModalOpen)

  return (
    <TodayCard
      title={period === 'day' ? "Today's intake" : "This week's intake"}
      headerAction={
        <button onClick={() => setMealModalOpen(true)} className="text-sm font-medium hover:underline cursor-pointer" style={{ color: INTAKE_COLOR }}>
          + Add meal
        </button>
      }
      color={INTAKE_COLOR}
      period={period}
      entries={records?.map((r) => ({ id: r.id, label: r.foodName || 'Unnamed food', time: r.createdAt, date: r.date, kcal: r.calories })) ?? null}
      goal={(period === 'day' ? intake?.perDay : intake?.perWeek) ?? null}
      noun="eaten"
      noGoal={<>No intake goal yet — <Link to="/plan" className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>set one in Plan</Link>.</>}
      emptyText={period === 'day' ? 'Nothing logged yet today. Put food on your scale, or add a meal by hand.' : 'Nothing logged yet this week.'}
      footer={
        <Link to="/history/food" className="text-xs text-[var(--text-muted)] hover:underline self-start">
          All meals in the Food Log →
        </Link>
      }
    />
  )
}
