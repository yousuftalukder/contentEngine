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
# Both builds are exercised, because the runner's CPU has AVX2 and some of Render's may not: this proves each
# binary exists and works, not that either one is safe on a machine this check never runs on.
for b in whisper-cli-base whisper-cli-avx2; do
  echo "-- $b"
  "$b" -m /opt/whisper/ggml-tiny.bin -f /tmp/in.wav -oj -of "/tmp/out-$b" -nt -l en
  grep -qi 'fox' "/tmp/out-$b.json" || { echo "FAIL: $b did not hear the word"; exit 1; }
done
whisper-cli -m /opt/whisper/ggml-base.bin -f /tmp/in.wav -oj -of /tmp/out -nt -l en
cat /tmp/out.json
grep -qi 'fox' /tmp/out.json
echo "ok: the word survived the round trip, on both builds"

echo "== edge-tts speaks Bangla =="
# Proves the install inside the image and that a Bangla voice produces real speech. It proves nothing about whether
# Microsoft answers Render's address — that is checked from production with POST /api/voices/test.
printf '%s' 'সোনারগাঁয়ে মেঘনা নদীতে আজ দুপুরে একটি নৌকাডুবির ঘটনা ঘটেছে।' > /tmp/bn.txt
edge-tts --voice bn-BD-NabanitaNeural --file /tmp/bn.txt --write-media /tmp/bn.mp3
bndur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/bn.mp3)
echo "bangla narration: ${bndur}s"
awk -v d="$bndur" 'BEGIN { exit (d > 2 ? 0 : 1) }'
echo "ok: edge-tts produced ${bndur}s of Bangla speech"

echo "== two pictures at different frame rates combine on this ffmpeg =="
# Debian's ffmpeg 5.1 never finishes a vstack of a 30 fps source and a 24 fps phone clip — a reaction render on Render
# sat at it until its 30-minute timeout. The engine brings both to 30 fps first; this is that filter shape, on this
# image's ffmpeg, with a deadline. Without the two fps filters it hangs here exactly as it did in production.
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=6" -f lavfi -i "testsrc2=size=360x640:rate=24:duration=3" -map 0 -t 6 /tmp/src.mp4 -map 1 -t 3 /tmp/host.mp4
timeout 120 ffmpeg -hide_banner -loglevel error -y -i /tmp/src.mp4 -stream_loop -1 -i /tmp/host.mp4 \
  -filter_complex "[0:v]setpts=PTS/1.1,fps=30,scale=360:320:force_original_aspect_ratio=decrease,pad=360:320:(ow-iw)/2:(oh-ih)/2,setsar=1[m];[1:v]fps=30,scale=360:320:force_original_aspect_ratio=decrease,pad=360:320:(ow-iw)/2:(oh-ih)/2,setsar=1[o];[m][o]vstack=inputs=2:shortest=1[v]" \
  -map "[v]" -t 5 -c:v libx264 -preset ultrafast /tmp/stack.mp4 || { echo "FAIL: the reaction stack did not finish on this ffmpeg"; exit 1; }
sdur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/stack.mp4)
echo "ok: stacked ${sdur}s from a 30 fps source and a 24 fps clip"

echo "== the brand pass levels the sound on this ffmpeg =="
# The last pass on every footage video: loudness to -14 LUFS at 48 kHz. On this image's ffmpeg (5.1) the chain failed
# outright without the closing aformat ("Cannot select channel layout"), and the engine fell back to the unbranded,
# unlevelled file on every video it rendered.
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=300:duration=4" -f lavfi -i "color=c=black:s=320x240:d=4" -ac 2 -shortest /tmp/plain.mp4
ffmpeg -hide_banner -loglevel error -y -i /tmp/plain.mp4 -filter_complex "[0:v]null[v];[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset ultrafast -c:a aac /tmp/finished.mp4 || { echo "FAIL: the brand pass audio chain is refused by this ffmpeg"; exit 1; }
rate=$(ffprobe -v error -select_streams a -show_entries stream=sample_rate -of csv=p=0 /tmp/finished.mp4)
[ "$rate" = "48000" ] || { echo "FAIL: finished audio is ${rate} Hz"; exit 1; }
echo "ok: the brand pass ran and wrote ${rate} Hz audio"

echo "== the 4b voice-over ducks the clip under the voice on this ffmpeg =="
# The summary voice-over drives the clip's own sound down with the voice (sidechaincompress), the voice padded so the
# clip does not go silent when it ends. A new filter shape: run here, on the image's own ffmpeg, under a deadline.
timeout 120 ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=330:duration=8" -f lavfi -i "sine=frequency=1000:duration=2" -filter_complex \
  "[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[src];[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asplit=2[vo][k];[k]apad[key];[src][key]sidechaincompress=threshold=0.015:ratio=12:attack=20:release=400[duck];[duck][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]" \
  -map "[a]" /tmp/ducked.wav
ddur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/ducked.wav)
awk -v d="$ddur" 'BEGIN { exit (d > 7.5 ? 0 : 1) }' || { echo "FAIL: the ducked mix is ${ddur}s, not the clip's 8s — the clip went silent with the voice"; exit 1; }
echo "ok: the voice-over mix ran and kept the whole ${ddur}s"
