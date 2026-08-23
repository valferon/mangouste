#!/usr/bin/env bash
# Rewrite the Depends line of a Tauri-built .deb.
#
# Tauri appends its own hardcoded list, which still names the pre-t64
# `libgtk-3-0`. That package has no candidate on Ubuntu 24.04, so the generated
# .deb refuses to install. Anything set in tauri.conf.json is added *before*
# Tauri's entries rather than replacing them, so the bad name can only be
# removed after the fact.
set -euo pipefail

DEB="${1:?usage: fix-deb-depends.sh <path-to-deb>}"
DEPENDS="${DEPENDS:-libwebkit2gtk-4.1-0, libgtk-3-0t64 | libgtk-3-0, libayatana-appindicator3-1, librsvg2-2}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

dpkg-deb -R "$DEB" "$WORK"

# Python rather than sed: the alternation in DEPENDS contains "|", which
# collides with any convenient sed delimiter.
DEPENDS="$DEPENDS" python3 - "$WORK/DEBIAN/control" <<'PY'
import os, sys, pathlib
control = pathlib.Path(sys.argv[1])
lines = control.read_text().splitlines()
out = [f"Depends: {os.environ['DEPENDS']}" if l.startswith("Depends:") else l for l in lines]
control.write_text("\n".join(out) + "\n")
PY

dpkg-deb --build --root-owner-group "$WORK" "$DEB" >/dev/null
echo "Depends: $(dpkg -I "$DEB" | awk -F': ' '/^ Depends:/{print $2}')"
