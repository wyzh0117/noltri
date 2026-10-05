//! Tiny UTC clock, so the companion needs no datetime crate.

use std::time::{SystemTime, UNIX_EPOCH};

/// ISO-8601 with a `Z` suffix, matching what `CaptureRequest.capture.capturedAt` and
/// `@noltri/shared`'s `nowIso()` produce, so timestamps from the two layers stay comparable.
pub fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    format_iso(millis)
}

fn format_iso(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let frac = millis.rem_euclid(1000) as u32;
    let days = secs.div_euclid(86_400);
    let second_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = second_of_day / 3600;
    let minute = (second_of_day % 3600) / 60;
    let second = second_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{frac:03}Z"
    )
}

/// A readable label for an epoch-millisecond stamp — backup file names carry raw millis, which nobody
/// can compare. Marked UTC because this module has no local-offset information to offer.
pub fn clock_label(millis: u64) -> String {
    let iso = format_iso(millis as i64);
    let (date, rest) = iso.split_once('T').unwrap_or((iso.as_str(), ""));
    let time = rest.get(..8).unwrap_or(rest);
    format!("{date} {time} UTC")
}

/// Howard Hinnant's `civil_from_days` — public-domain algorithm, no dependencies.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_epoch_and_known_instants() {
        assert_eq!(format_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        assert_eq!(format_iso(-1000), "1969-12-31T23:59:59.000Z");
    }

    #[test]
    fn now_is_parseable_shape() {
        let value = now_iso();
        assert_eq!(value.len(), 24, "unexpected shape: {value}");
        assert!(value.ends_with('Z'));
    }

    /// Backup names carry raw epoch millis; this is the only part a user can actually read.
    #[test]
    fn clock_labels_a_millisecond_stamp_in_utc() {
        assert_eq!(clock_label(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(clock_label(1_700_000_000_000), "2023-11-14 22:13:20 UTC");
    }
}
