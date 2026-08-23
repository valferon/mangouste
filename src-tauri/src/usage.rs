//! Claude subscription usage — the same data the `/usage` command shows.
//!
//! Reads the user's own OAuth access token from `~/.claude/.credentials.json`
//! and calls Anthropic's usage endpoint with it. The token is read at call time,
//! used only as a request header, and never logged, cached, or returned to the
//! frontend.
//!
//! Off unless the frontend asks: nothing here touches the token or the network
//! until `fetch_usage` is actually invoked.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read the Claude Code OAuth access token from the local credentials file.
///
/// Returns the token by value so the caller can hand it straight to the request
/// builder; it is never stored anywhere else.
fn read_access_token() -> Result<String, String> {
    let path = dirs::home_dir()
        .ok_or("no home directory")?
        .join(".claude")
        .join(".credentials.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read credentials: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("credentials not valid JSON: {e}"))?;

    let oauth = parsed
        .get("claudeAiOauth")
        .ok_or("no Claude OAuth entry in credentials; sign in with the CLI first")?;

    // Warn rather than fail on an expired token: the endpoint is authoritative.
    if let Some(expires_at) = oauth.get("expiresAt").and_then(|v| v.as_i64()) {
        let expires_ms = if expires_at < 1_000_000_000_000 {
            expires_at * 1000
        } else {
            expires_at
        };
        if (expires_ms as u64) < now_ms() {
            return Err("OAuth token expired; open Claude Code to re-authenticate".into());
        }
    }

    oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no access token in credentials".into())
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

/// Fetch current usage. Invoked only when the user opens the usage panel.
/// `async`: the request blocks for up to 15s, which must not hold the main thread.
#[tauri::command(async)]
pub fn fetch_usage() -> Result<ClaudeUsage, String> {
    let token = read_access_token()?;

    let response = ureq::get(USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", OAUTH_BETA)
        .timeout(std::time::Duration::from_secs(15))
        .call();

    let body: serde_json::Value = match response {
        Ok(ok) => ok
            .into_json()
            .map_err(|e| format!("usage response not JSON: {e}"))?,
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
            return Err("Unauthorized — open Claude Code to re-authenticate".into());
        }
        Err(ureq::Error::Status(429, _)) => {
            return Err("Rate limited by Anthropic; try again later".into());
        }
        Err(ureq::Error::Status(code, _)) => return Err(format!("usage request failed: HTTP {code}")),
        Err(e) => return Err(format!("usage request failed: {e}")),
    };

    Ok(ClaudeUsage {
        five_hour: window_of(&body, "five_hour"),
        seven_day: window_of(&body, "seven_day"),
        seven_day_sonnet: window_of(&body, "seven_day_sonnet"),
        seven_day_opus: window_of(&body, "seven_day_opus"),
        model_windows: model_windows_of(&body),
        extra_percent: body
            .get("extra_usage")
            .filter(|e| e.get("is_enabled").and_then(|v| v.as_bool()) == Some(true))
            .and_then(|e| e.get("utilization"))
            .and_then(|v| v.as_f64())
            .map(|v| v.round().max(0.0) as u32),
        fetched_at_ms: now_ms(),
    })
}
