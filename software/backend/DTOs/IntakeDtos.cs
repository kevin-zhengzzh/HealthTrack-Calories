namespace backend.DTOs;

public record CreateDeviceRequest(string Name);

// Key is returned only here, once — the server keeps just its hash
public record CreateDeviceResult(int Id, string Name, string KeyPrefix, string Key, DateTime CreatedAt);

public record DeviceDto(int Id, string Name, string KeyPrefix, DateTime CreatedAt, DateTime? LastSeenAt);

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
