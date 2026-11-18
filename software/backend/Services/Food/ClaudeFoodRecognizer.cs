using System.Text.Json;
using Anthropic;
using Anthropic.Exceptions;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Options;

namespace backend.Services.Food;

// Identifies the food in a device photo and estimates its calorie density
// with Claude's vision. Uses the beta endpoint only for server-side refusal
// fallbacks: if a safety classifier declines, the API re-serves the request
// on a fallback model inside the same call.
public class ClaudeFoodRecognizer : IFoodRecognizer
{
    private const string SystemPrompt = """
        You identify food from a single photo taken by a kitchen scale's camera, looking down at
        what is on the scale. The scale has already been tared, so the measured weight is the food
        only, not the plate or bowl.

        Name the food that makes up most of the weight, in English, as a short everyday name
        ("fried rice with egg", "banana", "beef noodle soup"). If several foods share the plate,
        name the combination ("rice with stir-fried broccoli and chicken") and estimate the
        calorie density of the mix as served.

        Estimate kcal per 100 g for the food in the state shown (cooked vs raw, with or without
        sauce or broth). Use typical values from standard nutrition tables.

        Confidence: "high" when the food is clearly visible and unambiguous, "medium" when the
        type is clear but preparation or ingredients are uncertain, "low" when you are guessing.

        If there is no food in the photo (empty scale, a hand, a non-food object, too dark or
        blurry to tell), set isFood to false, foodName to an empty string and caloriesPer100g to 0.
        """;

    private static readonly Dictionary<string, JsonElement> Schema = new()
    {
        ["type"] = JsonSerializer.SerializeToElement("object"),
        ["properties"] = JsonSerializer.SerializeToElement(new
        {
            isFood = new { type = "boolean" },
            foodName = new { type = "string" },
            caloriesPer100g = new { type = "number" },
            confidence = new { type = "string", @enum = new[] { "high", "medium", "low" } },
        }),
        ["required"] = JsonSerializer.SerializeToElement(new[] { "isFood", "foodName", "caloriesPer100g", "confidence" }),
        ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
    };

    private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

    private readonly AnthropicOptions _options;
    private readonly AnthropicClient? _client;

    public ClaudeFoodRecognizer(IOptions<AnthropicOptions> options)
    {
        _options = options.Value;
        // Optional at startup so the app and CI run without a key; uploads
        // then fail with a clear "not configured" error instead.
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
        {
            _client = new AnthropicClient
            {
                ApiKey = _options.ApiKey,
                Timeout = TimeSpan.FromSeconds(_options.TimeoutSeconds),
            };
        }
    }

    public bool IsAvailable => _client is not null;

    public async Task<FoodRecognition> RecognizeAsync(byte[] image, string mediaType, CancellationToken ct = default)
    {
        if (_client is null)
            throw new FoodRecognitionException("Food recognition is not configured (missing Anthropic API key).");

        BetaMessage response;
        try
        {
            response = await _client.Beta.Messages.Create(new MessageCreateParams
            {
                Model = _options.Model,
                MaxTokens = 4096,
                Betas = ["server-side-fallback-2026-07-01"],
                Fallbacks = new Default(),
                System = SystemPrompt,
                // A single-photo classification: low effort keeps the device's
                // wait short without changing the model.
                OutputConfig = new BetaOutputConfig
                {
                    Effort = Effort.Low,
                    Format = new BetaJsonOutputFormat { Schema = Schema },
                },
                Messages =
                [
                    new BetaUserMessageParam
                    {
                        Content = new List<BetaContentBlockParam>
                        {
                            new BetaImageBlockParam
                            {
                                Source = new BetaBase64ImageSource
                                {
                                    Data = Convert.ToBase64String(image),
                                    MediaType = mediaType,
                                },
                            },
                            new BetaTextBlockParam { Text = "What food is on the scale?" },
                        },
                    },
                ],
            }, ct);
        }
        catch (AnthropicApiException ex)
        {
            throw new FoodRecognitionException($"Food recognition request failed: {ex.Message}", ex);
        }

        var inputTokens = (int)response.Usage.InputTokens;
        var outputTokens = (int)response.Usage.OutputTokens;

        if (response.StopReason == "refusal")
            throw new FoodRecognitionException("The model declined to analyse this photo.");

        var text = string.Concat(response.Content
            .Select(b => b.TryPickText(out var t) ? t.Text : null)
            .Where(t => t is not null));

        Parsed? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<Parsed>(text, ReadOptions);
        }
        catch (JsonException ex)
        {
            throw new FoodRecognitionException("The model returned an unreadable answer.", ex);
        }
        if (parsed is null)
            throw new FoodRecognitionException("The model returned an empty answer.");

        return new FoodRecognition(
            parsed.IsFood && parsed.CaloriesPer100g > 0 && !string.IsNullOrWhiteSpace(parsed.FoodName),
            parsed.FoodName.Trim(),
            Math.Clamp(parsed.CaloriesPer100g, 0, 900), // pure fat is ~900 kcal/100g
            parsed.Confidence,
            inputTokens,
            outputTokens);
    }

    private sealed record Parsed(bool IsFood, string FoodName, double CaloriesPer100g, string Confidence);
}
