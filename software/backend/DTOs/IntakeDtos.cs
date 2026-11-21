namespace backend.DTOs;

public record CreateDeviceRequest(string Name);

// Key is returned only here, once — the server keeps just its hash
public record CreateDeviceResult(int Id, string Name, string KeyPrefix, string Key, DateTime CreatedAt);

// AwaitingDevice: claimed with a pairing code, but the device hasn't
// collected its key yet (it is offline or the pairing expired)
public record DeviceDto(int Id, string Name, string KeyPrefix, DateTime CreatedAt, DateTime? LastSeenAt, bool AwaitingDevice);

// Pairing-code flow (device ⇄ backend ⇄ website)
public record PairingStartRequest(string? Name, string? HardwareId = null);
public record PairingStartResult(string Code, string PairingToken, DateTime ExpiresAt, int PollSeconds);
public record PairingClaimRequest(string Code, string? Name);
public record PairingPollRequest(string PairingToken);
// Status: "pending" | "paired" (Key set, returned once) | "expired"
public record PairingPollResult(string Status, string? Key, string? DeviceName, string? Username = null);

// GET /api/device/me — asked by the device itself. Also carries today's
// intake and the daily goal for the ring on its screen.
public record DeviceSelfDto(string Name, string Username, int TodayCalories = 0, int? DailyGoal = null);

public record IntakeRecordDto(
    int Id,
    string FoodName,
    double WeightGrams,
    double CaloriesPer100g,
    int Calories,
    string Confidence,
    bool Corrected,
    bool HasImage,
    DateOnly Date,
    DateTime CreatedAt);

public record UpdateIntakeRequest(string FoodName, double WeightGrams, double CaloriesPer100g);

// GET /api/intake/stats: one row per day that has meals, and the top foods
public record IntakeDayDto(DateOnly Date, int Calories, int Meals);
public record IntakeFoodDto(string Name, int Calories, int Count);
public record IntakeStatsDto(List<IntakeDayDto> Days, List<IntakeFoodDto> Foods);

// Kept small and flat: it is parsed on a microcontroller and shown on a 320x240 screen
// DailyGoal: the user's daily intake goal (null = not set), for the ring on the device
// Today's meals for the list on the device. CreatedAtUnix: seconds since the
// epoch, so the device can show its own local time.
public record DeviceMealDto(int Id, string FoodName, int Calories, double WeightGrams, long CreatedAtUnix);
public record DeviceTodayDto(int TodayCalories, int? DailyGoal, IReadOnlyList<DeviceMealDto> Meals);

public record DeviceUploadResult(bool IsFood, int? Id, string FoodName, double WeightGrams, int Calories, int TodayCalories, string Message, int? DailyGoal = null);
