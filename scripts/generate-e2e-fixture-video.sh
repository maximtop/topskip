#!/usr/bin/env bash
# Regenerate extension/e2e/fixtures/skip-test.mp4 — 120s silent black video (~3–4 KiB), enough for 30s→60s skip tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/extension/e2e/fixtures/skip-test.mp4"
ffmpeg -y \
  -f lavfi -i "color=c=black:s=256x144:r=1:d=120" \
  -an \
  -c:v libx264 -pix_fmt yuv420p -tune stillimage -preset ultrafast -crf 38 \
  -movflags +faststart \
  "$OUT"
ls -lh "$OUT"
