namespace backend.Services.Food;

// What the vision model saw. Calorie density only — the total is computed in
// code from the scale's weight, never estimated by the model.
public record FoodRecognition(
    bool IsFood,
    string FoodName,
    double CaloriesPer100g,
    string Confidence,
    int InputTokens,
    int OutputTokens);

public class FoodRecognitionException(string message, Exception? inner = null) : Exception(message, inner);

// Business code depends on this; ClaudeFoodRecognizer is the real
// implementation and tests use a fake.
public interface IFoodRecognizer
{
    // False when no API key is configured; uploads are then stored as
    // photo + weight only, for the user to name in the Food Log.
    bool IsAvailable { get; }


    Task<FoodRecognition> RecognizeAsync(byte[] image, string mediaType, CancellationToken ct = default);
}
