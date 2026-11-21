using System.Security.Claims;
using backend.Controllers;
using backend.Data;
using backend.DTOs;
using backend.Models;
using backend.Validators;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace backend.Tests.Controllers;

// Plan page goals: either figure can be set, the weekly one is stored and
// the daily one derived from it
public class UserGoalsTests
{
    private const int Me = 1;

    private static AppDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        var db = new AppDbContext(options);
        db.Users.Add(new User { Id = Me, Username = "me", Email = "me@x" });
        db.SaveChanges();
        return db;
    }

    private static UserController NewController(AppDbContext db) => new(db, new UpdateUsernameRequestValidator())
    {
        ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    [new Claim(ClaimTypes.NameIdentifier, Me.ToString())], "test")),
            },
        },
    };

    private static GoalsDto Goals(IActionResult result) =>
        Assert.IsType<GoalsDto>(Assert.IsType<OkObjectResult>(result).Value);

    private static async Task<User> Me_(AppDbContext db) => (await db.Users.FindAsync(Me))!;

    [Fact]
    public async Task NewUsers_HaveNoIntakeGoal_AndTheDefaultBurnGoal()
    {
        using var db = NewDb();
        var user = await Me_(db);
        Assert.Null(user.WeeklyIntakeGoal);
        Assert.Equal(2000, user.WeeklyCalorieGoal);
    }

    [Fact]
    public async Task DailyGoal_IsStoredAsSevenTimes_AndComesBackExactly()
    {
        using var db = NewDb();

        var goals = Goals(await NewController(db).UpdateGoal("intake", new UpdateGoalRequest(1700, null)));

        Assert.Equal(new GoalDto(1700, 11900), goals.Intake);
        Assert.Equal(11900, (await Me_(db)).WeeklyIntakeGoal);
    }

    [Fact]
    public async Task WeeklyGoal_IsStoredAsIs_AndTheDailyOneIsRounded()
    {
        using var db = NewDb();

        var goals = Goals(await NewController(db).UpdateGoal("burn", new UpdateGoalRequest(null, 2000)));

        Assert.Equal(new GoalDto(286, 2000), goals.Burn);  // 2000 / 7 = 285.7
        Assert.Equal(2000, (await Me_(db)).WeeklyCalorieGoal);
    }

    [Fact]
    public async Task BurnGoal_CanBeSetPerDayToo()
    {
        using var db = NewDb();

        var goals = Goals(await NewController(db).UpdateGoal("Burn", new UpdateGoalRequest(300, null)));

        Assert.Equal(new GoalDto(300, 2100), goals.Burn);
        Assert.Null(goals.Intake.PerWeek);
    }

    [Theory]
    [InlineData("intake")]
    [InlineData("burn")]
    public async Task EitherGoal_CanBeCleared(string kind)
    {
        using var db = NewDb();
        var controller = NewController(db);
        await controller.UpdateGoal(kind, new UpdateGoalRequest(1700, null));

        var goals = Goals(await controller.UpdateGoal(kind, new UpdateGoalRequest(null, null)));

        Assert.Equal(new GoalDto(null, null), kind == "intake" ? goals.Intake : goals.Burn);
        var user = await Me_(db);
        Assert.Null(kind == "intake" ? user.WeeklyIntakeGoal : user.WeeklyCalorieGoal);
    }

    // ---- Body profile ----

    private static readonly int ThisYear = DateTime.UtcNow.Year;

    [Fact]
    public async Task Profile_IsSavedAndRounded()
    {
        using var db = NewDb();

        var result = await NewController(db).UpdateProfile(new ProfileDto("female", ThisYear - 30, 165.04, 60.26, "light"));

        Assert.Equal(new ProfileDto("female", ThisYear - 30, 165.0, 60.3, "light"),
            Assert.IsType<ProfileDto>(Assert.IsType<OkObjectResult>(result).Value));
        var user = await Me_(db);
        Assert.Equal(60.3, user.WeightKg);
        Assert.Equal("light", user.ActivityLevel);
    }

    [Fact]
    public async Task Profile_FieldsAreOptional_AndCanBeCleared()
    {
        using var db = NewDb();
        var controller = NewController(db);
        await controller.UpdateProfile(new ProfileDto("male", ThisYear - 40, 180, 80, "active"));

        Assert.IsType<OkObjectResult>(await controller.UpdateProfile(new ProfileDto(null, null, null, 78, null)));

        var user = await Me_(db);
        Assert.Null(user.Sex);
        Assert.Null(user.HeightCm);
        Assert.Equal(78, user.WeightKg);
    }

    public static TheoryData<ProfileDto> BadProfiles => new()
    {
        new ProfileDto("other", null, null, null, null),
        new ProfileDto(null, ThisYear - 5, null, null, null),       // too young
        new ProfileDto(null, ThisYear - 130, null, null, null),     // too old
        new ProfileDto(null, null, 90, null, null),
        new ProfileDto(null, null, 260, null, null),
        new ProfileDto(null, null, null, 20, null),
        new ProfileDto(null, null, null, double.NaN, null),
        new ProfileDto(null, null, null, null, "couch"),
    };

    [Theory]
    [MemberData(nameof(BadProfiles))]
    public async Task InvalidProfiles_AreRejected_AndNothingChanges(ProfileDto profile)
    {
        using var db = NewDb();

        Assert.IsType<BadRequestObjectResult>(await NewController(db).UpdateProfile(profile));
        var user = await Me_(db);
        Assert.Null(user.Sex);
        Assert.Null(user.WeightKg);
    }

    [Theory]
    [InlineData(1700, 11900)]                       // both
    [InlineData(0, null)]
    [InlineData(-1, null)]
    [InlineData(backend.Models.Goals.MaxPerDay + 1, null)]
    [InlineData(null, 0)]
    [InlineData(null, backend.Models.Goals.MaxPerWeek + 1)]
    public async Task InvalidGoals_AreRejected_AndNothingChanges(int? perDay, int? perWeek)
    {
        using var db = NewDb();

        Assert.IsType<BadRequestObjectResult>(await NewController(db).UpdateGoal("intake", new UpdateGoalRequest(perDay, perWeek)));
        Assert.Null((await Me_(db)).WeeklyIntakeGoal);
    }

    [Fact]
    public async Task UnknownGoalKind_IsNotFound()
    {
        using var db = NewDb();
        Assert.IsType<NotFoundObjectResult>(await NewController(db).UpdateGoal("sleep", new UpdateGoalRequest(8, null)));
    }

    [Theory]
    [InlineData(2000, 286)]
    [InlineData(11900, 1700)]
    [InlineData(7, 1)]
    [InlineData(3, 0)]
    public void PerDay_RoundsTheWeeklyGoalDividedBySeven(int perWeek, int perDay) =>
        Assert.Equal(perDay, backend.Models.Goals.PerDay(perWeek));
}
