using System.Security.Claims;
using backend.Data;
using backend.DTOs;
using backend.Models;
using backend.Services.Food;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace backend.Controllers;

// Pairing for scale/camera devices: a signed-in user creates a key here and
// flashes it into the device's firmware; revoking it stops future uploads.
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class DeviceController : ControllerBase
{
    internal const int MaxActiveDevices = 5;
    private const int MaxNameLength = 40;

    private readonly AppDbContext _db;

    public DeviceController(AppDbContext db) => _db = db;

    private int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    [HttpGet]
    public async Task<IActionResult> List()
    {
        var devices = await _db.Devices
            .Where(d => d.UserId == UserId && d.RevokedAt == null)
            .OrderBy(d => d.CreatedAt)
            .Select(d => new DeviceDto(d.Id, d.Name, d.KeyPrefix, d.CreatedAt, d.LastSeenAt,
                d.KeyHash.StartsWith("pending-")))
            .ToListAsync();
        return Ok(devices);
    }

    // Called by the device itself (device key, not JWT) to find out whose
    // account it logs to — and, via 401, that it was removed on the website
    [HttpGet("me")]
    [AllowAnonymous]
    public async Task<IActionResult> Me([FromHeader(Name = DeviceKeys.HeaderName)] string? deviceKey,
        [FromQuery] string? localDate = null)
    {
        if (string.IsNullOrWhiteSpace(deviceKey))
            return Unauthorized(new { message = "Missing device key." });

        var hash = DeviceKeys.Hash(deviceKey.Trim());
        var device = await _db.Devices.FirstOrDefaultAsync(d => d.KeyHash == hash && d.RevokedAt == null);
        if (device is null)
            return Unauthorized(new { message = "Unknown or revoked device key." });

        device.LastSeenAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        var user = await _db.Users.Where(u => u.Id == device.UserId)
            .Select(u => new { u.Username, u.DailyIntakeGoal }).FirstAsync();
        var today = await IntakeController.TodayTotal(_db, device.UserId, CheckInController.ResolveToday(localDate), default);
        return Ok(new DeviceSelfDto(device.Name, user.Username, today, user.DailyIntakeGoal));
    }

    // Unpair from the device itself: revokes its own key, so the website no
    // longer lists it and the key can't be used again
    [HttpDelete("me")]
    [AllowAnonymous]
    public async Task<IActionResult> RevokeSelf([FromHeader(Name = DeviceKeys.HeaderName)] string? deviceKey)
    {
        if (string.IsNullOrWhiteSpace(deviceKey))
            return Unauthorized(new { message = "Missing device key." });

        var hash = DeviceKeys.Hash(deviceKey.Trim());
        var device = await _db.Devices.FirstOrDefaultAsync(d => d.KeyHash == hash && d.RevokedAt == null);
        if (device is null)
            return Unauthorized(new { message = "Unknown or revoked device key." });

        device.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost]
    public async Task<IActionResult> Create(CreateDeviceRequest req)
    {
        var name = req.Name?.Trim() ?? string.Empty;
        if (name.Length is 0 or > MaxNameLength)
            return BadRequest(new { message = $"Device name must be 1–{MaxNameLength} characters." });

        var active = await _db.Devices.CountAsync(d => d.UserId == UserId && d.RevokedAt == null);
        if (active >= MaxActiveDevices)
            return BadRequest(new { message = $"You can pair at most {MaxActiveDevices} devices. Remove one first." });

        var key = DeviceKeys.Generate();
        var device = new Device
        {
            UserId = UserId,
            Name = name,
            KeyHash = DeviceKeys.Hash(key),
            KeyPrefix = DeviceKeys.DisplayPrefix(key),
        };
        _db.Devices.Add(device);
        await _db.SaveChangesAsync();

        return Ok(new CreateDeviceResult(device.Id, device.Name, device.KeyPrefix, key, device.CreatedAt));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Revoke(int id)
    {
        var device = await _db.Devices.FirstOrDefaultAsync(d => d.Id == id && d.UserId == UserId && d.RevokedAt == null);
        if (device is null) return NotFound();

        device.RevokedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return NoContent();
    }
}
