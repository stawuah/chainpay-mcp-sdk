#!/usr/bin/env bash
# Hero lane assets → frontend/public/landing/. Ruling: _bmad-output/design-council/landing-brand-ruling-2026-10-04.md
# Steps, in order, as shipped on 2026-10-04:
#   1. node gen.mjs still 2                  → raw/hero-still-v2.png chosen
#   2. finish.sh recompose                   → raw/hero-still-v2-shifted.png (tray inside x 12.9%–77.2%, pet quiet zone)
#   3. node gen.mjs video ../raw/hero-still-v2-shifted.png 3 → raw/hero-video-v1.mp4 chosen
#   4. finish.sh encode                      → hero-boundary.mp4 + hero-boundary-poster.webp
set -euo pipefail
cd "$(dirname "$0")/../raw"
OUT=../../../frontend/public/landing; mkdir -p "$OUT"
case "${1:-}" in
  recompose)
    # Scale to 95% and shift left on the flat field so the right 22% of the lane stays empty.
    magick -size 2736x1536 "xc:srgb(229,238,253)" \( hero-still-v2.png -resize 95% \) -geometry -88+38 -composite hero-still-v2-shifted.png ;;
  encode)
    # Seedance brightens the first 4 and last 7 frames toward the keyframe; loop the steady 4–184 instead
    # (both ends sit in the script's holds). Crop the centre 16:5 band, grade the field back to #e6eefd.
    ffmpeg -v error -y -i hero-video-v1.mp4 \
      -vf "select=between(n\,4\,184),setpts=N/24/TB,crop=1280:400:0:160,colorchannelmixer=rr=1.090:gg=1.102:bb=1.100,format=yuv420p" \
      -r 24 -c:v libx264 -profile:v high -preset veryslow -crf 19 -an -movflags +faststart "$OUT/hero-boundary.mp4"
    # Poster = frame 0 of the final encode, so playback starts without a colour jump.
    ffmpeg -v error -y -i "$OUT/hero-boundary.mp4" -vf "select=eq(n\,0)" -frames:v 1 /tmp/hero-poster.png
    magick /tmp/hero-poster.png -quality 82 "$OUT/hero-boundary-poster.webp" && rm /tmp/hero-poster.png ;;
  *) echo "usage: finish.sh recompose|encode" >&2; exit 1 ;;
esac
