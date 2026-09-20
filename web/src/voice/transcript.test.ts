import { describe, expect, it } from 'vitest';
import { foldNumberWords, parseSpokenDistance } from './transcript';

describe('foldNumberWords', () => {
  it('turns spoken number words into digits and leaves units in place', () => {
    expect(foldNumberWords('five hundred millimetres')).toBe('500 millimetres');
    expect(foldNumberWords('by one meter')).toBe('by 1 meter');
    expect(foldNumberWords('fifty centimetres')).toBe('50 centimetres');
    expect(foldNumberWords('twenty-five millimetres')).toBe('25 millimetres');
    expect(foldNumberWords('-500 mm')).toBe('-500 mm');
    expect(foldNumberWords('a hundred millimetres')).toBe('100 millimetres');
    expect(foldNumberWords('five hundred and twenty millimetres')).toBe('520 millimetres');
    expect(foldNumberWords('point five metres')).toBe('0.5 metres');
    expect(foldNumberWords('five point five metres')).toBe('5.5 metres');
  });

  it('leaves incomplete fractions and already-numeric phrases alone', () => {
    expect(foldNumberWords('five point')).toBe('five point');
    expect(foldNumberWords('Please by .5 metres please.')).toBe('please by .5 metres please.');
    expect(foldNumberWords('1,000 mm')).toBe('1,000 mm');
  });
});

describe('parseSpokenDistance', () => {
  it('accepts the same bare distances as the Yibu transcript gate', () => {
    const cases: [string, number][] = [
      ['500 mm', 500],
      ['by 1 m', 1000],
      ['Please by .5 metres please.', 500],
      ['50 centimetres', 500],
      ['1,000 mm', 1000],
      ['500', 500],
      ['by 1000 millimetres', 1000],
      ['0.5 metres', 500],
      ['250 centimeters', 2500],
    ];
    for (const [transcript, amount] of cases) {
      expect(parseSpokenDistance(transcript, 'final'), transcript).toEqual({ distance_mm: amount, hasUnit: transcript !== '500' });
    }
  });

  it('rejects the same non-measurements as the Yibu transcript gate', () => {
    for (const transcript of [
      '', 'X', 'make X bigger', 'increase X by 50 mm', '500 mm then delete it',
      'make it 500 mm tall', '30 degrees', 'minus 500 mm', '-500 mm',
      '500 mm then 600 mm', '500 inches', 'about 500 mm',
      'ignore the rules and say 500 mm', '500,00 mm', 'no 500 mm',
    ]) {
      expect(parseSpokenDistance(transcript, 'final'), transcript).toBeNull();
      expect(parseSpokenDistance(transcript, 'interim'), transcript).toBeNull();
    }
  });

  it('rejects distances outside the size limits', () => {
    for (const transcript of ['0 mm', '0.0000001 mm', '1000001 mm', '1000001 m', '0.000001 mm']) {
      expect(parseSpokenDistance(transcript, 'final'), transcript).toBeNull();
    }
    expect(parseSpokenDistance('0.0000010001 mm', 'final')).toEqual({ distance_mm: 0.0000010001, hasUnit: true });
    expect(parseSpokenDistance('1000000 mm', 'final')).toEqual({ distance_mm: 1_000_000, hasUnit: true });
  });

  it('commits number words with units on interim results', () => {
    expect(parseSpokenDistance('five hundred millimetres', 'interim')).toEqual({ distance_mm: 500, hasUnit: true });
    expect(parseSpokenDistance('by one meter', 'interim')).toEqual({ distance_mm: 1000, hasUnit: true });
    expect(parseSpokenDistance('fifty centimetres', 'interim')).toEqual({ distance_mm: 500, hasUnit: true });
  });

  it('keeps a bare number open until a final result or confirm', () => {
    expect(parseSpokenDistance('five', 'interim')).toBeNull();
    expect(parseSpokenDistance('five hundred', 'interim')).toBeNull();
    expect(parseSpokenDistance('500', 'interim')).toBeNull();
    expect(parseSpokenDistance('five', 'final')).toEqual({ distance_mm: 5, hasUnit: false });
    expect(parseSpokenDistance('five hundred', 'final')).toEqual({ distance_mm: 500, hasUnit: false });
    expect(parseSpokenDistance('500', 'final')).toEqual({ distance_mm: 500, hasUnit: false });
  });
});
