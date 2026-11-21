import { describe, expect, it } from 'vitest'
import { axis, bars, periodRange, summarize } from '../src/stats'

// Sunday 22 Nov 2026
const TODAY = new Date(2026, 10, 22)

describe('calendar periods', () => {
  it('weeks run Monday to Sunday and step back by whole weeks', () => {
    expect(periodRange('week', 0, TODAY)).toMatchObject({ from: '2026-11-16', to: '2026-11-22', label: 'Nov 16 – 22, 2026', current: true })
    expect(periodRange('week', 3, TODAY)).toMatchObject({ from: '2026-10-26', to: '2026-11-01', label: 'Oct 26 – Nov 1, 2026', current: false })
  })

  it('months and years are calendar ones', () => {
    expect(periodRange('month', 0, TODAY)).toMatchObject({ from: '2026-11-01', to: '2026-11-30', label: 'November 2026' })
    expect(periodRange('month', 11, TODAY)).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
    expect(periodRange('month', 9, new Date(2026, 1, 10))).toMatchObject({ from: '2025-05-01', to: '2025-05-31' })
    expect(periodRange('year', 1, TODAY)).toMatchObject({ from: '2025-01-01', to: '2025-12-31', label: '2025' })
  })
})

describe('bars', () => {
  const totals = new Map([['2026-11-16', 1800], ['2026-11-18', 2200], ['2026-10-05', 1500], ['2026-10-06', 2500]])

  it('a week has a bar per day, unlogged days at zero', () => {
    const b = bars('week', periodRange('week', 0, TODAY), totals, TODAY)
    expect(b.map((x) => x.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(b.map((x) => x.value)).toEqual([1800, 0, 2200, 0, 0, 0, 0])
    expect(b[1].loggedDays).toBe(0)
  })

  it('a month has a bar per day and marks the future', () => {
    const b = bars('month', periodRange('month', 0, TODAY), totals, TODAY)
    expect(b).toHaveLength(30)
    expect(b[21].future).toBe(false)
    expect(b[22].future).toBe(true)
  })

  it('a year has a bar per month holding the daily average of logged days', () => {
    const b = bars('year', periodRange('year', 0, TODAY), totals, TODAY)
    expect(b).toHaveLength(12)
    expect(b[9]).toMatchObject({ key: '2026-10', value: 2000, loggedDays: 2 })
    expect(b[10]).toMatchObject({ value: 2000, loggedDays: 2 })
    expect(b[11].future).toBe(true)
  })
})

describe('summary', () => {
  it('averages over logged days only', () => {
    const totals = new Map([['2026-11-16', 1800], ['2026-11-18', 2200], ['2026-11-30', 999]])
    expect(summarize(periodRange('week', 0, TODAY), totals)).toEqual({ total: 4000, loggedDays: 2, dailyAvg: 2000 })
    expect(summarize(periodRange('week', 1, TODAY), totals)).toEqual({ total: 0, loggedDays: 0, dailyAvg: null })
  })
})

describe('axis', () => {
  it('never goes below 100 and lands on a round step', () => {
    expect(axis(0)).toEqual({ top: 100, step: 25 })
    expect(axis(3)).toEqual({ top: 100, step: 25 })
    expect(axis(2340)).toEqual({ top: 3000, step: 1000 })
    expect(axis(1800)).toEqual({ top: 2000, step: 500 })
  })
})
