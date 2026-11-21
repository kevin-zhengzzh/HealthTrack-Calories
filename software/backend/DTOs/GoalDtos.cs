namespace backend.DTOs;

// PUT /api/user/goals/{intake|burn}: set either the daily or the weekly
// figure (the other is worked out from it). Neither = clear (intake only).
public record UpdateGoalRequest(int? PerDay, int? PerWeek);

public record GoalDto(int? PerDay, int? PerWeek);
public record GoalsDto(GoalDto Intake, GoalDto Burn);
