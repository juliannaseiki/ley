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
  Sun: '#E7A657',
  Moon: '#9B8EC4',
  Mercury: '#D97F63',
  Venus: '#E0B84E',
  Mars: '#C1553F',
  Jupiter: '#4E7FA8',
  Saturn: '#8A7256',
  Uranus: '#4FA79A',
  Neptune: '#6A6FB0',
  Pluto: '#96628C',
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
