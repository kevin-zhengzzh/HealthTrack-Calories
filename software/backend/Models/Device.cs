namespace backend.Models;

// A scale/camera device (e.g. a Stack-chan robot) that uploads meals on a
// user's behalf. It authenticates with an API key instead of a JWT; only the
// key's SHA-256 hash is stored, so a database leak doesn't leak usable keys.
public class Device
{
    public int Id { get; set; }
    public int UserId { get; set; }
    public User User { get; set; } = null!;

    public string Name { get; set; } = string.Empty;

    // Hex SHA-256 of the full key — unique, and the lookup key on every upload
    public string KeyHash { get; set; } = string.Empty;
    // First characters of the key, shown in the UI so users can tell keys apart
    public string KeyPrefix { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastSeenAt { get; set; }
    // Revoked keys are kept (records still reference the device) but rejected
    public DateTime? RevokedAt { get; set; }
}
