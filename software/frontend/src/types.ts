export interface User {
  id: number
  username: string
  email: string
  points: number
  streak: number
  lastCheckIn: string | null
  createdAt: string
  equippedSkinId: number | null
  equippedTheme: string
  avatarUrl: string | null
  // Goals, set on the Plan page and stored per week (daily = weekly / 7)
  weeklyCalorieGoal: number | null // burn: kcal burned in workouts per week, null = not set
  weeklyIntakeGoal: number | null // intake: kcal eaten per week, null = not set
  profile: Profile
}

export type ActivityLevel = 'sedentary' | 'light' | 'active' | 'very_active'

// Optional body profile (Plan page), for the one-year projection
export interface Profile {
  sex: 'male' | 'female' | null
  birthYear: number | null
  heightCm: number | null
  weightKg: number | null
  activityLevel: ActivityLevel | null
}

export type GoalKind = 'intake' | 'burn'

export interface Goals {
  intake: { perDay: number | null; perWeek: number | null }
  burn: { perDay: number | null; perWeek: number | null }
}

export interface CheckIn {
  id: number
  date: string
  note: string | null
  createdAt: string
}

export const WORKOUT_TYPES = ['Running', 'Cycling', 'Swimming', 'Gym', 'Yoga', 'Other'] as const

// Fixed categorical color per workout type (never reassigned/cycled), so a
// type keeps the same identity color across charts regardless of which
// types have data in a given period.
export const WORKOUT_TYPE_COLORS: Record<string, string> = {
  Running: '#2a78d6',
  Cycling: '#eb6834',
  Swimming: '#1baf7a',
  Gym: '#eda100',
  Yoga: '#e87ba4',
  Other: '#008300',
}

export interface WorkoutRecord {
  id: number
  workoutType: string
  calories: number
  date: string
  createdAt: string
}

export interface WorkoutSubmitResult extends WorkoutRecord {
  pointsEarned: number
  totalPoints: number
}

export interface CheckInResult {
  id: number
  date: string
  pointsEarned: number
  totalPoints: number
  streak: number
  createdAt: string
  percentSurpassed: number
}

export interface Skin {
  id: number
  name: string
  description: string
  pointCost: number
  theme: string
  isOwned: boolean
  isEquipped: boolean
  isReward: boolean
  isNew: boolean
}

export interface RewardStatus {
  checkIn: { pointsEarned: number; claimed: boolean } | null
  workout: { pointsEarned: number; claimed: boolean } | null
}

export interface PointTransaction {
  id: number
  amount: number
  reason: string
  createdAt: string
}

export interface LeaderboardEntry {
  rank: number
  id: number
  username: string
  points: number
  isMe: boolean
  avatarUrl: string | null
}

export interface StreakLeaderboardEntry {
  rank: number
  id: number
  username: string
  streak: number
  isMe: boolean
  avatarUrl: string | null
}

export interface CaloriesLeaderboardEntry {
  rank: number
  id: number
  username: string
  calories: number
  isMe: boolean
  avatarUrl: string | null
}

export interface CheckinTodayLeaderboardEntry {
  rank: number
  id: number
  username: string
  checkedInAt: string
  isMe: boolean
  avatarUrl: string | null
}

export interface AuthResponse {
  token: string
  userId: number
  username: string
}

// AI chat assistant — see specs/06-ai-features-spec.md §7
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatQuota {
  used: number
  limit: number
  remaining: number
}

export interface WeeklySummary {
  weekStart: string // yyyy-MM-dd, Monday
  weekEnd: string // yyyy-MM-dd, Sunday
  summary: string
  source: 'ai' | 'cache' | 'fallback'
}

// Goals the assistant proposed (Set my plan). Nothing is saved until the
// user presses Apply on the card; null = that goal isn't part of it.
export interface GoalProposal {
  intakePerDay: number | null
  burnPerWeek: number | null
  currentIntakePerDay: number | null
  currentBurnPerWeek: number | null
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'proposal'; proposal: GoalProposal }
  | { type: 'done'; remaining: number }
  | { type: 'error'; message: string }

// Food intake logged by a camera + scale device (e.g. Stack-chan)
export interface IntakeRecord {
  id: number
  foodName: string
  weightGrams: number
  caloriesPer100g: number
  calories: number
  confidence: 'high' | 'medium' | 'low' | string
  corrected: boolean
  hasImage: boolean
  date: string // yyyy-MM-dd, the user's local day
  createdAt: string
  // "scale" (the device), "photo" (a phone photo on the website: weight
  // typed or estimated, not measured) or "manual"
  source: 'scale' | 'photo' | 'manual' | string
}

// What the model saw in a phone photo (nothing is saved yet)
export interface PhotoRecognition {
  isFood: boolean
  foodName: string
  caloriesPer100g: number
  confidence: 'high' | 'medium' | 'low' | string
  estimatedGrams: number | null // a starting value for the user to correct
}

export interface IntakeStats {
  days: { date: string; calories: number; meals: number }[] // only days with meals
  foods: { name: string; calories: number; count: number }[] // top 10 by calories
}

export interface Device {
  id: number
  name: string
  keyPrefix: string
  createdAt: string
  lastSeenAt: string | null
  // Claimed with a pairing code, but the device hasn't collected its key yet
  awaitingDevice: boolean
  // Reported by the device itself; null until a firmware that reports them
  // has been in touch
  firmwareVersion?: string | null
  wifiRssi?: number | null // dBm
  scaleConnected?: boolean | null
  pendingUploads?: number | null // meals saved offline, not yet sent
  statusAt?: string | null
}

// Returned once at pairing time; the server only keeps the key's hash
export interface CreatedDevice {
  id: number
  name: string
  keyPrefix: string
  key: string
  createdAt: string
}

// Maps theme name → preview hex color
export const THEME_COLORS: Record<string, { primary: string; light: string }> = {
  default:  { primary: '#16a34a', light: '#dcfce7' },
  ocean:    { primary: '#2563eb', light: '#dbeafe' },
  sunset:   { primary: '#ea580c', light: '#ffedd5' },
  midnight: { primary: '#7c3aed', light: '#ede9fe' },
  cherry:   { primary: '#db2777', light: '#fce7f3' },
  dark:     { primary: '#6366f1', light: '#312e81' },
}
