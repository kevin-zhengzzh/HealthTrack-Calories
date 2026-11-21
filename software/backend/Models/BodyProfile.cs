namespace backend.Models;

// Limits for the optional body profile. The estimate itself (Mifflin-St Jeor
// BMR × everyday activity, plus the burn goal for workouts) is worked out in
// the frontend, which draws the projection.
public static class BodyProfile
{
    public static readonly string[] Sexes = ["male", "female"];

    // Everyday activity NOT counting logged workouts: those are added
    // separately from the burn goal, so they mustn't be counted twice.
    public static readonly string[] ActivityLevels = ["sedentary", "light", "active", "very_active"];

    public const int MinAge = 10, MaxAge = 120;
    public const double MinHeightCm = 100, MaxHeightCm = 250;
    public const double MinWeightKg = 25, MaxWeightKg = 400;

    // Same factors as the frontend's projection.ts
    public static readonly IReadOnlyDictionary<string, double> ActivityFactors = new Dictionary<string, double>
    {
        ["sedentary"] = 1.2, ["light"] = 1.3, ["active"] = 1.45, ["very_active"] = 1.6,
    };

    // Base burn (maintenance without workouts): Mifflin-St Jeor BMR ×
    // everyday activity. Mirrors projection.ts `maintenance`, for the AI
    // assistant; null while any body detail is missing.
    public static double? Maintenance(string? sex, int? birthYear, double? heightCm, double? weightKg, string? activityLevel, int year)
    {
        if (sex is null || birthYear is null || heightCm is null || weightKg is null || activityLevel is null) return null;
        if (!ActivityFactors.TryGetValue(activityLevel, out var factor)) return null;
        var bmr = 10 * weightKg.Value + 6.25 * heightCm.Value - 5 * (year - birthYear.Value) + (sex == "male" ? 5 : -161);
        return bmr * factor;
    }

    // Below this a daily intake goal isn't proposed by the assistant (common
    // guidance without medical supervision; the Plan page warns at the same
    // levels)
    public static int MinSafeIntake(string? sex) => sex == "male" ? 1500 : 1200;
}
