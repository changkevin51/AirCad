import { MAX_DIMENSION_MM, MIN_DIMENSION_MM } from './commands';

export type SpeechCommitMode = 'interim' | 'final';

export interface SpokenMeasurement {
  distance_mm: number;
  hasUnit: boolean;
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const SCALE: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1_000_000,
};

const MEASUREMENT = /^(?:please\s+)?(?:by\s+)?(?<amount>(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+)\s*(?<unit>millimet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|mm|cm|m)?(?:\s+please)?[.!]?$/i;

const validDistance = (value: number): boolean => Number.isFinite(value) && value > MIN_DIMENSION_MM && value <= MAX_DIMENSION_MM;

const isDigitToken = (token: string): boolean => /^[0-9]|^[.][0-9]/.test(token);

const isFractionDigit = (token: string): boolean => Object.hasOwn(SMALL, token) && SMALL[token] <= 9
  && token !== 'ten' && token !== 'eleven' && token !== 'twelve' && token !== 'thirteen'
  && token !== 'fourteen' && token !== 'fifteen' && token !== 'sixteen' && token !== 'seventeen'
  && token !== 'eighteen' && token !== 'nineteen';

const formatPlainNumber = (value: number): string => {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(12).replace(/\.?0+$/, '');
};

function parseNumberTokens(tokens: string[], start: number): { value: number; consumed: number } | null {
  let index = start;
  let total = 0;
  let current = 0;
  let seen = false;
  let fraction = '';
  let inFraction = false;
  let last: 'none' | 'small' | 'scale' | 'point' | 'and' | 'article' = 'none';

  if (tokens[index] === 'a' || tokens[index] === 'an') {
    index += 1;
    last = 'article';
  }

  while (index < tokens.length) {
    const word = tokens[index];
    if (word === 'and' && seen && !inFraction) {
      index += 1;
      last = 'and';
      continue;
    }
    if (word === 'point' || word === 'dot') {
      if (inFraction) break;
      inFraction = true;
      index += 1;
      last = 'point';
      continue;
    }
    if (inFraction) {
      if (!isFractionDigit(word)) break;
      fraction += String(SMALL[word]);
      index += 1;
      last = 'small';
      seen = true;
      continue;
    }
    if (Object.hasOwn(SMALL, word)) {
      current += SMALL[word];
      seen = true;
      index += 1;
      last = 'small';
      continue;
    }
    if (word === 'hundred') {
      if (!seen && last === 'article') {
        current = 1;
        seen = true;
      }
      if (current === 0) break;
      current *= 100;
      index += 1;
      last = 'scale';
      continue;
    }
    if (word === 'thousand' || word === 'million') {
      const scale = SCALE[word];
      if (current === 0) {
        if (last === 'article' || !seen) current = 1;
        else break;
      }
      total += current * scale;
      current = 0;
      seen = true;
      index += 1;
      last = 'scale';
      continue;
    }
    break;
  }

  if (!seen || last === 'point' || last === 'and' || last === 'article') return null;
  let value = total + current;
  if (fraction) value += Number(`0.${fraction}`);
  if (!Number.isFinite(value)) return null;
  return { value, consumed: index - start };
}

export function foldNumberWords(text: string): string {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return '';
  const punct = /[.!]$/.test(trimmed) ? trimmed.slice(-1) : '';
  const body = (punct ? trimmed.slice(0, -1) : trimmed).trim().replace(/([a-z])-([a-z])/g, '$1 $2');
  const tokens = body.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const canStart = token === 'a' || token === 'an' || Object.hasOwn(SMALL, token) || Object.hasOwn(SCALE, token)
      || token === 'point' || token === 'dot';
    if (canStart && !isDigitToken(token)) {
      const parsed = parseNumberTokens(tokens, index);
      if (parsed && parsed.consumed > 0) {
        out.push(formatPlainNumber(parsed.value));
        index += parsed.consumed;
        continue;
      }
    }
    out.push(token);
    index += 1;
  }
  return `${out.join(' ')}${punct}`;
}

export function explicitMeasurement(transcript: string): SpokenMeasurement | null {
  const match = foldNumberWords(transcript).match(MEASUREMENT);
  if (!match || !match.groups) return null;
  const unit = (match.groups.unit ?? 'mm').toLowerCase();
  const factor = unit === 'cm' || unit.startsWith('centimet') ? 10 : unit === 'm' || unit.startsWith('met') ? 1000 : 1;
  const amount = Number(match.groups.amount.replace(/,/g, '')) * factor;
  if (!Number.isFinite(amount)) return null;
  return { distance_mm: amount, hasUnit: Boolean(match.groups.unit) };
}

export function parseSpokenDistance(transcript: string, mode: SpeechCommitMode): SpokenMeasurement | null {
  const parsed = explicitMeasurement(transcript);
  if (!parsed || !validDistance(parsed.distance_mm)) return null;
  if (mode === 'interim' && !parsed.hasUnit) return null;
  return parsed;
}

export function pickMeasurement(transcripts: readonly string[], mode: SpeechCommitMode): SpokenMeasurement | null {
  for (const text of transcripts) {
    const parsed = parseSpokenDistance(text, mode);
    if (parsed) return parsed;
  }
  return null;
}
