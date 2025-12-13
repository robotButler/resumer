#!/usr/bin/env bash
set -euo pipefail

prefix="${PREFIX:-$HOME/.local}"
bindir="${BINDIR:-$prefix/bin}"
binary_name="${BINARY_NAME:-res}"

usage() {
  cat <<EOF
Install resumer from source (builds a standalone binary with Bun).

Usage:
  $0 [--prefix <dir>] [--bindir <dir>] [--name <binaryName>]

Defaults:
  --prefix  \$HOME/.local
  --bindir  <prefix>/bin
  --name    res
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="$2"
      bindir="$prefix/bin"
      shift 2
      ;;
    --bindir)
      bindir="$2"
      shift 2
      ;;
    --name)
      binary_name="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required (https://bun.sh/)" >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bun install
bun run typecheck
bun run build

mkdir -p "$bindir"
install -m 755 "./dist/res" "$bindir/$binary_name"

echo "Installed: $bindir/$binary_name"
echo "Try: $binary_name --help"

