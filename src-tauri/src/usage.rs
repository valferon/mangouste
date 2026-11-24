//! Claude subscription usage — the same data the `/usage` command shows.
//!
//! Reads the user's own OAuth access token from wherever the CLI put it — the
//! account's `.credentials.json` file, or the login keychain on macOS — and
//! calls Anthropic's usage endpoint with it. The token is read at call time,
//! used only as a request header, and never logged, cached, or returned to the
//! frontend.
//!
//! A token that has lapsed is not a sign-in that has ended. The token lasts
//! eight hours and the login behind it weeks, so the account that was not the
//! one in use is found lapsed after nearly every switch. `renew` has the CLI
//! trade the login for a new token, and only when there is nothing left to
//! renew with does the answer say to sign in.
//!
//! Off unless the frontend asks: nothing here touches the token or the network
//! until `fetch_usage` is actually invoked.

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub percent: u32,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelWindow {
    pub model: String,
    pub percent: u32,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub seven_day_sonnet: Option<UsageWindow>,
    pub seven_day_opus: Option<UsageWindow>,
    pub model_windows: Vec<ModelWindow>,
    pub extra_percent: Option<u32>,
    pub fetched_at_ms: u64,
}

/// Why there are no numbers, and whether signing in is what fixes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageError {
    pub message: String,
    /// The account to sign in, when that and nothing else is the fix. The
    /// panel offers the way there for these alone: for a network fault or a
    /// rate limit a sign-in changes nothing, and saying so cost people a trip
    /// through the browser.
    pub sign_in: Option<String>,
    /// How long until it is worth asking again unasked, in milliseconds, for
    /// the one fault that clears by itself: a renewal that found no network.
    pub retry_ms: Option<u64>,
}

/// Why there are no numbers, before it is put into words.
///
/// Kept apart from the words because the words name the account, and what an
/// account is called on screen is the person's own label for it, looked up
/// only once there is something to say.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fault {
    /// No sign-in stored, or one with nothing left to renew it.
    SignedOut,
    /// The token is lapsed and a renewal left it so, with how the run ended
    /// when it did not end well.
    NotRenewed(Option<String>),
    /// The endpoint turned down a token that is in date and unchanged on disk.
    Refused,
    /// Anything a sign-in would not change.
    Other(String),
}

impl Fault {
    /// The fault in words, for the account named `name` and shown as `title`.
    fn report(self, name: &str, title: &str) -> UsageError {
        let sign_in = |message: String| UsageError {
            message,
            sign_in: Some(name.to_string()),
            retry_ms: None,
        };
        let plain = |message: String| UsageError {
            message,
            sign_in: None,
            retry_ms: None,
        };
        match self {
            Fault::SignedOut => {
                let hint = if cfg!(target_os = "macos") {
                    " If it is, allow the keychain prompt."
                } else {
                    ""
                };
                sign_in(format!("{title} is not signed in.{hint}"))
            }
            // No button for this one. A login the server has ended is blanked
            // by the CLI and reads as signed out, so what is left here is a
            // machine with no network yet, a server having a bad minute, a CLI
            // that would not start: none of them fixed by signing in.
            Fault::NotRenewed(reason) => {
                let reason = reason.map(|r| format!(" ({r})")).unwrap_or_default();
                UsageError {
                    message: format!(
                        "Could not renew the sign-in for {title}{reason}. Usually the network; \
                         it is tried again. If it never clears, sign in again in Settings."
                    ),
                    sign_in: None,
                    retry_ms: Some(crate::renew::RETRY_AFTER_MS),
                }
            }
            // Offered, not asserted: a clock that is wrong makes a dead token
            // look in date, and the account's own sessions say which it is.
            Fault::Refused => sign_in(format!(
                "Anthropic refused the token for {title}. \
                 If sessions on this account fail too, sign in again."
            )),
            Fault::Other(message) => plain(message),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The keychain item the CLI writes on macOS, for a process on `~/.claude`.
///
/// There is no credentials file there: the CLI stores the same JSON as a
/// generic password instead, so reading the file would report "not signed in"
/// on a machine that is. Matched by service alone rather than service+account,
/// because the account is whichever local user wrote it.
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// The keychain item a CLI on this account writes.
///
/// The CLI names the item by its config dir: the bare service for a process
/// with no `CLAUDE_CONFIG_DIR`, and for one that has it, the service plus the
/// first eight hex digits of that directory's SHA-256. `child_dir` is the
/// variable a child on the account is given (`account::env_for`), so this is
/// the name such a child wrote under. Read out of 2.1.322, where it is
/// `Claude Code-credentials` followed by `-${sha256(dir).substring(0, 8)}`.
///
/// The CLI hashes the path in NFC. An account name is ASCII by rule, so only
/// a home directory spelled with decomposed accents would hash differently
/// here, and that account then reads as signed out rather than as another's.
fn keychain_service(child_dir: Option<&Path>) -> String {
    let Some(dir) = child_dir else {
        return KEYCHAIN_SERVICE.to_string();
    };
    let digest = Sha256::digest(dir.to_string_lossy().as_bytes());
    let prefix: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{KEYCHAIN_SERVICE}-{prefix}")
}

/// The credentials JSON out of the login keychain, or None if it is not there.
///
/// Shelling out to `security` rather than linking a keychain crate: the
/// framework call would need an Objective-C bridge in the build for one string
/// read, and `security` is part of the OS. The first read raises the system's
/// own "allow access" prompt, which is the user's to answer — and answering
/// "Always Allow" is what makes it silent from then on.
///
/// Compiled everywhere, reached only on macOS, so a change to it is checked by
/// a build on either host.
fn keychain_credentials(service: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    // By absolute path: whatever `security` comes first on PATH would be handed
    // the keychain read, and the credentials with it.
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!raw.is_empty()).then_some(raw)
}

/// The credentials JSON of `name`, from wherever this platform's CLI keeps
/// it, or `None` when the account has never stored a sign-in.
///
/// The keychain leads on macOS because that is the only place the CLI writes;
/// the file is still tried after it, since an older CLI or a
/// `CLAUDE_CODE_USE_KEYCHAIN=0` install leaves one there. Each account has its
/// own item, named by its config dir, so no account is handed another's.
fn read_credentials(name: &str) -> Result<Option<String>, String> {
    let child_dir = crate::account::env_for(name);
    if let Some(raw) = keychain_credentials(&keychain_service(child_dir.as_deref())) {
        return Ok(Some(raw));
    }
    let path = crate::account::credentials_file_of(name).ok_or("no home directory")?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read credentials: {e}")),
    }
}

/// What an account's stored sign-in is good for right now.
#[derive(Clone, PartialEq, Eq)]
enum Stored {
    /// An access token the endpoint will take.
    Fresh(String),
    /// The access token has run out and the login behind it has not: the CLI
    /// renews this by itself, with nobody signing in.
    Lapsed,
    /// Nothing to renew with: no login stored, or one past its own end date.
    SignedOut,
}

/// Written by hand so the token is never what gets printed: a derived `Debug`
/// would put it in the first log line or failed assertion that shows a
/// `Stored`.
impl std::fmt::Debug for Stored {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Stored::Fresh(_) => "Fresh(..)",
            Stored::Lapsed => "Lapsed",
            Stored::SignedOut => "SignedOut",
        })
    }
}

/// How close to its end a token still counts as usable.
///
/// A token that dies while the request is in flight comes back as a bare 401.
/// Kept well inside the five minutes at which the CLI itself calls a token
/// expired: asking for a renewal the CLI would not yet do renews nothing.
const EXPIRY_MARGIN_MS: u64 = 60_000;

/// A date out of the credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stamp {
    /// No such key, or null: the CLI's way of writing "no end".
    Absent,
    /// Milliseconds since the epoch.
    At(u64),
    /// There, and not a number. Not the same as absent: a date that cannot be
    /// read is not a promise that the thing never ends.
    Unreadable,
}

/// The date under `key`. The CLI writes milliseconds; a value too small to be
/// one is taken as seconds.
fn stamp_of(oauth: &serde_json::Value, key: &str) -> Stamp {
    match oauth.get(key) {
        None | Some(serde_json::Value::Null) => Stamp::Absent,
        Some(value) => match value.as_f64() {
            Some(number) if number.is_finite() => {
                // `as` saturates: a negative date is the epoch, not a wrap.
                let stamp = number.max(0.0) as u64;
                Stamp::At(if stamp < 1_000_000_000_000 {
                    stamp.saturating_mul(1000)
                } else {
                    stamp
                })
            }
            _ => Stamp::Unreadable,
        },
    }
}

/// Sort the credentials JSON into what can be done with it at `now_ms`.
///
/// The token is returned by value so the caller can hand it straight to the
/// request builder; it is never stored anywhere else. A token with no expiry
/// is taken as it is: the long-lived ones `setup-token` writes carry none.
fn stored_token(raw: &str, now_ms: u64) -> Result<Stored, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("credentials not valid JSON: {e}"))?;
    let Some(oauth) = parsed.get("claudeAiOauth").filter(|v| v.is_object()) else {
        return Ok(Stored::SignedOut);
    };
    let text = |key: &str| {
        oauth
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
    };

    // An expiry that cannot be read is treated as passed: the CLI gets to
    // look at it, where trusting it would send a token that may be days dead
    // and report the 401 as a sign-in that ended.
    let in_date = match stamp_of(oauth, "expiresAt") {
        Stamp::Absent => true,
        Stamp::At(at) => at > now_ms.saturating_add(EXPIRY_MARGIN_MS),
        Stamp::Unreadable => false,
    };
    if let (Some(token), true) = (text("accessToken"), in_date) {
        return Ok(Stored::Fresh(token.to_string()));
    }
    // Only a login plainly past its end is given up on here. Anything else
    // is the CLI's to try.
    let ended = matches!(stamp_of(oauth, "refreshTokenExpiresAt"), Stamp::At(at) if at <= now_ms);
    let renewable = text("refreshToken").is_some() && !ended;
    Ok(if renewable {
        Stored::Lapsed
    } else {
        Stored::SignedOut
    })
}

/// A usable access token, renewing a lapsed one first.
///
/// `read` and `renew` are the two things this cannot do by itself: look at
/// the stored sign-in, and have the CLI renew it. `renew` is given the check
/// it should stop on, so a second caller waiting behind the first's renewal
/// does not start another.
fn usable_token(
    read: impl Fn() -> Result<Stored, Fault>,
    renew: impl FnOnce(&dyn Fn() -> bool) -> Result<(), String>,
) -> Result<String, Fault> {
    match read()? {
        Stored::Fresh(token) => return Ok(token),
        Stored::SignedOut => return Err(Fault::SignedOut),
        Stored::Lapsed => {}
    }
    let ran = renew(&|| matches!(read(), Ok(Stored::Lapsed)));
    match read()? {
        Stored::Fresh(token) => Ok(token),
        // The CLI blanks a login the server has turned down, so a renewal can
        // be what reveals it was already gone.
        Stored::SignedOut => Err(Fault::SignedOut),
        Stored::Lapsed => Err(Fault::NotRenewed(ran.err())),
    }
}

/// `usable_token` against the real credentials and the real CLI.
fn access_token(name: &str) -> Result<String, Fault> {
    let read = || match read_credentials(name).map_err(Fault::Other)? {
        None => Ok(Stored::SignedOut),
        Some(raw) => stored_token(&raw, now_ms()).map_err(Fault::Other),
    };
    usable_token(read, |lapsed| crate::renew::renew(name, lapsed))
}

fn window_of(raw: &serde_json::Value, key: &str) -> Option<UsageWindow> {
    let entry = raw.get(key)?;
    let utilization = entry.get("utilization")?.as_f64()?;
    Some(UsageWindow {
        percent: utilization.round().max(0.0) as u32,
        resets_at: entry
            .get("resets_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Per-model weekly limits from the `limits` array (e.g. the Fable cap).
///
/// The top-level `seven_day_opus`/`seven_day_sonnet` keys are null on newer
/// plans; model-scoped caps now arrive as `limits` entries whose scope names
/// the model.
fn model_windows_of(raw: &serde_json::Value) -> Vec<ModelWindow> {
    let Some(limits) = raw.get("limits").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    limits
        .iter()
        .filter_map(|entry| {
            let model = entry
                .get("scope")?
                .get("model")?
                .get("display_name")?
                .as_str()?;
            Some(ModelWindow {
                model: model.to_string(),
                percent: entry.get("percent")?.as_f64()?.round().max(0.0) as u32,
                resets_at: entry
                    .get("resets_at")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
        })
        .collect()
}

fn usage_of(body: &serde_json::Value) -> ClaudeUsage {
    ClaudeUsage {
        five_hour: window_of(body, "five_hour"),
        seven_day: window_of(body, "seven_day"),
        seven_day_sonnet: window_of(body, "seven_day_sonnet"),
        seven_day_opus: window_of(body, "seven_day_opus"),
        model_windows: model_windows_of(body),
        extra_percent: body
            .get("extra_usage")
            .filter(|e| e.get("is_enabled").and_then(|v| v.as_bool()) == Some(true))
            .and_then(|e| e.get("utilization"))
            .and_then(|v| v.as_f64())
            .map(|v| v.round().max(0.0) as u32),
        fetched_at_ms: now_ms(),
    }
}

/// Why the endpoint gave no numbers.
enum Refusal {
    /// The token was turned down: 401.
    Unauthorized,
    /// Anything a different token would not change.
    Other(String),
}

/// One request to the usage endpoint. Blocks for up to 15s.
fn request_usage(token: &str) -> Result<serde_json::Value, Refusal> {
    let response = ureq::get(USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", OAUTH_BETA)
        .timeout(std::time::Duration::from_secs(15))
        .call();

    match response {
        Ok(ok) => ok
            .into_json()
            .map_err(|e| Refusal::Other(format!("usage response not JSON: {e}"))),
        Err(ureq::Error::Status(401, _)) => Err(Refusal::Unauthorized),
        // Not a sign-in fault: a 403 here is a network or region block, or a
        // token without the profile scope, and signing in again changes none.
        Err(ureq::Error::Status(403, _)) => {
            Err(Refusal::Other("usage request refused: HTTP 403".into()))
        }
        Err(ureq::Error::Status(429, _)) => Err(Refusal::Other(
            "Rate limited by Anthropic; try again later".into(),
        )),
        Err(ureq::Error::Status(code, _)) => {
            Err(Refusal::Other(format!("usage request failed: HTTP {code}")))
        }
        Err(e) => Err(Refusal::Other(format!("usage request failed: {e}"))),
    }
}

/// The endpoint's answer for whatever token `access` hands over.
///
/// A 401 is asked about once more, and only with a different token. Any CLI
/// on the account may renew between the read and the request, which retires
/// the token just sent; the same one refused twice would be refused a third
/// time.
fn usage_with(
    access: impl Fn() -> Result<String, Fault>,
    request: impl Fn(&str) -> Result<serde_json::Value, Refusal>,
) -> Result<serde_json::Value, Fault> {
    let settle = |refusal| match refusal {
        Refusal::Unauthorized => Fault::Refused,
        Refusal::Other(message) => Fault::Other(message),
    };
    let token = access()?;
    match request(&token) {
        Err(Refusal::Unauthorized) => {
            let again = access()?;
            if again == token {
                return Err(Fault::Refused);
            }
            request(&again).map_err(settle)
        }
        answered => answered.map_err(settle),
    }
}

/// Fetch current usage. Invoked only when the user opens the usage panel.
/// `async`: the request blocks for up to 15s, and a renewal before it for as
/// long as a CLI start takes, neither of which may hold the main thread.
#[tauri::command(async)]
pub fn fetch_usage() -> Result<ClaudeUsage, UsageError> {
    // Read once: the token, its renewal and the numbers must all be one
    // account's, even if a switch lands between them.
    let name = crate::account::current_name();
    usage_with(|| access_token(&name), request_usage)
        .map(|body| usage_of(&body))
        .map_err(|fault| fault.report(&name, &crate::account::title(&name)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const NOW: u64 = 1_800_000_000_000;
    const HOUR: u64 = 3_600_000;

    fn credentials(expires_at: u64, refresh_expires_at: Option<u64>) -> String {
        let mut oauth = serde_json::json!({
            "accessToken": "access",
            "refreshToken": "refresh",
            "expiresAt": expires_at,
        });
        if let Some(at) = refresh_expires_at {
            oauth["refreshTokenExpiresAt"] = at.into();
        }
        serde_json::json!({ "claudeAiOauth": oauth, "mcpOAuth": {} }).to_string()
    }

    #[test]
    fn a_token_in_date_is_used_as_it_is() {
        assert_eq!(
            stored_token(&credentials(NOW + HOUR, None), NOW),
            Ok(Stored::Fresh("access".into()))
        );
    }

    /// The case behind every "sign in again" after a switch: the account sat
    /// unused past the token's eight hours, with weeks left on its login.
    #[test]
    fn an_expired_token_with_a_live_login_is_lapsed_not_signed_out() {
        let raw = credentials(NOW - HOUR, Some(NOW + 20 * 24 * HOUR));
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::Lapsed));
    }

    /// Older CLIs wrote no end date for the login; it renews until refused.
    #[test]
    fn a_login_with_no_end_date_is_still_renewable() {
        assert_eq!(
            stored_token(&credentials(NOW - HOUR, None), NOW),
            Ok(Stored::Lapsed)
        );
    }

    #[test]
    fn a_login_past_its_own_end_is_signed_out() {
        let raw = credentials(NOW - HOUR, Some(NOW - 1));
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::SignedOut));
    }

    #[test]
    fn an_expired_token_with_nothing_to_renew_it_is_signed_out() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"access","expiresAt":1}}"#;
        assert_eq!(stored_token(raw, NOW), Ok(Stored::SignedOut));
        let blank = r#"{"claudeAiOauth":{"accessToken":"access","refreshToken":"","expiresAt":1}}"#;
        assert_eq!(stored_token(blank, NOW), Ok(Stored::SignedOut));
    }

    /// What 2.1.322 leaves behind once the server has refused the refresh
    /// token: both tokens blanked, the expiry zeroed, the rest kept. Measured
    /// with a made-up login in a scratch config dir.
    #[test]
    fn the_shape_the_cli_leaves_after_a_refused_renewal_is_signed_out() {
        let raw = serde_json::json!({
            "claudeAiOauth": {
                "accessToken": "",
                "refreshToken": "",
                "expiresAt": 0,
                "refreshTokenExpiresAt": NOW + 20 * 24 * HOUR,
                "subscriptionType": "team",
            }
        })
        .to_string();
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::SignedOut));
    }

    #[test]
    fn a_token_is_never_what_debug_prints() {
        let printed = format!("{:?}", Stored::Fresh("sk-ant-oat01-secret".into()));
        assert_eq!(printed, "Fresh(..)");
    }

    /// A token about to die in flight is renewed first, not sent.
    #[test]
    fn a_token_inside_the_margin_counts_as_lapsed() {
        let raw = credentials(NOW + EXPIRY_MARGIN_MS / 2, None);
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::Lapsed));
        let raw = credentials(NOW + EXPIRY_MARGIN_MS + 1, None);
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::Fresh("access".into())));
    }

    #[test]
    fn expiry_in_seconds_is_read_as_seconds() {
        let raw = credentials((NOW + HOUR) / 1000, None);
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::Fresh("access".into())));
        let raw = credentials((NOW - HOUR) / 1000, None);
        assert_eq!(stored_token(&raw, NOW), Ok(Stored::Lapsed));
    }

    /// `setup-token` writes a token with no expiry and no refresh token.
    #[test]
    fn a_token_with_no_expiry_is_used_as_it_is() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"long-lived","expiresAt":null}}"#;
        assert_eq!(
            stored_token(raw, NOW),
            Ok(Stored::Fresh("long-lived".into()))
        );
    }

    /// A new account's file holds MCP sign-ins before it holds a Claude one.
    #[test]
    fn credentials_with_no_claude_login_are_signed_out() {
        assert_eq!(
            stored_token(r#"{"mcpOAuth":{}}"#, NOW),
            Ok(Stored::SignedOut)
        );
        assert_eq!(
            stored_token(r#"{"claudeAiOauth":null}"#, NOW),
            Ok(Stored::SignedOut)
        );
        assert!(stored_token("not json", NOW).is_err());
    }

    /// A date written as a string, or anything else that is not a number, is
    /// not a promise that the token never ends. Trusted, a token days dead
    /// would be sent, refused, and reported as a sign-in that had ended.
    #[test]
    fn an_expiry_that_cannot_be_read_is_left_to_the_cli() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":"soon"}}"#;
        assert_eq!(stored_token(raw, NOW), Ok(Stored::Lapsed));
        let raw = r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":{}}}"#;
        assert_eq!(stored_token(raw, NOW), Ok(Stored::Lapsed));
    }

    /// Some writers put the date down as a float. Still a date.
    #[test]
    fn an_expiry_written_as_a_float_is_still_a_date() {
        let fresh = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"a","refreshToken":"r","expiresAt":{}.0}}}}"#,
            NOW + HOUR
        );
        assert_eq!(stored_token(&fresh, NOW), Ok(Stored::Fresh("a".into())));
        let lapsed = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"a","refreshToken":"r","expiresAt":{}.0}}}}"#,
            NOW - HOUR
        );
        assert_eq!(stored_token(&lapsed, NOW), Ok(Stored::Lapsed));
    }

    /// Only a login plainly past its end is given up on without asking the
    /// CLI: an end date that cannot be read is not one that has passed.
    #[test]
    fn a_login_end_that_cannot_be_read_is_still_tried() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1,"refreshTokenExpiresAt":"never"}}"#;
        assert_eq!(stored_token(raw, NOW), Ok(Stored::Lapsed));
    }

    #[test]
    fn dates_are_milliseconds_seconds_absent_or_unreadable() {
        let oauth = serde_json::json!({
            "ms": 1_800_000_000_000_u64,
            "s": 1_800_000_000,
            "null": null,
            "text": "1800000000000",
            "negative": -5,
        });
        assert_eq!(stamp_of(&oauth, "ms"), Stamp::At(1_800_000_000_000));
        assert_eq!(stamp_of(&oauth, "s"), Stamp::At(1_800_000_000_000));
        assert_eq!(stamp_of(&oauth, "null"), Stamp::Absent);
        assert_eq!(stamp_of(&oauth, "missing"), Stamp::Absent);
        assert_eq!(stamp_of(&oauth, "text"), Stamp::Unreadable);
        assert_eq!(stamp_of(&oauth, "negative"), Stamp::At(0));
    }

    /// Reads that answer in turn, the last one repeating: what the stored
    /// sign-in looks like before, during and after a renewal.
    fn reads(sequence: Vec<Stored>) -> impl Fn() -> Result<Stored, Fault> {
        let remaining = RefCell::new(sequence);
        move || {
            let mut remaining = remaining.borrow_mut();
            Ok(if remaining.len() > 1 {
                remaining.remove(0)
            } else {
                remaining[0].clone()
            })
        }
    }

    #[test]
    fn a_fresh_token_starts_no_renewal() {
        let renewed = Cell::new(false);
        let token = usable_token(reads(vec![Stored::Fresh("t".into())]), |_| {
            renewed.set(true);
            Ok(())
        });
        assert_eq!(token, Ok("t".into()));
        assert!(!renewed.get());
    }

    #[test]
    fn a_lapsed_token_is_renewed_and_the_new_one_returned() {
        let renewed = Cell::new(false);
        let read = reads(vec![Stored::Lapsed, Stored::Fresh("renewed".into())]);
        let token = usable_token(read, |_| {
            renewed.set(true);
            Ok(())
        });
        assert_eq!(token, Ok("renewed".into()));
        assert!(renewed.get());
    }

    /// The renewal is handed the check to stop on, and it reads the same
    /// stored sign-in the caller does.
    #[test]
    fn the_renewal_is_told_while_the_token_is_still_lapsed() {
        let seen = Cell::new(None);
        let read = reads(vec![
            Stored::Lapsed,
            Stored::Lapsed,
            Stored::Fresh("t".into()),
        ]);
        let token = usable_token(read, |lapsed| {
            seen.set(Some((lapsed(), lapsed())));
            Ok(())
        });
        assert_eq!(seen.get(), Some((true, false)));
        assert_eq!(token, Ok("t".into()));
    }

    #[test]
    fn a_renewal_that_did_not_help_is_its_own_fault_with_how_the_run_ended() {
        let quiet = usable_token(reads(vec![Stored::Lapsed]), |_| Ok(()));
        assert_eq!(quiet, Err(Fault::NotRenewed(None)));
        let failed = usable_token(reads(vec![Stored::Lapsed]), |_| Err("timed out".into()));
        assert_eq!(failed, Err(Fault::NotRenewed(Some("timed out".into()))));
    }

    #[test]
    fn a_signed_out_account_starts_no_renewal() {
        let renewed = Cell::new(false);
        let token = usable_token(reads(vec![Stored::SignedOut]), |_| {
            renewed.set(true);
            Ok(())
        });
        assert_eq!(token, Err(Fault::SignedOut));
        assert!(!renewed.get());
    }

    /// The CLI blanks a login the server turned down, so the renewal itself
    /// can be what shows it had already ended.
    #[test]
    fn a_login_found_dead_by_the_renewal_reads_as_signed_out() {
        let read = reads(vec![Stored::Lapsed, Stored::SignedOut]);
        assert_eq!(usable_token(read, |_| Ok(())), Err(Fault::SignedOut));
    }

    #[test]
    fn credentials_that_cannot_be_read_are_passed_on_as_they_are() {
        let read = || Err(Fault::Other("could not read credentials: denied".into()));
        assert_eq!(
            usable_token(read, |_| Ok(())),
            Err(Fault::Other("could not read credentials: denied".into()))
        );
    }

    /// Tokens handed over in turn, the last one repeating, and every token
    /// the endpoint was asked with.
    fn tokens(sequence: &[&str]) -> impl Fn() -> Result<String, Fault> {
        let remaining = RefCell::new(sequence.iter().map(|t| t.to_string()).collect::<Vec<_>>());
        move || {
            let mut remaining = remaining.borrow_mut();
            Ok(if remaining.len() > 1 {
                remaining.remove(0)
            } else {
                remaining[0].clone()
            })
        }
    }

    fn body() -> serde_json::Value {
        serde_json::json!({ "five_hour": { "utilization": 1.0 } })
    }

    #[test]
    fn an_answer_is_passed_through_with_one_request() {
        let asked = RefCell::new(Vec::new());
        let answer = usage_with(tokens(&["t"]), |token| {
            asked.borrow_mut().push(token.to_string());
            Ok(body())
        });
        assert_eq!(answer, Ok(body()));
        assert_eq!(*asked.borrow(), ["t"]);
    }

    /// Any CLI on the account may renew between the read and the request,
    /// which retires the token just sent.
    #[test]
    fn a_401_is_asked_again_with_the_token_that_replaced_it() {
        let asked = RefCell::new(Vec::new());
        let answer = usage_with(tokens(&["old", "new"]), |token| {
            asked.borrow_mut().push(token.to_string());
            if token == "old" {
                Err(Refusal::Unauthorized)
            } else {
                Ok(body())
            }
        });
        assert_eq!(answer, Ok(body()));
        assert_eq!(*asked.borrow(), ["old", "new"]);
    }

    #[test]
    fn a_401_on_a_token_that_did_not_change_is_not_sent_again() {
        let asked = Cell::new(0);
        let answer = usage_with(tokens(&["same"]), |_| {
            asked.set(asked.get() + 1);
            Err(Refusal::Unauthorized)
        });
        assert_eq!(answer, Err(Fault::Refused));
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn a_second_401_ends_it() {
        let asked = Cell::new(0);
        let answer = usage_with(tokens(&["old", "new"]), |_| {
            asked.set(asked.get() + 1);
            Err(Refusal::Unauthorized)
        });
        assert_eq!(answer, Err(Fault::Refused));
        assert_eq!(asked.get(), 2);
    }

    /// A rate limit or a dead network is not the token's doing, and reading
    /// the credentials again would change nothing.
    #[test]
    fn a_refusal_that_is_not_about_the_token_is_not_retried() {
        let asked = Cell::new(0);
        let answer = usage_with(tokens(&["t"]), |_| {
            asked.set(asked.get() + 1);
            Err(Refusal::Other("Rate limited".into()))
        });
        assert_eq!(answer, Err(Fault::Other("Rate limited".into())));
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn a_lapsed_token_that_cannot_be_renewed_never_reaches_the_endpoint() {
        let asked = Cell::new(0);
        let answer = usage_with(
            || Err(Fault::NotRenewed(None)),
            |_| {
                asked.set(asked.get() + 1);
                Ok(body())
            },
        );
        assert_eq!(answer, Err(Fault::NotRenewed(None)));
        assert_eq!(asked.get(), 0);
    }

    /// The words name the account the way the switcher does, and the account
    /// to sign in stays the directory name the backend knows it by.
    #[test]
    fn a_signed_out_account_is_reported_by_its_title_with_the_way_to_sign_in() {
        let error = Fault::SignedOut.report("work", "Ops team");
        assert!(error.message.starts_with("Ops team is not signed in."));
        assert_eq!(error.sign_in.as_deref(), Some("work"));
    }

    /// The one that used to send people through the browser: a token that
    /// could not be renewed just now is not a sign-in that has ended.
    #[test]
    fn a_renewal_that_did_not_help_is_not_reported_as_a_sign_in_to_redo() {
        let error = Fault::NotRenewed(Some("timed out".into())).report("work", "Ops team");
        assert_eq!(error.sign_in, None);
        assert!(error
            .message
            .starts_with("Could not renew the sign-in for Ops team (timed out)."));
        let error = Fault::NotRenewed(None).report("work", "Ops team");
        assert!(error
            .message
            .starts_with("Could not renew the sign-in for Ops team."));
    }

    /// The panel's own timer is minutes away, and a laptop that woke without
    /// a network has one long before that. Only this fault clears by itself.
    #[test]
    fn only_a_renewal_that_did_not_help_asks_to_be_tried_again_soon() {
        let retry = |fault: Fault| fault.report("work", "Ops team").retry_ms;
        assert_eq!(
            retry(Fault::NotRenewed(None)),
            Some(crate::renew::RETRY_AFTER_MS)
        );
        assert_eq!(retry(Fault::SignedOut), None);
        assert_eq!(retry(Fault::Refused), None);
        assert_eq!(retry(Fault::Other("Rate limited".into())), None);
    }

    #[test]
    fn a_refused_token_offers_the_sign_in_without_asserting_it() {
        let error = Fault::Refused.report("work", "Ops team");
        assert_eq!(error.sign_in.as_deref(), Some("work"));
        assert!(error.message.contains("refused the token for Ops team"));
        assert!(error
            .message
            .contains("If sessions on this account fail too"));
    }

    #[test]
    fn anything_else_is_reported_as_it_is_with_no_sign_in() {
        let error = Fault::Other("Rate limited".into()).report("work", "Ops team");
        assert_eq!(
            error,
            UsageError {
                message: "Rate limited".into(),
                sign_in: None,
                retry_ms: None
            }
        );
    }

    /// `main` runs with no `CLAUDE_CONFIG_DIR` and writes the bare item; any
    /// other account's item carries eight hex digits of its directory's
    /// SHA-256, which is what keeps one account from reading another's.
    #[test]
    fn each_account_has_its_own_keychain_item() {
        assert_eq!(keychain_service(None), "Claude Code-credentials");
        assert_eq!(
            keychain_service(Some(Path::new("/Users/someone/.claude-accounts/work"))),
            "Claude Code-credentials-ce42d15f"
        );
        assert_eq!(
            keychain_service(Some(Path::new("/home/someone/.claude-accounts/client-2_b"))),
            "Claude Code-credentials-db2af664"
        );
    }

    #[test]
    fn usage_errors_reach_the_panel_as_message_and_account() {
        let value = serde_json::to_value(Fault::Refused.report("work", "Ops")).unwrap();
        assert_eq!(value["signIn"], "work");
        assert!(value["message"].is_string());
        let value = serde_json::to_value(Fault::Other("Rate limited".into()).report("work", "Ops"))
            .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "message": "Rate limited", "signIn": null, "retryMs": null })
        );
    }

    #[test]
    fn usage_windows_come_out_of_the_endpoint_body() {
        let body = serde_json::json!({
            "five_hour": { "utilization": 33.6, "resets_at": "2026-01-01T00:00:00Z" },
            "seven_day": { "utilization": 42.0 },
            "seven_day_opus": null,
            "limits": [
                { "scope": { "model": { "display_name": "Fable" } }, "percent": 12.4 },
                { "scope": {}, "percent": 50.0 }
            ],
            "extra_usage": { "is_enabled": true, "utilization": 7.5 }
        });
        let usage = usage_of(&body);
        assert_eq!(usage.five_hour.as_ref().map(|w| w.percent), Some(34));
        assert_eq!(
            usage.five_hour.and_then(|w| w.resets_at).as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(usage.seven_day.map(|w| w.percent), Some(42));
        assert!(usage.seven_day_opus.is_none());
        assert_eq!(usage.model_windows.len(), 1);
        assert_eq!(usage.model_windows[0].model, "Fable");
        assert_eq!(usage.extra_percent, Some(8));
    }

    /// Asks the real endpoint for the account in effect, renewing its token
    /// first if it has lapsed, so it needs a signed-in account and a network.
    /// Prints the windows and never the token.
    /// `cargo test reads_the_real_usage -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_the_real_usage() {
        let name = crate::account::current_name();
        let started = std::time::Instant::now();
        let usage = fetch_usage().expect("usage for the account in effect");
        eprintln!(
            "{name}: 5h {:?}%, 7d {:?}% in {:?}",
            usage.five_hour.map(|w| w.percent),
            usage.seven_day.map(|w| w.percent),
            started.elapsed()
        );
    }
}
