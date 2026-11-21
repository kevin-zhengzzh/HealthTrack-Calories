import type { ActivityLevel, Profile } from './types'

// One-year weight projection for the Plan page.
//
// Maintenance = BMR (Mifflin-St Jeor) × everyday activity. The activity
// factors describe daily life WITHOUT logged workouts, because those come in
// separately from the burn goal — counting them twice would overstate burn.
// Each day: balance = intake goal − (maintenance at today's weight + daily
// burn goal), and 7,700 kcal ≈ 1 kg of body weight. Maintenance is
// recalculated from the new weight every day, so the curve flattens out as
// the body gets lighter or heavier, as it does in reality.

export const KCAL_PER_KG = 7700

export const ACTIVITY: Record<ActivityLevel, { factor: number; label: string; hint: string }> = {
  sedentary: { factor: 1.2, label: 'Mostly sitting', hint: 'Desk job, little walking' },
  light: { factor: 1.3, label: 'Lightly active', hint: 'Some walking, standing now and then' },
  active: { factor: 1.45, label: 'On my feet', hint: 'Walking or standing most of the day' },
  very_active: { factor: 1.6, label: 'Physical work', hint: 'Manual labour, lots of carrying' },
}

export interface CompleteProfile {
  sex: 'male' | 'female'
  birthYear: number
  heightCm: number
  weightKg: number
  activityLevel: ActivityLevel
}

// The fields the estimate still needs, in form order
export function missingProfileFields(p: Profile | null | undefined): string[] {
  const missing: string[] = []
  if (!p?.sex) missing.push('sex')
  if (!p?.birthYear) missing.push('birth year')
  if (!p?.heightCm) missing.push('height')
  if (!p?.weightKg) missing.push('weight')
  if (!p?.activityLevel) missing.push('everyday activity')
  return missing
}

export function isComplete(p: Profile | null | undefined): p is Profile & CompleteProfile {
  return missingProfileFields(p).length === 0
}

export function ageIn(birthYear: number, year = new Date().getFullYear()) {
  return year - birthYear
}

export function bmr(p: CompleteProfile, weightKg = p.weightKg, year?: number) {
  const base = 10 * weightKg + 6.25 * p.heightCm - 5 * ageIn(p.birthYear, year)
  return base + (p.sex === 'male' ? 5 : -161)
}

export function maintenance(p: CompleteProfile, weightKg = p.weightKg, year?: number) {
  return bmr(p, weightKg, year) * ACTIVITY[p.activityLevel].factor
}

export interface Projection {
  startKg: number
  endKg: number
  months: { month: number; weightKg: number }[] // month 0 = today … 12
  startBalance: number // kcal/day on day one: negative = losing
  maintenance: number // kcal/day today, without workouts
  // The plan would drive weight down to a life-threatening level (BMI 13):
  // the curve stops there instead of running on towards zero or below.
  hitFloor: boolean
  floorKg: number
}

// BMI 13 is already life-threatening; past it the simple energy model means
// nothing, so the projection doesn't go lower.
export const FLOOR_BMI = 13

export function project(p: CompleteProfile, intakePerDay: number, burnPerDay: number, days = 365, year?: number): Projection {
  let w = p.weightKg
  const floorKg = Math.min(p.weightKg, FLOOR_BMI * (p.heightCm / 100) ** 2)
  let hitFloor = false
  const months = [{ month: 0, weightKg: w }]
  const balanceAt = (kg: number) => intakePerDay - (maintenance(p, kg, year) + burnPerDay)
  for (let d = 1; d <= days; d++) {
    w += balanceAt(w) / KCAL_PER_KG
    if (w < floorKg) {
      w = floorKg
      hitFloor = true
    }
    // A point at the end of each twelfth of the period (month 12 = last day)
    if (d === Math.round((months.length * days) / 12)) months.push({ month: months.length, weightKg: w })
  }
  return {
    startKg: p.weightKg,
    endKg: w,
    months,
    startBalance: balanceAt(p.weightKg),
    maintenance: maintenance(p, p.weightKg, year),
    hitFloor,
    floorKg,
  }
}
