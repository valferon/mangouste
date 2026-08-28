//! "There is a newer mangouste" — read from the project's own GitHub releases.
//!
//! Deliberately a notice and not an installer. The app ships as a `.deb`, an
//! AppImage and a `.dmg`, and only two of those can be replaced in place by a
//! process running out of them; a self-updater that silently does nothing for
//! everyone on the third is worse than a link that works for all three. So this
//! answers one question — is there a newer tag, and what changed in it — and
//! hands the release page to the browser for the rest.
//!
//! The webview cannot reach api.github.com at all: the CSP in `tauri.conf.json`
//! allows `'self'` and the IPC origin, nothing else. That is on purpose, and it
//! is why the request lives here rather than in a `fetch` in the frontend.
//!
//! Nothing is sent. No token, no identifier, no version — an unauthenticated
//! GET of a public endpoint, and the only thing GitHub learns is that an IP
//! asked. Off unless the frontend invokes it, and the frontend's own preference
//! gate decides whether it ever does.

use serde::Serialize;

const REPO: &str = "valferon/mangouste";

/// Anonymous GitHub allows 60 requests an hour per IP. A check on launch and
/// one every six hours after is two of them; the ceiling is only reachable by
/// something else on the same address, which is why 403 has its own message.
fn latest_url() -> String {
    format!("https://api.github.com/repos/{REPO}/releases/latest")
}

/// One specific tag, for "what's new in the version you just started".
///
/// The running build's own notes are not on disk anywhere — the bundle carries
/// no changelog — so the same endpoint answers both questions.
fn tag_url(tag: &str) -> String {
    format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}")
}

/// A published release, reduced to what the sheet renders.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The tag with its `v` stripped, so it compares against `getVersion()`.
    pub version: String,
    /// The tag exactly as GitHub has it, for a link or a second lookup.
    pub tag: String,
    /// The release title. Falls back to the tag when a release has none.
    pub name: String,
    /// The release body, verbatim markdown. Empty when the notes are blank.
    pub notes: String,
    /// The release page, which is where the downloads are.
    pub url: String,
    /// ISO 8601, or `None` on a release GitHub has not published.
    pub published_at: Option<String>,
    /// Marked as a pre-release upstream. `latest` never is; a tag lookup can be.
    pub prerelease: bool,
}

/// Reduce one release object. `None` when the payload is not one.
///
/// `tag_name` is the only field worth refusing over: a release with no tag is
/// not something a version can be compared against, and everything else here
/// has a sane empty value.
fn release_of(raw: &serde_json::Value) -> Option<Release> {
    let tag = raw.get("tag_name")?.as_str()?.trim().to_string();
    if tag.is_empty() {
        return None;
    }
    let version = tag.strip_prefix('v').unwrap_or(&tag).to_string();
    let text = |key: &str| {
        raw.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let name = match text("name") {
        empty if empty.is_empty() => tag.clone(),
        named => named,
    };
    Some(Release {
        version,
        name,
        notes: text("body"),
        url: match text("html_url") {
            empty if empty.is_empty() => format!("https://github.com/{REPO}/releases/tag/{tag}"),
            link => link,
        },
        published_at: raw
            .get("published_at")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        prerelease: raw
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        tag,
    })
}

/// Ask GitHub for a release. `tag` names one; `None` is whatever is latest.
///
/// `async`: a request on a tethered connection can sit for the whole timeout,
/// and the main thread is drawing.
///
/// The releases this project cuts start as drafts, and `/releases/latest`
/// skips drafts — so a tag that exists but has not been published yet reads as
/// 404 here, which is the right answer. Nobody should be told to download
/// something that is not downloadable.
#[tauri::command(async)]
pub fn fetch_release(tag: Option<String>) -> Result<Option<Release>, String> {
    let url = match tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(tag) => tag_url(tag),
        None => latest_url(),
    };

    let response = ureq::get(&url)
        .set("Accept", "application/vnd.github+json")
        // GitHub answers a request with no User-Agent with a 403 and a lecture.
        .set(
            "User-Agent",
            concat!("mangouste/", env!("CARGO_PKG_VERSION")),
        )
        .timeout(std::time::Duration::from_secs(15))
        .call();

    let body: serde_json::Value = match response {
        Ok(ok) => ok
            .into_json()
            .map_err(|e| format!("release response not JSON: {e}"))?,
        // No published release yet, or no such tag. Not an error to show anyone:
        // "nothing to report" is a legitimate answer to "is there an update".
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(ureq::Error::Status(403, _)) | Err(ureq::Error::Status(429, _)) => {
            return Err("GitHub rate-limited the update check; it will try again later".into())
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("update check failed: HTTP {code}"))
        }
        Err(e) => return Err(format!("update check failed: {e}")),
    };

    Ok(release_of(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_the_v_so_the_version_compares_against_the_bundle() {
        let release = release_of(&json!({"tag_name": "v0.2.0", "name": "0.2.0"})).unwrap();
        assert_eq!(release.version, "0.2.0");
        assert_eq!(release.tag, "v0.2.0");
    }

    #[test]
    fn keeps_a_tag_that_never_had_a_v() {
        let release = release_of(&json!({"tag_name": "2026.8"})).unwrap();
        assert_eq!(release.version, "2026.8");
        assert_eq!(release.tag, "2026.8");
    }

    #[test]
    fn falls_back_to_the_tag_when_a_release_was_given_no_title() {
        let release = release_of(&json!({"tag_name": "v0.2.0", "name": ""})).unwrap();
        assert_eq!(release.name, "v0.2.0");
    }

    #[test]
    fn builds_a_release_page_url_when_the_payload_omits_one() {
        let release = release_of(&json!({"tag_name": "v0.2.0"})).unwrap();
        assert_eq!(
            release.url,
            "https://github.com/valferon/mangouste/releases/tag/v0.2.0"
        );
    }

    #[test]
    fn carries_the_notes_verbatim_because_the_sheet_renders_them_as_markdown() {
        let release =
            release_of(&json!({"tag_name": "v0.2.0", "body": "## Fixed\n\n- a thing\n"})).unwrap();
        assert_eq!(release.notes, "## Fixed\n\n- a thing");
    }

    #[test]
    fn refuses_a_payload_that_is_not_a_release() {
        assert!(release_of(&json!({"message": "Not Found"})).is_none());
        assert!(release_of(&json!({"tag_name": "   "})).is_none());
        assert!(release_of(&json!([])).is_none());
    }
}
