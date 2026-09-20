// Shared design system for every composition (blueprint §4: one palette, one display + one body face, fixed motion
// constants, safe margins, two transitions). Brand kits from the engine map onto these tokens.
import { staticFile, delayRender, continueRender, Easing } from "remotion";
import { loadFont as loadBengali } from "@remotion/google-fonts/NotoSansBengali";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

export type Brand = { name: string; logo?: string; primary: string; accent: string; text: string; handle?: string; font?: string; fontUrl?: string };
// Frames are relative to the start of the scene / section the words belong to.
export type Word = { text: string; from: number; to: number };

const bengali = loadBengali("normal", { weights: ["400", "600", "700"], subsets: ["bengali", "latin"], ignoreTooManyRequestsWarning: true });
const inter = loadInter("normal", { weights: ["400", "600", "800"], subsets: ["latin"], ignoreTooManyRequestsWarning: true });

export const fontStack = (b: Brand) => [b.font ? `"${b.font}"` : null, `"${inter.fontFamily}"`, `"${bengali.fontFamily}"`, "sans-serif"].filter(Boolean).join(", ");

// Assets arrive either as URLs or as paths staged into the bundle's public folder by render.mjs.
export const src = (p?: string) => (!p ? undefined : /^(https?:|data:|blob:)/.test(p) ? p : staticFile(p));

// A brand's own font file, loaded before the first frame renders.
const loaded = new Set<string>();
export function useBrandFont(b: Brand) {
  if (!b.fontUrl || !b.font || loaded.has(b.fontUrl)) return;
  loaded.add(b.fontUrl);
  const handle = delayRender(`brand font ${b.font}`);
  new FontFace(b.font, `url(${src(b.fontUrl)})`).load().then((f) => { (document.fonts as any).add(f); continueRender(handle); }).catch(() => continueRender(handle));
}

// Motion constants. Entrances spring with a little overshoot, exits ease out quickly, lists stagger. `pop` is for the
// small emphasis a thing gets on the word that names it; `soft` is for anything large, which should never snap.
export const MOTION = {
  enter: { damping: 13, stiffness: 170, mass: 0.7 },
  soft: { damping: 22, stiffness: 110, mass: 1 },
  pop: { damping: 9, stiffness: 260, mass: 0.6 },
  enterFrames: 9, exitFrames: 8, stagger: 3,
};
// Easing that looks designed rather than computed: everything decelerates hard into place, nothing arrives linearly.
export const EASE = { out: Easing.bezier(0.16, 1, 0.3, 1), inOut: Easing.bezier(0.65, 0, 0.35, 1) };
// Nothing on screen is ever perfectly still: a slow, unrepeating drift, in pixels, for whatever it is applied to.
export const drift = (frame: number, amp = 6, period = 240, phase = 0) => Math.sin((frame / period + phase) * Math.PI * 2) * amp;

export const shade = (hex: string, amt: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return hex;
  const n = parseInt(m[1], 16), c = (v: number) => Math.max(0, Math.min(255, Math.round(v + (amt < 0 ? v * amt : (255 - v) * amt))));
  return `#${[c(n >> 16), c((n >> 8) & 255), c(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};
export const isBangla = (s: string) => /[ঀ-৿]/.test(s || "");
