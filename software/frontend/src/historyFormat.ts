import { localDateStr } from './intake'

// Shared formatting and styles for the History tabs (Food Log, Workouts,
// Check-ins) and the dialogs they open, so all three look the same.

// "Today" / "Yesterday" / "Wed, Nov 18". The site is in English: a fixed
// locale, not the browser's (a Chinese browser showed "11月19日周四").
export function formatDay(dateStr: string) {
  const today = localDateStr()
  const yesterday = localDateStr(new Date(Date.now() - 86_400_000))
  if (dateStr === today) return 'Today'
  if (dateStr === yesterday) return 'Yesterday'
  return parseLocalDate(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatMonth(month: string) {
  return parseLocalDate(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// 24-hour times, like the clock on the device
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// "YYYY-MM-DD" as local midnight (a bare date string would parse as UTC)
export function parseLocalDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// Groups by a key (newest first), keeping each group's order
export function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = map.get(k) ?? []
    list.push(it)
    map.set(k, list)
  }
  return [...map.entries()].sort(([a], [b]) => b.localeCompare(a))
}

// Case-insensitive substring match, falling back to an in-order subsequence
// match (e.g. "cyc" or "ccyl" both still find "Cycling") for typo tolerance
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t.includes(q)) return true
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

// How many day (or month) cards a tab shows at first, and per "Show older"
export const GROUPS_PER_PAGE = 10

export const inputClass = 'border border-[var(--border-strong)] rounded-lg px-4 py-2 text-sm bg-[var(--bg-surface)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-green-500'
export const secondaryBtn = 'flex-1 border border-[var(--border-strong)] text-[var(--text-secondary)] rounded-lg py-2 font-semibold hover:bg-[var(--bg-inset)] transition cursor-pointer'
export const primaryBtn = 'flex-1 text-white rounded-lg py-2 font-semibold transition disabled:opacity-60 cursor-pointer'
export const dangerBtn = 'flex-1 bg-red-500 text-white rounded-lg py-2 font-semibold hover:bg-red-600 transition disabled:opacity-60 cursor-pointer'
