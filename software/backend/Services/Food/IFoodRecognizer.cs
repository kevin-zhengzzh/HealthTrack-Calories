namespace backend.Services.Food;

// Where the photo came from, which changes what the model is told and asked
public enum FoodPhotoSource
{
    // The Stack-chan scale's camera, looking down at the tared scale: the
    // weight is measured, so only the food and its density are asked for
    Scale,
    // A phone photo from the website: no scale, maybe a plate, so the model
    // also estimates the edible portion's weight as a starting value
    Phone,
}

// What the vision model saw. Calorie density only — the total is computed in
// code from a weight: the scale's, or (phone photos) the one the user
// confirms, which starts from EstimatedGrams.
public record FoodRecognition(
    bool IsFood,
    string FoodName,
    double CaloriesPer100g,
    string Confidence,
    int InputTokens,
    int OutputTokens,
    double? EstimatedGrams = null);

public class FoodRecognitionException(string message, Exception? inner = null) : Exception(message, inner);

// Business code depends on this; ClaudeFoodRecognizer is the real
// implementation and tests use a fake.
public interface IFoodRecognizer
{
    // False when no API key is configured; uploads are then stored as
    // photo + weight only, for the user to name in the Food Log.
    bool IsAvailable { get; }

    Task<FoodRecognition> RecognizeAsync(byte[] image, string mediaType, FoodPhotoSource source = FoodPhotoSource.Scale, CancellationToken ct = default);
}
