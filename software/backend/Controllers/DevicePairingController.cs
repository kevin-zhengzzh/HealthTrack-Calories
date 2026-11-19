using System.Security.Claims;
using backend.Data;
using backend.DTOs;
using backend.Models;
using backend.Services.Food;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace backend.Controllers;

// Pairing a device without copying keys around:
//   1. device  POST start  -> shows the 6-digit code, keeps the private token
//   2. user    POST claim  -> enters the code on the website; a Device is
//                             created for them, still without a key
//   3. device  POST poll   -> with its token; once claimed, the key is
//                             generated and returned this one time
// The key only ever exists in plaintext in that last response.
[ApiController]
[Route("api/device/pairing")]
public class DevicePairingController : ControllerBase
{
    internal static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(10);
    // A device that was claimed just before expiry still gets to collect its key
    internal static readonly TimeSpan CollectGrace = TimeSpan.FromMinutes(10);
    internal const int PollSeconds = 3;

    // Abuse limits (in-memory: fine for a single replica)
    internal const int MaxStartsPerIpPer10Min = 10;
    internal const int MaxFailedClaimsPerUserPerHour = 10;
    private const int MaxOpenPairings = 1000;
    private const int MaxNameLength = 40;

    private readonly AppDbContext _db;
    private readonly IMemoryCache _cache;

    public DevicePairingController(AppDbContext db, IMemoryCache cache)
    {
        _db = db;
        _cache = cache;
    }

    [HttpPost("start")]
    [AllowAnonymous]
    public async Task<IActionResult> Start(PairingStartRequest? req)
    {
        var ip = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        if (!TryCount($"pair-start:{ip}", MaxStartsPerIpPer10Min, TimeSpan.FromMinutes(10)))
            return StatusCode(StatusCodes.Status429TooManyRequests, new { message = "Too many pairing attempts. Try again later." });

        var now = DateTime.UtcNow;

        // Opportunistic cleanup of long-dead attempts (load + RemoveRange rather
        // than ExecuteDelete so the in-memory test provider supports it)
        var stale = await _db.DevicePairings.Where(p => p.ExpiresAt < now.AddDays(-1)).Take(100).ToListAsync();
        _db.DevicePairings.RemoveRange(stale);

        var open = await _db.DevicePairings.CountAsync(p => p.CompletedAt == null && p.ExpiresAt > now);
        if (open >= MaxOpenPairings)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "Pairing is busy. Try again shortly." });

        // Codes only need to be unique among pairings still waiting for a claim
        string code;
        var attempts = 0;
        do
        {
            code = DeviceKeys.GeneratePairingCode();
            if (++attempts > 20)
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "Pairing is busy. Try again shortly." });
        } while (await _db.DevicePairings.AnyAsync(p => p.Code == code && p.ClaimedAt == null && p.ExpiresAt > now));

        var token = DeviceKeys.GeneratePairingToken();
        var name = Clean(req?.Name);
        var pairing = new DevicePairing
        {
            Code = code,
            TokenHash = DeviceKeys.Hash(token),
            SuggestedName = name.Length > 0 ? name : "Stack-chan",
            CreatedAt = now,
            ExpiresAt = now + CodeLifetime,
        };
        _db.DevicePairings.Add(pairing);
        await _db.SaveChangesAsync();

        return Ok(new PairingStartResult(code, token, pairing.ExpiresAt, PollSeconds));
    }

    [HttpPost("claim")]
    [Authorize]
    public async Task<IActionResult> Claim(PairingClaimRequest req)
    {
        var userId = int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
        var failKey = $"pair-claim-fail:{userId}";
        if (_cache.TryGetValue(failKey, out Counter? fails) && fails!.Count >= MaxFailedClaimsPerUserPerHour)
            return StatusCode(StatusCodes.Status429TooManyRequests, new { message = "Too many wrong codes. Try again in an hour." });

        // Accept "483 920" or "483-920" as typed from the screen
        var code = new string((req.Code ?? string.Empty).Where(char.IsAsciiDigit).ToArray());
        var now = DateTime.UtcNow;
        var pairing = code.Length == 6
            ? await _db.DevicePairings.FirstOrDefaultAsync(p =>
                p.Code == code && p.ClaimedAt == null && p.CompletedAt == null && p.ExpiresAt > now)
            : null;
        if (pairing is null)
        {
            TryCount(failKey, int.MaxValue, TimeSpan.FromHours(1));
            return NotFound(new { message = "That code wasn't found or has expired. Check the number on the device screen." });
        }

        var active = await _db.Devices.CountAsync(d => d.UserId == userId && d.RevokedAt == null);
        if (active >= DeviceController.MaxActiveDevices)
            return BadRequest(new { message = $"You can pair at most {DeviceController.MaxActiveDevices} devices. Remove one first." });

        var name = Clean(req.Name);
        var device = new Device
        {
            UserId = userId,
            Name = name.Length > 0 ? name : pairing.SuggestedName,
            KeyHash = DeviceKeys.PendingHash(pairing.Id),
            KeyPrefix = string.Empty,
            CreatedAt = now,
        };
        _db.Devices.Add(device);
        await _db.SaveChangesAsync();

        pairing.UserId = userId;
        pairing.DeviceId = device.Id;
        pairing.ClaimedAt = now;
        await _db.SaveChangesAsync();

        return Ok(new DeviceDto(device.Id, device.Name, device.KeyPrefix, device.CreatedAt, null, AwaitingDevice: true));
    }

    [HttpPost("poll")]
    [AllowAnonymous]
    public async Task<IActionResult> Poll(PairingPollRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.PairingToken))
            return BadRequest(new { message = "Missing pairing token." });

        var hash = DeviceKeys.Hash(req.PairingToken.Trim());
        var pairing = await _db.DevicePairings.FirstOrDefaultAsync(p => p.TokenHash == hash);
        if (pairing is null)
            return NotFound(new { message = "Unknown pairing." });

        var now = DateTime.UtcNow;

        // Already collected: the key can't be shown again, so start over
        if (pairing.CompletedAt is not null)
            return Ok(new PairingPollResult("expired", null, null));

        if (pairing.ClaimedAt is null)
            return Ok(pairing.ExpiresAt > now
                ? new PairingPollResult("pending", null, null)
                : new PairingPollResult("expired", null, null));

        var device = await _db.Devices.FirstOrDefaultAsync(d => d.Id == pairing.DeviceId);
        if (device is null || device.RevokedAt is not null || pairing.ExpiresAt + CollectGrace < now)
            return Ok(new PairingPollResult("expired", null, null));

        // Claimed: mint the key now; only its hash is stored
        var key = DeviceKeys.Generate();
        device.KeyHash = DeviceKeys.Hash(key);
        device.KeyPrefix = DeviceKeys.DisplayPrefix(key);
        device.LastSeenAt = now;
        pairing.CompletedAt = now;
        await _db.SaveChangesAsync();

        return Ok(new PairingPollResult("paired", key, device.Name));
    }

    private static string Clean(string? name)
    {
        var n = (name ?? string.Empty).Trim();
        return n.Length > MaxNameLength ? n[..MaxNameLength] : n;
    }

    // Fixed-window counter (the window starts at the first hit and isn't
    // extended by later ones); returns false once the limit is reached
    private bool TryCount(string key, int limit, TimeSpan window)
    {
        var entry = _cache.GetOrCreate(key, e =>
        {
            e.AbsoluteExpirationRelativeToNow = window;
            return new Counter();
        })!;
        if (entry.Count >= limit) return false;
        entry.Count++;
        return true;
    }

    private sealed class Counter { public int Count; }
}
