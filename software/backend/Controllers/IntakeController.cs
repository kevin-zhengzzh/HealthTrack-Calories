using System.Security.Claims;
using backend.Data;
using backend.DTOs;
using backend.Models;
using backend.Services.Ai;
using backend.Services.Food;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace backend.Controllers;

// Calorie intake logged by a camera + scale device. The device sends a photo
// and the tared weight; the vision model names the food and its kcal/100g,
// and the total is computed here from the measured weight.
[ApiController]
[Route("api/[controller]")]
[Authorize]
public class IntakeController : ControllerBase
{
    // Every upload is a paid vision call, so cap them per user per day
    internal const int DailyRecognitionLimit = 60;
    // Uploads without recognition are free but still store a photo each
    internal const int DailyUploadLimit = 200;
    internal const long MaxImageBytes = 2 * 1024 * 1024;
    internal const double MaxWeightGrams = 5000;
    private const int MaxFoodNameLength = 80;
    private const int HistoryLimit = 500;

    private static readonly HashSet<string> AllowedImageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg", "image/png", "image/webp"
    };

    private readonly AppDbContext _db;
    private readonly IFoodRecognizer _recognizer;
    private readonly AiUsageTracker _usage;
    private readonly ILogger<IntakeController> _logger;

    public IntakeController(AppDbContext db, IFoodRecognizer recognizer, AiUsageTracker usage, ILogger<IntakeController> logger)
    {
        _db = db;
        _recognizer = recognizer;
        _usage = usage;
        _logger = logger;
    }

    private int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    // ---- Device upload (API key, not JWT) ----

    [HttpPost("device")]
    [AllowAnonymous]
    [RequestSizeLimit(MaxImageBytes + 64 * 1024)]
    public async Task<IActionResult> UploadFromDevice(
        [FromHeader(Name = DeviceKeys.HeaderName)] string? deviceKey,
        IFormFile? image,
        [FromForm] double weightGrams,
        [FromForm] string? localDate,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(deviceKey))
            return Unauthorized(new { message = "Missing device key." });

        var hash = DeviceKeys.Hash(deviceKey.Trim());
        var device = await _db.Devices.FirstOrDefaultAsync(d => d.KeyHash == hash && d.RevokedAt == null, ct);
        if (device is null)
            return Unauthorized(new { message = "Unknown or revoked device key." });

        if (image is null || image.Length == 0)
            return BadRequest(new { message = "No image uploaded." });
        if (image.Length > MaxImageBytes)
            return BadRequest(new { message = "Image must be 2MB or smaller." });
        if (!AllowedImageTypes.Contains(image.ContentType))
            return BadRequest(new { message = "Unsupported image type. Use JPEG, PNG or WebP." });
        if (!double.IsFinite(weightGrams) || weightGrams < 1 || weightGrams > MaxWeightGrams)
            return BadRequest(new { message = $"Weight must be between 1 and {MaxWeightGrams} grams." });

        var userId = device.UserId;
        var since = DateTime.UtcNow.Date;
        var date = CheckInController.ResolveToday(localDate);
        weightGrams = Math.Round(weightGrams, 1);
        var contentType = image.ContentType.ToLowerInvariant();

        if (!_recognizer.IsAvailable)
        {
            // Photo + weight only. Still capped: each upload stores an image.
            var uploadsToday = await _db.IntakeRecords.CountAsync(
                r => r.UserId == userId && r.CreatedAt >= since, ct);
            if (uploadsToday >= DailyUploadLimit)
                return StatusCode(StatusCodes.Status429TooManyRequests,
                    new { message = $"Daily limit of {DailyUploadLimit} uploads reached." });

            device.LastSeenAt = DateTime.UtcNow;
            var raw = new IntakeRecord
            {
                UserId = userId,
                DeviceId = device.Id,
                WeightGrams = weightGrams,
                ImageData = await ReadAllAsync(image, ct),
                ImageContentType = contentType,
                Date = date,
            };
            _db.IntakeRecords.Add(raw);
            await _db.SaveChangesAsync(ct);

            var totalSoFar = await TodayTotal(userId, date, ct);
            return Ok(new DeviceUploadResult(true, raw.Id, string.Empty, raw.WeightGrams, 0, totalSoFar,
                $"Saved {raw.WeightGrams} g", await DailyGoal(userId, ct)));
        }

        var usedToday = await _db.AiUsageLogs.CountAsync(
            l => l.UserId == userId && l.Feature == AiFeatures.FoodRecognition && l.CreatedAt >= since, ct);
        if (usedToday >= DailyRecognitionLimit)
            return StatusCode(StatusCodes.Status429TooManyRequests,
                new { message = $"Daily limit of {DailyRecognitionLimit} recognitions reached." });

        device.LastSeenAt = DateTime.UtcNow;
        var bytes = await ReadAllAsync(image, ct);

        FoodRecognition result;
        try
        {
            result = await _recognizer.RecognizeAsync(bytes, contentType, ct);
        }
        catch (FoodRecognitionException ex)
        {
            _logger.LogWarning(ex, "Food recognition failed for device {DeviceId}", device.Id);
            await _usage.SaveAsync(userId, AiFeatures.FoodRecognition, success: false, ex.Message);
            return StatusCode(StatusCodes.Status502BadGateway, new { message = "Food recognition is unavailable right now." });
        }
        _usage.AddUsage(new ChatUsage(result.InputTokens, result.OutputTokens));

        if (!result.IsFood)
        {
            await _usage.SaveAsync(userId, AiFeatures.FoodRecognition, success: true);
            var todaySoFar = await TodayTotal(userId, date, ct);
            return Ok(new DeviceUploadResult(false, null, string.Empty, weightGrams, 0, todaySoFar,
                "No food recognised. Nothing was logged.", await DailyGoal(userId, ct)));
        }

        var record = new IntakeRecord
        {
            UserId = userId,
            DeviceId = device.Id,
            FoodName = Truncate(result.FoodName, MaxFoodNameLength),
            WeightGrams = weightGrams,
            CaloriesPer100g = Math.Round(result.CaloriesPer100g, 1),
            Confidence = result.Confidence,
            ImageData = bytes,
            ImageContentType = contentType,
            Date = date,
        };
        record.Calories = IntakeRecord.ComputeCalories(record.WeightGrams, record.CaloriesPer100g);
        _db.IntakeRecords.Add(record);
        // Also persists the record and LastSeenAt: one SaveChanges for the request
        await _usage.SaveAsync(userId, AiFeatures.FoodRecognition, success: true);

        var total = await TodayTotal(userId, date, ct);
        return Ok(new DeviceUploadResult(true, record.Id, record.FoodName, record.WeightGrams, record.Calories, total,
            $"{record.FoodName}: {record.Calories} kcal", await DailyGoal(userId, ct)));
    }

    private static async Task<byte[]> ReadAllAsync(IFormFile file, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms, ct);
        return ms.ToArray();
    }

    internal static Task<int> TodayTotal(AppDbContext db, int userId, DateOnly date, CancellationToken ct) =>
        db.IntakeRecords.Where(r => r.UserId == userId && r.Date == date).SumAsync(r => r.Calories, ct);

    private Task<int> TodayTotal(int userId, DateOnly date, CancellationToken ct) => TodayTotal(_db, userId, date, ct);

    private Task<int?> DailyGoal(int userId, CancellationToken ct) =>
        _db.Users.Where(u => u.Id == userId).Select(u => u.DailyIntakeGoal).FirstOrDefaultAsync(ct);

    // ---- Signed-in user ----

    [HttpGet]
    public async Task<IActionResult> GetHistory()
    {
        var records = await _db.IntakeRecords
            .Where(r => r.UserId == UserId)
            .OrderByDescending(r => r.CreatedAt)
            .Take(HistoryLimit)
            .Select(r => new IntakeRecordDto(r.Id, r.FoodName, r.WeightGrams, r.CaloriesPer100g, r.Calories,
                r.Confidence, r.Corrected, r.ImageData != null, r.Date, r.CreatedAt))
            .ToListAsync();
        return Ok(records);
    }

    [HttpGet("{id}/image")]
    public async Task<IActionResult> GetImage(int id)
    {
        var image = await _db.IntakeRecords
            .Where(r => r.Id == id && r.UserId == UserId && r.ImageData != null)
            .Select(r => new { r.ImageData, r.ImageContentType })
            .FirstOrDefaultAsync();
        if (image is null) return NotFound();

        Response.Headers.CacheControl = "private, max-age=86400";
        return File(image.ImageData!, image.ImageContentType ?? "image/jpeg");
    }

    // The model can be wrong: let users fix the name, calorie density or weight
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(int id, UpdateIntakeRequest req)
    {
        var name = req.FoodName?.Trim() ?? string.Empty;
        if (name.Length is 0 or > MaxFoodNameLength)
            return BadRequest(new { message = $"Food name must be 1–{MaxFoodNameLength} characters." });
        if (!double.IsFinite(req.WeightGrams) || req.WeightGrams < 1 || req.WeightGrams > MaxWeightGrams)
            return BadRequest(new { message = $"Weight must be between 1 and {MaxWeightGrams} grams." });
        if (!double.IsFinite(req.CaloriesPer100g) || req.CaloriesPer100g < 0 || req.CaloriesPer100g > 900)
            return BadRequest(new { message = "Calories per 100g must be between 0 and 900." });

        var record = await _db.IntakeRecords.FirstOrDefaultAsync(r => r.Id == id && r.UserId == UserId);
        if (record is null) return NotFound();

        record.FoodName = name;
        record.WeightGrams = Math.Round(req.WeightGrams, 1);
        record.CaloriesPer100g = Math.Round(req.CaloriesPer100g, 1);
        record.Calories = IntakeRecord.ComputeCalories(record.WeightGrams, record.CaloriesPer100g);
        record.Corrected = true;
        await _db.SaveChangesAsync();

        return Ok(new IntakeRecordDto(record.Id, record.FoodName, record.WeightGrams, record.CaloriesPer100g,
            record.Calories, record.Confidence, record.Corrected, record.ImageData != null, record.Date, record.CreatedAt));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(int id)
    {
        var record = await _db.IntakeRecords.FirstOrDefaultAsync(r => r.Id == id && r.UserId == UserId);
        if (record is null) return NotFound();

        _db.IntakeRecords.Remove(record);
        await _db.SaveChangesAsync();
        return NoContent();
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
