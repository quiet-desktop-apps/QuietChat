import unicode from 'neo-blessed/lib/unicode.js';

let configured = false;
/** Keep blessed's layout and incremental renderer in agreement with Alacritty.
 * Its bundled Unicode tables predate modern emoji and count 🍻/👍 as one cell,
 * although the terminal advances two. Subsequent relative cursor moves then
 * erase/write the wrong columns, leaving fragments of previous frames behind.
 */
export function configureTerminalUnicode(): void {
  if (configured) return;
  configured = true;
  const previousWidth = unicode.charWidth;
  const emoji = /^(?!\p{Regional_Indicator})\p{Emoji_Presentation}$/u;
  unicode.charWidth = (value, index = 0) => {
    const point = typeof value === 'number' ? value : value.codePointAt(index);
    if (point !== undefined && emoji.test(String.fromCodePoint(point))) return 2;
    return previousWidth(value, index);
  };
  // Regional indicators use one cell each (two for a flag pair).
  // parseContent must reserve the same extra cell that draw() will consume.
  // Retain the existing BMP rules and supplementary CJK support under /u.
  unicode.chars.all = new RegExp(`(${unicode.chars.all.source.slice(1, -1)}|[\\u{20000}-\\u{3fffd}]|(?!\\p{Regional_Indicator})\\p{Emoji_Presentation})`, 'gu');
}
