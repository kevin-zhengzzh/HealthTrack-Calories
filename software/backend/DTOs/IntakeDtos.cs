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

// GET /api/device/me — asked by the device itself
public record DeviceSelfDto(string Name, string Username);

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

// Kept small and flat: it is parsed on a microcontroller and shown on a 320x240 screen
public record DeviceUploadResult(bool IsFood, int? Id, string FoodName, double WeightGrams, int Calories, int TodayCalories, string Message);
