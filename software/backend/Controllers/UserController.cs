using System.Security.Claims;
using backend.Data;
using backend.DTOs;
using backend.Models;
using FluentValidation;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace backend.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class UserController : ControllerBase
{
    private readonly AppDbContext _db;
    private readonly IValidator<UpdateUsernameRequest> _usernameValidator;

    public UserController(AppDbContext db, IValidator<UpdateUsernameRequest> usernameValidator)
    {
        _db = db;
        _usernameValidator = usernameValidator;
    }

    private int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);

    [HttpGet("me")]
    public async Task<IActionResult> GetMe()
    {
        var raw = await _db.Users
            .Include(u => u.OwnedSkins)
            .Where(u => u.Id == UserId)
            .Select(u => new
            {
                u.Id,
                u.Username,
                u.Email,
                u.Points,
                u.Streak,
                u.LastCheckIn,
                u.CreatedAt,
                u.EquippedSkinId,
                u.AvatarUpdatedAt,
                u.WeeklyCalorieGoal,
                u.WeeklyIntakeGoal,
                HasAvatar = u.AvatarData != null,
                EquippedTheme = u.EquippedSkinId == null
                    ? "default"
                    : _db.Skins.Where(s => s.Id == u.EquippedSkinId).Select(s => s.Theme).FirstOrDefault()
            })
            .FirstOrDefaultAsync();

        if (raw is null) return NotFound();

        return Ok(new
        {
            raw.Id,
            raw.Username,
            raw.Email,
            raw.Points,
            raw.Streak,
            raw.LastCheckIn,
            raw.CreatedAt,
            raw.EquippedSkinId,
            raw.EquippedTheme,
            raw.WeeklyCalorieGoal,
            raw.WeeklyIntakeGoal,
            AvatarUrl = raw.HasAvatar ? $"/user/avatar/{raw.Id}?v={raw.AvatarUpdatedAt!.Value.Ticks}" : null
        });
    }

    [HttpPut("username")]
    public async Task<IActionResult> UpdateUsername(UpdateUsernameRequest req)
    {
        var validation = await _usernameValidator.ValidateAsync(req);
        if (!validation.IsValid)
            return BadRequest(validation.Errors.Select(e => e.ErrorMessage));

        var user = await _db.Users.FindAsync(UserId);
        if (user is null) return NotFound();

        if (req.Username == user.Username)
            return Ok(new { username = user.Username });

        var taken = await _db.Users.AnyAsync(u => u.Id != UserId && u.Username == req.Username);
        if (taken)
            return Conflict(new { message = "That username is already taken." });

        user.Username = req.Username;
        await _db.SaveChangesAsync();

        return Ok(new { username = user.Username });
    }

    // Both goals live on the Plan page. Either figure can be sent; the
    // weekly value is stored and the daily one derived (Goals).
    [HttpPut("goals/{kind}")]
    public async Task<IActionResult> UpdateGoal(string kind, UpdateGoalRequest req)
    {
        var isIntake = kind.Equals("intake", StringComparison.OrdinalIgnoreCase);
        if (!isIntake && !kind.Equals("burn", StringComparison.OrdinalIgnoreCase))
            return NotFound(new { message = "Unknown goal. Use 'intake' or 'burn'." });
        if (req.PerDay is not null && req.PerWeek is not null)
            return BadRequest(new { message = "Send the daily or the weekly goal, not both." });
        if (req.PerDay is < 1 or > Goals.MaxPerDay)
            return BadRequest(new { message = $"Daily goal must be between 1 and {Goals.MaxPerDay:N0} kcal." });
        if (req.PerWeek is < 1 or > Goals.MaxPerWeek)
            return BadRequest(new { message = $"Weekly goal must be between 1 and {Goals.MaxPerWeek:N0} kcal." });

        int? perWeek = req.PerWeek ?? req.PerDay * 7;
        if (perWeek is null && !isIntake)
            return BadRequest(new { message = "The burn goal can't be cleared." });

        var user = await _db.Users.FindAsync(UserId);
        if (user is null) return NotFound();

        if (isIntake) user.WeeklyIntakeGoal = perWeek;
        else user.WeeklyCalorieGoal = perWeek!.Value;
        await _db.SaveChangesAsync();

        return Ok(GoalsOf(user));
    }

    internal static GoalsDto GoalsOf(User user) => new(
        new GoalDto(Goals.PerDay(user.WeeklyIntakeGoal), user.WeeklyIntakeGoal),
        new GoalDto(Goals.PerDay(user.WeeklyCalorieGoal), user.WeeklyCalorieGoal));

    private static readonly HashSet<string> AllowedAvatarTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg", "image/png", "image/webp", "image/gif"
    };
    private const long MaxAvatarBytes = 10 * 1024 * 1024; // 10MB

    [HttpPost("avatar")]
    [RequestSizeLimit(MaxAvatarBytes)]
    public async Task<IActionResult> UploadAvatar(IFormFile file)
    {
        if (file is null || file.Length == 0)
            return BadRequest(new { message = "No file uploaded." });

        if (file.Length > MaxAvatarBytes)
            return BadRequest(new { message = "Image must be 10MB or smaller." });

        if (!AllowedAvatarTypes.Contains(file.ContentType))
            return BadRequest(new { message = "Unsupported image type. Use JPEG, PNG, WebP, or GIF." });

        var user = await _db.Users.FindAsync(UserId);
        if (user is null) return NotFound();

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        user.AvatarData = ms.ToArray();
        user.AvatarContentType = file.ContentType;
        user.AvatarUpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        return Ok(new { avatarUrl = $"/user/avatar/{user.Id}?v={user.AvatarUpdatedAt.Value.Ticks}" });
    }

    [HttpGet("avatar/{id}")]
    [AllowAnonymous]
    public async Task<IActionResult> GetAvatar(int id)
    {
        var user = await _db.Users.FindAsync(id);
        if (user?.AvatarData is null) return NotFound();

        return File(user.AvatarData, user.AvatarContentType ?? "application/octet-stream");
    }
}
