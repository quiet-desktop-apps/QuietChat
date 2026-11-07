import blessed from 'neo-blessed';
import qrcode from 'qrcode-terminal';
import { join, basename } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';
import { AppEvents, displayText, singleLine, type Attachment, type Chat, type Message, type Transport } from './model.js';
import { chooseFile, inspectAttachment, Viewer } from './media.js';
import { PAGE_SIZE, Store } from './store.js';
import { TerminalInput } from './terminal-input.js';
import { openWebLink } from './links.js';
import { Conversation } from './conversation.js';
import { configureTerminalUnicode } from './terminal-unicode.js';

configureTerminalUnicode();

type List = blessed.Widgets.ListElement & { selected: number };
const hotkeys = ['C-q', 'C-c', 'C-s', 'tab', 'S-tab', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'];
const emojis = ['👍', '❤️', '😂', '😊', '🙏', '🎉', '🔥', '✅', '👋', '😢'];

// Keep one input listener for the widget's lifetime. neo-blessed readInput()
// installs deferred listeners that can duplicate after rapid modal focus changes.
function editor(options: blessed.Widgets.TextareaOptions, multiline: boolean): blessed.Widgets.TextareaElement {
  const field = blessed.textarea({ ...options, keys: false, inputOnFocus: false });
  field.removeAllListeners('click');
  field.on('click', () => field.focus());
  field.on('focus', () => { field.screen.grabKeys = true; field.screen.program.showCursor(); field.screen.render(); });
  field.on('blur', () => { field.screen.grabKeys = false; field.screen.program.hideCursor(); });
  field.on('paste', (text: string) => {
    const cleaned = displayText(text.replace(/\r\n?/g, '\n')).replace(/\t/g, '    ');
    field.setValue((field.getValue() + (multiline ? cleaned : cleaned.replace(/\n/g, ' '))).slice(0, 16000));
    field.screen.render();
  });
  field.on('keypress', (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
    if (hotkeys.includes(key.full) || key.ctrl || key.meta) return;
    const value = field.getValue();
    if (key.name === 'enter' || key.name === 'linefeed') {
      if (!multiline || (key.name === 'enter' && !key.shift)) { field.emit('submit', value); return; }
      field.setValue(value + '\n');
    } else if (key.name === 'backspace') {
      const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
      field.setValue(value.slice(0, parts.at(-1)?.index ?? 0));
    } else if (key.name === 'escape') {
      if (field.listeners('cancel').length) field.emit('cancel');
      else field.screen.focusNext();
      return;
    } else if (ch && !/[\x00-\x1f\x7f]/.test(ch) && value.length + ch.length <= 16000) {
      field.setValue(value + ch);
    }
    field.screen.render();
  });
  return field;
}

export class TerminalUI {
  private readonly input = new TerminalInput(process.stdin);
  readonly screen = blessed.screen({ input: this.input, terminal: process.env.TERM === 'alacritty' ? 'xterm-256color' : undefined, smartCSR: true, fullUnicode: true, title: 'QuietChat', dockBorders: true, ignoreLocked: hotkeys });
  private readonly header = blessed.box({ parent: this.screen, top: 0, height: 1, width: '100%', style: { fg: 'black', bg: 'cyan', bold: true } });
  private readonly status = blessed.box({ parent: this.screen, top: 1, height: 2, width: '100%', tags: false, style: { fg: 'cyan' } });
  private readonly search = editor({ parent: this.screen, top: 3, left: 0, width: '30%', height: 3, border: 'line', label: ' Search · F9 ', mouse: true, tags: false }, false);
  private readonly chats = blessed.list({ parent: this.screen, top: 6, left: 0, bottom: 3, width: '30%', border: 'line', label: ' Chats · F7 contacts ', mouse: true, keys: true, tags: false, scrollbar: { ch: '│' }, style: { selected: { bg: 'cyan', fg: 'black' }, focus: { border: { fg: 'cyan' } } } }) as List;
  private readonly conversation = new Conversation({ parent: this.screen, top: 3, left: '30%', right: 0, bottom: 7, border: 'line', label: ' Select a chat ', scrollbar: { ch: '│' }, style: { focus: { border: { fg: 'cyan' } } } });
  private readonly messages = this.conversation.widget;
  private readonly replyPreview = blessed.box({ parent: this.screen, left: '30%', right: 0, bottom: 7, height: 2, hidden: true, tags: false, wrap: false, style: { fg: 'cyan' } });
  private readonly composer = editor({ parent: this.screen, left: '30%', right: 0, bottom: 3, height: 4, border: 'line', label: ' Enter sends · Shift+Enter newline ', mouse: true, tags: false, style: { focus: { border: { fg: 'cyan' } } } }, true);
  private readonly hint = blessed.box({ parent: this.screen, bottom: 0, height: 1, width: '100%', tags: false, style: { fg: 'gray' }, content: ' Shift+drag: select · Ctrl+Shift+C/V: copy/paste · Ctrl+click: link · Ctrl+Q: quit' });
  private chatRows: Chat[] = [];
  private messageRows: Message[] = [];
  private current?: Chat;
  private contactsMode = false;
  private offset = 0;
  private attachment?: Attachment;
  private reply?: Message;
  private readonly drafts = new Map<string, { text: string; attachment?: Attachment; reply?: Message }>();
  private busy = false;
  private modal = false;
  private qr?: string;
  private qrBox?: blessed.Widgets.BoxElement;
  private qrWindow = false;
  private qrGeneration = 0;
  private readonly qrPath: string;
  private readonly viewer = new Viewer(message => this.notice(message));
  private readonly qrViewer = new Viewer(message => this.notice(message));
  private connection = 'Starting…';
  private feedback = '';
  private feedbackUntil = 0;
  private refreshTimer?: NodeJS.Timeout;
  private readonly memoryTimer: NodeJS.Timeout;
  private destroyed = false;

  constructor(private readonly store: Store, private readonly transport: Transport, events: AppEvents, directory: string, private readonly demo: boolean, quit: () => void) {
    this.qrPath = join(directory, 'pairing.png');
    this.input.on('paste', (text: string) => this.screen.focused?.emit('paste', text));
    // Scope keyboard disambiguation and bracketed paste to this app's lifetime.
    // Kitty modes belong to the active buffer: flush blessed's buffered switch
    // into the alternate screen before enabling them there.
    this.screen.program.flush();
    this.screen.program.write('\x1b[>1u\x1b[?2004h');
    // X10 loses modified mouse releases in blessed's decoder. SGR preserves
    // Ctrl+click and supports coordinates beyond the old 223-column limit.
    this.screen.program.setMouse({ sgrMouse: true, utfMouse: false }, true);
    const buttons: [string, () => void][] = [
      ['F1 Help', () => this.help()], ['F3 Attach', () => { void this.attach(); }],
      ['F5 Emoji', () => this.emoji(false)], ['F6 React', () => this.emoji(true)],
      ['F8 Reply', () => this.startReply()], ['F10 Preview', () => { void this.openSelected(); }],
    ];
    buttons.forEach(([content, action], i) => {
      const button = blessed.button({ parent: this.screen, bottom: 1, height: 2, left: `${i * (100 / buttons.length)}%`, width: `${100 / buttons.length}%`, content, mouse: true, align: 'center', style: { bg: 'blue', fg: 'white', hover: { bg: 'cyan', fg: 'black' } } });
      button.on('press', () => { if (!this.modal && !this.qr) action(); });
    });
    this.screen.key('C-q', quit);
    this.screen.key('C-c', () => this.notice('Hold Shift and drag to select text, then Ctrl+Shift+C to copy. Ctrl+Shift+V pastes; Ctrl+Q quits.'));
    this.screen.key('f1', () => this.help());
    this.screen.key('f2', () => { void this.openQR(); });
    this.screen.key('C-s', () => { void this.send(); });
    this.screen.key('f8', () => this.startReply());
    this.screen.key('f3', () => { void this.attach(); });
    this.screen.key('f4', () => { void this.attach(true); });
    this.screen.key('f5', () => this.emoji(false));
    this.screen.key('f6', () => this.emoji(true));
    this.screen.key('f7', () => {
      if (this.modal || this.qr) return;
      this.contactsMode = !this.contactsMode; this.search.clearValue(); this.refresh(); this.chats.focus();
    });
    this.screen.key('f9', () => { if (!this.modal && !this.qr) this.search.focus(); });
    this.screen.key('f10', () => { void this.openSelected(); });
    this.screen.key(['tab', 'S-tab'], (_ch, key) => {
      if (this.modal || this.qr) return;
      const fields = [this.chats, this.messages, this.composer, this.search];
      const index = fields.indexOf(this.screen.focused as typeof fields[number]);
      fields[(index + (key.shift ? fields.length - 1 : 1)) % fields.length].focus(); this.screen.render();
    });
    this.search.on('submit', () => { this.refresh(); this.chats.focus(); });
    this.composer.on('submit', () => { void this.send(); });
    this.composer.on('cancel', () => {
      if (this.busy) return;
      if (this.reply) { this.reply = undefined; this.setComposerLabel(); this.screen.render(); }
      else this.screen.focusNext();
    });
    this.search.on('keypress', () => this.queueRefresh());
    this.chats.on('select', (_item, index: number) => this.openChat(this.chatRows[index]));
    this.chats.on('element click', element => {
      const index = this.chats.getItemIndex(element as blessed.Widgets.BoxElement);
      if (index >= 0 && this.current?.id !== this.chatRows[index]?.id) this.openChat(this.chatRows[index]);
    });
    this.messages.on('open link', (url: string) => {
      if (this.modal || this.qr) return;
      void openWebLink(url).catch(error => this.notice((error as Error).message));
    });
    this.messages.on('select', () => { void this.openSelected(); });
    this.messages.key('pageup', () => { this.offset += PAGE_SIZE; this.refreshMessages(); });
    this.messages.key('pagedown', () => { this.offset = Math.max(0, this.offset - PAGE_SIZE); this.refreshMessages(); });
    events.on('changed', () => this.queueRefresh());
    events.on('notice', text => this.notice(text));
    events.on('connection', state => { this.connection = state.detail; this.renderStatus(); });
    events.on('qr', value => this.showQR(value));
    this.screen.on('resize', () => { this.conversation.reflow(); this.layoutQR(); this.renderStatus(); });
    this.memoryTimer = setInterval(() => this.renderStatus(), 2000);
    this.refresh(); this.chats.focus(); this.renderStatus();
  }
  private queueRefresh(): void {
    if (!this.refreshTimer) this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; if (!this.destroyed) this.refresh(); }, 100);
  }
  private renderStatus(): void {
    if (this.destroyed) return;
    const rss = (process.memoryUsage().rss / 1048576).toFixed(0);
    this.header.setContent(` QuietChat${this.demo ? ' · OFFLINE DEMO' : ''}     ${rss} MiB app RSS`);
    const size = Number(this.screen.width) < 80 || Number(this.screen.height) < 24 ? ' · Enlarge terminal to at least 80×24' : '';
    this.status.setContent(` ${singleLine(this.connection)}${size}\n ${Date.now() < this.feedbackUntil ? singleLine(this.feedback) : 'Media opens on demand · F1 help · F2 pairing QR window'}`);
    this.screen.render();
  }
  notice(text: string): void { this.feedback = text; this.feedbackUntil = Date.now() + 12_000; this.renderStatus(); }
  private refresh(): void {
    const selected = this.chatRows[this.chats.selected]?.id;
    const search = this.search.getValue().trim();
    this.chatRows = this.contactsMode ? this.store.listContacts(search) : this.store.listChats(search);
    this.chats.setLabel(this.contactsMode ? ' Contacts · F7 chats ' : ' Chats · F7 contacts ');
    this.chats.setItems(this.chatRows.map(c => `${c.unread ? `(${c.unread}) ` : ''}${singleLine(c.name)}`));
    const index = this.chatRows.findIndex(c => c.id === selected);
    if (index >= 0) this.chats.select(index);
    if (this.current) this.refreshMessages();
    this.screen.render();
  }
  private openChat(chat?: Chat): void {
    if (!chat || this.modal || this.qr) return;
    if (this.busy) { this.notice('Wait for the current action to finish before changing chat.'); return; }
    if (this.current) this.drafts.set(this.current.id, { text: this.composer.getValue(), attachment: this.attachment, reply: this.reply });
    this.current = chat; this.offset = 0;
    this.store.chat(chat.id); this.store.markViewed(chat.id);
    const draft = this.drafts.get(chat.id);
    this.reply = draft?.reply; this.attachment = draft?.attachment; this.composer.setValue(draft?.text || '');
    this.setComposerLabel(); this.refreshMessages(true); this.composer.focus(); this.screen.render();
  }
  private setComposerLabel(): void {
    const target = singleLine(this.current?.name || 'select a chat');
    this.updateReplyPreview();
    this.composer.setLabel(` To ${target} · ${this.attachment ? `${singleLine(basename(this.attachment.path))} · ` : ''}Enter sends · Shift+Enter newline `);
  }
  private refreshMessages(latest = false): void {
    if (!this.current) return;
    this.current.name = this.store.displayName(this.current.id) || this.current.name;
    this.setComposerLabel();
    const selected = latest ? undefined : this.messageRows[this.conversation.selected]?.id;
    const wasLast = this.conversation.selected === this.messageRows.length - 1;
    this.messageRows = this.store.messages(this.current.id, this.offset);
    if (!this.messageRows.length && this.offset) { this.offset = Math.max(0, this.offset - PAGE_SIZE); this.messageRows = this.store.messages(this.current.id, this.offset); }
    this.messages.setLabel(` ${singleLine(this.current.name)} · ${this.offset ? 'older messages' : 'recent messages'} `);
    const index = this.messageRows.findIndex(m => m.id === selected);
    const follow = latest || (wasLast && this.conversation.isAtBottom()) || index < 0;
    this.conversation.setMessages(this.messageRows, follow ? Math.max(0, this.messageRows.length - 1) : index, follow);
    this.screen.render();
  }
  private startReply(): void {
    if (this.modal || this.qr || this.busy) return;
    const selected = this.messageRows[this.conversation.selected];
    if (!selected || selected.chat !== this.current?.id) { this.notice('Select a message to reply to.'); return; }
    try { this.store.quote(selected.chat, selected); }
    catch (error) { this.notice((error as Error).message); return; }
    this.reply = { ...selected, text: selected.text.slice(0, 200) };
    this.setComposerLabel(); this.composer.focus(); this.screen.render();
  }
  private updateReplyPreview(): void {
    const bottom = this.reply ? 9 : 7;
    const follow = this.conversation.isAtBottom();
    if (this.reply) {
      this.replyPreview.setContent(` Reply to ${singleLine(this.reply.mine ? 'You' : this.reply.sender)} · Esc cancels\n ${singleLine(this.reply.text)}`);
      this.replyPreview.show();
    } else this.replyPreview.hide();
    if (this.messages.bottom !== bottom) { this.messages.bottom = bottom; this.conversation.reflow(follow); }
  }
  private async send(): Promise<void> {
    if (this.modal || this.qr || this.busy) return;
    if (!this.current) { this.notice('Select a chat first.'); return; }
    const text = this.composer.getValue(), attachment = this.attachment, reply = this.reply, chat = this.current.id;
    if (!text.trim() && !attachment) return;
    this.busy = true; this.notice(`Sending to ${this.current.name}…`);
    try {
      if (attachment) await this.transport.sendMedia(chat, await inspectAttachment(attachment.path), text, reply);
      else await this.transport.sendText(chat, text, reply);
      if (this.composer.getValue() === text) this.composer.clearValue();
      if (this.attachment === attachment) this.attachment = undefined;
      if (this.reply === reply) this.reply = undefined;
      this.drafts.delete(chat); this.setComposerLabel(); this.notice(this.demo ? 'Added to offline demo. Nothing was sent to WhatsApp.' : 'Submitted to WhatsApp. Recipient delivery/read status is not shown yet.');
    } catch (error) { this.notice(`Send failed; draft kept. ${(error as Error).message}`); }
    finally { this.busy = false; this.composer.focus(); this.screen.render(); }
  }
  private async attach(manual = false): Promise<void> {
    if (this.modal || this.qr || this.busy) return;
    if (!this.current) { this.notice('Select a chat first.'); return; }
    this.modal = true;
    const chat = this.current.id;
    try {
      const path = manual ? await this.prompt('Image/video path (empty removes attachment)', '') : await chooseFile();
      if (path === undefined || this.current?.id !== chat) return;
      this.attachment = path ? await inspectAttachment(path) : undefined;
      this.setComposerLabel();
      this.notice(this.attachment ? `Attached ${basename(this.attachment.path)} (${(this.attachment.size / 1048576).toFixed(1)} MiB). F10 previews; Enter sends to ${this.current.name}.` : 'Attachment removed.');
    } catch (error) { this.notice((error as Error).message); }
    finally { this.modal = false; this.composer.focus(); this.screen.render(); }
  }
  private prompt(label: string, initial: string): Promise<string | undefined> {
    return new Promise(resolve => {
      const prompt = blessed.prompt({ parent: this.screen, top: 'center', left: 'center', width: '90%', height: 9, border: 'line', label: ' QuietChat ', tags: false, keys: true, mouse: true });
      prompt.input(label, initial, (_error, value) => { prompt.destroy(); resolve(value == null ? undefined : value); });
    });
  }
  private async openSelected(): Promise<void> {
    if (this.modal || this.qr || this.busy) return;
    if (this.attachment && this.screen.focused === this.composer) { this.viewer.open(this.attachment.path, this.attachment.kind); return; }
    const m = this.messageRows[this.conversation.selected];
    if (!m || (m.kind !== 'image' && m.kind !== 'video')) { this.notice('Select an image/video message, or focus the composer to preview an attachment.'); return; }
    this.busy = true; this.notice('Opening media…');
    try { const path = await this.transport.download(m); if (!this.destroyed) this.viewer.open(path, m.kind); this.notice('Media opened in mpv. Close the media window when finished.'); }
    catch (error) { this.notice((error as Error).message); }
    finally { this.busy = false; }
  }
  private emoji(reaction: boolean): void {
    if (this.modal || this.qr || this.busy) return;
    const message = this.messageRows[this.conversation.selected];
    if (reaction && !message) { this.notice('Select a message first.'); return; }
    this.modal = true;
    const picker = blessed.list({ parent: this.screen, top: 'center', left: 'center', width: 35, height: 16, border: 'line', label: reaction ? ' React to selected message ' : ' Insert emoji ', items: [...emojis, ...(reaction ? ['Remove my reaction'] : [])], keys: true, mouse: true, style: { selected: { bg: 'cyan', fg: 'black' } } });
    const close = () => { picker.destroy(); this.modal = false; this.composer.focus(); this.screen.render(); };
    picker.on('cancel', close);
    picker.on('select', (_item, index: number) => {
      close(); const emoji = emojis[index] || '';
      if (reaction) {
        this.busy = true;
        void this.transport.react(message!, emoji).catch(error => this.notice((error as Error).message)).finally(() => { this.busy = false; });
      } else { this.composer.setValue(this.composer.getValue() + emoji); this.screen.render(); }
    });
    picker.focus(); this.screen.render();
  }
  private help(): void {
    if (this.modal || this.qr) return;
    this.modal = true;
    const box = blessed.box({ parent: this.screen, top: 'center', left: 'center', width: '90%', height: 24, border: 'line', label: ' QuietChat · Escape to close ', keys: true, mouse: true, tags: false, content:
      ' Click a chat/contact, or use arrows + Enter.\n Tab / Shift+Tab move between panels.\n Enter sends. Shift+Enter adds a new line. Ctrl+S also sends.\n\n F2  Open the current pairing QR in a separate window\n F3  Choose an image/video     F4  Enter a file path\n F5  Insert emoji              F6  React to selected message\n F7  Toggle contacts/chats     F9  Search contacts/chats\n F8  Reply to selected message · Esc cancels the reply\n F10 Open selected media (or preview composer attachment)\n PgUp/PgDn in messages: older/newer pages\n Ctrl+click a link: open it in the default browser\n Shift+drag: select text · Ctrl+Shift+C: copy · Ctrl+Shift+V: paste\n Ctrl+Q: quit\n\n To remove an attachment: F4, clear the path, Enter.\n Drafts stay in memory per chat until you quit.\n No calls, photo editing, read receipts or full-history guarantee.\n Disappearing/view-once content stays on your phone.\n Unofficial WhatsApp client; not affiliated with Meta.' });
    box.key(['escape', 'enter'], () => { box.destroy(); this.modal = false; this.chats.focus(); this.screen.render(); });
    box.focus(); this.screen.render();
  }
  private showQR(value?: string): void {
    this.qr = value; this.qrGeneration++;
    if (!value) {
      this.qrBox?.destroy(); this.qrBox = undefined; this.qrViewer.close(); this.qrWindow = false;
      try { unlinkSync(this.qrPath); } catch {} this.chats.focus(); this.screen.render(); return;
    }
    if (!this.qrBox) this.qrBox = blessed.box({ parent: this.screen, top: 3, bottom: 3, left: 0, width: '100%', tags: false, align: 'center', style: { fg: 'white', bg: 'black' } });
    this.layoutQR(); this.qrBox.focus();
    if (this.qrWindow) void this.openQR();
    this.screen.render();
  }
  private layoutQR(): void {
    if (!this.qr || !this.qrBox) return;
    qrcode.generate(this.qr, { small: true }, code => {
      const rows = code.trimEnd().split('\n');
      const fits = rows.length + 5 <= Number(this.screen.height) - 6 && Math.max(...rows.map(row => row.length)) + 4 <= Number(this.screen.width);
      this.qrBox!.setContent(fits ? `\nWhatsApp → Linked devices → Link a device\n\n${code}\nQR refreshes automatically · F2 opens a larger QR window` : '\n\nScan to link QuietChat\n\nPress F2 to open a large QR image window,\nor enlarge this terminal.\n\nOn your phone: WhatsApp → Linked devices → Link a device\n\nThe QR refreshes automatically.');
    });
  }
  private async openQR(): Promise<void> {
    if (!this.qr) { this.notice('No pairing QR is active. A saved session reconnects automatically.'); return; }
    const generation = this.qrGeneration, value = this.qr;
    try {
      const QRCode = await import('qrcode');
      const png = await QRCode.toBuffer(value, { type: 'png', width: 640, margin: 4, errorCorrectionLevel: 'M' });
      if (generation !== this.qrGeneration || this.destroyed) return;
      writeFileSync(this.qrPath, png, { mode: 0o600 });
      this.qrWindow = true; this.qrViewer.open(this.qrPath, 'image');
    } catch (error) { this.notice(`Could not open QR window: ${(error as Error).message}`); }
  }
  destroy(): void {
    this.destroyed = true; clearInterval(this.memoryTimer); clearTimeout(this.refreshTimer);
    this.viewer.close(); this.qrViewer.close(); this.qrGeneration++;
    try { unlinkSync(this.qrPath); } catch {}
    this.screen.program.flush();
    this.screen.program.write('\x1b[<u\x1b[?2004l');
    this.screen.destroy(); this.input.disconnect();
  }
}
