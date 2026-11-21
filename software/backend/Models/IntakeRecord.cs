namespace backend.Models;

// One food item weighed and photographed by a device. Calories is derived
// from WeightGrams × CaloriesPer100g, and recomputed when either is corrected.
public class IntakeRecord
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public User User { get; set; } = null!;

    // Null once the device is deleted; records outlive their device
    public int? DeviceId { get; set; }

    // Empty until recognised or named by the user (photo + weight only upload)
    public string FoodName { get; set; } = string.Empty;
    public double WeightGrams { get; set; }
    public double CaloriesPer100g { get; set; }
    public int Calories { get; set; }

    // Model's own confidence ("high" / "medium" / "low"), shown so users
    // know which entries are worth double-checking
    // or "manual" for a meal typed in on the website
    public string Confidence { get; set; } = string.Empty;
    public const string ManualConfidence = "manual";
    // True once the user has edited the AI's food name or calorie density
    public bool Corrected { get; set; }

    public byte[]? ImageData { get; set; }
    public string? ImageContentType { get; set; }

    public DateOnly Date { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public static int ComputeCalories(double weightGrams, double caloriesPer100g) =>
        (int)Math.Round(weightGrams * caloriesPer100g / 100.0, MidpointRounding.AwayFromZero);
}
