using System.Security.Cryptography;
using System.Text;

namespace backend.Services.Food;

public static class DeviceKeys
{
    public const string HeaderName = "X-Device-Key";
    private const string Prefix = "hk_";

    // 32 random bytes → 43 base64url chars; unguessable, so a fast
    // unsalted hash is enough (no need for BCrypt's per-key salt, which
    // would also make lookup-by-hash impossible).
    public static string Generate() =>
        Prefix + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static string Hash(string key) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));

    public static string DisplayPrefix(string key) => key[..Math.Min(key.Length, 8)];

    // Placeholder KeyHash for a device that was claimed by pairing code but
    // hasn't collected its key yet. Unique (KeyHash has a unique index) and
    // can never equal a real hash, which is 64 hex characters.
    public static string PendingHash(int pairingId) => $"pending-{pairingId}-{Guid.NewGuid():N}";

    public static bool IsPending(string keyHash) => keyHash.StartsWith("pending-", StringComparison.Ordinal);

    // Private token the device keeps while pairing (same strength as a key)
    public static string GeneratePairingToken() =>
        "pt_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static string GeneratePairingCode() =>
        RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");
}
