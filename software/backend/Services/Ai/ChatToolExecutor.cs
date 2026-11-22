using System.Text.Json;
using backend.Controllers;
using backend.Data;
using backend.Models;
using Microsoft.EntityFrameworkCore;

namespace backend.Services.Ai;

// Runs the chat assistant's tools (spec §6, T-1..T-5, plus the plan tools). Every tool is
// read-only — propose_goals included: it only validates a proposal, which the
// user then applies from a card in the chat (AGENTS.md D-34). Each is scoped to
// the userId passed in by the controller from the JWT — the model only supplies
// a tool name and arguments, never whose data to read (D-5) — and returns
// aggregates only (D-4). Failures come back as {"error": ...} tool results
// instead of exceptions, so the model can recover or explain.
public class ChatToolExecutor
{
    public const string WorkoutSummary = "get_workout_summary";
    public const string CheckInStatus = "get_checkin_status";
    public const string WeeklyGoalProgress = "get_weekly_goal_progress";
    public const string Rank = "get_rank";
    public const string PointsSummary = "get_points_summary";
    public const string IntakeSummary = "get_intake_summary";
    public const string PlanContext = "get_plan_context";
    public const string ProposeGoals = "propose_goals";

    // How far back get_plan_context averages the user's logs
    internal const int PlanLookbackDays = 28;

    // Matches the Rank page, which lists the top 50 of each board
    private const int LeaderboardSize = 50;

    private static readonly string[] Ranges = ["this_week", "last_week", "this_month", "last_month"];
    // Food is often asked about by the day as well
    private static readonly string[] IntakeRanges = ["today", "yesterday", .. Ranges];

    // Offered when no topic is picked: everything that only reads
    public static readonly IReadOnlyList<ChatToolDefinition> ReadOnlyDefinitions =
    [
        new(WorkoutSummary,
            "Get the user's workout totals (count, active days, calories, breakdown by type) for a date range. Weeks start on Monday.",
            Schema(new
            {
                type = "object",
                properties = new { range = new { type = "string", @enum = Ranges } },
                required = new[] { "range" },
                additionalProperties = false,
            })),
        new(CheckInStatus,
            $"Get the user's current daily check-in streak, whether they've checked in today, and how many more consecutive check-ins unlock the reward skin ({CheckInController.RewardSkinStreak}-day streak).",
            Schema(new { type = "object", properties = new { }, additionalProperties = false })),
        new(WeeklyGoalProgress,
            "Get the user's progress toward their weekly calorie goal for the current Monday–Sunday week.",
            Schema(new { type = "object", properties = new { }, additionalProperties = false })),
        new(Rank,
            $"Get the user's position on each leaderboard (points, check-in streak, calories burned today, earliest check-in today) and the gap to the next rank up. The Rank page shows the top {LeaderboardSize}.",
            Schema(new { type = "object", properties = new { }, additionalProperties = false })),
        new(PointsSummary,
            "Get the user's points balance, points earned and spent in the last 7 days, the most recent point transactions, and today's rewards that haven't been claimed yet.",
            Schema(new { type = "object", properties = new { }, additionalProperties = false })),
        new(IntakeSummary,
            "Get the food the user logged (calories eaten) for a date range: total, days with meals logged, average per logged day (unlogged days are not counted as zero), each day's total, the daily intake goal and the top foods. Weeks start on Monday.",
            Schema(new
            {
                type = "object",
                properties = new { range = new { type = "string", @enum = IntakeRanges } },
                required = new[] { "range" },
                additionalProperties = false,
            })),
        new(PlanContext,
            $"Get what a plan needs: the user's current daily intake goal and weekly burn (workout) goal, their body details, their estimated base burn (kcal a day without workouts), and their averages over the last {PlanLookbackDays} days (food eaten per logged day, workout calories per week).",
            Schema(new { type = "object", properties = new { }, additionalProperties = false })),
    ];

    // Every tool, including propose_goals, which only the "plan" topic offers
    public static readonly IReadOnlyList<ChatToolDefinition> Definitions =
    [
        .. ReadOnlyDefinitions,
        new(ProposeGoals,
            "Propose new goals to the user. This does NOT save anything: the app shows the proposal as a card with an Apply button, and only the user can apply it. Give one or both values as whole numbers.",
            Schema(new
            {
                type = "object",
                properties = new
                {
                    intakePerDay = new { type = "integer", description = "Daily food intake goal in kcal" },
                    burnPerWeek = new { type = "integer", description = "Weekly workout burn goal in kcal (logged workouts only, not the base burn)" },
                },
                additionalProperties = false,
            })),
    ];

    // The subset a chat mode allows (spec §5.3); null (no topic) means the
    // read-only tools
    public static IReadOnlyList<ChatToolDefinition> DefinitionsFor(IReadOnlyList<string>? toolNames) =>
        toolNames is null ? ReadOnlyDefinitions : Definitions.Where(d => toolNames.Contains(d.Name)).ToList();

    private readonly AppDbContext _db;
    private readonly AiUsageTracker _tracker;

    public ChatToolExecutor(AppDbContext db, AiUsageTracker tracker)
    {
        _db = db;
        _tracker = tracker;
    }

    // `today` is the user's local date, already clamped by the controller's
    // ResolveToday, so tools agree with what the rest of the app shows.
    public async Task<string> ExecuteAsync(int userId, DateOnly today, ChatToolCall call, CancellationToken ct = default)
    {
        _tracker.AddToolCall(call.Name);

        JsonElement args;
        try
        {
            args = JsonDocument.Parse(string.IsNullOrWhiteSpace(call.ArgumentsJson) ? "{}" : call.ArgumentsJson).RootElement;
        }
        catch (JsonException)
        {
            return Error($"Arguments for {call.Name} were not valid JSON.");
        }

        object result = call.Name switch
        {
            WorkoutSummary => await GetWorkoutSummary(userId, today, args, ct),
            CheckInStatus => await GetCheckInStatus(userId, today, ct),
            WeeklyGoalProgress => await GetWeeklyGoalProgress(userId, today, ct),
            Rank => await GetRank(userId, today, ct),
            PointsSummary => await GetPointsSummary(userId, today, ct),
            IntakeSummary => await GetIntakeSummary(userId, today, args, ct),
            PlanContext => await GetPlanContext(userId, today, ct),
            ProposeGoals => await CheckProposal(userId, args, ct),
            _ => new { error = $"Unknown tool: {call.Name}" },
        };
        return JsonSerializer.Serialize(result, JsonSerializerOptions.Web);
    }

    // T-1
    private async Task<object> GetWorkoutSummary(int userId, DateOnly today, JsonElement args, CancellationToken ct)
    {
        var range = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("range", out var r) && r.ValueKind == JsonValueKind.String
            ? r.GetString()
            : null;
        if (range is null || !Ranges.Contains(range))
            return new { error = $"range must be one of: {string.Join(", ", Ranges)}" };

        var (from, to) = ResolveRange(range, today);
        var records = await _db.WorkoutRecords
            .Where(w => w.UserId == userId && w.Date >= from && w.Date <= to)
            .Select(w => new { w.WorkoutType, w.Calories, w.Date })
            .ToListAsync(ct);

        return new
        {
            range,
            from,
            to,
            workoutCount = records.Count,
            activeDays = records.Select(w => w.Date).Distinct().Count(),
            totalCalories = records.Sum(w => w.Calories),
            byType = records
                .GroupBy(w => w.WorkoutType)
                .OrderByDescending(g => g.Sum(w => w.Calories))
                .ToDictionary(g => g.Key, g => new { count = g.Count(), calories = g.Sum(w => w.Calories) }),
        };
    }

    // T-2
    private async Task<object> GetCheckInStatus(int userId, DateOnly today, CancellationToken ct)
    {
        var storedStreak = await _db.Users.Where(u => u.Id == userId).Select(u => (int?)u.Streak).FirstOrDefaultAsync(ct);
        if (storedStreak is null) return new { error = "User not found." };

        var lastCheckInDate = await _db.CheckIns
            .Where(c => c.UserId == userId)
            .MaxAsync(c => (DateOnly?)c.Date, ct);
        var checkedInToday = await _db.CheckIns.AnyAsync(c => c.UserId == userId && c.Date == today, ct);
        var ownsRewardSkin = await _db.UserSkins.AnyAsync(us => us.UserId == userId && us.Skin.IsReward, ct);

        // User.Streak is only recalculated on the next check-in, so after missed
        // days it still holds the old run. Treat it as broken unless the latest
        // check-in (a local date, same rule as CheckInController) is today or yesterday.
        var streakAlive = lastCheckInDate >= today.AddDays(-1);
        var streak = streakAlive ? storedStreak.Value : 0;

        return new
        {
            streak,
            checkedInToday,
            rewardSkinStreak = CheckInController.RewardSkinStreak,
            ownsRewardSkin,
            checkInsUntilRewardSkin = ownsRewardSkin ? 0 : Math.Max(0, CheckInController.RewardSkinStreak - streak),
        };
    }

    // T-3
    private async Task<object> GetWeeklyGoalProgress(int userId, DateOnly today, CancellationToken ct)
    {
        var user = await _db.Users.Where(u => u.Id == userId).Select(u => new { u.WeeklyCalorieGoal }).FirstOrDefaultAsync(ct);
        if (user is null) return new { error = "User not found." };
        var goal = user.WeeklyCalorieGoal;

        var weekStart = StartOfWeek(today);
        var caloriesSoFar = await _db.WorkoutRecords
            .Where(w => w.UserId == userId && w.Date >= weekStart && w.Date <= today)
            .SumAsync(w => w.Calories, ct);

        // The burn goal can be cleared on the Plan page
        if (goal is null)
            return new
            {
                weekStart,
                goal = (int?)null,
                note = "The user has no weekly burn goal set (it can be set on the Plan page).",
                caloriesSoFar,
                daysLeftInWeek = 6 - DaysSinceMonday(today),
            };

        return new
        {
            weekStart,
            goal = goal.Value,
            caloriesSoFar,
            remainingCalories = Math.Max(0, goal.Value - caloriesSoFar),
            percent = goal.Value > 0 ? (int)Math.Round(caloriesSoFar * 100.0 / goal.Value) : 0,
            daysLeftInWeek = 6 - DaysSinceMonday(today),
        };
    }

    // T-4. Same orderings as LeaderboardController (value desc, then Id asc) so
    // the answer matches the Rank page — including its use of the stored Streak.
    // Only the user's own rank and gaps are returned, never other users (D-4).
    private async Task<object> GetRank(int userId, DateOnly today, CancellationToken ct)
    {
        var users = await _db.Users
            .Select(u => new
            {
                u.Id,
                u.Points,
                u.Streak,
                CaloriesToday = u.WorkoutRecords.Where(w => w.Date == today).Sum(w => (int?)w.Calories) ?? 0,
            })
            .ToListAsync(ct);
        if (users.All(u => u.Id != userId)) return new { error = "User not found." };

        var checkInOrder = await _db.CheckIns
            .Where(c => c.Date == today)
            .OrderBy(c => c.CreatedAt)
            .Select(c => c.UserId)
            .ToListAsync(ct);
        var checkInIndex = checkInOrder.IndexOf(userId);

        return new
        {
            totalUsers = users.Count,
            leaderboardShowsTop = LeaderboardSize,
            points = Position(users.Select(u => (u.Id, u.Points)), userId),
            streak = Position(users.Select(u => (u.Id, u.Streak)), userId),
            caloriesToday = Position(users.Select(u => (u.Id, u.CaloriesToday)), userId),
            earliestCheckInToday = new
            {
                rank = checkInIndex >= 0 ? checkInIndex + 1 : (int?)null,
                checkedInToday = checkInIndex >= 0,
                usersCheckedInToday = checkInOrder.Count,
            },
        };
    }

    private static object Position(IEnumerable<(int Id, int Value)> rows, int userId)
    {
        var ordered = rows.OrderByDescending(r => r.Value).ThenBy(r => r.Id).ToList();
        var index = ordered.FindIndex(r => r.Id == userId);
        return new
        {
            rank = index + 1,
            value = ordered[index].Value,
            // How much more the user needs to draw level with the person one place up
            behindNextRank = index == 0 ? (int?)null : ordered[index - 1].Value - ordered[index].Value,
        };
    }

    // T-5. Unclaimed rewards use the same rule as RewardsController.GetToday.
    private async Task<object> GetPointsSummary(int userId, DateOnly today, CancellationToken ct)
    {
        var balance = await _db.Users.Where(u => u.Id == userId).Select(u => (int?)u.Points).FirstOrDefaultAsync(ct);
        if (balance is null) return new { error = "User not found." };

        // Transactions are UTC instants; a 7-day window starting at UTC midnight
        // is close enough for a summary
        var since = today.AddDays(-6).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var lastWeek = await _db.PointTransactions
            .Where(p => p.UserId == userId && p.CreatedAt >= since)
            .Select(p => p.Amount)
            .ToListAsync(ct);
        var recent = await _db.PointTransactions
            .Where(p => p.UserId == userId)
            .OrderByDescending(p => p.CreatedAt)
            .Take(5)
            .Select(p => new { p.Reason, p.Amount, p.CreatedAt })
            .ToListAsync(ct);

        var unclaimedCheckIn = await _db.CheckIns
            .Where(c => c.UserId == userId && c.Date == today && !c.Claimed && c.PointsEarned > 0)
            .SumAsync(c => c.PointsEarned, ct);
        var unclaimedWorkout = await _db.WorkoutRecords
            .Where(w => w.UserId == userId && w.Date == today && !w.Claimed && w.PointsEarned > 0)
            .SumAsync(w => w.PointsEarned, ct);

        return new
        {
            balance = balance.Value,
            earnedLast7Days = lastWeek.Where(a => a > 0).Sum(),
            spentLast7Days = -lastWeek.Where(a => a < 0).Sum(),
            unclaimedToday = new
            {
                checkIn = unclaimedCheckIn,
                workout = unclaimedWorkout,
                total = unclaimedCheckIn + unclaimedWorkout,
            },
            recentTransactions = recent.Select(p => new
            {
                reason = p.Reason,
                amount = p.Amount,
                date = DateOnly.FromDateTime(p.CreatedAt),
            }),
        };
    }

    private async Task<object> GetIntakeSummary(int userId, DateOnly today, JsonElement args, CancellationToken ct)
    {
        var range = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("range", out var r) && r.ValueKind == JsonValueKind.String
            ? r.GetString()
            : null;
        if (range is null || !IntakeRanges.Contains(range))
            return new { error = $"range must be one of: {string.Join(", ", IntakeRanges)}" };

        var (from, to) = range switch
        {
            "today" => (today, today),
            "yesterday" => (today.AddDays(-1), today.AddDays(-1)),
            _ => ResolveRange(range, today),
        };
        var meals = await _db.IntakeRecords
            .Where(m => m.UserId == userId && m.Date >= from && m.Date <= to)
            .Select(m => new { m.Date, m.FoodName, m.Calories })
            .ToListAsync(ct);
        var weeklyGoal = await _db.Users.Where(u => u.Id == userId).Select(u => u.WeeklyIntakeGoal).FirstOrDefaultAsync(ct);

        var days = meals.GroupBy(m => m.Date).OrderBy(g => g.Key)
            .Select(g => new { date = g.Key, calories = g.Sum(m => m.Calories), meals = g.Count() })
            .ToList();
        return new
        {
            range,
            from,
            to,
            mealCount = meals.Count,
            daysWithMeals = days.Count,
            totalEaten = meals.Sum(m => m.Calories),
            avgPerLoggedDay = days.Count > 0 ? (int)Math.Round(days.Average(d => d.calories)) : (int?)null,
            dailyIntakeGoal = Goals.PerDay(weeklyGoal),
            days,
            // Uploads the model couldn't name yet have no calories
            unnamedMeals = meals.Count(m => m.FoodName == string.Empty),
            topFoods = meals.Where(m => m.FoodName != string.Empty)
                .GroupBy(m => m.FoodName.Trim().ToLowerInvariant())
                .OrderByDescending(g => g.Sum(m => m.Calories))
                .Take(5)
                .Select(g => new { name = g.First().FoodName.Trim(), count = g.Count(), calories = g.Sum(m => m.Calories) }),
        };
    }

    private async Task<object> GetPlanContext(int userId, DateOnly today, CancellationToken ct)
    {
        var u = await _db.Users.Where(x => x.Id == userId)
            .Select(x => new { x.WeeklyIntakeGoal, x.WeeklyCalorieGoal, x.Sex, x.BirthYear, x.HeightCm, x.WeightKg, x.ActivityLevel })
            .FirstOrDefaultAsync(ct);
        if (u is null) return new { error = "User not found." };

        var from = today.AddDays(-(PlanLookbackDays - 1));
        var intakeDays = await _db.IntakeRecords
            .Where(r => r.UserId == userId && r.Date >= from && r.Date <= today)
            .GroupBy(r => r.Date)
            .Select(g => g.Sum(r => r.Calories))
            .ToListAsync(ct);
        var workouts = await _db.WorkoutRecords
            .Where(w => w.UserId == userId && w.Date >= from && w.Date <= today)
            .Select(w => new { w.Date, w.Calories })
            .ToListAsync(ct);

        var missing = new List<string>();
        if (u.Sex is null) missing.Add("sex");
        if (u.BirthYear is null) missing.Add("birth year");
        if (u.HeightCm is null) missing.Add("height");
        if (u.WeightKg is null) missing.Add("weight");
        if (u.ActivityLevel is null) missing.Add("everyday activity");
        var baseBurn = BodyProfile.Maintenance(u.Sex, u.BirthYear, u.HeightCm, u.WeightKg, u.ActivityLevel, today.Year);

        return new
        {
            currentGoals = new
            {
                intakePerDay = Goals.PerDay(u.WeeklyIntakeGoal),
                burnPerWeek = u.WeeklyCalorieGoal,
            },
            body = new
            {
                sex = u.Sex,
                age = u.BirthYear is { } y ? today.Year - y : (int?)null,
                heightCm = u.HeightCm,
                weightKg = u.WeightKg,
                everydayActivity = u.ActivityLevel,
                missing,
            },
            baseBurnPerDay = baseBurn is { } b ? (int)Math.Round(b) : (int?)null,
            baseBurnNote = baseBurn is null
                ? "Unknown until the body details are filled in on the Plan page."
                : "Estimated (Mifflin-St Jeor BMR × everyday activity); it excludes logged workouts.",
            minimumIntakePerDay = BodyProfile.MinSafeIntake(u.Sex),
            lastDays = new
            {
                days = PlanLookbackDays,
                daysWithMealsLogged = intakeDays.Count,
                avgIntakePerLoggedDay = intakeDays.Count > 0 ? (int)Math.Round(intakeDays.Average()) : (int?)null,
                workoutDays = workouts.Select(w => w.Date).Distinct().Count(),
                avgWorkoutBurnPerWeek = (int)Math.Round(workouts.Sum(w => w.Calories) * 7.0 / PlanLookbackDays),
            },
        };
    }

    // Validates a proposal; the assistant service turns a valid one into a
    // card the user can apply. Nothing is written here.
    private async Task<object> CheckProposal(int userId, JsonElement args, CancellationToken ct)
    {
        var u = await _db.Users.Where(x => x.Id == userId)
            .Select(x => new { x.WeeklyIntakeGoal, x.WeeklyCalorieGoal, x.Sex })
            .FirstOrDefaultAsync(ct);
        if (u is null) return new { error = "User not found." };

        int? Int(string name) =>
            args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)
                ? n : null;
        var intake = Int("intakePerDay");
        var burn = Int("burnPerWeek");

        if (intake is null && burn is null)
            return new { error = "Give intakePerDay, burnPerWeek or both, as whole numbers." };
        var minIntake = BodyProfile.MinSafeIntake(u.Sex);
        if (intake is { } i && (i < minIntake || i > Goals.MaxPerDay))
            return new { error = $"intakePerDay must be between {minIntake} and {Goals.MaxPerDay}; lower intakes need medical supervision, so don't propose them." };
        if (burn is { } w && (w < 1 || w > Goals.MaxPerWeek))
            return new { error = $"burnPerWeek must be between 1 and {Goals.MaxPerWeek}." };

        return new
        {
            proposal = new
            {
                intakePerDay = intake,
                burnPerWeek = burn,
                currentIntakePerDay = Goals.PerDay(u.WeeklyIntakeGoal),
                currentBurnPerWeek = u.WeeklyCalorieGoal,
            },
            note = "Shown to the user as a card with an Apply button. Nothing is saved until they press it; don't say it has been saved.",
        };
    }

    internal static (DateOnly from, DateOnly to) ResolveRange(string range, DateOnly today)
    {
        var weekStart = StartOfWeek(today);
        var monthStart = new DateOnly(today.Year, today.Month, 1);
        return range switch
        {
            "this_week" => (weekStart, today),
            "last_week" => (weekStart.AddDays(-7), weekStart.AddDays(-1)),
            "this_month" => (monthStart, today),
            "last_month" => (monthStart.AddMonths(-1), monthStart.AddDays(-1)),
            _ => throw new ArgumentOutOfRangeException(nameof(range)),
        };
    }

    // Monday-start weeks, matching the frontend's WeeklyGoalDonut
    internal static DateOnly StartOfWeek(DateOnly d) => d.AddDays(-DaysSinceMonday(d));

    private static int DaysSinceMonday(DateOnly d) => ((int)d.DayOfWeek + 6) % 7;

    private static JsonElement Schema(object schema) => JsonSerializer.SerializeToElement(schema);

    private static string Error(string message) => JsonSerializer.Serialize(new { error = message });
}
