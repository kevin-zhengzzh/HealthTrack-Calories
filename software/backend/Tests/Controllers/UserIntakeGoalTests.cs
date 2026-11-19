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

public class UserIntakeGoalTests
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

    [Fact]
    public async Task NewUsers_HaveNoGoal()
    {
        using var db = NewDb();
        Assert.Null((await db.Users.FindAsync(Me))!.DailyIntakeGoal);
    }

    [Fact]
    public async Task SettingTheGoal_KeepsItUntilChanged()
    {
        using var db = NewDb();
        var controller = NewController(db);

        Assert.IsType<OkObjectResult>(await controller.UpdateIntakeGoal(new UpdateIntakeGoalRequest(1800)));
        Assert.Equal(1800, (await db.Users.FindAsync(Me))!.DailyIntakeGoal);

        Assert.IsType<OkObjectResult>(await controller.UpdateIntakeGoal(new UpdateIntakeGoalRequest(2200)));
        Assert.Equal(2200, (await db.Users.FindAsync(Me))!.DailyIntakeGoal);
    }

    [Fact]
    public async Task Null_ClearsTheGoal()
    {
        using var db = NewDb();
        var controller = NewController(db);
        await controller.UpdateIntakeGoal(new UpdateIntakeGoalRequest(1800));

        Assert.IsType<OkObjectResult>(await controller.UpdateIntakeGoal(new UpdateIntakeGoalRequest(null)));
        Assert.Null((await db.Users.FindAsync(Me))!.DailyIntakeGoal);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(UserController.MaxDailyIntakeGoal + 1)]
    public async Task OutOfRangeGoals_AreRejected(int goal)
    {
        using var db = NewDb();
        var result = await NewController(db).UpdateIntakeGoal(new UpdateIntakeGoalRequest(goal));

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Null((await db.Users.FindAsync(Me))!.DailyIntakeGoal);
    }
}
