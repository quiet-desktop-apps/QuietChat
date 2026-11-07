import blessed from 'neo-blessed';
import { displayText, singleLine, type Message } from './model.js';
import { webLinks } from './links.js';

type Measure = (text: string) => number;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Keep explicit blank lines and split long URLs without dropping text. Measure
// with the same cell-width rules as the terminal renderer, not UTF-16 length.
export function wrapMessage(text: string, width: number, measure: Measure): string[] {
  width = Math.max(2, width);
  return displayText(text.replace(/\r\n?/g, '\n')).replace(/\t/g, '    ').split('\n').flatMap(paragraph => {
    const lines: string[] = [];
    let line = '', cells = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      const size = measure(segment);
      if (cells + size > width && line) {
        // Prefer a word boundary, retaining whitespace rather than losing it.
        const space = line.lastIndexOf(' ');
        if (space > 0 && space < line.length - 1) {
          lines.push(line.slice(0, space + 1));
          line = line.slice(space + 1); cells = measure(line);
        }
        if (cells + size > width) { lines.push(line); line = ''; cells = 0; }
      }
      line += segment; cells += size;
    }
    lines.push(line);
    return lines;
  });
}

export type LinkCell = { row: number; start: number; end: number; from: number; to: number; url: string };
export type Bubble = { top: number; left: number; width: number; lines: string[]; links: LinkCell[]; mine: boolean };

// Keep source offsets while wrapping, so clicking a URL continuation opens the
// entire original URL rather than a fragment plus the next bubble's padding.
function linkedLines(text: string, width: number, measure: Measure): { lines: string[]; links: LinkCell[] } {
  const clean = displayText(text.replace(/\r\n?/g, '\n')).replace(/\t/g, '    ');
  const urls = webLinks(clean), lines: string[] = [], links: LinkCell[] = [];
  let offset = 0;
  for (const paragraph of clean.split('\n')) {
    for (const line of wrapMessage(paragraph, width, measure)) {
      for (const url of urls) {
        const from = Math.max(0, url.start - offset), to = Math.min(line.length, url.end - offset);
        if (from < to) links.push({ row: lines.length, start: measure(line.slice(0, from)), end: measure(line.slice(0, to)), from, to, url: url.url });
      }
      lines.push(line); offset += line.length;
    }
    offset++; // Explicit paragraph break; soft wraps consume no source character.
  }
  return { lines, links };
}

export function bubbleLinkAt(bubble: Bubble, row: number, column: number): string | undefined {
  return bubble.links.find(link => link.row === row && column >= link.start + 2 && column < link.end + 2)?.url;
}
export function layoutMessages(messages: Message[], columns: number, measure: Measure): Bubble[] {
  const available = Math.max(6, columns);
  const maxText = Math.max(2, Math.floor(available * 0.78) - 4);
  let top = 0;
  return messages.map(message => {
    const time = new Date(message.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const heading = `${message.mine ? 'You' : singleLine(message.sender)} · ${time}`;
    const media = message.kind === 'image' ? '[IMAGE]\n' : message.kind === 'video' ? '[VIDEO]\n' : '';
    const lines = wrapMessage(heading, maxText, measure), links: LinkCell[] = [];
    const sections = [
      ...(message.quote ? [`↪ ${singleLine(message.quote)}`] : []),
      media + message.text,
      ...(message.reactions ? [`Reactions: ${message.reactions}`] : []),
    ];
    for (const section of sections) {
      const wrapped = linkedLines(section, maxText, measure);
      links.push(...wrapped.links.map(link => ({ ...link, row: lines.length + link.row })));
      lines.push(...wrapped.lines);
    }
    const width = Math.min(available, Math.max(...lines.map(measure)) + 4);
    const bubble = { top, left: message.mine ? available - width : 0, width, lines, links, mine: message.mine };
    top += lines.length + 1;
    return bubble;
  });
}

export class Conversation {
  readonly widget: blessed.Widgets.BoxElement;
  selected = -1;
  private rows: Message[] = [];
  private bubbles: Bubble[] = [];

  constructor(options: blessed.Widgets.BoxOptions) {
    this.widget = blessed.box({ ...options, scrollable: true, alwaysScroll: true, keys: false, mouse: true, tags: false, wrap: false });
    this.widget.key('up', () => this.select(this.selected - 1));
    this.widget.key('down', () => this.select(this.selected + 1));
    this.widget.key('home', () => this.select(0));
    this.widget.key('end', () => this.select(this.rows.length - 1));
    this.widget.key('enter', () => this.widget.emit('select'));
    this.widget.key(['C-up', 'C-down'], (_ch, key) => {
      this.widget.scroll(key.name === 'up' ? -1 : 1); this.widget.screen.render();
    });
    this.widget.on('click', (event: { x: number; y: number; ctrl?: boolean; button?: string }) => {
      const row = event.y - Number(this.widget.atop) - Number(this.widget.itop) + this.scrollTop;
      const col = event.x - Number(this.widget.aleft) - Number(this.widget.ileft);
      const index = this.bubbles.findIndex(b => row >= b.top && row < b.top + b.lines.length && col >= b.left && col < b.left + b.width);
      if (event.ctrl && (!event.button || event.button === 'left') && index >= 0) {
        const bubble = this.bubbles[index];
        const url = bubbleLinkAt(bubble, row - bubble.top, col - bubble.left);
        if (url) { this.widget.emit('open link', url); return; }
      }
      this.widget.focus();
      if (index >= 0) this.select(index, false);
      this.widget.screen.render();
    });
  }

  // neo-blessed getScroll() includes its cursor offset; childBase is the
  // actual first visible row when alwaysScroll is enabled.
  private get scrollTop(): number {
    return (this.widget as blessed.Widgets.BoxElement & { childBase: number }).childBase;
  }

  isAtBottom(): boolean {
    return this.scrollTop + Number(this.widget.height) - Number(this.widget.iheight) >= this.widget.getScrollHeight();
  }

  setMessages(rows: Message[], selected: number, follow: boolean): void {
    this.rows = rows; this.selected = rows.length ? selected : -1;
    this.reflow(follow);
  }

  reflow(follow = false): void {
    const previous = this.scrollTop;
    const anchor = this.bubbles.findIndex(b => previous < b.top + b.lines.length + 1);
    const within = anchor >= 0 ? previous - this.bubbles[anchor].top : 0;
    this.bubbles = layoutMessages(this.rows, Number(this.widget.width) - Number(this.widget.iwidth) - 1, text => Number(this.widget.strWidth(text)));
    this.paint();
    const anchored = this.bubbles[anchor];
    this.widget.setScroll(anchored ? anchored.top + Math.min(within, anchored.lines.length - 1) : previous);
    if (follow) this.reveal(true);
    this.widget.screen.render();
  }

  select(index: number, reveal = true): void {
    if (!this.rows.length) return;
    this.selected = Math.max(0, Math.min(index, this.rows.length - 1));
    const scroll = this.scrollTop;
    this.paint(); this.widget.setScroll(scroll);
    if (reveal) this.reveal();
    this.widget.emit('select item'); this.widget.screen.render();
  }

  private reveal(tail = false): void {
    const bubble = this.bubbles[this.selected];
    if (!bubble) return;
    const height = Math.max(1, Number(this.widget.height) - Number(this.widget.iheight));
    const scroll = this.scrollTop, bottom = bubble.top + bubble.lines.length;
    if (tail) this.widget.setScroll(Math.max(0, bottom - height));
    else if (bubble.top < scroll || bubble.lines.length > height) this.widget.setScroll(bubble.top);
    else if (bottom > scroll + height) this.widget.setScroll(bottom - height);
  }

  private paint(): void {
    const lines: string[] = [];
    this.bubbles.forEach((bubble, index) => {
      const selected = index === this.selected;
      const color = bubble.mine ? (selected ? 29 : 23) : (selected ? 24 : 236);
      bubble.lines.forEach((line, row) => {
        const padding = Math.max(0, bubble.width - 4 - Number(this.widget.strWidth(line)));
        let styled = '', position = 0;
        for (const link of bubble.links.filter(link => link.row === row)) {
          styled += line.slice(position, link.from) + '\x1b[4m' + line.slice(link.from, link.to) + '\x1b[24m';
          position = link.to;
        }
        styled += line.slice(position);
        const marker = selected && row === 0 ? '› ' : '  ';
        lines.push(' '.repeat(bubble.left) + `\x1b[48;5;${color}m\x1b[37m` + marker + styled + ' '.repeat(padding + 2) + '\x1b[0m');
      });
      lines.push('');
    });
    lines.pop(); // No trailing blank row beyond the final bubble.
    this.widget.setContent(lines.join('\n'));
  }
}
