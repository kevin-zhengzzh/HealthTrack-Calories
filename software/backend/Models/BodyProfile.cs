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
}
