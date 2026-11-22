import { Link, useNavigate } from 'react-router-dom'

// Health disclaimer, linked from the footer of every page (signed in or not)
// and from the sign-up form. Public route: /disclaimer.
export default function Disclaimer() {
  const navigate = useNavigate()
  // Back to wherever the link was clicked; straight to the home page when
  // opened directly (no history to go back to)
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/'))

  return (
    <div className="min-h-screen bg-[var(--bg-page)] px-4 py-10">
      <article className="max-w-2xl mx-auto bg-[var(--bg-surface)] rounded-2xl shadow p-6 sm:p-8 text-[var(--text-secondary)] leading-relaxed">
        <button type="button" onClick={back} className="text-sm font-medium hover:underline cursor-pointer mb-4" style={{ color: 'var(--primary)' }}>
          ← Back
        </button>
        <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2">Health disclaimer</h1>
        <p className="text-sm text-[var(--text-muted)] mb-6">Please read this before relying on any number in HealthTrack.</p>

        <Section title="Not medical advice">
          HealthTrack is a tool for tracking habits: meals, workouts and check-ins. It is not a medical service and
          doesn't replace a doctor, dietitian or other qualified professional. Nothing in the app — including the AI
          assistant — is a diagnosis, treatment or personal medical advice.
        </Section>

        <Section title="Every number is an estimate">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <b>Meal calories</b> come from a photo (the AI names the food and its calories per 100 g) times the weight
              on the scale. Recognition can be wrong, and mixed dishes vary — check entries and correct them in the Food Log.
            </li>
            <li>
              <b>Base burn</b> uses the Mifflin-St Jeor formula and an activity factor: averages for a population, not a
              measurement of your body.
            </li>
            <li>
              <b>Workout calories</b> are what you enter.
            </li>
            <li>
              The <b>one-year projection</b> on the Plan page is a simple energy model. Real bodies adapt, and real weight
              changes differ from it.
            </li>
            <li>
              <b>AI suggestions</b> (summaries, workout advice, proposed goals) can be wrong. Goals are only saved when
              you apply them.
            </li>
          </ul>
        </Section>

        <Section title="Talk to a professional first if you…">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>are pregnant or breastfeeding</li>
            <li>are under 18</li>
            <li>have a medical condition (for example diabetes, heart, kidney or thyroid problems) or take medication that affects appetite or weight</li>
            <li>have, or have had, an eating disorder</li>
            <li>plan to eat less than 1,200 (women) / 1,500 (men) kcal a day, or to lose more than about 1% of your body weight a week</li>
          </ul>
        </Section>

        <Section title="Exercise safely">
          Stop exercising and seek help if you feel chest pain, dizziness, faintness or unusual shortness of breath.
          Build up gradually.
        </Section>

        <Section title="If you're struggling">
          If tracking food or weight makes you anxious, or you feel it's taking over, take a break from it and talk to
          someone you trust or a health professional.
        </Section>

        <p className="text-sm text-[var(--text-muted)] mt-8">
          <Link to="/" className="underline">Back to HealthTrack</Link>
        </p>
      </article>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">{title}</h2>
      <div className="text-sm">{children}</div>
    </section>
  )
}
