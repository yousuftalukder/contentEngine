// Animated explainer (animation blueprint): narration drives the animation. Each scene is one of six fixed layouts,
// timed to its own narration; elements enter on their cue words. Two transitions only (fade, slide), one persistent
// background and logo, subtitles, brand outro. 16:9 for YouTube, 9:16 for Shorts.
import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Brand, Word, fontStack, src, useBrandFont, shade, MOTION } from "./theme";
import { LAYOUTS } from "./scenes";
import { Captions, Outro, ProgressBar } from "./parts";

export type ExplainerScene = { layout: string; durationInFrames: number; data: any; cues: number[]; words: Word[]; chapter?: string; transition?: "fade" | "slide" };
export type ExplainerProps = { width?: number; height?: number; fps?: number; lang: string; brand: Brand; title: string; audio?: string; music?: string; musicVolume?: number; subtitles?: boolean; scenes: ExplainerScene[]; outroFrames: number };

export const explainerDuration = (p: ExplainerProps) => p.scenes.reduce((a, s) => a + s.durationInFrames, 0) + (p.outroFrames || 0);

const SceneShell: React.FC<{ s: ExplainerScene; brand: Brand; vertical: boolean }> = ({ s, brand, vertical }) => {
  const frame = useCurrentFrame();
  const Layout = LAYOUTS[s.layout] || LAYOUTS.BulletReveal;
  const out = interpolate(frame, [s.durationInFrames - MOTION.exitFrames, s.durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const inn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const slide = s.transition === "slide" ? (1 - inn) * (vertical ? 80 : 140) : 0;
  return (
    <AbsoluteFill style={{ opacity: Math.min(inn, out), transform: `translateX(${slide}px)` }}>
      <Layout data={s.data || {}} cues={s.cues || []} brand={brand} vertical={vertical} durationInFrames={s.durationInFrames} />
    </AbsoluteFill>
  );
};

export const Explainer: React.FC<ExplainerProps> = (p) => {
  const { width, height, durationInFrames } = useVideoConfig(); const frame = useCurrentFrame();
  useBrandFont(p.brand);
  const vertical = height > width;
  let t = 0; const seqs = p.scenes.map((s, i) => { const from = t; t += s.durationInFrames; return { ...s, from, i }; });
  const body = t, current = seqs.filter((s) => frame >= s.from).at(-1);
  const bg = shade(p.brand.primary, -0.72);
  return (
    <AbsoluteFill style={{ fontFamily: fontStack(p.brand), background: `radial-gradient(circle at 20% 15%, ${shade(p.brand.primary, -0.45)}, ${bg} 60%)` }}>
      <AbsoluteFill style={{ backgroundImage: "radial-gradient(rgba(255,255,255,.07) 2px, transparent 2px)", backgroundSize: "44px 44px", transform: `translateY(${-(frame % 44) * 0.3}px)` }} />
      {seqs.map((s) => (
        <Sequence key={s.i} from={s.from} durationInFrames={s.durationInFrames}>
          <SceneShell s={s} brand={p.brand} vertical={vertical} />
          {p.subtitles !== false ? <Captions words={s.words} brand={p.brand} perChunk={vertical ? 4 : 9} fontSize={vertical ? 46 : 38} bottom={vertical ? 150 : 46} /> : null}
        </Sequence>
      ))}
      {frame < body ? (
        <AbsoluteFill style={{ padding: vertical ? 60 : 48, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          {p.brand.logo ? <Img src={src(p.brand.logo)!} style={{ height: vertical ? 70 : 60, objectFit: "contain", opacity: 0.9 }} /> : <div style={{ color: "#fff", fontSize: 30, fontWeight: 800, opacity: 0.85 }}>{p.brand.name}</div>}
          {current?.chapter ? <div style={{ color: "rgba(255,255,255,.75)", fontSize: vertical ? 30 : 26, fontWeight: 600, border: `2px solid ${p.brand.accent}`, padding: "6px 16px", borderRadius: 30 }}>{current.chapter}</div> : null}
        </AbsoluteFill>
      ) : null}
      <Sequence from={body} durationInFrames={p.outroFrames}><Outro brand={p.brand} lang={p.lang} vertical={vertical} /></Sequence>
      <ProgressBar total={durationInFrames} color={p.brand.accent} />
      {p.audio ? <Audio src={src(p.audio)!} /> : null}
      {p.music ? <Audio src={src(p.music)!} loop volume={(f) => (f < body ? p.musicVolume ?? 0.06 : 0.2)} /> : null}
    </AbsoluteFill>
  );
};
