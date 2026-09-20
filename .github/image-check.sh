#!/bin/sh
# What the production image must be able to do, checked inside the image itself. Lives in a file rather than inline in
# the workflow because every one of these needs quoting that YAML and shell disagree about, and the two times this was
# written inline it was the check that broke, not the thing being checked.
set -eu

echo "== Bengali draws, rather than drawing boxes =="
fc-list :lang=bn family | head -3
ass() {
  printf '[Script Info]\nScriptType: v4.00+\nPlayResX: 900\nPlayResY: 200\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: H,%s,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,20,20,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,H,,0,0,0,,সিলেটে বন্যা পরিস্থিতির অবনতি\n' "$1" > "$2"
}
ass 'Noto Sans Bengali' /tmp/good.ass
ass 'A Font That Is Not Installed Anywhere' /tmp/bad.ass
for n in good bad; do
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i color=c=black:s=900x200:d=1 \
    -vf "ass=filename=/tmp/$n.ass:shaping=complex:fontsdir=/usr/share/fonts/truetype/noto" -frames:v 1 "/tmp/$n.png"
done
ls -la /tmp/good.png /tmp/bad.png
# Boxes and glyphs are different pictures. If naming the font changes nothing about the output, the name never
# resolved and what is on the card is .notdef — which is exactly what reached production while the old check, which
# only asked whether a PNG had been written, went on passing.
if cmp -s /tmp/good.png /tmp/bad.png; then
  echo "FAIL: Bengali renders identically with a real font and a made-up one — it is drawing boxes"
  exit 1
fi
echo "ok: Bengali draws with its own font"

echo "== piper speaks =="
printf '%s' 'The engine speaks for itself, which is the only claim worth testing here.' \
  | piper --model /opt/piper/voices/en_US-lessac-medium.onnx --output_file /tmp/en.wav
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/en.wav)
echo "narration: ${dur}s"
awk -v d="$dur" 'BEGIN { exit (d > 1.5 ? 0 : 1) }'
echo "ok: piper produced ${dur}s of speech"

echo "== whisper.cpp hears it back =="
printf '%s' 'The quick brown fox jumps over the lazy dog near the river bank.' \
  | piper --model /opt/piper/voices/en_US-lessac-medium.onnx --output_file /tmp/say.wav
ffmpeg -hide_banner -loglevel error -y -i /tmp/say.wav -ar 16000 -ac 1 -c:a pcm_s16le /tmp/in.wav
whisper-cli -m /opt/whisper/ggml-base.bin -f /tmp/in.wav -oj -of /tmp/out -nt -l en
cat /tmp/out.json
grep -qi 'fox' /tmp/out.json
echo "ok: the word survived the round trip"
