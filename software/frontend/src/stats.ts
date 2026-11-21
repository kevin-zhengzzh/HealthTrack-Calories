import { localDateStr } from './intake'

// Calendar periods for the Statistics page, like a bookkeeping app: a week
// (Monday–Sunday), a month or a year, stepped back with an offset (0 = the
// current one). Week and month show a bar per day; the year shows a bar per
// month holding that month's daily average, so all three read in kcal/day
// against the same daily goal. Averages only count days with something
// logged: a day you forgot to log isn't a day you ate nothing.

export type PeriodKind = 'week' | 'month' | 'year'

export interface PeriodRange {
  from: string // yyyy-MM-dd, inclusive
  to: string
  label: string
  current: boolean
}

export interface Bar {
  key: string // yyyy-MM-dd, or yyyy-MM for a month
  label: string // axis label
  title: string // tooltip heading
  value: number // kcal (day total, or the month's daily average)
  loggedDays: number // days with entries behind this bar
  future: boolean
}

const day = (y: number, m: number, d: number) => new Date(y, m, d)
const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-US', opts)

export function periodRange(kind: PeriodKind, offset: number, today = new Date()): PeriodRange {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate()
  if (kind === 'week') {
    const monday = day(y, m, d - ((today.getDay() + 6) % 7) - 7 * offset)
    const sunday = day(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
    const sameMonth = monday.getMonth() === sunday.getMonth()
    const label = `${fmt(monday, { month: 'short', day: 'numeric' })} – ${fmt(sunday, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}, ${sunday.getFullYear()}`
    return { from: localDateStr(monday), to: localDateStr(sunday), label, current: offset === 0 }
  }
  if (kind === 'month') {
    const first = day(y, m - offset, 1)
    const last = day(first.getFullYear(), first.getMonth() + 1, 0)
    return { from: localDateStr(first), to: localDateStr(last), label: fmt(first, { month: 'long', year: 'numeric' }), current: offset === 0 }
  }
  const year = y - offset
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year), current: offset === 0 }
}

function* daysOf(range: PeriodRange) {
  const [y, m, d] = range.from.split('-').map(Number)
  for (let cur = day(y, m - 1, d); localDateStr(cur) <= range.to; cur = day(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1))
    yield cur
}

// totals: kcal per yyyy-MM-dd (days with nothing logged left out)
export function bars(kind: PeriodKind, range: PeriodRange, totals: Map<string, number>, today = new Date()): Bar[] {
  const todayStr = localDateStr(today)
  if (kind !== 'year') {
    return [...daysOf(range)].map((d) => {
      const key = localDateStr(d)
      const value = totals.get(key) ?? 0
      return {
        key,
        label: kind === 'week' ? fmt(d, { weekday: 'short' }) : String(d.getDate()),
        title: fmt(d, { weekday: 'short', month: 'short', day: 'numeric' }),
        value,
        loggedDays: totals.has(key) ? 1 : 0,
        future: key > todayStr,
      }
    })
  }
  const year = Number(range.from.slice(0, 4))
  return Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`
    let sum = 0, logged = 0
    for (const [date, kcal] of totals) {
      if (date.startsWith(key)) { sum += kcal; logged++ }
    }
    const first = day(year, i, 1)
    return {
      key,
      label: fmt(first, { month: 'narrow' }),
      title: `${fmt(first, { month: 'long', year: 'numeric' })} · daily average`,
      value: logged ? Math.round(sum / logged) : 0,
      loggedDays: logged,
      future: `${key}-01` > todayStr,
    }
  })
}

export interface Summary {
  total: number
  loggedDays: number
  dailyAvg: number | null // null = nothing logged
}

export function summarize(range: PeriodRange, totals: Map<string, number>): Summary {
  let total = 0, loggedDays = 0
  for (const [date, kcal] of totals) {
    if (date >= range.from && date <= range.to) { total += kcal; loggedDays++ }
  }
  return { total, loggedDays, dailyAvg: loggedDays ? Math.round(total / loggedDays) : null }
}

// A "nice" axis top and tick step: never below 100 kcal, so a near-empty
// period doesn't blow single calories up into a full-height bar
export function axis(maxValue: number, minTop = 100): { top: number; step: number } {
  const target = Math.max(minTop, maxValue)
  const raw = target / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => s >= raw)!
  return { top: Math.ceil(target / step) * step, step }
}
