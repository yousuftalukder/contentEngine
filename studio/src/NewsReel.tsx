// A story as a reel: one still per narrated section (Ken Burns, crossfaded), the headline strip and brand bar on top,
// karaoke captions timed to the narration, a progress bar, and a brand outro. 9:16 for Reels/Shorts, 16:9 for YouTube.
import React from "react";
import { AbsoluteFill, Audio, Sequence, useVideoConfig } from "remotion";
import { Brand, Word, fontStack, src, useBrandFont } from "./theme";
import { BrandBar, Captions, HeadlineStrip, KenBurns, Outro, ProgressBar } from "./parts";

export type ReelSection = { image: string; durationInFrames: number; narration: string; words: Word[] };
export type ReelProps = {
  width?: number; height?: number; fps?: number; lang: string; brand: Brand; headline: string; kicker?: string; credit?: string;
  audio?: string; music?: string; musicVolume?: number; sections: ReelSection[]; outroFrames: number;
};

export const reelDuration = (p: ReelProps) => p.sections.reduce((a, s) => a + s.durationInFrames, 0) + (p.outroFrames || 0);

export const NewsReel: React.FC<ReelProps> = (p) => {
  const { width, height, durationInFrames } = useVideoConfig();
  useBrandFont(p.brand);
  const vertical = height > width;
  let t = 0; const seqs = p.sections.map((s, i) => { const from = t; t += s.durationInFrames; return { ...s, from, i }; });
  const body = t;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", fontFamily: fontStack(p.brand) }}>
      {seqs.map((s) => (
        <Sequence key={`img${s.i}`} from={s.from} durationInFrames={s.durationInFrames + (s.i < seqs.length - 1 ? 10 : 0)}>
          <KenBurns image={s.image} duration={s.durationInFrames + 10} index={s.i} />
        </Sequence>
      ))}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.6) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 52%, rgba(0,0,0,.78) 100%)" }} />
      <Sequence durationInFrames={body}>
        <BrandBar brand={p.brand} kicker={p.kicker} vertical={vertical} />
        <HeadlineStrip brand={p.brand} headline={p.headline} vertical={vertical} top={vertical ? 190 : 150} />
      </Sequence>
      {seqs.map((s) => (
        <Sequence key={`cap${s.i}`} from={s.from} durationInFrames={s.durationInFrames}>
          <Captions words={s.words} brand={p.brand} perChunk={vertical ? 4 : 7} fontSize={vertical ? 66 : 54} bottom={vertical ? 330 : 90} />
        </Sequence>
      ))}
      <Sequence from={body} durationInFrames={p.outroFrames}>
        <Outro brand={p.brand} lang={p.lang} credit={p.credit} vertical={vertical} />
      </Sequence>
      <ProgressBar total={durationInFrames} color={p.brand.accent} />
      {p.audio ? <Audio src={src(p.audio)!} /> : null}
      {p.music ? <Audio src={src(p.music)!} loop volume={(f) => (f < body ? p.musicVolume ?? 0.07 : 0.22)} /> : null}
    </AbsoluteFill>
  );
};
