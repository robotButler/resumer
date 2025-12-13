#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-robotButler/resumer}"
PREFIX="${PREFIX:-$HOME/.local}"
BINDIR="${BINDIR:-$PREFIX/bin}"
NAME="${NAME:-res}"
VERSION="${VERSION:-latest}" # tag like v0.1.0, or "latest"

usage() {
  cat <<EOF
Install resumer ("res") from GitHub Releases.

Env vars:
  REPO     GitHub repo (default: $REPO)
  VERSION  Tag like v0.1.0, or "latest" (default: $VERSION)
  BINDIR   Install directory (default: $BINDIR)
  NAME     Installed binary name (default: $NAME)

Examples:
  curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
  VERSION=v0.1.0 curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
  BINDIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sudo bash
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

need uname
need mktemp
need curl

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$os" in
  linux) os="linux" ;;
  darwin) os="macos" ;;
  *)
    echo "Unsupported OS: $os" >&2
    exit 1
    ;;
esac

case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *)
    echo "Unsupported arch: $arch" >&2
    exit 1
    ;;
esac

asset="res-${os}-${arch}"

api="https://api.github.com/repos/${REPO}/releases/${VERSION}"
if [[ "$VERSION" == "latest" ]]; then
  api="https://api.github.com/repos/${REPO}/releases/latest"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

json="$tmp/release.json"
curl -fsSL "$api" -o "$json"

download_url=""
if command -v python3 >/dev/null 2>&1; then
  download_url="$(
    python3 - <<PY
import json
import sys

with open("${json}", "r", encoding="utf-8") as f:
    data = json.load(f)

assets = data.get("assets") or []
want = "${asset}"
for a in assets:
    if a.get("name") == want:
        print(a.get("browser_download_url") or "")
        break
PY
  )"
else
  # Fallback: very small JSON "parse" that assumes the download_url appears near the name.
  download_url="$(grep -A2 "\"name\": \"${asset}\"" "$json" | grep -m1 "browser_download_url" | sed -E 's/.*\"browser_download_url\": \"([^\"]+)\".*/\\1/')"
fi

if [[ -z "$download_url" ]]; then
  echo "Could not find asset '${asset}' in ${REPO} release (${VERSION})." >&2
  echo "If you're installing from source instead, run: ./scripts/install-local.sh" >&2
  exit 1
fi

mkdir -p "$BINDIR"
out="$tmp/$asset"
curl -fL "$download_url" -o "$out"
chmod +x "$out"
install -m 755 "$out" "$BINDIR/$NAME"

echo "Installed: $BINDIR/$NAME"
echo "Try: $NAME --help"
