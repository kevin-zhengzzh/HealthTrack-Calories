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
    // Identifies the physical device (its MAC), reported when pairing. Lets a
    // re-pair replace the same account's old record instead of adding another.
    public string? HardwareId { get; set; }

    // Reported by the device in request headers (Services/Food/DeviceStatus);
    // null until a firmware that reports it has been in touch
    public string? FirmwareVersion { get; set; }
    public int? WifiRssi { get; set; }          // dBm
    public bool? ScaleConnected { get; set; }
    public int? PendingUploads { get; set; }    // meals saved offline, not yet sent
    public DateTime? StatusAt { get; set; }

    // Revoked keys are kept (records still reference the device) but rejected
    public DateTime? RevokedAt { get; set; }
}
