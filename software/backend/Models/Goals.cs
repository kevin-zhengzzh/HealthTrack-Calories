namespace backend.Models;

// Intake and burn goals are both stored per week (User.WeeklyIntakeGoal,
// User.WeeklyCalorieGoal) and the daily figure is always worked out from
// that. Storing the weekly value keeps both directions exact: a daily goal
// of 1,700 is stored as 11,900 and comes back as 1,700, while a weekly goal
// of 2,000 stays 2,000 (≈ 286 a day). Storing the rounded daily value
// instead would drift (286 × 7 = 2,002).
public static class Goals
{
    public const int MaxPerDay = 20000;
    public const int MaxPerWeek = MaxPerDay * 7;

    public static int PerDay(int perWeek) => (int)Math.Round(perWeek / 7.0, MidpointRounding.AwayFromZero);

    public static int? PerDay(int? perWeek) => perWeek is { } w ? PerDay(w) : null;
}
