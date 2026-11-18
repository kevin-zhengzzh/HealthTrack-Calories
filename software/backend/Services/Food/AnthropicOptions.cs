namespace backend.Services.Food;

// Bound from the "Anthropic" config section. ApiKey is never in appsettings —
// it comes from user-secrets locally or the Anthropic__ApiKey env var.
public class AnthropicOptions
{
    public string? ApiKey { get; set; }
    public string Model { get; set; } = "claude-opus-5-5";
    public int TimeoutSeconds { get; set; } = 60;
}
