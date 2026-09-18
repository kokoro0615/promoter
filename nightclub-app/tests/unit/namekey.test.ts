import { describe, expect, it } from 'vitest';
import { kanaKey, nameKey } from '../../src/server/lib/namekey.js';

describe('nameKey', () => {
  it('normalizes NFKC width, case and whitespace', () => {
    expect(nameKey('Ｙａｍａｄａ　Ｔａｒｏ')).toBe('yamada taro');
    expect(nameKey('  Yamada   Taro ')).toBe('yamada taro');
    expect(nameKey('山田 太郎')).toBe('山田 太郎');
  });
  it('collapses all whitespace runs to single spaces', () => {
    expect(nameKey('a\t\n b')).toBe('a b');
  });
  it('keeps distinct people distinct (no merging)', () => {
    expect(nameKey('山田 太郎')).not.toBe(nameKey('山田太郎'));
  });
});

describe('kanaKey', () => {
  it('maps hiragana to katakana, preserving name_key shape', () => {
    expect(kanaKey('やまだ たろう')).toBe('ヤマダ タロウ');
    expect(kanaKey('ﾔﾏﾀﾞ ﾀﾛｳ')).toBe('ヤマダ タロウ');
  });
  it('leaves non-kana untouched', () => {
    expect(kanaKey('Yamada')).toBe('yamada');
  });
});
