// The Office cast — roster metadata + sprite frames.
//
// Both the static portraits (cards / picker) and the in-scene walking sprites are
// now fully custom-drawn from the same per-character recipes in portraitArt.ts:
// the scene sprite reuses the portrait's exact head/face/clothing and adds legs,
// so an agent on the office floor looks identical to its card. The LimeZu base
// sheets are no longer used for the cast. See assets/ATTRIBUTION.md.

import { Texture } from 'pixi.js';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';

export type OfficeCharacterName =
  | 'ted'
  | 'marshall'
  | 'lily'
  | 'robin'
  | 'barney'
  | 'tracy'
  | 'penny'
  | 'luke'
  | 'ranjit'
  | 'carl'
  | 'wendy'
  | 'arthur'
  | 'bilson'
  | 'blauman'
  | 'randy'
  | 'patrice'
  | 'james'
  | 'victoria'
  | 'stella'
  | 'zoey'
  | 'quinn'
  | 'nora'
  | 'captain'
  | 'sandy'
  | 'stuart'
  | 'marvin'
  | 'student1' | 'student2' | 'student3' | 'student4' | 'student5' | 'student6'
  | 'kid1' | 'kid2' | 'kid3' | 'kid4' | 'kid5';

export interface CastMember {
  name: OfficeCharacterName;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
  /** Drawn smaller on the floor (children). */
  small?: boolean;
}

/** Selectable roster, in display order: the gang, the family, MacLaren's,
 *  GNB, and the people who passed through. */
export const OFFICE_CAST: CastMember[] = [
  { name: 'ted', displayName: "Ted", shirt: '#8a5a44', blurb: "Architect. Hopeless romantic." },
  { name: 'marshall', displayName: "Marshall", shirt: '#5f8262', blurb: "Lawyer. Sasquatch believer." },
  { name: 'lily', displayName: "Lily", shirt: '#469696', blurb: "Kindergarten teacher, artist" },
  { name: 'robin', displayName: "Robin", shirt: '#384678', blurb: "News anchor. Canadian." },
  { name: 'barney', displayName: "Barney", shirt: '#3c3e4e', blurb: "Suit up. Please." },
  { name: 'tracy', displayName: "Tracy", shirt: '#f0cc46', blurb: "The yellow umbrella" },
  { name: 'penny', displayName: "Penny", shirt: '#e68aa0', blurb: "The daughter" },
  { name: 'luke', displayName: "Luke", shirt: '#4a7ab5', blurb: "The son" },
  { name: 'ranjit', displayName: "Ranjit", shirt: '#32323c', blurb: "Best driver in New York" },
  { name: 'carl', displayName: "Carl", shirt: '#323238', blurb: "Bartender, MacLaren's" },
  { name: 'wendy', displayName: "Wendy", shirt: '#46825a', blurb: "Waitress, MacLaren's" },
  { name: 'arthur', displayName: "Arthur", shirt: '#28345c', blurb: "GNB. \"Artillery\" Arthur." },
  { name: 'bilson', displayName: "Bilson", shirt: '#60646e', blurb: "GNB management" },
  { name: 'blauman', displayName: "Blauman", shirt: '#5a4a3e', blurb: "GNB. Has had enough." },
  { name: 'randy', displayName: "Randy", shirt: '#acc4e0', blurb: "GNB. Brews his own beer." },
  { name: 'patrice', displayName: "Patrice", shirt: '#8c64aa', blurb: "Nobody asked you, Patrice" },
  { name: 'james', displayName: "James", shirt: '#a0a4b0', blurb: "Barney's brother" },
  { name: 'victoria', displayName: "Victoria", shirt: '#ec96aa', blurb: "Baker. Buttercup Bakery." },
  { name: 'stella', displayName: "Stella", shirt: '#e6e6ee', blurb: "Dermatologist" },
  { name: 'zoey', displayName: "Zoey", shirt: '#5a965a', blurb: "Saves old buildings" },
  { name: 'quinn', displayName: "Quinn", shirt: '#2e2a34', blurb: "Coffee table, anyone?" },
  { name: 'nora', displayName: "Nora", shirt: '#b43c3c', blurb: "Robin's colleague" },
  { name: 'captain', displayName: "The Captain", shirt: '#283a6e', blurb: "Loves boats" },
  { name: 'sandy', displayName: "Sandy", shirt: '#b89a6a', blurb: "Sandy Rivers, Metro News 1" },
  { name: 'stuart', displayName: "Stuart", shirt: '#7a8ca0', blurb: "Married to Claudia" },
  { name: 'marvin', displayName: "Marvin Sr.", shirt: '#5a3c82', blurb: "Marshall's dad. Vikings." },
  { name: 'student1', displayName: "Student", shirt: '#5a7ab0', blurb: "Architecture 101" },
  { name: 'student2', displayName: "Student", shirt: '#b05a6a', blurb: "Architecture 101" },
  { name: 'student3', displayName: "Student", shirt: '#6a9a6a', blurb: "Architecture 101" },
  { name: 'student4', displayName: "Student", shirt: '#8a6ab0', blurb: "Architecture 101" },
  { name: 'student5', displayName: "Student", shirt: '#b08a4a', blurb: "Architecture 101" },
  { name: 'student6', displayName: "Student", shirt: '#4a8a9a', blurb: "Architecture 101" },
  { name: 'kid1', displayName: "Kid", shirt: '#e05a4a', blurb: "Laser tag squad", small: true },
  { name: 'kid2', displayName: "Kid", shirt: '#4a8ae0', blurb: "Laser tag squad", small: true },
  { name: 'kid3', displayName: "Kid", shirt: '#5ac06a', blurb: "Laser tag squad", small: true },
  { name: 'kid4', displayName: "Kid", shirt: '#e0b040', blurb: "Laser tag squad", small: true },
  { name: 'kid5', displayName: "Kid", shirt: '#b060d0', blurb: "Laser tag squad", small: true },
];

export const CAST_BY_NAME: Record<OfficeCharacterName, CastMember> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c])) as Record<OfficeCharacterName, CastMember>;

export const DEFAULT_CHARACTER: OfficeCharacterName = 'marshall';

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────
const frameCache = new Map<OfficeCharacterName, Texture[][]>();

function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W; canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * Frame grid CharacterSprite expects: 3 rows (down, up, right) × 7 frames
 * [walk1, walk2, walk3, type1, type2, read1, read2]. We provide a front view
 * (down — and reused for the side row, so left/right walkers still show a face)
 * and a back view (up — agents seated facing their desk show their back). The
 * three walk frames are stand / step-left / step-right.
 */
export async function getCastFrames(name: OfficeCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const { front, back } = sceneFrameBufs(name);
  const toRow = (bufs: Uint8ClampedArray[]): Texture[] => {
    const [stand, stepL, stepR] = bufs.map(bufToTexture);
    return [stand, stepL, stepR, stand, stand, stand, stand];
  };
  const frontRow = toRow(front);
  const frames: Texture[][] = [frontRow, toRow(back), frontRow]; // down, up, right
  frameCache.set(name, frames);
  return frames;
}

/**
 * Paint a character's static portrait for cards / the picker (delegates to the
 * custom procedural composer in portraitArt.ts).
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: OfficeCharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}
