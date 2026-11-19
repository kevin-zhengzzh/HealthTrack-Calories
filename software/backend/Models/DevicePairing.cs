namespace backend.Models;

// One "pair this device" attempt. The device shows Code on its screen; a
// signed-in user enters it on the website (claim), which binds a new Device
// to that user; the device then polls with its private token and receives
// the device key exactly once.
//
// Knowing the code alone is not enough to get the key — the poll needs the
// token, which only the device has. Only hashes are stored.
public class DevicePairing
{
    public int Id { get; set; }

    // 6 digits, unique among pairings that haven't expired or completed
    public string Code { get; set; } = string.Empty;
    // SHA-256 of the device's private pairing token
    public string TokenHash { get; set; } = string.Empty;

    // Name the device suggested for itself; the user can override it on claim
    public string SuggestedName { get; set; } = string.Empty;
    // Physical device id the device reported (see Device.HardwareId)
    public string? HardwareId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }

    // Set on claim
    public int? UserId { get; set; }
    public int? DeviceId { get; set; }
    public DateTime? ClaimedAt { get; set; }

    // Set when the device has collected its key; the pairing is then spent
    public DateTime? CompletedAt { get; set; }
}
