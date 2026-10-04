// Stands in for whisper.cpp in the tests: the same arguments and the same JSON out, with no model and no CPU time.
// It writes down how it was called, so a test can check the flags the engine passes — the one that matters being
// whether timestamps were asked for, since without them whisper returns a block per 30 seconds and no timing inside.
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
if (process.env.FAKE_WHISPER_LOG) appendFileSync(process.env.FAKE_WHISPER_LOG, JSON.stringify(args) + "\n");
const noTimestamps = args.includes("-nt") || args.includes("--no-timestamps");
const lines = [
  [0, 6.2, "The ferry service at Paturia stopped on Sunday after the river rose."],
  [6.2, 13.8, "By Wednesday the channel had been dredged and the first vehicles crossed at dawn."],
  [13.8, 21.5, "Drivers who had waited three days said the queue stretched for four kilometres."],
  [21.5, 29.0, "The authority says two more dredgers will keep the channel open through the monsoon."],
  [29.0, 37.4, "Traders say vegetable prices in Dhaka rose by a third while the crossing was closed."],
  [37.4, 45.0, "Nobody can say yet whether the channel will hold when the next flood comes. (audience cheering)"],
  [45.0, 52.0, "[BLANK_AUDIO]"],
];
// What whisper does with -nt: one segment per 30-second window, the text of the window run together.
const out = noTimestamps
  ? [[0, 30, lines.filter(([s]) => s < 30).map((l) => l[2]).join(" ")], [30, 45, lines.filter(([s]) => s >= 30).map((l) => l[2]).join(" ")]]
  : lines;
writeFileSync(`${get("-of")}.json`, JSON.stringify({ transcription: out.map(([s, e, text]) => ({ offsets: { from: Math.round(s * 1000), to: Math.round(e * 1000) }, text })) }));
