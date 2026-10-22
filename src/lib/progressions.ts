// progressions.ts - the chord search, and what it can honestly answer.
//
// Someone writing in the studio wants the chords to a song without leaving for
// a browser tab. dice cannot give them that. Per-song chord sheets are a
// licensed database and a request to somebody's server, and this app does not
// make outbound requests with what you are working on.
//
// What it can give, offline and immediately, is the progression underneath the
// song. Most of what people search for is a shape with a name: a doo-wop turn,
// a twelve-bar blues, the four chords half of pop is built on. Those are common
// property, they transpose into any key, and they are what you actually type
// into the progression box.
//
// So the search takes a name, a feel, a roman numeral, or a chord symbol you
// typed yourself, and answers in the key you are playing in.

import { NOTE_NAMES } from "./music";

export interface ProgressionStep {
  /** Semitones above the tonic. */
  offset: number;
  /** Chord quality suffix the parser understands: "", "m", "7", "maj7". */
  quality: string;
}

export interface NamedProgression {
  id: string;
  name: string;
  /** The shape in roman numerals, for people who read them. */
  roman: string;
  steps: ProgressionStep[];
  /** Words someone might search with, beyond the name. */
  tags: string[];
  /** One line on where it is heard. */
  note: string;
}

const step = (offset: number, quality = ""): ProgressionStep => ({ offset, quality });

/**
 * The library.
 *
 * Chosen for how often someone sits down meaning to play one of them, not for
 * coverage of the theory. Each is the shape itself, with no claim about any
 * particular recording.
 */
export const PROGRESSIONS: NamedProgression[] = [
  {
    id: "axis",
    name: "Four chords",
    roman: "I - V - vi - IV",
    steps: [step(0), step(7), step(9, "m"), step(5)],
    tags: ["pop", "axis", "happy", "anthem", "four chord"],
    note: "The turn a great deal of pop sits on.",
  },
  {
    id: "axis-vi",
    name: "Sensitive female",
    roman: "vi - IV - I - V",
    steps: [step(9, "m"), step(5), step(0), step(7)],
    tags: ["pop", "ballad", "sad", "axis"],
    note: "The same four chords started on the minor.",
  },
  {
    id: "doowop",
    name: "Doo-wop",
    roman: "I - vi - IV - V",
    steps: [step(0), step(9, "m"), step(5), step(7)],
    tags: ["fifties", "50s", "ballad", "sweet", "oldies"],
    note: "Fifties ballads, and most slow dances since.",
  },
  {
    id: "blues12",
    name: "Twelve-bar blues",
    roman: "I7 - IV7 - I7 - V7",
    steps: [step(0, "7"), step(5, "7"), step(0, "7"), step(7, "7")],
    tags: ["blues", "rock and roll", "shuffle", "swing"],
    note: "Four of the twelve bars; repeat and resolve as you like.",
  },
  {
    id: "jazz251",
    name: "Two five one",
    roman: "ii7 - V7 - Imaj7",
    steps: [step(2, "m7"), step(7, "7"), step(0, "maj7")],
    tags: ["jazz", "standard", "turnaround", "bebop"],
    note: "The sentence most jazz standards are built out of.",
  },
  {
    id: "andalusian",
    name: "Andalusian cadence",
    roman: "i - VII - VI - V",
    steps: [step(0, "m"), step(10), step(8), step(7)],
    tags: ["flamenco", "spanish", "minor", "dramatic", "descending"],
    note: "A minor walk down to the dominant.",
  },
  {
    id: "canon",
    name: "Canon",
    roman: "I - V - vi - iii - IV - I - IV - V",
    steps: [
      step(0),
      step(7),
      step(9, "m"),
      step(4, "m"),
      step(5),
      step(0),
      step(5),
      step(7),
    ],
    tags: ["pachelbel", "classical", "wedding", "descending"],
    note: "Pachelbel's, and every song that has borrowed it.",
  },
  {
    id: "minor-pop",
    name: "Minor pop",
    roman: "i - VI - III - VII",
    steps: [step(0, "m"), step(8), step(3), step(10)],
    tags: ["minor", "sad", "moody", "pop"],
    note: "The minor key's answer to the four chords.",
  },
  {
    id: "lament",
    name: "Lament",
    roman: "i - VII - VI - VII",
    steps: [step(0, "m"), step(10), step(8), step(10)],
    tags: ["minor", "folk", "dark", "rock"],
    note: "A minor rock from the tonic and back.",
  },
  {
    id: "mixolydian",
    name: "Flat seven rock",
    roman: "I - VII - IV - I",
    steps: [step(0), step(10), step(5), step(0)],
    tags: ["rock", "mixolydian", "classic rock", "riff"],
    note: "The flat seventh that makes a major key sound like a riff.",
  },
  {
    id: "plagal",
    name: "Plagal turn",
    roman: "I - IV - I - V",
    steps: [step(0), step(5), step(0), step(7)],
    tags: ["gospel", "hymn", "country", "simple"],
    note: "Three chords, in the order hymns and country use them.",
  },
  {
    id: "royal-road",
    name: "Royal road",
    roman: "IV - V - iii - vi",
    steps: [step(5, "maj7"), step(7, "7"), step(4, "m7"), step(9, "m")],
    tags: ["jpop", "anime", "city pop", "bittersweet", "japanese"],
    note: "The lift and fall that runs through Japanese pop.",
  },
  {
    id: "circle",
    name: "Circle of fifths",
    roman: "vi - ii - V - I",
    steps: [step(9, "m7"), step(2, "m7"), step(7, "7"), step(0, "maj7")],
    tags: ["jazz", "standard", "resolving", "walk"],
    note: "Each chord a fifth below the last, all the way home.",
  },
  {
    id: "three-chord",
    name: "Three chords",
    roman: "I - IV - V",
    steps: [step(0), step(5), step(7)],
    tags: ["folk", "punk", "country", "campfire", "simple", "rock"],
    note: "The first three anyone learns, and most of what they need.",
  },
  {
    id: "power-ballad",
    name: "Power ballad",
    roman: "I - iii - IV - V",
    steps: [step(0), step(4, "m"), step(5), step(7)],
    tags: ["ballad", "eighties", "80s", "rock", "big"],
    note: "A slow climb to the dominant, for the chorus.",
  },
  {
    id: "third-lift",
    name: "Major third lift",
    roman: "I - III - IV - iv",
    steps: [step(0), step(4), step(5), step(5, "m")],
    tags: ["alternative", "nineties", "90s", "uneasy", "chromatic"],
    note: "A bright third, then a minor fourth that pulls the floor away.",
  },
  {
    id: "blues-turn",
    name: "Blues turnaround",
    roman: "I7 - VI7 - ii7 - V7",
    steps: [step(0, "7"), step(9, "7"), step(2, "m7"), step(7, "7")],
    tags: ["blues", "jazz", "turnaround", "swing", "shuffle"],
    note: "The last two bars of a blues, on its way back round.",
  },
  {
    id: "aeolian",
    name: "Minor cadence",
    roman: "i - iv - v",
    steps: [step(0, "m"), step(5, "m"), step(7, "m")],
    tags: ["minor", "folk", "sad", "modal", "medieval"],
    note: "All minor, no leading tone, so it never quite resolves.",
  },
  {
    id: "dorian-vamp",
    name: "Dorian vamp",
    roman: "i - IV - i - IV",
    steps: [step(0, "m7"), step(5), step(0, "m7"), step(5)],
    tags: ["modal", "funk", "jam", "groove", "santana"],
    note: "Two chords to sit on for as long as you like.",
  },
  {
    id: "phrygian-vamp",
    name: "Phrygian vamp",
    roman: "i - II - i - II",
    steps: [step(0, "m"), step(1), step(0, "m"), step(1)],
    tags: ["spanish", "metal", "dark", "modal", "flamenco"],
    note: "A semitone above the tonic, which is where the menace comes from.",
  },
  {
    id: "gospel-four",
    name: "Gospel four",
    roman: "I - I7 - IV - iv",
    steps: [step(0), step(0, "7"), step(5), step(5, "m")],
    tags: ["gospel", "soul", "church", "warm", "gentle"],
    note: "The seventh turns the tonic into a door to the fourth.",
  },
  {
    id: "minor-251",
    name: "Minor two five",
    roman: "iim7b5 - V7 - i",
    steps: [step(2, "m7b5"), step(7, "7"), step(0, "m")],
    tags: ["jazz", "minor", "standard", "noir", "turnaround"],
    note: "The two five one, in a minor key.",
  },
  {
    id: "folk-hymn",
    name: "Hymn",
    roman: "I - vi - I - vi - IV - V",
    steps: [step(0), step(9, "m"), step(0), step(9, "m"), step(5), step(7)],
    tags: ["hymn", "folk", "ballad", "slow", "waltz"],
    note: "A long verse shape that rocks between two chords before it moves.",
  },
  {
    id: "jazz-blues-turn",
    name: "Turnaround",
    roman: "I - vi - ii - V",
    steps: [step(0, "maj7"), step(9, "m7"), step(2, "m7"), step(7, "7")],
    tags: ["jazz", "turnaround", "rhythm changes", "standard"],
    note: "The last two bars of a standard, on a loop.",
  },
];

/** Write a progression out in a key, as the chord box takes it. */
export function progressionInKey(p: NamedProgression, tonic: number): string {
  const root = ((Math.round(tonic) % 12) + 12) % 12;
  return p.steps
    .map((s) => `${NOTE_NAMES[(root + s.offset) % 12]}${s.quality}`)
    .join(" ");
}

export interface ProgressionMatch {
  progression: NamedProgression;
  /** Higher is a better match. */
  score: number;
}

/**
 * Search the library.
 *
 * A name match beats a tag match, and a whole word beats part of one. Scoring
 * the name by its words rather than by the whole string matters as soon as two
 * entries share a word: "blues" should find the twelve-bar before it finds the
 * turnaround, and a prefix bonus on the full name put the turnaround first
 * purely because its name happens to start with the word.
 *
 * Equal scores keep library order, which is roughly how often each one is
 * wanted, and an empty query returns that order unchanged.
 */
export function searchProgressions(query: string, limit = 6): ProgressionMatch[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) {
    return PROGRESSIONS.slice(0, limit).map((progression) => ({ progression, score: 0 }));
  }
  const words = q.split(/\s+/).filter(Boolean);
  const out: ProgressionMatch[] = [];

  for (const progression of PROGRESSIONS) {
    const nameWords = progression.name.toLowerCase().split(/[\s-]+/).filter(Boolean);
    const roman = progression.roman.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (nameWords.includes(word)) score += 6;
      else if (nameWords.some((w) => w.startsWith(word))) score += 3;
      else if (progression.name.toLowerCase().includes(word)) score += 2;
      if (roman.includes(word)) score += 3;
      if (progression.tags.some((t) => t === word)) score += 3;
      else if (progression.tags.some((t) => t.startsWith(word))) score += 2;
      else if (progression.tags.some((t) => t.includes(word))) score += 1;
    }
    if (score > 0) out.push({ progression, score });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
