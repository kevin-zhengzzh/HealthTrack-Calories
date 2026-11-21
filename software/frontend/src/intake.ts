import { useGoals } from './goals'

// yyyy-MM-dd of the browser's local day; intake records carry the same format
export function localDateStr(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Daily intake goal (null = not set), derived from the weekly one. Set on the
// Plan page.
export function useIntakeGoal() {
  const { intake, loaded } = useGoals()
  return { goal: intake?.perDay ?? null, loaded }
}
