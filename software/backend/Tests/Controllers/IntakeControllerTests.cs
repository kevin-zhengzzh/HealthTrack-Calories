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

        public Task<FoodRecognition> RecognizeAsync(byte[] image, string mediaType, CancellationToken ct = default)
        {
            Calls++;
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
