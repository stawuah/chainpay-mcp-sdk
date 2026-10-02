#!/bin/zsh
# finish.sh <id> <version>: raw/<id>-v<N>.mp4 → final/<id>.mp4 (H.264, yuv420p, faststart, silent). x-header is center-cropped to 3:1, 1500x500.
R="$HOME/Desktop/ChainPay Social/motion"; mkdir -p "$R/final"
id=$1; v=$2; in="$R/raw/$id-v$v.mp4"; out="$R/final/$id.mp4"
vf="scale=trunc(iw/2)*2:trunc(ih/2)*2"
[[ $id == x-header ]] && vf="crop=iw:trunc(iw/3/2)*2:0:(ih-iw/3)/2,scale=1500:500"
ffmpeg -v error -y -i "$in" -vf "$vf,format=yuv420p" -c:v libx264 -preset slow -crf 18 -an -movflags +faststart "$out" && \
  echo "✓ $id $(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$out") $(du -h "$out" | cut -f1)"
