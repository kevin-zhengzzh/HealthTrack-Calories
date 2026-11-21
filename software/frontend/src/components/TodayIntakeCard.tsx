import { Link } from 'react-router-dom'
import { INTAKE_COLOR, useGoals } from '../goals'
import type { IntakeRecord } from '../types'
import TodayCard from './TodayCard'

// Today's food intake against the daily intake goal (Plan page).
// records: today's meals, null while loading.
export default function TodayIntakeCard({ records }: { records: IntakeRecord[] | null }) {
  const { intake } = useGoals()

  return (
    <TodayCard
      title="Today's intake"
      headerAction={
        <Link to="/food-log" className="text-sm font-medium hover:underline" style={{ color: 'var(--primary)' }}>
          Food Log →
        </Link>
      }
      color={INTAKE_COLOR}
      entries={records?.map((r) => ({ id: r.id, label: r.foodName || 'Unnamed food', time: r.createdAt, kcal: r.calories })) ?? null}
      goal={intake?.perDay ?? null}
      noun="eaten"
      noGoal={<>No intake goal yet — <Link to="/plan" className="font-medium hover:underline" style={{ color: 'var(--primary)' }}>set one in Plan</Link>.</>}
      emptyText="Nothing logged yet today. Put food on your scale to add it."
    />
  )
}
