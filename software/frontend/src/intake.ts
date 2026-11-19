import { useCallback } from 'react'
import { updateIntakeGoal } from './api'
import { useStore } from './store'

// yyyy-MM-dd of the browser's local day; intake records carry the same format
export function localDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const MAX_INTAKE_GOAL = 20000

// The daily intake goal lives on the user, so it carries over to later days
// until it's changed. Returns the current goal (null = not set) and a saver.
export function useIntakeGoal() {
  const user = useStore((s) => s.user)
  const setUser = useStore((s) => s.setUser)
  const pushToast = useStore((s) => s.pushToast)

  const save = useCallback(async (goal: number | null) => {
    try {
      const res = await updateIntakeGoal(goal)
      const current = useStore.getState().user
      if (current) setUser({ ...current, dailyIntakeGoal: res.dailyIntakeGoal })
      pushToast(goal === null ? 'Daily goal cleared.' : 'Daily goal updated!', 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to update goal')
      throw err
    }
  }, [setUser, pushToast])

  return { goal: user?.dailyIntakeGoal ?? null, loaded: user !== null, save }
}
