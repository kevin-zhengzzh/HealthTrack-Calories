import { describe, expect, it } from 'vitest'
import { bmr, isComplete, maintenance, missingProfileFields, project, type CompleteProfile } from '../src/projection'

const YEAR = 2026
const her: CompleteProfile = { sex: 'female', birthYear: 1996, heightCm: 165, weightKg: 60, activityLevel: 'light' }
const him: CompleteProfile = { sex: 'male', birthYear: 1986, heightCm: 180, weightKg: 80, activityLevel: 'sedentary' }

describe('maintenance estimate', () => {
  it('uses Mifflin-St Jeor for BMR', () => {
    // 10×60 + 6.25×165 − 5×30 − 161 = 1320.25
    expect(bmr(her, her.weightKg, YEAR)).toBeCloseTo(1320.25)
    // 10×80 + 6.25×180 − 5×40 + 5 = 1730
    expect(bmr(him, him.weightKg, YEAR)).toBeCloseTo(1730)
  })

  it('multiplies by the everyday (non-workout) activity factor', () => {
    expect(maintenance(her, her.weightKg, YEAR)).toBeCloseTo(1320.25 * 1.3)
    expect(maintenance(him, him.weightKg, YEAR)).toBeCloseTo(1730 * 1.2)
  })
})

describe('one-year projection', () => {
  it('stays put when intake matches maintenance plus workouts', () => {
    const m = maintenance(him, him.weightKg, YEAR)
    const p = project(him, m + 300, 300, 365, YEAR)
    expect(p.startBalance).toBeCloseTo(0)
    expect(p.endKg).toBeCloseTo(80, 5)
  })

  it('loses weight on a deficit, more slowly as the body gets lighter', () => {
    const m = maintenance(him, him.weightKg, YEAR)
    const p = project(him, m - 500, 0, 365, YEAR)
    expect(p.startBalance).toBeCloseTo(-500)
    // A fixed −500/day would be −23.7 kg; adaptation makes it noticeably less
    expect(p.endKg).toBeLessThan(80 - 10)
    expect(p.endKg).toBeGreaterThan(80 - 23.7)
    const drops = p.months.slice(1).map((m, i) => p.months[i].weightKg - m.weightKg)
    expect(drops[0]).toBeGreaterThan(drops[drops.length - 1])
  })

  it('gains weight on a surplus', () => {
    const m = maintenance(her, her.weightKg, YEAR)
    expect(project(her, m + 300, 0, 365, YEAR).endKg).toBeGreaterThan(60)
  })

  it('gives 13 monthly points from today to month 12', () => {
    const p = project(her, 1800, 200, 365, YEAR)
    expect(p.months.map((m) => m.month)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(p.months[0].weightKg).toBe(60)
    expect(p.months[12].weightKg).toBeCloseTo(p.endKg)
  })
})

describe('profile completeness', () => {
  it('lists what is missing', () => {
    expect(missingProfileFields(null)).toEqual(['sex', 'birth year', 'height', 'weight', 'everyday activity'])
    expect(missingProfileFields({ sex: 'male', birthYear: 1990, heightCm: null, weightKg: 70, activityLevel: null }))
      .toEqual(['height', 'everyday activity'])
    expect(isComplete(her)).toBe(true)
  })
})
