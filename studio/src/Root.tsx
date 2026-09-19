import React from "react";
import { Composition } from "remotion";
import { NewsReel, ReelProps, reelDuration } from "./NewsReel";
import { Explainer, ExplainerProps, explainerDuration } from "./Explainer";

// Sample props so `npm run studio` previews without the engine. Pictures are inline SVG gradients.
const pic = (a: string, b: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#g)"/></svg>`)}`;
const brand = { name: "Dhaka Pulse", primary: "#0b3d91", accent: "#ffb300", text: "#ffffff", handle: "fb.com/dhakapulse" };
const words = (s: string, dur: number) => { const w = s.split(" "); return w.map((t, i) => ({ text: t, from: Math.round((i * dur) / w.length), to: Math.round(((i + 1) * dur) / w.length) })); };
const sampleReel: ReelProps = {
  lang: "bn", brand, headline: "সিলেটে বন্যা পরিস্থিতির অবনতি, লাখো মানুষ পানিবন্দী", kicker: "ব্রেকিং", credit: "সূত্র: প্রথম আলো, বিবিসি বাংলা", outroFrames: 60,
  sections: [
    { image: pic("#1d3b72", "#6a8fd6"), durationInFrames: 120, narration: "সুরমা ও কুশিয়ারা নদীর পানি বিপৎসীমার ওপর দিয়ে বইছে", words: words("সুরমা ও কুশিয়ারা নদীর পানি বিপৎসীমার ওপর দিয়ে বইছে", 120) },
    { image: pic("#3a1d72", "#d66a9f"), durationInFrames: 110, narration: "জেলা প্রশাসন আশ্রয়কেন্দ্র খুলেছে", words: words("জেলা প্রশাসন আশ্রয়কেন্দ্র খুলেছে", 110) },
  ],
};
const sampleExplainer: ExplainerProps = {
  lang: "en", brand, title: "How the metro rail works", outroFrames: 60,
  scenes: [
    { layout: "TitleCard", durationInFrames: 90, data: { title: "How Dhaka's metro works", subtitle: "Three parts, one line" }, cues: [0], words: words("How Dhaka's metro works in three parts", 90), chapter: "Intro" },
    { layout: "IconGrid", durationInFrames: 120, data: { heading: "The system", items: [{ icon: "train-front", label: "Trains" }, { icon: "zap", label: "Power" }, { icon: "ticket", label: "Tickets" }] }, cues: [10, 40, 70], words: words("Trains, the power that moves them, and the tickets riders buy", 120), chapter: "Parts", transition: "slide" },
    { layout: "BulletReveal", durationInFrames: 120, data: { heading: "Why it matters", bullets: ["Faster trips", "Less traffic", "Cleaner air"] }, cues: [10, 45, 80], words: words("Faster trips, less traffic and cleaner air", 120) },
    { layout: "DataChart", durationInFrames: 120, data: { heading: "Daily riders", kind: "bar", unit: "k", data: [{ label: "2023", value: 180 }, { label: "2024", value: 320 }, { label: "2025", value: 410 }] }, cues: [10], words: words("Riders more than doubled in two years", 120), transition: "slide" },
    { layout: "Comparison", durationInFrames: 120, data: { heading: "Metro vs bus", left: { title: "Metro", points: ["20 min", "Air-conditioned"] }, right: { title: "Bus", points: ["75 min", "Crowded"] } }, cues: [10, 55], words: words("Twenty minutes by metro against seventy five by bus", 120) },
    { layout: "FullQuote", durationInFrames: 100, data: { quote: "It changed how I get to work.", attribution: "A daily rider" }, cues: [0], words: words("It changed how I get to work", 100) },
  ],
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="NewsReel" component={NewsReel as any} width={1080} height={1920} fps={30} durationInFrames={300} defaultProps={sampleReel as any}
      calculateMetadata={({ props }: any) => ({ durationInFrames: Math.max(30, reelDuration(props)), width: props.width || 1080, height: props.height || 1920, fps: props.fps || 30 })} />
    <Composition id="Explainer" component={Explainer as any} width={1920} height={1080} fps={30} durationInFrames={300} defaultProps={sampleExplainer as any}
      calculateMetadata={({ props }: any) => ({ durationInFrames: Math.max(30, explainerDuration(props)), width: props.width || 1920, height: props.height || 1080, fps: props.fps || 30 })} />
  </>
);
