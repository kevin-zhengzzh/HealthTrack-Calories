using backend.Models;

namespace backend.Services.Food;

// What a device reports about itself in headers on the requests it already
// makes (account check, uploads, today's list) — no extra polling, so the
// backend isn't woken more often (AGENTS.md D-38). Shown on the Device page.
public static class DeviceStatus
{
    public const string FirmwareHeader = "X-Firmware";
    public const string RssiHeader = "X-Wifi-Rssi";
    public const string ScaleHeader = "X-Scale";
    public const string QueuedHeader = "X-Queued";

    private const int MaxFirmwareLength = 32;

    // Records whatever valid values came with the request; ignores the rest
    public static void Apply(Device device, IHeaderDictionary? headers, DateTime now)
    {
        if (headers is null) return;
        var any = false;
        if (headers.TryGetValue(FirmwareHeader, out var fw) && fw.ToString().Trim() is { Length: > 0 } v)
        {
            device.FirmwareVersion = v.Length > MaxFirmwareLength ? v[..MaxFirmwareLength] : v;
            any = true;
        }
        if (headers.TryGetValue(RssiHeader, out var r) && int.TryParse(r, out var rssi) && rssi is >= -120 and <= 0)
        {
            device.WifiRssi = rssi;
            any = true;
        }
        if (headers.TryGetValue(ScaleHeader, out var sc) && sc.ToString() is "0" or "1")
        {
            device.ScaleConnected = sc.ToString() == "1";
            any = true;
        }
        if (headers.TryGetValue(QueuedHeader, out var q) && int.TryParse(q, out var queued) && queued is >= 0 and <= 1000)
        {
            device.PendingUploads = queued;
            any = true;
        }
        if (any) device.StatusAt = now;
    }

    // An upload's capture time (Unix seconds, from the device's clock) is
    // accepted for the past two weeks, up to five minutes ahead for clock skew
    public static readonly TimeSpan MaxTakenAtAge = TimeSpan.FromDays(14);

    public static DateTime? TakenAt(long? unixSeconds, DateTime now)
    {
        if (unixSeconds is not { } s || s <= 0) return null;
        DateTime t;
        try { t = DateTimeOffset.FromUnixTimeSeconds(s).UtcDateTime; }
        catch (ArgumentOutOfRangeException) { return null; }
        return t > now.AddMinutes(5) || t < now - MaxTakenAtAge ? null : t;
    }

    // The local day of a queued upload: the device's own date if it's within a
    // day of the capture time's UTC date (time zones), else the UTC date
    public static DateOnly DayOf(DateTime takenAtUtc, string? localDate)
    {
        var utcDay = DateOnly.FromDateTime(takenAtUtc);
        if (localDate is not null && DateOnly.TryParse(localDate, out var d) && Math.Abs(d.DayNumber - utcDay.DayNumber) <= 1)
            return d;
        return utcDay;
    }
}
