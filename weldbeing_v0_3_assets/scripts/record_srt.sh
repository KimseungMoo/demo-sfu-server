#!/bin/bash
set -e
ROOT=${RECORDINGS_ROOT:-/recordings}
LIST=/scripts/srt_streams.txt
mkdir -p "$ROOT"
echo "[recorder] starting. reading $LIST"
date
while read NAME; do
  [ -z "$NAME" ] && continue
  OUT="$ROOT/${NAME}_$(date +%Y%m%d_%H%M%S).mp4"
  echo "[recorder] subscribing $NAME -> $OUT"
  ffmpeg -loglevel error -stats     -i "srt://sls:10085?mode=caller&streamid=live/${NAME}"     -c copy -movflags +faststart     "$OUT" < /dev/null &
done < "$LIST"
wait
