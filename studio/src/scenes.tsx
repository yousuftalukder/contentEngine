// The six scene layouts from the animation blueprint. Each receives its data, the cue frames at which its elements are
// spoken (computed from the narration timing by the engine), and handles its own entrance; the Explainer fades it out.
//
// What separates these from a slide deck: nothing arrives linearly (springs with overshoot, and easing that decelerates
// hard), text is revealed behind a moving mask rather than faded in, lists cascade instead of appearing at once, every
// element keeps a slow drift after it lands, and whatever the narrator is naming right now is lifted while the rest
// dims. The timing comes from the narration, so the emphasis always lands on the word being spoken.
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import * as Lucide from "lucide-react";
import { Brand, MOTION, EASE, shade, drift } from "./theme";

export type SceneProps = { data: any; cues: number[]; brand: Brand; vertical: boolean; durationInFrames: number };

const useEnter = (at: number, frames = 16) => { const frame = useCurrentFrame(); const { fps } = useVideoConfig(); return spring({ frame: frame - at, fps, config: MOTION.enter, durationInFrames: frames }); };
// The brief lift an element gets as the narrator names it: up over four frames, settled by twelve.
const useCue = (at: number) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: frame - at, fps, config: MOTION.pop, durationInFrames: 10 });
  return interpolate(s, [0, 0.5, 1], [0, 1, 0], { extrapolateRight: "clamp" });
};
const cue = (cues: number[], i: number, fallback = 0) => (Number.isFinite(cues?.[i]) ? cues[i] : fallback + i * 12);
const pascal = (s: string) => String(s || "").replace(/(^|[-_\s]+)(\w)/g, (_, __, c) => c.toUpperCase());
export const Icon: React.FC<{ name: string; size: number; color: string }> = ({ name, size, color }) => {
  const C = (Lucide as any)[pascal(name)] || (Lucide as any)[`${pascal(name)}Icon`] || Lucide.Circle;
  return <C size={size} color={color} strokeWidth={2.2} />;
};

// Text that arrives from behind a moving edge instead of fading: the single cheapest thing that reads as designed.
const Reveal: React.FC<{ at: number; frames?: number; children: React.ReactNode; style?: React.CSSProperties; from?: number }> = ({ at, frames = 18, children, style, from = 26 }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame - at, [0, frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE.out });
  return (
    <div style={{ ...style, clipPath: `inset(0 ${(1 - t) * 100}% 0 0)`, transform: `translateY(${(1 - t) * from}px)`, opacity: Math.min(1, t * 1.6) }}>{children}</div>
  );
};

const Heading: React.FC<{ text?: string; brand: Brand; vertical: boolean }> = ({ text, brand, vertical }) => {
  const frame = useCurrentFrame();
  const bar = interpolate(frame, [0, 22], [0, 1], { extrapolateRight: "clamp", easing: EASE.out });
  if (!text) return null;
  return (
    <div style={{ display: "flex", gap: 24, marginBottom: 36, alignItems: "stretch" }}>
      <div style={{ width: 10, background: brand.accent, borderRadius: 5, transform: `scaleY(${bar})`, transformOrigin: "top" }} />
      <Reveal at={0} style={{ fontSize: vertical ? 64 : 60, fontWeight: 800, color: "#fff", lineHeight: 1.18, letterSpacing: "-0.01em", maxWidth: "92%" }}>{text}</Reveal>
    </div>
  );
};
const Body: React.FC<{ vertical: boolean; children: React.ReactNode; center?: boolean }> = ({ vertical, children, center }) => (
  <AbsoluteFill style={{ padding: vertical ? "260px 70px 300px" : "110px 150px 150px", justifyContent: center ? "center" : "flex-start" }}>{children}</AbsoluteFill>
);

export const TitleCard: React.FC<SceneProps> = ({ data, brand, vertical }) => {
  const frame = useCurrentFrame();
  const bar = interpolate(frame, [8, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE.out });
  const words = String(data.title || "").split(" ");
  return (
    <Body vertical={vertical} center>
      <div style={{ transform: `translateY(${drift(frame, 5, 320)}px)` }}>
        <div style={{ fontSize: vertical ? 96 : 104, fontWeight: 800, color: "#fff", lineHeight: 1.08, letterSpacing: "-0.02em" }}>
          {/* Word by word, so the title reads as it lands rather than appearing all at once. */}
          {words.map((w, i) => <Reveal key={i} at={2 + i * 3} frames={16} from={34} style={{ display: "inline-block", marginRight: "0.28em" }}>{w}</Reveal>)}
        </div>
        <div style={{ height: 12, width: `${bar * (vertical ? 60 : 30)}%`, background: brand.accent, borderRadius: 6, margin: "34px 0" }} />
        {data.subtitle ? <Reveal at={10 + words.length * 3} style={{ fontSize: vertical ? 48 : 44, color: "rgba(255,255,255,.82)" }}>{data.subtitle}</Reveal> : null}
      </div>
    </Body>
  );
};

export const BulletReveal: React.FC<SceneProps> = ({ data, cues, brand, vertical }) => {
  const frame = useCurrentFrame();
  const bullets: string[] = (data.bullets || []).map((b: any) => (typeof b === "string" ? b : b.text));
  const active = bullets.reduce((acc, _, i) => (frame >= cue(cues, i, 8) ? i : acc), -1);
  return (
    <Body vertical={vertical}>
      <Heading text={data.heading} brand={brand} vertical={vertical} />
      {bullets.map((t, i) => <Bullet key={i} text={t} at={cue(cues, i, 8)} brand={brand} vertical={vertical} state={i < active ? "done" : i === active ? "live" : "waiting"} />)}
    </Body>
  );
};
const Bullet: React.FC<{ text: string; at: number; brand: Brand; vertical: boolean; state: "waiting" | "live" | "done" }> = ({ text, at, brand, vertical, state }) => {
  const frame = useCurrentFrame();
  const e = useEnter(at), pop = useCue(at);
  // The line being spoken sits forward and bright; the ones already said fall back without disappearing.
  const dim = state === "done" ? 0.5 : 1;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 26, margin: vertical ? "0 0 34px" : "0 0 30px",
      opacity: e * dim, transform: `translateX(${(1 - e) * -60}px) translateY(${drift(frame, 2, 260, at / 60)}px) scale(${1 + pop * 0.02})`, transformOrigin: "left center" }}>
      <div style={{ width: 26, height: 26, borderRadius: 13, background: brand.accent, marginTop: vertical ? 22 : 20, flex: "0 0 auto",
        transform: `scale(${e * (1 + pop * 0.35)})`, boxShadow: `0 0 ${18 * pop}px ${brand.accent}` }} />
      <div style={{ fontSize: vertical ? 58 : 54, color: "#fff", fontWeight: 600, lineHeight: 1.3 }}>{text}</div>
    </div>
  );
};

export const IconGrid: React.FC<SceneProps> = ({ data, cues, brand, vertical }) => {
  const items: { icon: string; label: string }[] = data.items || [];
  const cols = vertical ? 2 : Math.min(items.length, items.length === 4 ? 2 : 3);
  return (
    <Body vertical={vertical} center>
      <Heading text={data.heading} brand={brand} vertical={vertical} />
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: vertical ? 40 : 48, marginTop: 10 }}>
        {items.map((it, i) => <IconCard key={i} item={it} at={cue(cues, i, 6)} brand={brand} vertical={vertical} index={i} />)}
      </div>
    </Body>
  );
};
const IconCard: React.FC<{ item: { icon: string; label: string }; at: number; brand: Brand; vertical: boolean; index: number }> = ({ item, at, brand, vertical, index }) => {
  const frame = useCurrentFrame();
  const e = useEnter(at), pop = useCue(at);
  return (
    <div style={{ background: "rgba(255,255,255,.06)", border: `1px solid rgba(255,255,255,${0.12 + pop * 0.25})`, borderRadius: 24, padding: vertical ? "40px 24px" : "44px 30px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 24, opacity: e,
      transform: `scale(${(0.6 + 0.4 * e) * (1 + pop * 0.04)}) translateY(${drift(frame, 3, 300, index / 5)}px)`,
      boxShadow: `0 ${18 + pop * 10}px ${34 + pop * 20}px rgba(0,0,0,${0.28 + pop * 0.12})` }}>
      <div style={{ width: vertical ? 150 : 140, height: vertical ? 150 : 140, borderRadius: "50%", background: shade(brand.accent, -0.1), display: "flex", alignItems: "center", justifyContent: "center",
        transform: `rotate(${(1 - e) * -12}deg)`, boxShadow: `0 0 ${30 * pop}px ${shade(brand.accent, 0.1)}` }}>
        <Icon name={item.icon} size={vertical ? 82 : 76} color="#111" />
      </div>
      <div style={{ fontSize: vertical ? 44 : 40, color: "#fff", fontWeight: 700, textAlign: "center", lineHeight: 1.25 }}>{item.label}</div>
    </div>
  );
};

export const Comparison: React.FC<SceneProps> = ({ data, cues, brand, vertical }) => {
  const frame = useCurrentFrame();
  const lAt = cue(cues, 0, 4), rAt = cue(cues, 1, 20);
  const l = useEnter(lAt), r = useEnter(rAt), vs = useEnter(Math.min(lAt, rAt) + 6);
  const lPop = useCue(lAt), rPop = useCue(rAt);
  const side = (d: any, e: number, pop: number, color: string, from: number, at: number) => (
    <div style={{ flex: 1, background: `linear-gradient(160deg, ${shade(color, -0.2)}, ${shade(color, -0.55)})`, borderRadius: 28, padding: vertical ? "40px 44px" : "48px 52px",
      opacity: e, transform: `${vertical ? `translateY(${(1 - e) * from}px)` : `translateX(${(1 - e) * from}px)`} scale(${1 + pop * 0.02})`,
      boxShadow: `0 ${20 + pop * 12}px ${40 + pop * 20}px rgba(0,0,0,${0.3 + pop * 0.15})`, border: `1px solid rgba(255,255,255,${0.06 + pop * 0.2})` }}>
      <div style={{ fontSize: vertical ? 58 : 56, fontWeight: 800, color: "#fff", marginBottom: 24 }}>{d?.title}</div>
      {(d?.points || []).map((p: string, i: number) => (
        <Reveal key={i} at={at + 6 + i * 4} frames={14} from={14} style={{ fontSize: vertical ? 42 : 40, color: "rgba(255,255,255,.9)", margin: "0 0 16px", lineHeight: 1.3 }}>• {p}</Reveal>
      ))}
    </div>
  );
  return (
    <Body vertical={vertical}>
      <Heading text={data.heading} brand={brand} vertical={vertical} />
      <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", gap: 40, alignItems: "stretch", position: "relative", flex: 1 }}>
        {side(data.left, l, lPop, brand.primary, vertical ? -80 : -120, lAt)}
        {side(data.right, r, rPop, shade(brand.accent, -0.35), vertical ? 80 : 120, rAt)}
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(-50%, -50%) scale(${vs}) rotate(${(1 - vs) * -40 + drift(frame, 2, 400)}deg)`,
          width: 120, height: 120, borderRadius: 60, background: brand.accent, color: "#111", fontSize: 44, fontWeight: 900,
          display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>VS</div>
      </div>
    </Body>
  );
};

export const DataChart: React.FC<SceneProps> = ({ data, cues, brand, vertical }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const rows: { label: string; value: number }[] = (data.data || []).map((d: any) => ({ label: String(d.label), value: Number(d.value) || 0 }));
  const max = Math.max(1, ...rows.map((r) => r.value)); const start = cue(cues, 0, 8);
  const fmt = (v: number) => `${Math.round(v).toLocaleString()}${data.unit ? ` ${data.unit}` : ""}`;
  if (data.kind === "line") {
    const W = vertical ? 900 : 1500, H = vertical ? 900 : 620, pts = rows.map((r, i) => [(i / Math.max(1, rows.length - 1)) * W, H - (r.value / max) * H * 0.9]);
    const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" "); const len = pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
    const draw = interpolate(frame, [start, start + 46], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE.inOut });
    const head = pts.length ? pts[Math.min(pts.length - 1, Math.floor(draw * (pts.length - 1)))] : null;
    return (
      <Body vertical={vertical}>
        <Heading text={data.heading} brand={brand} vertical={vertical} />
        <svg width={W} height={H + 80} style={{ overflow: "visible" }}>
          {[0.25, 0.5, 0.75, 1].map((g) => <line key={g} x1={0} x2={W} y1={H - H * 0.9 * g} y2={H - H * 0.9 * g} stroke="rgba(255,255,255,.08)" strokeWidth={2} />)}
          <path d={`${path} L${W},${H} L0,${H} Z`} fill={brand.accent} opacity={0.12 * draw} />
          <path d={path} fill="none" stroke={brand.accent} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
          {head && draw > 0.02 && draw < 0.995 ? <circle cx={head[0]} cy={head[1]} r={16} fill="#fff" opacity={0.9} /> : null}
          {pts.map(([x, y], i) => draw >= i / Math.max(1, rows.length - 1) ? (
            <g key={i}>
              <circle cx={x} cy={y} r={14} fill="#fff" />
              <text x={x} y={H + 60} fill="rgba(255,255,255,.8)" fontSize={34} textAnchor="middle">{rows[i].label}</text>
              <text x={x} y={y - 30} fill="#fff" fontSize={36} fontWeight={700} textAnchor="middle">{fmt(rows[i].value)}</text>
            </g>) : null)}
        </svg>
      </Body>
    );
  }
  return (
    <Body vertical={vertical} center>
      <Heading text={data.heading} brand={brand} vertical={vertical} />
      <div style={{ display: "flex", flexDirection: "column", gap: vertical ? 34 : 26 }}>
        {rows.map((r, i) => {
          const at = start + i * MOTION.stagger * 2;
          const g = spring({ frame: frame - at, fps, config: MOTION.soft });
          const lead = r.value === max ? 1 : 0;                                   // the biggest bar carries the brand colour
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 24, opacity: interpolate(frame - at, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
              <div style={{ width: vertical ? 260 : 360, fontSize: 38, color: "rgba(255,255,255,.85)", textAlign: "right", flex: "0 0 auto" }}>{r.label}</div>
              <div style={{ flex: 1, height: vertical ? 64 : 58, background: "rgba(255,255,255,.07)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(r.value / max) * 100 * g}%`, borderRadius: 10,
                  background: lead ? `linear-gradient(90deg, ${brand.accent}, ${shade(brand.accent, 0.3)})` : `linear-gradient(90deg, ${shade(brand.accent, -0.45)}, ${shade(brand.accent, -0.25)})`,
                  boxShadow: lead ? `0 0 24px ${shade(brand.accent, -0.1)}` : "none" }} />
              </div>
              <div style={{ width: vertical ? 220 : 240, fontSize: 40, fontWeight: 800, color: "#fff", fontVariantNumeric: "tabular-nums" }}>{fmt(r.value * g)}</div>
            </div>
          );
        })}
      </div>
    </Body>
  );
};

export const FullQuote: React.FC<SceneProps> = ({ data, brand, vertical }) => {
  const frame = useCurrentFrame();
  const mark = useEnter(2, 20), a = useEnter(26);
  // The quote arrives a line at a time, the way it would be read aloud.
  const lines = String(data.quote || "").split(/(?<=[.!?।])\s+/).filter(Boolean);
  return (
    <Body vertical={vertical} center>
      <div style={{ fontSize: vertical ? 220 : 240, lineHeight: 0.6, color: brand.accent, fontWeight: 900, opacity: mark,
        transform: `translateY(${drift(frame, 4, 340)}px) rotate(${(1 - mark) * -14}deg)`, transformOrigin: "left bottom" }}>“</div>
      <div style={{ fontSize: vertical ? 70 : 72, color: "#fff", fontWeight: 700, lineHeight: 1.3 }}>
        {(lines.length ? lines : [data.quote]).map((l, i) => <Reveal key={i} at={6 + i * 10} frames={20} from={22} style={{ marginBottom: 8 }}>{l}</Reveal>)}
      </div>
      {data.attribution ? <div style={{ fontSize: vertical ? 42 : 40, color: "rgba(255,255,255,.75)", marginTop: 36, opacity: a, transform: `translateX(${(1 - a) * 20}px)` }}>— {data.attribution}</div> : null}
    </Body>
  );
};

export const LAYOUTS: Record<string, React.FC<SceneProps>> = { TitleCard, BulletReveal, IconGrid, Comparison, DataChart, FullQuote };
