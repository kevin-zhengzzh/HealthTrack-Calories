import { useCallback } from 'react'
import { updateGoal } from './api'
import { useStore } from './store'
import type { GoalKind, Goals } from './types'

// Both goals are stored per week; the daily figure is always derived from it
// (same rounding as the backend's Goals.PerDay), so setting either one never
// makes the other drift.
export const MAX_GOAL_PER_DAY = 20000
export const MAX_GOAL_PER_WEEK = MAX_GOAL_PER_DAY * 7

export const perDay = (perWeek: number) => Math.round(perWeek / 7)

// Intake is blue everywhere; burn uses the theme colour (it was the app's
// only calorie figure before intake existed)
export const INTAKE_COLOR = '#2a78d6'

export interface Goal {
  perDay: number
  perWeek: number
}

const goalOf = (perWeek: number | null | undefined): Goal | null =>
  perWeek == null ? null : { perDay: perDay(perWeek), perWeek }

// Current goals from the signed-in user, and a saver for the Plan page.
// Either is null when not set (new accounts start with a burn goal).
export function useGoals() {
  const user = useStore((s) => s.user)
  const setUser = useStore((s) => s.setUser)

  const save = useCallback(async (kind: GoalKind, value: { perDay: number } | { perWeek: number } | null) => {
    const res: Goals = await updateGoal(kind, value)
    const current = useStore.getState().user
    if (current) setUser({ ...current, weeklyIntakeGoal: res.intake.perWeek, weeklyCalorieGoal: res.burn.perWeek })
  }, [setUser])

  return {
    loaded: user !== null,
    intake: goalOf(user?.weeklyIntakeGoal),
    burn: goalOf(user?.weeklyCalorieGoal),
    save,
  }
}
