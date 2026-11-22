using System.Text.Json;
using backend.Data;
using backend.Models;
using backend.Services.Ai;
using backend.Tests.Fakes;
using Microsoft.EntityFrameworkCore;

namespace backend.Tests.Services;

public class WeeklySummaryServiceTests
{
    // Wednesday — "last week" is Mon 2026-09-28 .. Sun 2026-10-04
    private static readonly DateOnly Today = new(2026, 10, 7);
    private static readonly DateOnly LastMonday = new(2026, 9, 28);
    private const int Me = 1;
    private const int SomeoneElse = 2;

    private static AppDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        var db = new AppDbContext(options);
        db.Users.AddRange(
            new User { Id = Me, Username = "me", WeeklyCalorieGoal = 2000 },
            new User { Id = SomeoneElse, Username = "other" });
        db.SaveChanges();
        return db;
    }

    private static WorkoutRecord Workout(int userId, DateOnly date, int calories, string type = "Running") =>
        new() { UserId = userId, Date = date, Calories = calories, WorkoutType = type };

    private static AppDbContext DbWithLastWeekWorkouts()
    {
        var db = NewDb();
        db.WorkoutRecords.AddRange(
            Workout(Me, LastMonday, 420),
            Workout(Me, LastMonday.AddDays(3), 520, "Cycling"),
            Workout(Me, LastMonday.AddDays(6), 450),            // Sunday — still last week
            Workout(Me, LastMonday.AddDays(-3), 300, "Gym"),    // the week before
            Workout(Me, LastMonday.AddDays(7), 999),            // this week — excluded
            Workout(SomeoneElse, LastMonday, 5000));            // another user — excluded
        db.CheckIns.AddRange(
            new CheckIn { UserId = Me, Date = LastMonday },
            new CheckIn { UserId = Me, Date = LastMonday.AddDays(1) });
        db.SaveChanges();
        return db;
    }

    [Fact]
    public async Task NothingLoggedLastWeek_ReturnsFallbackWithoutCallingTheModel()
    {
        var model = new FakeChatModel();   // throws if called
        var service = new WeeklySummaryService(NewDb(), model);

        var result = await service.GetAsync(Me, Today);

        Assert.Equal(WeeklySummaryService.SourceFallback, result.Source);
        Assert.Equal(LastMonday, result.WeekStart);
        Assert.Equal(LastMonday.AddDays(6), result.WeekEnd);
        Assert.Empty(model.Requests);
    }

    [Fact]
    public async Task GeneratesFromPrecomputedStatsForTheLastCompleteWeek()
    {
        var model = new FakeChatModel().Returns(FakeChatModel.Text("Great week!"));
        var service = new WeeklySummaryService(DbWithLastWeekWorkouts(), model);

        var result = await service.GetAsync(Me, Today);

        Assert.Equal(WeeklySummaryService.SourceAi, result.Source);
        Assert.Equal("Great week!", result.Summary);

        var request = Assert.Single(model.Requests);
        Assert.Null(request.Tools);
        Assert.Contains("Write in English", request.Messages[0].Content);
        using var stats = JsonDocument.Parse(request.Messages[1].Content!);
        var s = stats.RootElement;
        Assert.Equal("2026-09-28", s.GetProperty("weekStart").GetString());
        Assert.Equal(3, s.GetProperty("workoutCount").GetInt32());
        Assert.Equal(3, s.GetProperty("activeDays").GetInt32());
        Assert.Equal(1390, s.GetProperty("totalCalories").GetInt32());
        Assert.Equal(2000, s.GetProperty("weeklyCalorieGoal").GetInt32());
        Assert.Equal(70, s.GetProperty("goalPercent").GetInt32());
        Assert.Equal(300, s.GetProperty("previousWeekCalories").GetInt32());
        Assert.Equal(2, s.GetProperty("checkInDays").GetInt32());
        Assert.Equal(2, s.GetProperty("byType").GetProperty("Running").GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task MealsOnly_StillGetASummary_WithIntakeStatsOverLoggedDays()
    {
        var db = NewDb();
        db.Users.Find(Me)!.WeeklyIntakeGoal = 1800 * 7;
        db.IntakeRecords.AddRange(
            new IntakeRecord { UserId = Me, FoodName = "Rice", Calories = 1500, Date = LastMonday },
            new IntakeRecord { UserId = Me, FoodName = "Cake", Calories = 600, Date = LastMonday },
            new IntakeRecord { UserId = Me, FoodName = "Soup", Calories = 1500, Date = LastMonday.AddDays(4) },
            new IntakeRecord { UserId = Me, FoodName = "Toast", Calories = 1000, Date = LastMonday.AddDays(-2) },   // week before
            new IntakeRecord { UserId = SomeoneElse, FoodName = "Pizza", Calories = 9000, Date = LastMonday });
        db.SaveChanges();
        var model = new FakeChatModel().Returns(FakeChatModel.Text("You logged meals on 2 days."));

        var result = await new WeeklySummaryService(db, model).GetAsync(Me, Today);

        Assert.Equal(WeeklySummaryService.SourceAi, result.Source);
        var request = Assert.Single(model.Requests);
        Assert.Contains("logged meals", request.Messages[0].Content);
        using var stats = JsonDocument.Parse(request.Messages[1].Content!);
        var m = stats.RootElement.GetProperty("meals");
        Assert.Equal(2, m.GetProperty("daysWithMeals").GetInt32());
        Assert.Equal(3600, m.GetProperty("totalEaten").GetInt32());
        Assert.Equal(1800, m.GetProperty("avgPerLoggedDay").GetInt32());
        Assert.Equal(1, m.GetProperty("daysOverGoal").GetInt32());
        Assert.Equal(1000, m.GetProperty("previousWeekAvgPerLoggedDay").GetInt32());
        Assert.Equal("Rice", m.GetProperty("topFoods")[0].GetString());
        Assert.Equal(0, stats.RootElement.GetProperty("workoutCount").GetInt32());
    }

    [Fact]
    public async Task WorkoutsOnly_HaveNoMealStats()
    {
        var model = new FakeChatModel().Returns(FakeChatModel.Text("ok"));
        await new WeeklySummaryService(DbWithLastWeekWorkouts(), model).GetAsync(Me, Today);

        using var stats = JsonDocument.Parse(model.Requests[0].Messages[1].Content!);
        Assert.Equal(JsonValueKind.Null, stats.RootElement.GetProperty("meals").ValueKind);
    }

    [Fact]
    public async Task SecondRequestForTheSameWeek_IsServedFromCache()
    {
        var db = DbWithLastWeekWorkouts();
        var model = new FakeChatModel().Returns(FakeChatModel.Text("Great week!"));

        await new WeeklySummaryService(db, model).GetAsync(Me, Today);
        var second = await new WeeklySummaryService(db, model).GetAsync(Me, Today.AddDays(2));

        Assert.Equal(WeeklySummaryService.SourceCache, second.Source);
        Assert.Equal("Great week!", second.Summary);
        Assert.Single(model.Requests);
        Assert.Single(db.WeeklySummaries);
    }




    [Fact]
    public async Task ModelFailure_PropagatesAndCachesNothing()
    {
        var db = DbWithLastWeekWorkouts();
        var model = new FakeChatModel().Throws(new ChatModelException("DeepSeek returned 503", 503));

        await Assert.ThrowsAsync<ChatModelException>(() => new WeeklySummaryService(db, model).GetAsync(Me, Today));

        Assert.Empty(db.WeeklySummaries);
    }

    [Fact]
    public async Task EmptyModelReply_IsTreatedAsAFailure()
    {
        var db = DbWithLastWeekWorkouts();
        var model = new FakeChatModel().Returns(FakeChatModel.Text("   "));

        await Assert.ThrowsAsync<ChatModelException>(() => new WeeklySummaryService(db, model).GetAsync(Me, Today));

        Assert.Empty(db.WeeklySummaries);
    }
}
