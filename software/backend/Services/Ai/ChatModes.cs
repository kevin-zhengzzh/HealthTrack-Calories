namespace backend.Services.Ai;

// A topic the user picked from the pills above the chat input (spec §5.3).
// Each mode adds focused instructions to the system prompt and narrows the
// tool list to what that topic needs, so the model has fewer wrong choices.
public sealed record ChatMode(string Id, string Instructions, IReadOnlyList<string> Tools);

public static class ChatModes
{
    public static readonly IReadOnlyDictionary<string, ChatMode> All = new Dictionary<string, ChatMode>
    {
        ["advice"] = new("advice",
            "Workout advice: first look at the user's recent workouts, then give 2–3 specific, practical " +
            "suggestions grounded in that data (variety, rest days, consistency, a realistic next session). " +
            "General fitness guidance only — no medical, injury or diet advice; if the user mentions pain, an " +
            "injury or a health condition, recommend seeing a professional.",
            [ChatToolExecutor.WorkoutSummary, ChatToolExecutor.WeeklyGoalProgress]),

        // The one topic that leads to a data change: the model proposes, the
        // user applies from a card in the chat (AGENTS.md D-34)
        ["plan"] = new("plan",
            "Plan: help the user set their daily intake goal and weekly workout burn goal. First call " +
            "get_plan_context. If the user hasn't said what they want, ask briefly whether they want to lose, keep " +
            "or gain weight (and how fast) before proposing. Base the numbers on their base burn when known " +
            "(otherwise on their logged averages, and mention that filling in body details on the Plan page makes " +
            "it more accurate). Keep the total daily change moderate, at most about 500 kcal: count it as intake − " +
            "(base burn + burn goal ÷ 7), so a workout goal adds to the deficit. Pick a burn goal they can reach from " +
            "where their workouts are now, and never an intake below minimumIntakePerDay. Explain the reasoning in " +
            "two or three short lines, then call propose_goals. Never say the goals are saved: the user applies " +
            "them with the card's Apply button. Not medical advice; for health conditions suggest a professional.",
            [ChatToolExecutor.PlanContext, ChatToolExecutor.ProposeGoals]),
    };

    public static ChatMode? Find(string? id) =>
        id is not null && All.TryGetValue(id, out var mode) ? mode : null;
}
