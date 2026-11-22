import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { updateProfile } from '../api'
import InfoTip from '../components/InfoTip'
import { INTAKE_COLOR, MAX_GOAL_PER_DAY, MAX_GOAL_PER_WEEK, perDay, useGoals, type Goal } from '../goals'
import { ACTIVITY, FLOOR_BMI, isComplete, maintenance, missingProfileFields, project } from '../projection'
import { useStore } from '../store'
import type { ActivityLevel, GoalKind, Profile } from '../types'

const inputClass = 'w-full border border-[var(--border-strong)] rounded-lg px-3 py-2 tabular-nums bg-[var(--bg-surface)] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-green-500'
const cardClass = 'bg-[var(--bg-surface)] rounded-2xl shadow p-5 flex flex-col gap-4'
const saveBtnClass = 'ml-auto text-white rounded-lg py-2 px-6 font-semibold transition disabled:opacity-50 cursor-pointer disabled:cursor-default'
const clearBtnClass = 'border border-[var(--border-strong)] text-[var(--text-secondary)] rounded-lg py-2 px-4 font-semibold hover:bg-[var(--bg-inset)] transition cursor-pointer disabled:opacity-50 disabled:cursor-default'

const blockNonDigits = (e: React.KeyboardEvent) => {
  if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault()
}

function CardTitle({ dot, title, tip, children }: { dot: string; title: string; tip?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1.5 w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: dot }} aria-hidden />
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
          {title}
          {tip && <InfoTip label={`About ${title}`}>{tip}</InfoTip>}
        </h2>
        <p className="text-sm text-[var(--text-muted)]">{children}</p>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ goals

// One goal: per-day and per-week inputs kept in step (×7 / ÷7). Whichever was
// typed in last is what gets saved; the backend stores the weekly figure.
// Both cards are identical apart from the wording.
function GoalCard({ kind, title, blurb, accent, goal }: { kind: GoalKind; title: string; blurb: string; accent: string; goal: Goal | null }) {
  const { save } = useGoals()
  const pushToast = useStore((s) => s.pushToast)
  const [day, setDay] = useState('')
  const [week, setWeek] = useState('')
  const [edited, setEdited] = useState<'day' | 'week' | null>(null)
  const [saving, setSaving] = useState(false)

  // Show the saved goal whenever it changes (load, save, clear). Numbers, not
  // the goal object: that's rebuilt on every render.
  const savedDay = goal?.perDay
  const savedWeek = goal?.perWeek
  useEffect(() => {
    setDay(savedDay != null ? String(savedDay) : '')
    setWeek(savedWeek != null ? String(savedWeek) : '')
    setEdited(null)
  }, [savedDay, savedWeek])

  function onDay(v: string) {
    setDay(v)
    setEdited('day')
    const n = Number(v)
    setWeek(v && Number.isFinite(n) ? String(n * 7) : '')
  }

  function onWeek(v: string) {
    setWeek(v)
    setEdited('week')
    const n = Number(v)
    setDay(v && Number.isFinite(n) ? String(perDay(n)) : '')
  }

  const value = edited === 'day' ? Number(day) : edited === 'week' ? Number(week) : NaN
  const max = edited === 'day' ? MAX_GOAL_PER_DAY : MAX_GOAL_PER_WEEK
  const valid = Number.isInteger(value) && value >= 1 && value <= max
  const changed = edited !== null && (edited === 'day' ? value !== goal?.perDay : value !== goal?.perWeek)

  async function run(v: { perDay: number } | { perWeek: number } | null, done: string) {
    setSaving(true)
    try {
      await save(kind, v)
      pushToast(done, 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to update goal')
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || !changed) return
    run(edited === 'day' ? { perDay: value } : { perWeek: value }, `${title} updated!`)
  }

  return (
    <section className={cardClass}>
      <CardTitle
        dot={accent}
        title={title}
        tip={<>Set it per day or per week — the other is worked out for you (× 7 or ÷ 7, rounded). The weekly figure is what's saved, so neither one drifts.</>}
      >
        {blurb}
      </CardTitle>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 flex-1">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Per day (kcal)
            <input
              type="number" min={1} max={MAX_GOAL_PER_DAY} step={1} inputMode="numeric"
              value={day} placeholder="—"
              onChange={(e) => onDay(e.target.value)} onKeyDown={(e) => { if (e.key === '.') e.preventDefault(); blockNonDigits(e) }}
              className={`${inputClass} text-right`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Per week (kcal)
            <input
              type="number" min={1} max={MAX_GOAL_PER_WEEK} step={1} inputMode="numeric"
              value={week} placeholder="—"
              onChange={(e) => onWeek(e.target.value)} onKeyDown={(e) => { if (e.key === '.') e.preventDefault(); blockNonDigits(e) }}
              className={`${inputClass} text-right`}
            />
          </label>
        </div>
        <p className="text-xs text-[var(--text-muted)] min-h-4">
          {edited && !valid
            ? `Enter a whole number from 1 to ${max.toLocaleString()}.`
            : edited === 'week' && valid && value % 7 !== 0
              ? `≈ ${perDay(value).toLocaleString()} a day (weekly ÷ 7, rounded).`
              : goal ? 'Change either one — the other follows.' : 'Not set yet.'}
        </p>
        <div className="flex gap-3 mt-auto">
          <button type="button" disabled={saving || !goal} onClick={() => run(null, `${title} cleared.`)} className={clearBtnClass}>
            Clear
          </button>
          <button type="submit" disabled={saving || !valid || !changed} className={saveBtnClass} style={{ backgroundColor: 'var(--primary)' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  )
}

// ------------------------------------------------------------------ body

const EMPTY_PROFILE: Profile = { sex: null, birthYear: null, heightCm: null, weightKg: null, activityLevel: null }

function ProfileCard({ profile }: { profile: Profile }) {
  const setUser = useStore((s) => s.setUser)
  const pushToast = useStore((s) => s.pushToast)
  const [draft, setDraft] = useState({ sex: '', birthYear: '', heightCm: '', weightKg: '', activityLevel: '' })
  const [saving, setSaving] = useState(false)

  const saved = JSON.stringify(profile)
  useEffect(() => {
    const p: Profile = JSON.parse(saved)
    setDraft({
      sex: p.sex ?? '',
      birthYear: p.birthYear != null ? String(p.birthYear) : '',
      heightCm: p.heightCm != null ? String(p.heightCm) : '',
      weightKg: p.weightKg != null ? String(p.weightKg) : '',
      activityLevel: p.activityLevel ?? '',
    })
  }, [saved])

  const num = (v: string) => (v.trim() === '' ? null : Number(v))
  const next: Profile = {
    sex: (draft.sex || null) as Profile['sex'],
    birthYear: num(draft.birthYear),
    heightCm: num(draft.heightCm),
    weightKg: num(draft.weightKg),
    activityLevel: (draft.activityLevel || null) as ActivityLevel | null,
  }
  const changed = JSON.stringify(next) !== saved
  const thisYear = new Date().getFullYear()
  const problem =
    next.birthYear !== null && (!Number.isInteger(next.birthYear) || thisYear - next.birthYear < 10 || thisYear - next.birthYear > 120) ? 'Birth year looks off.'
    : next.heightCm !== null && (!(next.heightCm >= 100) || next.heightCm > 250) ? 'Height should be 100–250 cm.'
    : next.weightKg !== null && (!(next.weightKg >= 25) || next.weightKg > 400) ? 'Weight should be 25–400 kg.'
    : null

  async function save(p: Profile, done: string) {
    setSaving(true)
    try {
      const res = await updateProfile(p)
      const current = useStore.getState().user
      if (current) setUser({ ...current, profile: res })
      pushToast(done, 'success')
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))
  const hasAny = Object.values(profile).some((v) => v !== null)

  return (
    <section className={cardClass}>
      <CardTitle
        dot="var(--text-muted)"
        title="About you"
        tip={<>Used only to estimate how much energy your body uses in a day (base burn), for the Dashboard's Burned and Net and for the projection. Everything is optional and only visible to you.</>}
      >
        Works out your daily base burn for the Dashboard and the projection. All optional.
      </CardTitle>

      <form
        onSubmit={(e) => { e.preventDefault(); if (changed && !problem) save(next, 'Profile saved!') }}
        className="flex flex-col gap-3 flex-1"
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Sex
            <div className="grid grid-cols-2 rounded-lg border border-[var(--border-strong)] overflow-hidden" role="radiogroup" aria-label="Sex">
              {(['female', 'male'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={draft.sex === s}
                  onClick={() => setDraft((d) => ({ ...d, sex: d.sex === s ? '' : s }))}
                  className="py-2 capitalize cursor-pointer transition"
                  style={draft.sex === s ? { backgroundColor: 'var(--primary-light)', color: 'var(--primary-text)', fontWeight: 600 } : undefined}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Birth year
            <input type="number" inputMode="numeric" min={thisYear - 120} max={thisYear - 10} step={1} placeholder="e.g. 1996"
              value={draft.birthYear} onChange={set('birthYear')} onKeyDown={blockNonDigits} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Height (cm)
            <input type="number" inputMode="decimal" min={100} max={250} step={0.1} placeholder="e.g. 170"
              value={draft.heightCm} onChange={set('heightCm')} onKeyDown={blockNonDigits} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
            Weight (kg)
            <input type="number" inputMode="decimal" min={25} max={400} step={0.1} placeholder="e.g. 65"
              value={draft.weightKg} onChange={set('weightKg')} onKeyDown={blockNonDigits} className={inputClass} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
          <span className="flex items-center gap-2">
            Everyday activity
            <InfoTip label="About everyday activity" align="left">
              How active your normal day is <b>without</b> workouts. Workouts are counted separately through your burn
              goal, so they aren't counted twice.
            </InfoTip>
          </span>
          <select value={draft.activityLevel} onChange={set('activityLevel')} className={inputClass}>
            <option value="">Choose…</option>
            {(Object.keys(ACTIVITY) as ActivityLevel[]).map((k) => (
              <option key={k} value={k}>{ACTIVITY[k].label} — {ACTIVITY[k].hint}</option>
            ))}
          </select>
        </label>
        {isComplete(profile) && (
          <div className="rounded-lg bg-[var(--bg-inset)] px-3 py-2 text-sm text-[var(--text-secondary)] flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              Base burn (maintenance)
              <InfoTip label="About base burn" align="left">
                Roughly what your body uses in a day <b>without</b> workouts: BMR from the Mifflin-St Jeor formula
                (sex, age, height, weight) × your everyday activity. Eat this much and do no workouts, and your weight
                stays about the same. The Dashboard adds it to each day's Burned and Net.
              </InfoTip>
            </span>
            <span className="tabular-nums font-semibold">≈ {Math.round(maintenance(profile)).toLocaleString()} kcal/day</span>
          </div>
        )}
        <p className="text-xs text-[var(--text-muted)] min-h-4">{problem ?? (changed ? 'Unsaved changes.' : '')}</p>
        <div className="flex gap-3 mt-auto">
          <button type="button" disabled={saving || !hasAny} onClick={() => save(EMPTY_PROFILE, 'Profile cleared.')} className={clearBtnClass}>
            Clear
          </button>
          <button type="submit" disabled={saving || !changed || problem !== null} className={saveBtnClass} style={{ backgroundColor: 'var(--primary)' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  )
}

// ------------------------------------------------------------------ projection

const fmtKg = (kg: number) => `${kg.toFixed(1)} kg`
const signed = (n: number, digits = 1) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(digits)}`

function ProjectionCard({ profile, intake, burn }: { profile: Profile; intake: Goal | null; burn: Goal | null }) {
  const missing = [
    ...(intake ? [] : ['an intake goal']),
    ...missingProfileFields(profile).map((f) => `your ${f}`),
  ]
  const result = useMemo(
    () => (intake && isComplete(profile) ? project(profile, intake.perDay, burn?.perDay ?? 0) : null),
    [profile, intake, burn],
  )

  return (
    <section className={cardClass}>
      <CardTitle
        dot="var(--primary)"
        title="One-year projection"
        tip={
          <>
            Maintenance = BMR (Mifflin-St Jeor) × everyday activity. Each day: intake goal − (maintenance + daily burn
            goal); about 7,700 kcal ≈ 1 kg. Maintenance is recalculated as your weight changes, so the curve levels off.
            A rough estimate, not medical advice.
          </>
        }
      >
        If you stick to this plan every day for a year.
      </CardTitle>

      {!result ? (
        <p className="text-sm text-[var(--text-muted)]">
          To see it, add {missing.join(', ').replace(/, ([^,]*)$/, ' and $1')}.
        </p>
      ) : (
        <ProjectionBody result={result} intake={intake!} burn={burn} profile={profile} />
      )}
    </section>
  )
}

function ProjectionBody({ result, intake, burn, profile }: {
  result: ReturnType<typeof project>
  intake: Goal
  burn: Goal | null
  profile: Profile
}) {
  const change = result.endKg - result.startKg
  const firstMonthWeekly = ((result.months[1].weightKg - result.startKg) / 365) * 12 * 7
  const steepLoss = firstMonthWeekly < -0.01 * result.startKg
  const lowIntake = intake.perDay < (profile.sex === 'male' ? 1500 : 1200)
  const endBmi = profile.heightCm ? result.endKg / (profile.heightCm / 100) ** 2 : null

  return (
    <div className="flex flex-col gap-4">
      <WeightChart months={result.months} />
      <div className="grid grid-cols-1 gap-3 text-sm">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">In a year</p>
          {result.hitFloor ? (
            <p className="text-2xl font-bold text-red-600">Dangerously low</p>
          ) : (
            <p className="text-2xl font-bold text-[var(--text-primary)] tabular-nums">
              {fmtKg(result.endKg)}{' '}
              <span className={`text-base font-semibold ${change < 0 ? 'text-green-600' : change > 0 ? 'text-amber-600' : 'text-[var(--text-muted)]'}`}>
                ({signed(change)} kg)
              </span>
            </p>
          )}
          <p className="text-[var(--text-muted)]">from {fmtKg(result.startKg)} today</p>
        </div>
        {result.hitFloor && (
          <div className="rounded-lg bg-red-50 text-red-800 px-3 py-2 text-xs leading-relaxed">
            This plan would take you below a life-threatening weight (BMI {FLOOR_BMI}, about {fmtKg(result.floorKg)}), so the
            projection stops there. Please don't follow it — check the goals and your details, and talk to a doctor before
            eating this little.
          </div>
        )}
        <div className="rounded-lg bg-[var(--bg-inset)] px-3 py-2 tabular-nums whitespace-nowrap text-[var(--text-secondary)] flex flex-col gap-0.5">
          <span className="flex justify-between"><span>Eat</span><span>{intake.perDay.toLocaleString()}</span></span>
          <span className="flex justify-between"><span>− Maintenance</span><span>{Math.round(result.maintenance).toLocaleString()}</span></span>
          <span className="flex justify-between"><span>− Workouts</span><span>{(burn?.perDay ?? 0).toLocaleString()}</span></span>
          <span className="flex justify-between font-semibold border-t border-[var(--border)] pt-0.5 mt-0.5">
            <span>= Per day now</span><span>{signed(Math.round(result.startBalance), 0)} kcal</span>
          </span>
        </div>
        {(steepLoss || lowIntake || (endBmi !== null && endBmi < 18.5)) && (
          <div className="rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs leading-relaxed">
            {steepLoss && <p>That's more than about 1% of your body weight a week at first — hard to keep up and not generally recommended.</p>}
            {lowIntake && <p>{intake.perDay.toLocaleString()} kcal a day is below the usual minimum of {profile.sex === 'male' ? '1,500' : '1,200'} without medical supervision.</p>}
            {endBmi !== null && endBmi < 18.5 && !result.hitFloor && <p>The end weight would be underweight (BMI {endBmi.toFixed(1)}).</p>}
          </div>
        )}
        <p className="text-xs text-[var(--text-muted)]">A rough estimate; real bodies vary. Not medical advice.</p>
      </div>
    </div>
  )
}

const W = 560, H = 220, PAD = { top: 16, right: 16, bottom: 28, left: 44 }

function WeightChart({ months }: { months: { month: number; weightKg: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const values = months.map((m) => m.weightKg)
  const lo = Math.min(...values), hi = Math.max(...values)
  const pad = Math.max(1, (hi - lo) * 0.15)
  const yMin = Math.max(0, Math.floor(lo - pad)), yMax = Math.ceil(hi + pad)
  const x = (i: number) => PAD.left + (i / 12) * (W - PAD.left - PAD.right)
  const y = (kg: number) => PAD.top + (1 - (kg - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom)
  const line = months.map((m, i) => `${i ? 'L' : 'M'}${x(i)},${y(m.weightKg)}`).join(' ')
  const area = `${line} L${x(12)},${H - PAD.bottom} L${x(0)},${H - PAD.bottom} Z`
  const start = new Date()
  const label = (i: number) => (i === 0 ? 'Now' : new Date(start.getFullYear(), start.getMonth() + i, 1).toLocaleDateString('en-US', { month: 'short' }))
  const ticks = [yMin, (yMin + yMax) / 2, yMax]

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={`Projected weight from ${values[0].toFixed(1)} to ${values[12].toFixed(1)} kg over a year`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} className="fill-[var(--text-muted)]">{t.toFixed(t % 1 ? 1 : 0)}{t === yMax ? ' kg' : ''}</text>
          </g>
        ))}
        <path d={area} fill="var(--primary)" opacity={0.08} />
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2.5} strokeLinejoin="round" />
        {months.map((m, i) => (
          <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover((h) => (h === i ? null : h))}>
            <rect x={x(i) - 18} y={PAD.top} width={36} height={H - PAD.top - PAD.bottom} fill="transparent" />
            <circle cx={x(i)} cy={y(m.weightKg)} r={hover === i ? 5 : 3} fill="var(--bg-surface)" stroke="var(--primary)" strokeWidth={2} />
            {(i % 3 === 0) && (
              <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} className="fill-[var(--text-muted)]">{label(i)}</text>
            )}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div
          className="absolute pointer-events-none -translate-x-1/2 -translate-y-full bg-gray-800 text-white text-xs rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap"
          style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(months[hover].weightKg) / H) * 100}%`, marginTop: -8 }}
        >
          <span className="font-semibold">{fmtKg(months[hover].weightKg)}</span>
          <span className="text-gray-300"> · {label(hover)}</span>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ page

export default function Plan() {
  const { loaded, intake, burn } = useGoals()
  const profile = useStore((s) => s.user?.profile) ?? EMPTY_PROFILE

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold text-[var(--text-primary)]">Plan</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Your daily goals, and where they'd take you in a year. Goals carry over until you change them.
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          Every figure here is an estimate, not medical advice — check with a professional before a big change,
          especially if you're pregnant, under 18 or have a health condition.{' '}
          <Link to="/disclaimer" className="underline">Disclaimer</Link>
        </p>
      </div>

      {!loaded ? (
        <p className="text-[var(--text-muted)]">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <GoalCard
            kind="intake"
            title="Intake goal"
            blurb="How much you plan to eat. Shown on the dashboard, the Food Log and Stack-chan."
            accent={INTAKE_COLOR}
            goal={intake}
          />
          <GoalCard
            kind="burn"
            title="Burn goal"
            blurb="How much you plan to burn in workouts. Shown on the dashboard and Statistics."
            accent="var(--primary)"
            goal={burn}
          />
          <ProfileCard profile={profile} />
          <ProjectionCard profile={profile} intake={intake} burn={burn} />
        </div>
      )}
    </div>
  )
}
