import { BodyId } from './types';

export const BODY_IDS: BodyId[] = [
  'Sun',
  'Moon',
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
  'Pluto',
];

export const BODY_LABELS: Record<BodyId, string> = {
  Sun: 'Sun',
  Moon: 'Moon',
  Mercury: 'Mercury',
  Venus: 'Venus',
  Mars: 'Mars',
  Jupiter: 'Jupiter',
  Saturn: 'Saturn',
  Uranus: 'Uranus',
  Neptune: 'Neptune',
  Pluto: 'Pluto',
};

export const BODY_SYMBOLS: Record<BodyId, string> = {
  Sun: '☉',
  Moon: '☽',
  Mercury: '☿',
  Venus: '♀',
  Mars: '♂',
  Jupiter: '♃',
  Saturn: '♄',
  Uranus: '♅',
  Neptune: '♆',
  Pluto: '♇',
};

/**
 * One pastel color per body. Re-derived via the data-viz skill's OKLCH categorical-palette
 * method (evenly-spaced hues, optimized for maximum pairwise separation under simulated
 * colorblindness, then re-tuned twice more for specific colliding pairs) after the previous
 * palette put Mercury and Mars close enough to be visually indistinguishable (~10-18 RGB units
 * apart) — two separate, correctly-rendered lines were being misread as one broken line. Worst
 * pair is now Mars/Mercury at normal-vision ΔE 10.0 (was ~0-3) and colorblind-sim ΔE 6.1, clearing
 * the colorblind floor but not the ideal target. Packing 10 mutually-distinct pastel hues into
 * full pairwise separation is close to a hard limit — a more saturated alternative that clears
 * every check is available if that residual risk matters more than staying pastel.
 */
export const BODY_COLORS: Record<BodyId, string> = {
  Sun: '#CE752B',
  Moon: '#A387EA',
  Mercury: '#CC6398',
  Venus: '#BFB65B',
  Mars: '#EC7A7D',
  Jupiter: '#5ABEF9',
  Saturn: '#55A66B',
  Uranus: '#5ACAA9',
  Neptune: '#2580C1',
  Pluto: '#DC8ACD',
};

export const LINE_KIND_LABELS: Record<'MC' | 'IC' | 'AC' | 'DC', string> = {
  MC: 'Midheaven',
  IC: 'Nadir',
  AC: 'Rising',
  DC: 'Setting',
};

export const ZODIAC_SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
];

export function eclipticLonToSign(lonDeg: number): { sign: string; degreeInSign: number } {
  const normalized = ((lonDeg % 360) + 360) % 360;
  const index = Math.floor(normalized / 30);
  return { sign: ZODIAC_SIGNS[index], degreeInSign: normalized - index * 30 };
}
