import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, normalizeMessageContent, type WASocket, type BaileysEventMap, type Contact } from '@whiskeysockets/baileys';
import pino from 'pino';
import { sqliteAuth } from './auth.js';
import { AppEvents, type Attachment, type Message, type ReplyTarget, type Transport } from './model.js';
import { MediaCache } from './media.js';
import { Store } from './store.js';

export function reconnectDelay(code: number | undefined, attempt: number): number | undefined {
  if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(code!)) return;
  return code === DisconnectReason.restartRequired ? 250 : Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}

export class WhatsAppTransport implements Transport {
  private socket?: WASocket;
  private stopped = false;
  private online = false;
  private timer?: NodeJS.Timeout;
  private attempt = 0;
  private generation = 0;
  private downloading = false;
  private readonly logger = pino({ level: 'silent' });
  private readonly auth;
  constructor(private readonly store: Store, private readonly events: AppEvents, private readonly cache: MediaCache, private readonly createSocket: typeof makeWASocket = makeWASocket) { this.auth = sqliteAuth(store); }
  async start(): Promise<void> { this.stopped = false; this.connect(); }
  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.events.emit('connection', { phase: 'connecting', detail: 'Connecting to WhatsApp…' });
    const socket = this.createSocket({
      auth: this.auth.state, logger: this.logger,
      browser: Browsers.ubuntu('QuietChat'),
      syncFullHistory: false, markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false, enableRecentMessageCache: false,
      connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 30_000,
      shouldIgnoreJid: jid => jid === 'status@broadcast' || jid.endsWith('@newsletter'),
      getMessage: async key => this.store.raw(key)?.message || undefined,
    });
    this.socket = socket;
    const on = <K extends keyof BaileysEventMap>(name: K, handler: (event: BaileysEventMap[K]) => void) => {
      socket.ev.on(name, event => {
        if (this.stopped || generation !== this.generation) return;
        try { handler(event); } catch (error) { this.events.emit('notice', `Could not process ${name}: ${(error as Error).message}`); }
      });
    };
    on('creds.update', () => this.auth.save());
    on('connection.update', update => {
      if (update.qr) {
        this.events.emit('connection', { phase: 'qr', detail: 'Scan the QR code with WhatsApp → Linked devices' });
        this.events.emit('qr', update.qr);
      }
      if (update.connection === 'open') {
        this.online = true; this.attempt = 0; this.auth.save();
        this.events.emit('qr', undefined);
        this.events.emit('connection', { phase: 'online', detail: 'Connected · waiting for messages/history' });
      }
      if (update.connection === 'close') {
        this.online = false; this.events.emit('qr', undefined);
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const delay = reconnectDelay(code, this.attempt++);
        if (delay === undefined) {
          const loggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.badSession;
          this.events.emit('connection', { phase: loggedOut ? 'logged-out' : 'offline', detail: loggedOut ? 'Session ended. Quit, then run ./run.sh --reset-session to pair again.' : `Connection stopped (${code}). Check linked devices on your phone, then restart.` });
          return;
        }
        this.events.emit('connection', { phase: 'offline', detail: `Disconnected · reconnecting in ${delay / 1000}s` });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          try { this.connect(); }
          catch { this.events.emit('connection', { phase: 'offline', detail: 'Could not restart the connection. Quit and restart QuietChat.' }); }
        }, delay);
      }
    });
    const contacts = (items: Partial<Contact>[]) => {
      for (const contact of items) {
        this.store.alias(contact.id, contact.lid);
        this.store.alias(contact.id, contact.phoneNumber);
        this.store.alias(contact.lid, contact.phoneNumber);
        for (const id of [contact.id, contact.lid, contact.phoneNumber]) if (id) {
          this.store.contact(id, contact.notify || contact.verifiedName, 0);
          this.store.contact(id, contact.name);
        }
      }
    };
    on('messaging-history.set', history => {
      this.store.transaction(() => {
        contacts(history.contacts);
        for (const chat of history.chats) if (chat.id) this.store.chat(chat.id, chat.name, Number(chat.conversationTimestamp || 0), chat.unreadCount, chat.ephemeralExpiration);
        for (const message of history.messages) this.store.put(message);
        this.store.prune();
      });
      this.events.emit('changed');
    });
    on('lid-mapping.update', mapping => { this.store.alias(mapping.lid, mapping.pn); this.events.emit('changed'); });
    on('contacts.upsert', items => { contacts(items); this.events.emit('changed'); });
    on('contacts.update', items => { contacts(items); this.events.emit('changed'); });
    on('chats.upsert', items => { for (const c of items) if (c.id) this.store.chat(c.id, c.name, Number(c.conversationTimestamp || 0), c.unreadCount, c.ephemeralExpiration); this.events.emit('changed'); });
    on('chats.update', items => { for (const c of items) if (c.id) this.store.chat(c.id, c.name, Number(c.conversationTimestamp || 0), c.unreadCount, c.ephemeralExpiration); this.events.emit('changed'); });
    on('chats.delete', ids => { for (const id of ids) this.store.removeChat(id); void this.cache.clear().catch(() => this.events.emit('notice', 'Could not clear media cache.')); this.events.emit('changed'); });
    on('messages.upsert', event => {
      const incoming: Message[] = [];
      this.store.transaction(() => {
        for (const m of event.messages) {
          const inserted = this.store.put(m, event.type === 'notify');
          if (inserted && event.type === 'notify' && !m.key.fromMe && m.key.remoteJid && m.key.id) {
            const message = this.store.message(m.key.remoteJid, m.key.id);
            if (message) incoming.push(message);
          }
        }
        this.store.prune();
      });
      for (const message of incoming) this.events.emit('incoming', message);
      this.events.emit('changed');
    });
    on('messages.update', updates => {
      for (const { key, update } of updates) {
        if (update.message !== undefined) {
          this.store.update(key, update.message);
          if (update.message === null && key.remoteJid && key.id) void this.cache.remove(key.remoteJid, key.id);
        }
      }
      this.events.emit('changed');
    });
    on('messages.delete', deletion => {
      if ('keys' in deletion) for (const key of deletion.keys) { this.store.remove(key); if (key.remoteJid && key.id) void this.cache.remove(key.remoteJid, key.id); }
      else { this.store.clearMessages(deletion.jid); void this.cache.clear().catch(() => this.events.emit('notice', 'Could not clear media cache.')); }
      this.events.emit('changed');
    });
    on('messages.reaction', reactions => {
      for (const { key, reaction } of reactions) this.store.reactions(key, reaction.text || '', reaction.key?.fromMe ? 'me' : reaction.key?.participant || reaction.key?.remoteJid || 'unknown');
      this.events.emit('changed');
    });
  }
  stop(): void {
    this.stopped = true; this.online = false; this.generation++;
    clearTimeout(this.timer); this.socket?.end(undefined); this.socket = undefined;
  }
  private connected(): WASocket {
    if (!this.online || !this.socket) throw new Error('Not connected. The draft is kept; send it again after reconnection.');
    return this.socket;
  }
  async profilePicture(chat: string): Promise<string | undefined> {
    return this.connected().profilePictureUrl(chat, 'preview');
  }
  async sendText(chat: string, text: string, reply?: ReplyTarget): Promise<void> {
    if (!text.trim()) return;
    if (text.length > 16000) throw new Error('Messages are limited to 16,000 characters in this prototype.');
    if (this.store.expiration(chat)) throw new Error('Use your phone for chats with disappearing messages in this prototype.');
    const message = await this.connected().sendMessage(chat, { text, linkPreview: null }, { quoted: this.store.quote(chat, reply) });
    if (message) this.store.put(message);
    this.events.emit('changed');
  }
  async sendMedia(chat: string, attachment: Attachment, caption: string, reply?: ReplyTarget): Promise<void> {
    if (this.store.expiration(chat)) throw new Error('Use your phone for chats with disappearing messages in this prototype.');
    if (caption.length > 1024) throw new Error('Image/video captions are limited to 1,024 characters.');
    const socket = this.connected();
    const message = await socket.sendMessage(chat, attachment.kind === 'image' ?
      { image: { url: attachment.path }, mimetype: attachment.mime, caption } :
      { video: { url: attachment.path }, mimetype: attachment.mime, caption }, { quoted: this.store.quote(chat, reply) });
    if (message) this.store.put(message);
    this.events.emit('changed');
  }
  async react(message: Message, emoji: string): Promise<void> {
    const raw = this.store.raw({ remoteJid: message.chat, id: message.id });
    if (!raw) throw new Error('This message is no longer available.');
    await this.connected().sendMessage(message.chat, { react: { text: emoji, key: raw.key } });
    this.store.reactions(raw.key, emoji); this.events.emit('changed');
  }
  async download(message: Message): Promise<string> {
    if (message.kind !== 'image' && message.kind !== 'video') throw new Error('Select an image or video.');
    const raw = this.store.raw({ remoteJid: message.chat, id: message.id });
    if (!raw) throw new Error('The attachment is no longer available.');
    const path = this.cache.path(message.chat, message.id, message.kind);
    if (await this.cache.cached(path)) return path;
    if (this.downloading) throw new Error('Wait for the current download to finish.');
    const socket = this.connected();
    const content = normalizeMessageContent(raw.message);
    const length = Number(content?.imageMessage?.fileLength || content?.videoMessage?.fileLength || 0);
    if (length > this.cache.maxFile) throw new Error('This attachment exceeds the 100 MiB download limit.');
    this.downloading = true;
    try {
      const signal = AbortSignal.timeout(90_000);
      const stream = await downloadMediaMessage(raw, 'stream', { options: { signal } }, { logger: this.logger, reuploadRequest: socket.updateMediaMessage });
      await this.cache.save(path, stream, signal);
      if (!this.store.raw(raw.key)) {
        await this.cache.remove(message.chat, message.id);
        throw new Error('The message was removed while its media was downloading.');
      }
      return path;
    } finally { this.downloading = false; }
  }
}
