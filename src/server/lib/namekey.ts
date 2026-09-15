// Search-key normalization per settings_and_rules.md §4:
// NFKC, whitespace collapse, ASCII lowercase, kana auxiliary key.
// Never infer kanji readings; never merge same-name customers.
export function nameKey(input: string): string {
  return input.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Hiragana -> Katakana for the auxiliary reading key (NFKC has already
// folded halfwidth kana into fullwidth katakana).
export function kanaKey(input: string): string {
  return nameKey(input).replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60),
  );
}
