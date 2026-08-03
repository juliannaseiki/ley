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

/** One calm, distinguishable color per body, chosen to read clearly over the globe's blue/green palette. */
export const BODY_COLORS: Record<BodyId, string> = {
  Sun: '#F3C98A',
  Moon: '#C7BEE0',
  Mercury: '#EAB29E',
  Venus: '#EFD48C',
  Mars: '#E0A093',
  Jupiter: '#A8C4DC',
  Saturn: '#C2AF97',
  Uranus: '#A3D6CC',
  Neptune: '#B0B3D8',
  Pluto: '#CBA8C3',
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
