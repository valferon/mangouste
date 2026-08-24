#!/usr/bin/env bash
# Install mangouste on macOS, with no ceremony asked of the person running it.
#
# The .dmg is ad-hoc signed and not notarized, which is fine — an ad-hoc
# signature is a valid signature, and every locally built Mac app has one. What
# breaks a download is `com.apple.quarantine`: browsers attach it, Gatekeeper
# then assesses the app, finds no notarization, and the *kernel* refuses to
# execute it ("AppleSystemPolicy: Security policy would not allow process"). The
# icon bounces and nothing ever starts.
#
# curl does not attach that flag. So fetching the image here rather than in a
# browser sidesteps the whole assessment, and the app launches the way a locally
# built one does. Everything else below is bookkeeping.
set -euo pipefail

REPO="${MANGOUSTE_REPO:-valferon/mangouste}"
APP_NAME="mangouste.app"

die() {
	echo "install-macos.sh: $*" >&2
	exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS; on Linux use the .deb or .AppImage"

# Which image to fetch. An explicit URL wins; then a tag argument
# (`install-macos.sh v0.1.7`); otherwise whatever the latest release holds.
#
# The asset name carries the version, so the latest one has to be looked up
# rather than guessed. Parsed with grep and sed on purpose: jq is not on a stock
# Mac, and neither is python3 without the command line tools.
resolve_url() {
	if [ -n "${MANGOUSTE_DMG_URL:-}" ]; then
		printf '%s' "$MANGOUSTE_DMG_URL"
		return
	fi
	local api="https://api.github.com/repos/$REPO/releases/latest"
	case "${1:-}" in
		v*) api="https://api.github.com/repos/$REPO/releases/tags/$1" ;;
	esac
	curl -fsSL "$api" |
		grep -o '"browser_download_url": *"[^"]*_universal\.dmg"' |
		head -1 |
		sed 's/.*"\(https[^"]*\)"/\1/'
}

force=""
[ "${1:-}" = "--force" ] && force=1

url="$(resolve_url "$@")"
[ -n "$url" ] || die "no universal .dmg in that release; check https://github.com/$REPO/releases"

work="$(mktemp -d)"
mount="$work/mnt"
# Detach before cleaning up, or the temp directory cannot be removed and the
# image stays attached to a machine whose install just failed.
cleanup() {
	[ -d "$mount" ] && hdiutil detach "$mount" -quiet 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT

echo "Downloading $(basename "$url")"
curl -fL --progress-bar -o "$work/mangouste.dmg" "$url"

hdiutil attach "$work/mangouste.dmg" -mountpoint "$mount" -nobrowse -readonly -quiet
src="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$src" ] || die "no .app inside the disk image"

# /Applications is group-writable for admin users, so no sudo for most people.
# Anyone else gets ~/Applications, which macOS treats as a real app folder —
# better than demanding a password for a user-space tool.
target_dir="/Applications"
if [ ! -w "$target_dir" ]; then
	target_dir="$HOME/Applications"
	mkdir -p "$target_dir"
	echo "/Applications is not writable; installing to $target_dir"
fi
dest="$target_dir/$APP_NAME"

# Re-running this is how you update, so an install that is already current
# should cost nothing. `|| true` is load-bearing, not defensive noise: on a fresh
# machine `$dest` does not exist, `defaults read` exits 1, and under `set -e` the
# assignment below would end the script — silently, before installing anything.
# An installer that works only for people who already have the app is a real
# failure mode and someone else already found it the hard way.
bundle_version() {
	/usr/bin/defaults read "$1/Contents/Info" CFBundleShortVersionString 2>/dev/null || true
}
new_version="$(bundle_version "$src")"
old_version="$(bundle_version "$dest")"
if [ -z "$force" ] && [ -n "$old_version" ] && [ "$old_version" = "$new_version" ]; then
	echo "mangouste $old_version is already installed. Opening it."
	echo "Pass --force to reinstall anyway."
	open "$dest"
	exit 0
fi

if [ -e "$dest" ]; then
	# A running copy cannot be replaced under itself, and how it goes matters:
	# mangouste kills the `claude` processes it owns from its own exit handler,
	# and a SIGKILL never runs that -- it orphans them instead, still burning
	# tokens with no window attached. So: ask, then insist, then force, in that
	# order, and only force what will not go.
	running() { pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1; }
	if running; then
		echo "Quitting the running copy"
		osascript -e 'quit app "mangouste"' >/dev/null 2>&1 || true
		for _ in $(seq 1 10); do running || break; sleep 1; done
		if running; then
			echo "  still up; sending SIGTERM"
			pkill -TERM -f "$dest/Contents/MacOS/" 2>/dev/null || true
			for _ in 1 2 3; do running || break; sleep 1; done
		fi
		if running; then
			echo "  unresponsive; force-quitting"
			pkill -KILL -f "$dest/Contents/MacOS/" 2>/dev/null || true
		fi
	fi
	echo "Replacing $dest"
	rm -rf "$dest"
fi

echo "Installing to $dest"
cp -R "$src" "$dest"

# Belt and braces: curl attached no quarantine, but an image built elsewhere can
# carry attributes of its own, and one flag on one file is enough to be refused.
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

# A copy this machine has already refused stays refused: Gatekeeper caches its
# verdict against the binary's cdhash, and clearing the flag afterwards does not
# reopen a decision already made. Re-signing changes the hash, which retires the
# cached answer. Only ever applied to an ad-hoc signature — re-signing a
# Developer ID build would strip its notarization ticket, which is the opposite
# of helping.
if codesign -dv "$dest" 2>&1 | grep -q '^Signature=adhoc'; then
	codesign --force --deep --sign - "$dest" >/dev/null 2>&1 || true
fi

if ! codesign -v --deep --strict "$dest" 2>/dev/null; then
	die "the installed copy does not verify; delete $dest and re-run"
fi

echo "Installed. Opening."
open "$dest"

cat <<TXT

mangouste is in $target_dir.

  claude must be installed and signed in for chat panes to work.
  If a session's usage figures ask for keychain access, that is the CLI's own
  OAuth token being read; answering "Always Allow" makes it silent.

  If the window never appears, this says where startup stopped:
    MANGOUSTE_TRACE_STARTUP=1 $dest/Contents/MacOS/mangouste
TXT
