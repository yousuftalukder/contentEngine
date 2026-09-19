// The six scene layouts from the animation blueprint. Each receives its data, the cue frames at which its elements are
// spoken (computed from the narration timing by the engine), and handles its own entrance; the Explainer fades it out.
import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import * as Lucide from "lucide-react";
import { Brand, MOTION, shade } from "./theme";

export type SceneProps = { data: any; cues: number[]; brand: Brand; vertical: boolean; durationInFrames: number };

const useEnter = (at: number, frames = 16) => { const frame = useCurrentFrame(); const { fps } = useVideoConfig(); return spring({ frame: frame - at, fps, config: MOTION.enter, durationInFrames: frames }); };
const cue = (cues: number[], i: number, fallback = 0) => (Number.isFinite(cues?.[i]) ? cues[i] : fallback + i * 12);
const pascal = (s: string) => String(s || "").replace(/(^|[-_\s]+)(\w)/g, (_, __, c) => c.toUpperCase());
export const Icon: React.FC<{ name: string; size: number; color: string }> = ({ name, size, color }) => {
  const C = (Lucide as any)[pascal(name)] || (Lucide as any)[`${pascal(name)}Icon`] || Lucide.Circle;
  return <C size={size} color={color} strokeWidth={2.2} />;
};
const Heading: React.FC<{ text?: string; brand: Brand; vertical: boolean }> = ({ text, brand, vertical }) => {
  const e = useEnter(0);
  if (!text) return null;
  return <div style={{ fontSize: vertical ? 64 : 60, fontWeight: 800, color: "#fff", marginBottom: 36, opacity: e, transform: `translateY(${(1 - e) * 24}px)`, borderLeft: `10px solid ${brand.accent}`, paddingLeft: 24, lineHeight: 1.2 }}>{text}</div>;
};
const Body: React.FC<{ vertical: boolean; children: React.ReactNode; center?: boolean }> = ({ vertical, children, center }) => (
  <AbsoluteFill style={{ padding: vertical ? "260px 70px 300px" : "110px 150px 150px", justifyContent: center ? "center" : "flex-start" }}>{children}</AbsoluteFill>
);

export const TitleCard: React.FC<SceneProps> = ({ data, brand, vertical }) => {
  const a = useEnter(2), b = useEnter(10), bar = useEnter(6, 24);
  return (
    <Body vertical={vertical} center>
      <div style={{ fontSize: vertical ? 96 : 104, fontWeight: 800, color: "#fff", lineHeight: 1.1, opacity: a, transform: `scale(${0.85 + 0.15 * a})`, transformOrigin: "left center" }}>{data.title}</div>
      <div style={{ height: 12, width: `${bar * (vertical ? 60 : 30)}%`, background: brand.accent, borderRadius: 6, margin: "34px 0" }} />
      {data.subtitle ? <div style={{ fontSize: vertical ? 48 : 44, color: "rgba(255,255,255,.8)", opacity: b, transform: `translateY(${(1 - b) * 20}px)` }}>{data.subtitle}</div> : null}
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
      {bullets.map((t, i) => <Bullet key={i} text={t} at={cue(cues, i, 8)} brand={brand} vertical={vertical} dim={i < active} />)}
    </Body>
  );
};
const Bullet: React.FC<{ text: string; at: number; brand: Brand; vertical: boolean; dim: boolean }> = ({ text, at, brand, vertical, dim }) => {
  const e = useEnter(at);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 26, margin: vertical ? "0 0 34px" : "0 0 30px", opacity: e * (dim ? 0.55 : 1), transform: `translateX(${(1 - e) * -60}px)` }}>
      <div style={{ width: 26, height: 26, borderRadius: 13, background: brand.accent, marginTop: vertical ? 22 : 20, flex: "0 0 auto", transform: `scale(${e})` }} />
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
        {items.map((it, i) => <IconCard key={i} item={it} at={cue(cues, i, 6)} brand={brand} vertical={vertical} />)}
      </div>
    </Body>
  );
};
const IconCard: React.FC<{ item: { icon: string; label: string }; at: number; brand: Brand; vertical: boolean }> = ({ item, at, brand, vertical }) => {
  const e = useEnter(at);
  return (
    <div style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 24, padding: vertical ? "40px 24px" : "44px 30px", display: "flex", flexDirection: "column", alignItems: "center", gap: 24, opacity: e, transform: `scale(${0.6 + 0.4 * e})` }}>
      <div style={{ width: vertical ? 150 : 140, height: vertical ? 150 : 140, borderRadius: "50%", background: shade(brand.accent, -0.1), display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name={item.icon} size={vertical ? 82 : 76} color="#111" />
      </div>
      <div style={{ fontSize: vertical ? 44 : 40, color: "#fff", fontWeight: 700, textAlign: "center", lineHeight: 1.25 }}>{item.label}</div>
    </div>
  );
};

export const Comparison: React.FC<SceneProps> = ({ data, cues, brand, vertical }) => {
  const l = useEnter(cue(cues, 0, 4)), r = useEnter(cue(cues, 1, 20)), vs = useEnter(Math.min(cue(cues, 0, 4), cue(cues, 1, 20)) + 6);
  const side = (d: any, e: number, color: string, from: number) => (
    <div style={{ flex: 1, background: `linear-gradient(160deg, ${shade(color, -0.2)}, ${shade(color, -0.55)})`, borderRadius: 28, padding: vertical ? "40px 44px" : "48px 52px", opacity: e, transform: vertical ? `translateY(${(1 - e) * from}px)` : `translateX(${(1 - e) * from}px)` }}>
      <div style={{ fontSize: vertical ? 58 : 56, fontWeight: 800, color: "#fff", marginBottom: 24 }}>{d?.title}</div>
      {(d?.points || []).map((p: string, i: number) => <div key={i} style={{ fontSize: vertical ? 42 : 40, color: "rgba(255,255,255,.9)", margin: "0 0 16px", lineHeight: 1.3 }}>• {p}</div>)}
    </div>
  );
  return (
    <Body vertical={vertical}>
      <Heading text={data.heading} brand={brand} vertical={vertical} />
      <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", gap: 40, alignItems: "stretch", position: "relative", flex: 1 }}>
        {side(data.left, l, brand.primary, vertical ? -80 : -120)}
        {side(data.right, r, shade(brand.accent, -0.35), vertical ? 80 : 120)}
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(-50%, -50%) scale(${vs})`, width: 120, height: 120, borderRadius: 60, background: brand.accent, color: "#111", fontSize: 44, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>VS</div>
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
    const draw = interpolate(frame, [start, start + 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <Body vertical={vertical}>
        <Heading text={data.heading} brand={brand} vertical={vertical} />
        <svg width={W} height={H + 80} style={{ overflow: "visible" }}>
          <path d={path} fill="none" stroke={brand.accent} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
          {pts.map(([x, y], i) => draw >= i / Math.max(1, rows.length - 1) ? <g key={i}><circle cx={x} cy={y} r={14} fill="#fff" /><text x={x} y={H + 60} fill="rgba(255,255,255,.8)" fontSize={34} textAnchor="middle">{rows[i].label}</text><text x={x} y={y - 30} fill="#fff" fontSize={36} fontWeight={700} textAnchor="middle">{fmt(rows[i].value)}</text></g> : null)}
        </svg>
      </Body>
    );
  }
  return (
    <Body vertical={vertical} center>
      <Heading text={data.heading} brand={brand} vertical={vertical} />
      <div style={{ display: "flex", flexDirection: "column", gap: vertical ? 34 : 26 }}>
        {rows.map((r, i) => {
          const g = spring({ frame: frame - start - i * MOTION.stagger * 2, fps, config: { damping: 18, stiffness: 90 } });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <div style={{ width: vertical ? 260 : 360, fontSize: vertical ? 38 : 38, color: "rgba(255,255,255,.85)", textAlign: "right", flex: "0 0 auto" }}>{r.label}</div>
              <div style={{ flex: 1, height: vertical ? 64 : 58, background: "rgba(255,255,255,.07)", borderRadius: 10 }}>
                <div style={{ height: "100%", width: `${(r.value / max) * 100 * g}%`, background: `linear-gradient(90deg, ${brand.accent}, ${shade(brand.accent, 0.25)})`, borderRadius: 10 }} />
              </div>
              <div style={{ width: vertical ? 220 : 240, fontSize: vertical ? 40 : 40, fontWeight: 800, color: "#fff" }}>{fmt(r.value * g)}</div>
            </div>
          );
        })}
      </div>
    </Body>
  );
};

export const FullQuote: React.FC<SceneProps> = ({ data, brand, vertical }) => {
  const q = useEnter(4, 20), a = useEnter(24);
  return (
    <Body vertical={vertical} center>
      <div style={{ fontSize: vertical ? 220 : 240, lineHeight: 0.6, color: brand.accent, fontWeight: 900, opacity: q }}>“</div>
      <div style={{ fontSize: vertical ? 70 : 72, color: "#fff", fontWeight: 700, lineHeight: 1.3, opacity: q, transform: `translateY(${(1 - q) * 30}px)` }}>{data.quote}</div>
      {data.attribution ? <div style={{ fontSize: vertical ? 42 : 40, color: "rgba(255,255,255,.75)", marginTop: 36, opacity: a }}>— {data.attribution}</div> : null}
    </Body>
  );
};

export const LAYOUTS: Record<string, React.FC<SceneProps>> = { TitleCard, BulletReveal, IconGrid, Comparison, DataChart, FullQuote };
