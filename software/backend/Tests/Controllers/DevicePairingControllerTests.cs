using System.Security.Claims;
using backend.Controllers;
using backend.Data;
using backend.DTOs;
using backend.Models;
using backend.Services.Food;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace backend.Tests.Controllers;

public class DevicePairingControllerTests
{
    private const int Me = 1;
    private const int SomeoneElse = 2;

    private static AppDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        var db = new AppDbContext(options);
        db.Users.AddRange(
            new User { Id = Me, Username = "me", Email = "me@x" },
            new User { Id = SomeoneElse, Username = "other", Email = "other@x" });
        db.SaveChanges();
        return db;
    }

    private static DevicePairingController NewController(AppDbContext db, IMemoryCache cache, int? userId = null)
    {
        var http = new DefaultHttpContext();
        http.Connection.RemoteIpAddress = System.Net.IPAddress.Loopback;
        if (userId is not null)
            http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, userId.ToString()!)], "test"));
        return new DevicePairingController(db, cache) { ControllerContext = new ControllerContext { HttpContext = http } };
    }

    private static T Body<T>(IActionResult result) => Assert.IsType<T>(Assert.IsType<OkObjectResult>(result).Value);

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    private static async Task<PairingStartResult> Start(AppDbContext db, IMemoryCache cache, string? name = null) =>
        Body<PairingStartResult>(await NewController(db, cache).Start(new PairingStartRequest(name)));

    [Fact]
    public async Task FullFlow_DeviceGetsWorkingKey_OnlyOnce()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());

        var started = await Start(db, cache, "Stack-chan CoreS3");
        Assert.Matches("^[0-9]{6}$", started.Code);

        // Not claimed yet
        var pending = Body<PairingPollResult>(await NewController(db, cache).Poll(new PairingPollRequest(started.PairingToken)));
        Assert.Equal("pending", pending.Status);
        Assert.Null(pending.Key);

        // User types the code the way it's shown on screen
        var spaced = $"{started.Code[..3]} {started.Code[3..]}";
        var claimed = Body<DeviceDto>(await NewController(db, cache, Me).Claim(new PairingClaimRequest(spaced, null)));
        Assert.True(claimed.AwaitingDevice);
        Assert.Equal("Stack-chan CoreS3", claimed.Name);

        var paired = Body<PairingPollResult>(await NewController(db, cache).Poll(new PairingPollRequest(started.PairingToken)));
        Assert.Equal("paired", paired.Status);
        Assert.StartsWith("hk_", paired.Key);
        Assert.Equal("me", paired.Username);

        // The key works for uploads: its hash is what's stored
        var device = await db.Devices.SingleAsync();
        Assert.Equal(Me, device.UserId);
        Assert.Equal(DeviceKeys.Hash(paired.Key!), device.KeyHash);
        Assert.False(DeviceKeys.IsPending(device.KeyHash));

        // A second poll can't fetch the key again
        var again = Body<PairingPollResult>(await NewController(db, cache).Poll(new PairingPollRequest(started.PairingToken)));
        Assert.Equal("expired", again.Status);
        Assert.Null(again.Key);
    }

    [Fact]
    public async Task Claim_UsesTheUsersChosenName()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        var started = await Start(db, cache);

        var claimed = Body<DeviceDto>(await NewController(db, cache, Me).Claim(new PairingClaimRequest(started.Code, "  Kitchen scale ")));

        Assert.Equal("Kitchen scale", claimed.Name);
    }

    [Fact]
    public async Task Code_CanOnlyBeClaimedOnce()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        var started = await Start(db, cache);

        Body<DeviceDto>(await NewController(db, cache, Me).Claim(new PairingClaimRequest(started.Code, null)));
        var second = await NewController(db, cache, SomeoneElse).Claim(new PairingClaimRequest(started.Code, null));

        Assert.IsType<NotFoundObjectResult>(second);
        Assert.Equal(Me, (await db.Devices.SingleAsync()).UserId);
    }

    [Fact]
    public async Task ExpiredCode_CannotBeClaimed_AndDeviceIsToldToRestart()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        var started = await Start(db, cache);
        (await db.DevicePairings.SingleAsync()).ExpiresAt = DateTime.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();

        var claim = await NewController(db, cache, Me).Claim(new PairingClaimRequest(started.Code, null));
        var poll = Body<PairingPollResult>(await NewController(db, cache).Poll(new PairingPollRequest(started.PairingToken)));

        Assert.IsType<NotFoundObjectResult>(claim);
        Assert.Equal("expired", poll.Status);
        Assert.Empty(db.Devices);
    }

    [Fact]
    public async Task DeviceRemovedBeforeCollecting_GetsNoKey()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        var started = await Start(db, cache);
        Body<DeviceDto>(await NewController(db, cache, Me).Claim(new PairingClaimRequest(started.Code, null)));
        (await db.Devices.SingleAsync()).RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var poll = Body<PairingPollResult>(await NewController(db, cache).Poll(new PairingPollRequest(started.PairingToken)));

        Assert.Equal("expired", poll.Status);
        Assert.Null(poll.Key);
    }

    [Fact]
    public async Task UnknownToken_IsNotFound()
    {
        using var db = NewDb();
        var result = await NewController(db, new MemoryCache(new MemoryCacheOptions())).Poll(new PairingPollRequest("pt_nope"));
        Assert.IsType<NotFoundObjectResult>(result);
    }

    [Fact]
    public async Task WrongCodes_AreRateLimitedPerUser()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        var started = await Start(db, cache);
        var wrong = started.Code == "000000" ? "000001" : "000000";

        for (var i = 0; i < DevicePairingController.MaxFailedClaimsPerUserPerHour; i++)
            Assert.IsType<NotFoundObjectResult>(await NewController(db, cache, Me).Claim(new PairingClaimRequest(wrong, null)));

        // Even the right code is refused once locked out
        var locked = await NewController(db, cache, Me).Claim(new PairingClaimRequest(started.Code, null));
        Assert.Equal(StatusCodes.Status429TooManyRequests, Status(locked));
        // ...but other users are unaffected
        Assert.IsType<OkObjectResult>(await NewController(db, cache, SomeoneElse).Claim(new PairingClaimRequest(started.Code, null)));
    }

    [Fact]
    public async Task Start_IsRateLimitedPerIp()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        for (var i = 0; i < DevicePairingController.MaxStartsPerIpPer10Min; i++)
            await Start(db, cache);

        var over = await NewController(db, cache).Start(new PairingStartRequest(null));

        Assert.Equal(StatusCodes.Status429TooManyRequests, Status(over));
    }

    [Fact]
    public async Task DeviceMe_ReturnsAccount_Until_DeviceIsRemoved()
    {
        using var db = NewDb();
        var key = DeviceKeys.Generate();
        var device = new Device { UserId = Me, Name = "Stack-chan", KeyHash = DeviceKeys.Hash(key) };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        var controller = new DeviceController(db);

        var me = Body<DeviceSelfDto>(await controller.Me(key));
        Assert.Equal("me", me.Username);
        Assert.Equal("Stack-chan", me.Name);
        Assert.NotNull(device.LastSeenAt);

        device.RevokedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        Assert.IsType<UnauthorizedObjectResult>(await controller.Me(key));
        Assert.IsType<UnauthorizedObjectResult>(await controller.Me(null));
    }

    [Fact]
    public async Task DeviceMe_ReportsTodaysIntakeAndTheGoal()
    {
        using var db = NewDb();
        var key = DeviceKeys.Generate();
        db.Devices.Add(new Device { UserId = Me, Name = "Stack-chan", KeyHash = DeviceKeys.Hash(key) });
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        db.IntakeRecords.AddRange(
            new IntakeRecord { UserId = Me, FoodName = "rice", Calories = 300, Date = today },
            new IntakeRecord { UserId = Me, FoodName = "apple", Calories = 80, Date = today },
            new IntakeRecord { UserId = Me, FoodName = "cake", Calories = 500, Date = today.AddDays(-1) },
            new IntakeRecord { UserId = SomeoneElse, FoodName = "pizza", Calories = 900, Date = today });
        (await db.Users.FindAsync(Me))!.DailyIntakeGoal = 1700;
        await db.SaveChangesAsync();

        var me = Body<DeviceSelfDto>(await new DeviceController(db).Me(key, today.ToString("yyyy-MM-dd")));
        Assert.Equal(380, me.TodayCalories);
        Assert.Equal(1700, me.DailyGoal);
    }

    private static async Task<string> PairFully(AppDbContext db, IMemoryCache cache, int userId, string? hardwareId)
    {
        var started = Body<PairingStartResult>(await NewController(db, cache).Start(new PairingStartRequest(null, hardwareId)));
        Body<DeviceDto>(await NewController(db, cache, userId).Claim(new PairingClaimRequest(started.Code, null)));
        return Body<PairingPollResult>(await NewController(db, cache).Poll(new PairingPollRequest(started.PairingToken))).Key!;
    }

    [Fact]
    public async Task RePairingSameHardware_ReplacesTheOldRecord()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());

        await PairFully(db, cache, Me, "aa:bb:cc:dd:ee:ff");
        await PairFully(db, cache, Me, "AA:BB:CC:DD:EE:FF");

        var active = await db.Devices.Where(d => d.RevokedAt == null).ToListAsync();
        Assert.Single(active);
        Assert.Equal("AA:BB:CC:DD:EE:FF", active[0].HardwareId);
        Assert.Equal(2, await db.Devices.CountAsync());
    }

    [Fact]
    public async Task RePairing_WorksAtTheDeviceLimit()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        for (var i = 0; i < DeviceController.MaxActiveDevices - 1; i++)
            db.Devices.Add(new Device { UserId = Me, Name = $"d{i}", KeyHash = $"h{i}" });
        await db.SaveChangesAsync();
        await PairFully(db, cache, Me, "AA:BB:CC:DD:EE:FF");

        // Full now, but pairing the same device again just replaces it
        var key = await PairFully(db, cache, Me, "AA:BB:CC:DD:EE:FF");

        Assert.NotNull(key);
        Assert.Equal(DeviceController.MaxActiveDevices, await db.Devices.CountAsync(d => d.RevokedAt == null));
    }

    [Fact]
    public async Task SameHardware_OnAnotherAccount_LeavesTheFirstAlone()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());

        await PairFully(db, cache, Me, "AA:BB:CC:DD:EE:FF");
        await PairFully(db, cache, SomeoneElse, "AA:BB:CC:DD:EE:FF");

        // A MAC isn't secret, so it must never let one user revoke another's device
        Assert.Equal(2, await db.Devices.CountAsync(d => d.RevokedAt == null));
    }

    [Fact]
    public async Task NoOrInvalidHardwareId_NeverReplacesAnything()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());

        await PairFully(db, cache, Me, null);
        await PairFully(db, cache, Me, null);
        await PairFully(db, cache, Me, "<script>");

        Assert.Equal(3, await db.Devices.CountAsync(d => d.RevokedAt == null));
        Assert.All(db.Devices, d => Assert.Null(d.HardwareId));
    }

    [Fact]
    public async Task Device_CanUnpairItself()
    {
        using var db = NewDb();
        var key = await PairFully(db, new MemoryCache(new MemoryCacheOptions()), Me, null);
        var controller = new DeviceController(db);

        Assert.IsType<NoContentResult>(await controller.RevokeSelf(key));

        Assert.NotNull((await db.Devices.SingleAsync()).RevokedAt);
        Assert.IsType<UnauthorizedObjectResult>(await controller.RevokeSelf(key));
        Assert.IsType<UnauthorizedObjectResult>(await controller.Me(key));
    }

    [Fact]
    public async Task Claim_RespectsDeviceLimit()
    {
        using var db = NewDb();
        var cache = new MemoryCache(new MemoryCacheOptions());
        for (var i = 0; i < DeviceController.MaxActiveDevices; i++)
            db.Devices.Add(new Device { UserId = Me, Name = $"d{i}", KeyHash = $"h{i}" });
        await db.SaveChangesAsync();
        var started = await Start(db, cache);

        var result = await NewController(db, cache, Me).Claim(new PairingClaimRequest(started.Code, null));

        Assert.IsType<BadRequestObjectResult>(result);
    }
}
