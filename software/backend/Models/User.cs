namespace backend.Models;

public class User
{
    public int Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    // Gamification
    public int Points { get; set; } = 0;
    public int Streak { get; set; } = 0;
    public DateTime? LastCheckIn { get; set; }

    // Which calendar day the workout daily-bonus was last granted for.
    // Tracked here (not derived from WorkoutRecords) so deleting/re-recording
    // a workout on the same day can't re-earn the bonus.
    public DateOnly? LastWorkoutBonusDate { get; set; }

    // Goals, set on the Plan page and stored per week (see Goals for why).
    // Burn: kcal burned in workouts per week (the original "weekly goal").
    // New accounts start at 2,000; null = cleared on the Plan page.
    public int? WeeklyCalorieGoal { get; set; } = 2000;

    // Intake: kcal eaten per week; null = not set. One value, not one per
    // day: it carries over until changed.
    public int? WeeklyIntakeGoal { get; set; }

    // Body profile (Plan page), all optional: used to estimate maintenance
    // calories for the one-year projection. See Models/BodyProfile.cs.
    public string? Sex { get; set; }            // "male" | "female"
    public int? BirthYear { get; set; }
    public double? HeightCm { get; set; }
    public double? WeightKg { get; set; }
    public string? ActivityLevel { get; set; }  // BodyProfile.ActivityLevels

    // Equipped skin (null = default green theme)
    public int? EquippedSkinId { get; set; }

    // Avatar image, stored inline
    public byte[]? AvatarData { get; set; }
    public string? AvatarContentType { get; set; }
    public DateTime? AvatarUpdatedAt { get; set; }

    // Navigation
    public ICollection<CheckIn> CheckIns { get; set; } = [];
    public ICollection<UserSkin> OwnedSkins { get; set; } = [];
    public ICollection<WorkoutRecord> WorkoutRecords { get; set; } = [];
    public ICollection<PointTransaction> PointTransactions { get; set; } = [];
}
