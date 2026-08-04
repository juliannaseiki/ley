import { BodyId, LineKind } from './types';

/**
 * What it means to live on a given body/angle astrocartography line — shown in the bottom panel
 * when a line or its label is tapped. MC/IC/AC/DC keep their traditional meanings (public life,
 * home, self, relationships respectively); each body's theme is layered on top of that.
 */
export const LINE_DESCRIPTIONS: Record<BodyId, Record<LineKind, string>> = {
  Sun: {
    MC: "Career and public standing take on outsized importance here. You're more visible, more likely to be recognized for who you are, and drawn toward roles that put your identity front and center.",
    IC: 'Home and family life feel central to your sense of self in this location — a place where your identity is anchored less by what you do and more by where you belong.',
    AC: "You come across as more confident and vivid here, radiating a stronger sense of self. First impressions lean warm and assured, sometimes a little larger than life.",
    DC: 'Relationships formed here tend to reflect your identity back at you — partners who mirror your vitality, or draw your sense of self into sharper focus through the connection.',
  },
  Moon: {
    MC: 'Your emotional life becomes public here — moods, instincts, and caretaking impulses shape your reputation, sometimes making career feel like an extension of home.',
    IC: 'This is a place that can feel like home in a deep, almost instinctive way — domestic life, family ties, and emotional security are strongly emphasized.',
    AC: 'You come across as more emotionally responsive and approachable here, your moods closer to the surface. People read you as nurturing, or occasionally moody, right away.',
    DC: 'Relationships here tend to be emotionally charged and caretaking in nature — you may find yourself drawn to nurture others, or to be nurtured, more than usual.',
  },
  Mercury: {
    MC: 'Communication, teaching, and the exchange of ideas take center stage professionally here — a promising location for work built on words, information, or persuasion.',
    IC: 'Home life here tends to be full of talk, ideas, and mental activity — a place where the mind rarely settles, even in private.',
    AC: 'You come across as quicker and more talkative here — first impressions lean toward wit, curiosity, and restless intelligence.',
    DC: 'Relationships formed here are often built on conversation and shared ideas — connections that live and die a little by how well you communicate.',
  },
  Venus: {
    MC: 'Beauty, charm, and diplomacy become career assets here — work in art, design, hospitality, or anything relational tends to flourish publicly.',
    IC: 'Home feels softer and more aesthetically pleasing here — a place that draws out your taste for comfort, beauty, and harmonious surroundings.',
    AC: 'You come across as more charming and easy on the eyes here — first impressions lean attractive, gracious, and easy to like.',
    DC: 'This is a classic line for love — relationships formed here tend to be affectionate, harmonious, and easy to fall into.',
  },
  Mars: {
    MC: 'Ambition sharpens here — career drive, competitiveness, and a willingness to fight for position become more visible, for better or worse.',
    IC: 'Home life can run hotter here — more friction, more energy, a place where tension surfaces close to where you live.',
    AC: 'You come across as more assertive and physically energized here — first impressions lean bold, sometimes combative, rarely passive.',
    DC: 'Relationships here can carry a competitive or confrontational edge — passionate connections, but ones where friction is part of the draw.',
  },
  Jupiter: {
    MC: 'This is a fortunate line for career — opportunity, recognition, and expansion tend to find you publicly, often bigger than you expected.',
    IC: 'Home and family life feel abundant here — a place associated with growth, generosity, and a sense of things working out at the foundation.',
    AC: 'You come across as more expansive and optimistic here — first impressions lean confident, generous, larger than life.',
    DC: 'Relationships formed here tend to be generous and growth-oriented — partners who expand your world, sometimes to excess.',
  },
  Saturn: {
    MC: 'Career here comes with real structure, and real weight — recognition is earned slowly, through discipline, and tends to last once it arrives.',
    IC: 'Home life can feel more serious or restrained here — a place that asks for responsibility at the foundation, not always comfort.',
    AC: 'You come across as more reserved and self-contained here — first impressions lean serious, competent, a little guarded.',
    DC: 'Relationships formed here tend to be built on commitment and responsibility rather than ease — durable, but requiring real work.',
  },
  Uranus: {
    MC: 'Career here is prone to sudden shifts — unconventional paths, unexpected breaks, and a public life that resists staying predictable.',
    IC: 'Home life can feel unsettled or unconventional here — a place that disrupts routine at the foundation, for better or worse.',
    AC: 'You come across as more unpredictable and independent here — first impressions lean original, a little electric, hard to pin down.',
    DC: 'Relationships formed here tend to be unconventional or sudden — connections that jolt you out of old patterns, sometimes without warning.',
  },
  Neptune: {
    MC: 'Career here can feel dreamlike or hard to pin down — creative and spiritual work thrive, but so does confusion about direction.',
    IC: 'Home life can feel hazy or idealized here — a place that blurs the line between sanctuary and escape.',
    AC: 'You come across as softer and harder to read here — first impressions lean dreamy, elusive, easily romanticized by others.',
    DC: 'Relationships formed here can be intensely romantic and idealized — but also prone to illusion, so clarity takes real effort.',
  },
  Pluto: {
    MC: 'Career here tends to be transformative and intense — power, ambition, and reputation get pushed to extremes, rarely staying comfortable.',
    IC: 'Home life here can surface deep, sometimes buried material — a place that transforms you from the foundation up, whether you invite it or not.',
    AC: 'You come across as more intense and magnetic here — first impressions lean powerful, a little unsettling, hard to ignore.',
    DC: 'Relationships formed here tend to be intense and transformative — deep entanglements that change you, for better or worse.',
  },
};
