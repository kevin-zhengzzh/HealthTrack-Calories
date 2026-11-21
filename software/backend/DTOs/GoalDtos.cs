namespace backend.DTOs;

// PUT /api/user/goals/{intake|burn}: set either the daily or the weekly
// figure (the other is worked out from it). Neither = clear (intake only).
public record UpdateGoalRequest(int? PerDay, int? PerWeek);

public record GoalDto(int? PerDay, int? PerWeek);
public record GoalsDto(GoalDto Intake, GoalDto Burn);

// PUT /api/user/profile: the whole profile at once; any field may be null
public record ProfileDto(string? Sex, int? BirthYear, double? HeightCm, double? WeightKg, string? ActivityLevel);
