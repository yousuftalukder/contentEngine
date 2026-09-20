// Building blocks shared by the compositions: karaoke captions, Ken Burns stills, brand bar, headline strip, outro card.
import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Brand, Word, src, MOTION, shade, isBangla } from "./theme";

// A few words at a time, the spoken word in the accent colour — the karaoke style short-form viewers expect.
export const Captions: React.FC<{ words: Word[]; brand: Brand; perChunk: number; fontSize: number; bottom: number }> = ({ words, brand, perChunk, fontSize, bottom }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  if (!words?.length) return null;
  const chunks: Word[][] = []; for (let i = 0; i < words.length; i += perChunk) chunks.push(words.slice(i, i + perChunk));
  const chunk = chunks.find((c, i) => frame >= c[0].from && frame < (chunks[i + 1]?.[0].from ?? c[c.length - 1].to + 8));
  if (!chunk) return null;
  const pop = spring({ frame: frame - chunk[0].from, fps, config: { damping: 200 }, durationInFrames: 7 });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: bottom }}>
      <div style={{ maxWidth: "86%", textAlign: "center", fontSize, fontWeight: 800, lineHeight: 1.3, opacity: pop, transform: `scale(${0.94 + 0.06 * pop})`, textShadow: "0 4px 20px rgba(0,0,0,.8), 0 0 2px rgba(0,0,0,.9)" }}>
        {chunk.map((w, i) => {
          const on = frame >= w.from && frame < w.to;
          return <span key={i} style={{ display: "inline-block", margin: "0 .16em", color: on ? brand.accent : "#fff", transform: on ? "translateY(-3px) scale(1.04)" : "none" }}>{w.text}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

// Slow zoom / pan on a still, a different direction per index, fading in over the previous one.
// A section's backdrop: stock footage where there is some, otherwise the picture with a slow push. Footage is muted and
// loops, because it only has to cover the narration — the voice is the engine's, not the clip's.
export const KenBurns: React.FC<{ image: string; duration: number; index: number; video?: boolean }> = ({ image, duration, index, video }) => {
  const frame = useCurrentFrame();
  const t = Math.min(1, frame / Math.max(1, duration));
  const d = index % 4, scale = d % 2 ? interpolate(t, [0, 1], [1.16, 1.04]) : interpolate(t, [0, 1], [1.04, 1.16]);
  const x = d === 2 ? interpolate(t, [0, 1], [-2.5, 2.5]) : d === 3 ? interpolate(t, [0, 1], [2.5, -2.5]) : 0;
  const fade = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade, overflow: "hidden" }}>
      {video
        ? <OffthreadVideo src={src(image)!} muted loop style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${1.02})` }} />
        : <Img src={src(image)!} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale}) translateX(${x}%)` }} />}
    </AbsoluteFill>
  );
};

export const BrandBar: React.FC<{ brand: Brand; kicker?: string; vertical: boolean }> = ({ brand, kicker, vertical }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const inn = spring({ frame, fps, config: MOTION.enter, durationInFrames: 14 });
  const pad = vertical ? 54 : 48;
  return (
    <AbsoluteFill style={{ padding: `${pad}px ${pad}px 0`, flexDirection: "row", alignItems: "flex-start", gap: 18, opacity: inn, transform: `translateY(${(1 - inn) * -30}px)` }}>
      {brand.logo ? <Img src={src(brand.logo)!} style={{ height: vertical ? 86 : 72, objectFit: "contain", filter: "drop-shadow(0 3px 10px rgba(0,0,0,.5))" }} />
        : <div style={{ fontSize: vertical ? 40 : 34, fontWeight: 800, color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,.6)" }}>{brand.name}</div>}
      {kicker ? <div style={{ marginTop: 10, background: brand.accent, color: "#111", fontWeight: 800, fontSize: vertical ? 30 : 26, padding: "6px 16px", borderRadius: 6, letterSpacing: isBangla(kicker) ? 0 : ".06em", textTransform: isBangla(kicker) ? "none" : "uppercase" }}>{kicker}</div> : null}
    </AbsoluteFill>
  );
};

// The story's headline in a brand-colour strip, kept on screen like a news lower third.
export const HeadlineStrip: React.FC<{ brand: Brand; headline: string; vertical: boolean; top: number }> = ({ brand, headline, vertical, top }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const inn = spring({ frame: frame - 6, fps, config: MOTION.enter, durationInFrames: 16 });
  const size = vertical ? (headline.length > 70 ? 50 : 58) : headline.length > 80 ? 44 : 52;
  return (
    <AbsoluteFill style={{ top, height: "auto", padding: vertical ? "0 54px" : "0 48px", opacity: inn }}>
      <div style={{ background: `linear-gradient(90deg, ${brand.primary}, ${shade(brand.primary, -0.25)})`, color: brand.text || "#fff", fontWeight: 800, fontSize: size, lineHeight: 1.22, padding: vertical ? "22px 28px" : "18px 24px",
        borderLeft: `10px solid ${brand.accent}`, borderRadius: 8, boxShadow: "0 12px 40px rgba(0,0,0,.45)", transform: `translateX(${(1 - inn) * -60}px)`, maxWidth: vertical ? "100%" : "70%" }}>{headline}</div>
    </AbsoluteFill>
  );
};

export const ProgressBar: React.FC<{ total: number; color: string }> = ({ total, color }) => {
  const frame = useCurrentFrame();
  return <div style={{ position: "absolute", top: 0, left: 0, height: 8, width: `${(frame / Math.max(1, total)) * 100}%`, background: color }} />;
};

export const Outro: React.FC<{ brand: Brand; lang: string; credit?: string; vertical: boolean }> = ({ brand, lang, credit, vertical }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: MOTION.enter, durationInFrames: 18 });
  const cta = lang === "bn" ? "আরও খবর পেতে ফলো করুন" : "Follow for more";
  return (
    <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 40%, ${shade(brand.primary, 0.12)}, ${shade(brand.primary, -0.35)})`, justifyContent: "center", alignItems: "center", gap: 28, color: brand.text || "#fff" }}>
      {brand.logo ? <Img src={src(brand.logo)!} style={{ width: vertical ? 420 : 340, objectFit: "contain", transform: `scale(${0.7 + 0.3 * pop})`, opacity: pop }} />
        : <div style={{ fontSize: vertical ? 86 : 72, fontWeight: 800, transform: `scale(${0.7 + 0.3 * pop})` }}>{brand.name}</div>}
      <div style={{ fontSize: vertical ? 50 : 42, fontWeight: 700, opacity: pop }}>{cta}</div>
      {brand.handle ? <div style={{ fontSize: vertical ? 40 : 34, color: brand.accent, fontWeight: 700, opacity: pop }}>{brand.handle}</div> : null}
      {credit ? <div style={{ position: "absolute", bottom: 60, fontSize: 26, opacity: 0.7 }}>{credit}</div> : null}
    </AbsoluteFill>
  );
};
