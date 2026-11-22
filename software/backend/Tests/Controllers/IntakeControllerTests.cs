using System.Security.Claims;
using backend.Controllers;
using backend.Data;
using backend.DTOs;
using backend.Models;
using backend.Services.Ai;
using backend.Services.Food;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace backend.Tests.Controllers;

public class IntakeControllerTests
{
    private const int Me = 1;
    private const int SomeoneElse = 2;
    private const string MyKey = "hk_my-test-key";

    private sealed class FakeRecognizer : IFoodRecognizer
    {
        public FoodRecognition Result { get; set; } = new(true, "banana", 89, "high", 1500, 40);
        public bool Fail { get; set; }
        public bool IsAvailable { get; set; } = true;
        public int Calls { get; private set; }
        public FoodPhotoSource? LastSource { get; private set; }

        public Task<FoodRecognition> RecognizeAsync(byte[] image, string mediaType, FoodPhotoSource source = FoodPhotoSource.Scale, CancellationToken ct = default)
        {
            Calls++;
            LastSource = source;
            if (Fail) throw new FoodRecognitionException("boom");
            return Task.FromResult(Result);
        }
    }

    private static AppDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        var db = new AppDbContext(options);
        db.Users.AddRange(
            new User { Id = Me, Username = "me", Email = "me@x" },
            new User { Id = SomeoneElse, Username = "other", Email = "other@x" });
        db.Devices.Add(new Device { Id = 1, UserId = Me, Name = "Stack-chan", KeyHash = DeviceKeys.Hash(MyKey), KeyPrefix = "hk_my-te" });
        db.SaveChanges();
        return db;
    }

    private static IntakeController NewController(AppDbContext db, IFoodRecognizer recognizer, int userId = Me)
    {
        var controller = new IntakeController(db, recognizer,
            new AiUsageTracker(db, NullLogger<AiUsageTracker>.Instance),
            NullLogger<IntakeController>.Instance);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    [new Claim(ClaimTypes.NameIdentifier, userId.ToString())], "test")),
            },
        };
        return controller;
    }

    private static IFormFile Jpeg(int size = 1024)
    {
        var stream = new MemoryStream(new byte[size]);
        return new FormFile(stream, 0, size, "image", "meal.jpg")
        {
            Headers = new HeaderDictionary(),
            ContentType = "image/jpeg",
        };
    }

    private static T Body<T>(IActionResult result) => Assert.IsType<T>(Assert.IsType<OkObjectResult>(result).Value);

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    [Fact]
    public async Task Upload_ComputesCaloriesFromWeight_AndSavesForDeviceOwner()
    {
        using var db = NewDb();
        var controller = NewController(db, new FakeRecognizer(), userId: SomeoneElse);

        var result = await controller.UploadFromDevice(MyKey, Jpeg(), 150, null, default);

        var body = Body<DeviceUploadResult>(result);
        Assert.True(body.IsFood);
        Assert.Equal(134, body.Calories); // 150 g × 89 kcal/100 g = 133.5 → 134
        Assert.Equal(134, body.TodayCalories);

        var saved = await db.IntakeRecords.SingleAsync();
        // Owner comes from the device key, never from whoever else is signed in
        Assert.Equal(Me, saved.UserId);
        Assert.Equal(1, saved.DeviceId);
        Assert.NotNull(saved.ImageData);
        Assert.NotNull((await db.Devices.SingleAsync()).LastSeenAt);
        var log = await db.AiUsageLogs.SingleAsync();
        Assert.Equal(AiFeatures.FoodRecognition, log.Feature);
        Assert.Equal(1500, log.InputTokens);
    }

    [Fact]
    public async Task Upload_WithoutRecognizer_StoresPhotoAndWeightOnly()
    {
        using var db = NewDb();
        var recognizer = new FakeRecognizer { IsAvailable = false };

        var body = Body<DeviceUploadResult>(await NewController(db, recognizer).UploadFromDevice(MyKey, Jpeg(500), 123.46, null, default));

        Assert.Equal(0, recognizer.Calls);
        Assert.Equal(123.5, body.WeightGrams);
        Assert.Equal(0, body.Calories);
        var saved = await db.IntakeRecords.SingleAsync();
        Assert.Equal(Me, saved.UserId);
        Assert.Equal("", saved.FoodName);
        Assert.Equal(500, saved.ImageData!.Length);
        Assert.Equal("image/jpeg", saved.ImageContentType);
        // No model call, so nothing is logged against the AI quota
        Assert.Empty(db.AiUsageLogs);
    }

    [Fact]
    public async Task Upload_WithoutRecognizer_HasItsOwnDailyCap()
    {
        using var db = NewDb();
        for (var i = 0; i < IntakeController.DailyUploadLimit; i++)
            db.IntakeRecords.Add(new IntakeRecord { UserId = Me, WeightGrams = 1 });
        await db.SaveChangesAsync();

        var result = await NewController(db, new FakeRecognizer { IsAvailable = false })
            .UploadFromDevice(MyKey, Jpeg(), 100, null, default);

        Assert.Equal(StatusCodes.Status429TooManyRequests, Status(result));
    }

    [Fact]
    public async Task Upload_TodayTotal_SumsEarlierMeals()
    {
        using var db = NewDb();
        var controller = NewController(db, new FakeRecognizer());

        await controller.UploadFromDevice(MyKey, Jpeg(), 100, null, default);
        var second = Body<DeviceUploadResult>(await controller.UploadFromDevice(MyKey, Jpeg(), 200, null, default));

        Assert.Equal(178, second.Calories);
        Assert.Equal(89 + 178, second.TodayCalories);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("hk_wrong")]
    public async Task Upload_MissingOrUnknownKey_IsUnauthorized(string? key)
    {
        using var db = NewDb();
        var recognizer = new FakeRecognizer();

        var result = await NewController(db, recognizer).UploadFromDevice(key, Jpeg(), 100, null, default);

        Assert.IsType<UnauthorizedObjectResult>(result);
        Assert.Equal(0, recognizer.Calls);
    }

    [Fact]
    public async Task Upload_RevokedKey_IsUnauthorized()
    {
        using var db = NewDb();
        (await db.Devices.SingleAsync()).RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var result = await NewController(db, new FakeRecognizer()).UploadFromDevice(MyKey, Jpeg(), 100, null, default);

        Assert.IsType<UnauthorizedObjectResult>(result);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(5001)]
    [InlineData(double.NaN)]
    public async Task Upload_InvalidWeight_IsRejectedBeforeCallingModel(double weight)
    {
        using var db = NewDb();
        var recognizer = new FakeRecognizer();

        var result = await NewController(db, recognizer).UploadFromDevice(MyKey, Jpeg(), weight, null, default);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(0, recognizer.Calls);
    }

    [Fact]
    public async Task Upload_NotFood_LogsNothing()
    {
        using var db = NewDb();
        var recognizer = new FakeRecognizer { Result = new(false, "", 0, "low", 1500, 20) };

        var body = Body<DeviceUploadResult>(await NewController(db, recognizer).UploadFromDevice(MyKey, Jpeg(), 100, null, default));

        Assert.False(body.IsFood);
        Assert.Empty(db.IntakeRecords);
        // Still a paid call, so it counts toward the daily limit
        Assert.Single(db.AiUsageLogs);
    }

    [Fact]
    public async Task Upload_RecognizerFailure_Returns502AndLogsFailure()
    {
        using var db = NewDb();

        var result = await NewController(db, new FakeRecognizer { Fail = true }).UploadFromDevice(MyKey, Jpeg(), 100, null, default);

        Assert.Equal(StatusCodes.Status502BadGateway, Status(result));
        Assert.Empty(db.IntakeRecords);
        Assert.False((await db.AiUsageLogs.SingleAsync()).Success);
    }

    [Fact]
    public async Task Upload_OverDailyLimit_Returns429WithoutCallingModel()
    {
        using var db = NewDb();
        for (var i = 0; i < IntakeController.DailyRecognitionLimit; i++)
            db.AiUsageLogs.Add(new AiUsageLog { UserId = Me, Feature = AiFeatures.FoodRecognition, Success = true });
        await db.SaveChangesAsync();
        var recognizer = new FakeRecognizer();

        var result = await NewController(db, recognizer).UploadFromDevice(MyKey, Jpeg(), 100, null, default);

        Assert.Equal(StatusCodes.Status429TooManyRequests, Status(result));
        Assert.Equal(0, recognizer.Calls);
    }

    [Fact]
    public async Task Update_RecomputesCalories_AndMarksCorrected()
    {
        using var db = NewDb();
        db.IntakeRecords.Add(new IntakeRecord { Id = 10, UserId = Me, FoodName = "rice", WeightGrams = 200, CaloriesPer100g = 130, Calories = 260 });
        await db.SaveChangesAsync();

        var body = Body<IntakeRecordDto>(await NewController(db, new FakeRecognizer())
            .Update(10, new UpdateIntakeRequest("fried rice", 200, 175)));

        Assert.Equal(350, body.Calories);
        Assert.True(body.Corrected);
    }

    // ---- Phone photos ----

    [Fact]
    public async Task RecognizePhoto_AsksForAPhonePhoto_AndStoresNothing()
    {
        using var db = NewDb();
        var recognizer = new FakeRecognizer { Result = new(true, "fried rice", 180, "medium", 1500, 40, EstimatedGrams: 320) };

        var body = Body<PhotoRecognitionDto>(await NewController(db, recognizer).RecognizePhoto(Jpeg(), CancellationToken.None));

        Assert.Equal(FoodPhotoSource.Phone, recognizer.LastSource);
        Assert.Equal(("fried rice", 180.0, 320.0), (body.FoodName, body.CaloriesPer100g, body.EstimatedGrams!.Value));
        Assert.Empty(db.IntakeRecords);
        Assert.Single(db.AiUsageLogs);   // counts against the daily cap
    }

    [Fact]
    public async Task RecognizePhoto_NotFood_Unavailable_OrOverTheCap()
    {
        using var db = NewDb();
        var notFood = Body<PhotoRecognitionDto>(await NewController(db, new FakeRecognizer { Result = new(false, "", 0, "low", 10, 5) })
            .RecognizePhoto(Jpeg(), CancellationToken.None));
        Assert.False(notFood.IsFood);
        Assert.Null(notFood.EstimatedGrams);

        Assert.Equal(503, Status(await NewController(db, new FakeRecognizer { IsAvailable = false }).RecognizePhoto(Jpeg(), CancellationToken.None)));
        Assert.Equal(502, Status(await NewController(db, new FakeRecognizer { Fail = true }).RecognizePhoto(Jpeg(), CancellationToken.None)));
        Assert.IsType<BadRequestObjectResult>(await NewController(db, new FakeRecognizer()).RecognizePhoto(null, CancellationToken.None));

        for (var i = 0; i < IntakeController.DailyRecognitionLimit; i++)
            db.AiUsageLogs.Add(new AiUsageLog { UserId = Me, Feature = AiFeatures.FoodRecognition, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
        var capped = new FakeRecognizer();
        Assert.Equal(429, Status(await NewController(db, capped).RecognizePhoto(Jpeg(), CancellationToken.None)));
        Assert.Equal(0, capped.Calls);
    }

    [Fact]
    public async Task CreateFromPhoto_SavesThePhotoAndTheCheckedValues()
    {
        using var db = NewDb();

        var body = Body<IntakeRecordDto>(await NewController(db, new FakeRecognizer())
            .CreateFromPhoto(Jpeg(2048), " Fried rice ", 300, 180, "medium", corrected: true, TodayStr, CancellationToken.None));

        Assert.Equal(("Fried rice", 540, "photo", true, true), (body.FoodName, body.Calories, body.Source, body.HasImage, body.Corrected));
        var saved = db.IntakeRecords.Single();
        Assert.Equal(2048, saved.ImageData!.Length);
        Assert.Null(saved.DeviceId);
        Assert.Equal("medium", saved.Confidence);
    }

    [Fact]
    public async Task CreateFromPhoto_RejectsBadValuesOrNoPhoto_AndCleansConfidence()
    {
        using var db = NewDb();
        var c = NewController(db, new FakeRecognizer());
        Assert.IsType<BadRequestObjectResult>(await c.CreateFromPhoto(null, "rice", 100, 100, "high", false, null, CancellationToken.None));
        Assert.IsType<BadRequestObjectResult>(await c.CreateFromPhoto(Jpeg(), "rice", 0, 100, "high", false, null, CancellationToken.None));
        Assert.IsType<BadRequestObjectResult>(await c.CreateFromPhoto(Jpeg(), "", 100, 100, "high", false, null, CancellationToken.None));
        Assert.Empty(db.IntakeRecords);

        var odd = Body<IntakeRecordDto>(await c.CreateFromPhoto(Jpeg(), "rice", 100, 100, "manual", false, null, CancellationToken.None));
        Assert.Equal("medium", odd.Confidence);
    }

    [Fact]
    public async Task Create_ManualMeal_ComputesCalories_OnTheLocalDay()
    {
        using var db = NewDb();
        var body = Body<IntakeRecordDto>(await NewController(db, new FakeRecognizer())
            .Create(new UpdateIntakeRequest("  Toast ", 60, 265), Today.AddDays(-1).ToString("yyyy-MM-dd")));

        Assert.Equal("Toast", body.FoodName);
        Assert.Equal(159, body.Calories);
        Assert.Equal("manual", body.Confidence);
        Assert.Equal("manual", body.Source);
        Assert.False(body.HasImage);
        Assert.Equal(Today.AddDays(-1), body.Date);
        Assert.Equal(Me, db.IntakeRecords.Single().UserId);
    }

    [Theory]
    [InlineData("", 100, 100)]
    [InlineData("rice", 0, 100)]
    [InlineData("rice", 100, 901)]
    public async Task Create_InvalidMeal_IsRejected(string name, double grams, double density)
    {
        using var db = NewDb();
        Assert.IsType<BadRequestObjectResult>(await NewController(db, new FakeRecognizer())
            .Create(new UpdateIntakeRequest(name, grams, density)));
        Assert.Empty(db.IntakeRecords);
    }

    [Fact]
    public async Task Stats_SumsEachDay_AndRanksFoodsInTheRange()
    {
        using var db = NewDb();
        db.IntakeRecords.AddRange(
            new IntakeRecord { UserId = Me, FoodName = "Rice", Calories = 260, Date = Today },
            new IntakeRecord { UserId = Me, FoodName = "rice ", Calories = 200, Date = Today.AddDays(-1) },
            new IntakeRecord { UserId = Me, FoodName = "Apple", Calories = 80, Date = Today },
            new IntakeRecord { UserId = Me, FoodName = "", Calories = 0, Date = Today },
            new IntakeRecord { UserId = Me, FoodName = "Cake", Calories = 900, Date = Today.AddDays(-10) },
            new IntakeRecord { UserId = SomeoneElse, FoodName = "Pizza", Calories = 900, Date = Today });
        await db.SaveChangesAsync();

        var stats = Body<IntakeStatsDto>(await NewController(db, new FakeRecognizer()).Stats(Today.AddDays(-6), Today));

        Assert.Equal([new IntakeDayDto(Today.AddDays(-1), 200, 1), new IntakeDayDto(Today, 340, 3)], stats.Days);
        Assert.Equal(["Rice", "Apple"], stats.Foods.Select(f => f.Name));
        Assert.Equal((460, 2), (stats.Foods[0].Calories, stats.Foods[0].Count));
    }

    [Fact]
    public async Task Stats_RejectsBackwardsOrOverlongRanges()
    {
        using var db = NewDb();
        var c = NewController(db, new FakeRecognizer());
        Assert.IsType<BadRequestObjectResult>(await c.Stats(Today, Today.AddDays(-1)));
        Assert.IsType<BadRequestObjectResult>(await c.Stats(Today.AddDays(-366), Today));
        Assert.IsType<OkObjectResult>(await c.Stats(Today.AddDays(-365), Today));
    }

    [Fact]
    public async Task OtherUsersRecords_AreInvisible()
    {
        using var db = NewDb();
        db.IntakeRecords.Add(new IntakeRecord { Id = 10, UserId = Me, FoodName = "rice", WeightGrams = 200, CaloriesPer100g = 130, Calories = 260, ImageData = [1] });
        await db.SaveChangesAsync();
        var other = NewController(db, new FakeRecognizer(), userId: SomeoneElse);

        Assert.Empty(Body<List<IntakeRecordDto>>(await other.GetHistory()));
        Assert.IsType<NotFoundResult>(await other.GetImage(10));
        Assert.IsType<NotFoundResult>(await other.Update(10, new UpdateIntakeRequest("x", 1, 1)));
        Assert.IsType<NotFoundResult>(await other.Delete(10));
        Assert.Single(db.IntakeRecords);
    }

    // ---- Today's list on the device ----

    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static string TodayStr => Today.ToString("yyyy-MM-dd");

    private static void AddMeals(AppDbContext db)
    {
        db.IntakeRecords.AddRange(
            new IntakeRecord { Id = 10, UserId = Me, FoodName = "rice", Calories = 260, WeightGrams = 200, Date = Today, CreatedAt = DateTime.UtcNow.AddHours(-2) },
            new IntakeRecord { Id = 11, UserId = Me, FoodName = "apple", Calories = 80, WeightGrams = 150, Date = Today, CreatedAt = DateTime.UtcNow.AddHours(-1) },
            new IntakeRecord { Id = 12, UserId = Me, FoodName = "cake", Calories = 500, WeightGrams = 120, Date = Today.AddDays(-1) },
            new IntakeRecord { Id = 13, UserId = SomeoneElse, FoodName = "pizza", Calories = 900, WeightGrams = 300, Date = Today });
        db.Users.Find(Me)!.WeeklyIntakeGoal = 1700 * 7;
        db.SaveChanges();
    }

    [Fact]
    public async Task DeviceToday_ListsOnlyTodaysMealsOfTheDevicesAccount_NewestFirst()
    {
        using var db = NewDb();
        AddMeals(db);

        var today = Body<DeviceTodayDto>(await NewController(db, new FakeRecognizer()).DeviceTodayList(MyKey, TodayStr, default));

        Assert.Equal(340, today.TodayCalories);
        Assert.Equal(1700, today.DailyGoal);
        Assert.Equal([11, 10], today.Meals.Select(m => m.Id));
        Assert.True(today.Meals[0].CreatedAtUnix > today.Meals[1].CreatedAtUnix);
    }

    [Fact]
    public async Task DeviceDelete_RemovesTodaysMeal_AndReturnsTheNewList()
    {
        using var db = NewDb();
        AddMeals(db);

        var today = Body<DeviceTodayDto>(await NewController(db, new FakeRecognizer()).DeviceDelete(10, MyKey, TodayStr, default));

        Assert.Equal(80, today.TodayCalories);
        Assert.Equal([11], today.Meals.Select(m => m.Id));
        Assert.Null(await db.IntakeRecords.FindAsync(10));
    }

    [Theory]
    [InlineData(12)]  // mine, but from yesterday: history is off limits to a device key
    [InlineData(13)]  // someone else's
    [InlineData(99)]  // doesn't exist
    public async Task DeviceDelete_OnlyReachesTodaysMealsOfTheAccount(int id)
    {
        using var db = NewDb();
        AddMeals(db);

        var result = await NewController(db, new FakeRecognizer()).DeviceDelete(id, MyKey, TodayStr, default);

        Assert.IsType<NotFoundObjectResult>(result);
        Assert.Equal(4, db.IntakeRecords.Count());
    }

    [Fact]
    public async Task DeviceTodayAndDelete_RejectUnknownOrRevokedKeys()
    {
        using var db = NewDb();
        AddMeals(db);
        var controller = NewController(db, new FakeRecognizer());

        Assert.IsType<UnauthorizedObjectResult>(await controller.DeviceTodayList(null, TodayStr, default));
        Assert.IsType<UnauthorizedObjectResult>(await controller.DeviceDelete(10, "hk_wrong", TodayStr, default));

        db.Devices.Single().RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        Assert.IsType<UnauthorizedObjectResult>(await controller.DeviceTodayList(MyKey, TodayStr, default));
        Assert.IsType<UnauthorizedObjectResult>(await controller.DeviceDelete(10, MyKey, TodayStr, default));
        Assert.Equal(4, db.IntakeRecords.Count());
    }

    [Fact]
    public void DeviceKeys_AreUniqueAndHashDeterministically()
    {
        var a = DeviceKeys.Generate();
        var b = DeviceKeys.Generate();

        Assert.NotEqual(a, b);
        Assert.StartsWith("hk_", a);
        Assert.Equal(DeviceKeys.Hash(a), DeviceKeys.Hash(a));
        Assert.NotEqual(DeviceKeys.Hash(a), DeviceKeys.Hash(b));
        Assert.Equal(64, DeviceKeys.Hash(a).Length);
    }
}
