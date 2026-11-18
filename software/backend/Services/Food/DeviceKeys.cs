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
}
