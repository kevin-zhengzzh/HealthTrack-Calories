import { useEffect, useState } from 'react'
import { getCheckInHistory, getWorkoutHistory } from '../api'
import { useStore } from '../store'
import type { CheckIn, WorkoutRecord } from '../types'
import CalorieBarChart from '../components/CalorieBarChart'
import WeeklyGoalDonut from '../components/WeeklyGoalDonut'
import CheckInHeatmap from '../components/CheckInHeatmap'
import WeeklySummaryCard from '../components/WeeklySummaryCard'

// Trends and history, moved off the dashboard (which now only shows today).
// For now it holds the dashboard's former charts as they were; the intake /
// burn switch with calendar week / month / year views comes next.
export default function Statistics() {
  const { user, workoutRefreshKey } = useStore()
  const [workouts, setWorkouts] = useState<WorkoutRecord[]>([])
  const [checkIns, setCheckIns] = useState<CheckIn[]>([])

  useEffect(() => {
    getWorkoutHistory().then(setWorkouts).catch(console.error)
    getCheckInHistory().then(setCheckIns).catch(console.error)
  }, [workoutRefreshKey])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold text-[var(--text-primary)]">Statistics</h1>

      <WeeklySummaryCard />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CalorieBarChart records={workouts} />
        {user && <WeeklyGoalDonut records={workouts} goal={user.weeklyCalorieGoal} />}
      </div>

      <CheckInHeatmap checkIns={checkIns} records={workouts} />
    </div>
  )
}
