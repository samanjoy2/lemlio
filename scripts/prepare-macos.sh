#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
resources="$root/apps/desktop/src-tauri/resources/tectonic"
mkdir -p "$resources/fonts"
case "$(uname -m)" in
  arm64) target=aarch64-apple-darwin; checksum=a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667 ;;
  x86_64) target=x86_64-apple-darwin; checksum=7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80 ;;
  *) echo 'Unsupported macOS architecture' >&2; exit 1 ;;
esac
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
curl --fail --location --retry 3 "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-$target.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$resources"
chmod +x "$resources/tectonic"
if otool -L "$resources/tectonic" | grep -E '/opt/homebrew/|/usr/local/'; then
  echo 'Tectonic must not depend on an external Homebrew installation.' >&2; exit 1
fi
curl --fail --location --retry 3 https://mirrors.ctan.org/fonts/lm.zip -o "$archive"
printf '%s  %s\n' 71c48809cb50fbfe09c8eddaa251398957c7b243acdf69f7f807268f0d42c939 "$archive" | shasum -a 256 -c -
python3 - "$archive" "$resources/fonts" <<'PY'
import sys, zipfile
from pathlib import Path
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        if name.endswith(('.otf', 'GUST-FONT-LICENSE.TXT', 'README-Latin-Modern.TXT', 'MANIFEST-Latin-Modern.TXT')):
            (Path(sys.argv[2])/Path(name).name).write_bytes(archive.read(name))
PY
echo 'Packaged macOS Tectonic and Latin Modern fonts are ready.'
