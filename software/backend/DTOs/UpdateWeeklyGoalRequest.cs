namespace backend.DTOs;

public record UpdateWeeklyGoalRequest(int WeeklyCalorieGoal);

// Null clears the goal
public record UpdateIntakeGoalRequest(int? DailyIntakeGoal);
