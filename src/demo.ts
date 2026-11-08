import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppEvents, type Attachment, type Message, type ReplyTarget, type Transport } from './model.js';
import { Store } from './store.js';
import type { MediaCache } from './media.js';

export class DemoTransport implements Transport {
  private media = new Map<string, string>();
  constructor(private readonly store: Store, private readonly events: AppEvents, private readonly cache?: MediaCache) {}
  async start(): Promise<void> {
    this.store.completeMuteSync();
    const chat = 'demo-alex@s.whatsapp.net', time = Math.floor(Date.now() / 1000);
    this.store.setSelf({ id: '447700900099@s.whatsapp.net', lid: '140000099@lid' });
    this.store.chat('447700900099@s.whatsapp.net', 'Demo account', time - 400);
    this.store.contact(chat, 'Alex · demo');
    this.store.chat(chat, 'Alex · demo', time);
    this.store.contact('demo-sam@s.whatsapp.net', 'Sam · demo');
    this.store.chat('demo-sam@s.whatsapp.net', 'Sam · demo', time - 100);
    this.store.chat('demo-weekend@g.us', 'Weekend plans · demo', time - 200);
    this.store.put({ key: { remoteJid: chat, id: 'welcome', fromMe: false }, pushName: 'Alex', messageTimestamp: time - 60, message: { conversation: 'Welcome to QuietChat. This is an offline demo; nothing here connects to WhatsApp.' } });
    this.store.put({ key: { remoteJid: chat, id: 'image', fromMe: false }, pushName: 'Alex', messageTimestamp: time - 40, message: { imageMessage: { caption: 'Select this image and press Enter to open it in mpv.', mimetype: 'image/png' } } });
    this.store.put({ key: { remoteJid: chat, id: 'video', fromMe: false }, pushName: 'Alex', messageTimestamp: time - 20, message: { videoMessage: { caption: 'A two-second test video. Media opens only when you select it.', mimetype: 'video/mp4' } } });
    this.media.set('image', fileURLToPath(new URL('../../test/fixtures/demo.png', import.meta.url)));
    this.media.set('video', fileURLToPath(new URL('../../test/fixtures/demo.mp4', import.meta.url)));
    // Synthetic group history exercises saved names, profile-only names and LID mentions.
    this.store.contact('447700900001@s.whatsapp.net', 'Ada (work)');
    this.store.alias('140000001@lid', '447700900001@s.whatsapp.net');
    this.store.put({ key: { remoteJid: 'demo-weekend@g.us', id: 'group-saved' }, participant: '140000001@lid', pushName: 'Ada', messageTimestamp: time - 310,
      message: { conversation: 'Thanks everyone! Looking forward to Saturday.' } });
    this.store.put({ key: { remoteJid: 'demo-weekend@g.us', id: 'group-profile', participant: '140000002@lid' }, pushName: 'Lin', messageTimestamp: time - 300,
      message: { extendedTextMessage: { text: 'Hi @140000001 👋\nCan you share the plan with @140000002 and @140000099? https://example.com/weekend', contextInfo: { mentionedJid: ['140000001@lid', '140000002@lid', '140000099@lid'], quotedMessage: { extendedTextMessage: { text: 'Thanks @140000099!', contextInfo: { mentionedJid: ['140000099@lid'] } } } } } } });
    this.store.put({ key: { remoteJid: 'demo-weekend@g.us', id: 'group-unknown', participant: '144400003@lid' }, messageTimestamp: time - 290,
      message: { conversation: 'A participant whose name has not arrived yet.' } });
    this.events.emit('connection', { phase: 'online', detail: 'Offline demo · no WhatsApp connection · choose Alex to try it' });
    this.events.emit('changed');
  }
  stop(): void {}
  async sendText(chat: string, text: string, reply?: ReplyTarget): Promise<void> {
    this.store.put(generateWAMessageFromContent(chat, { extendedTextMessage: { text } }, { userJid: '447700900099@s.whatsapp.net', messageId: randomUUID(), quoted: this.store.quote(chat, reply) }));
    this.events.emit('changed');
  }
  async sendMedia(chat: string, attachment: Attachment, caption: string, reply?: ReplyTarget): Promise<void> {
    const id = randomUUID();
    // Keep demo messages viewable after a temporary clipboard draft is released.
    const path = this.cache ? await this.cache.save(this.cache.path(chat, id, attachment.kind), createReadStream(attachment.path)) : attachment.path;
    this.store.put(generateWAMessageFromContent(chat, attachment.kind === 'image' ? { imageMessage: { caption, mimetype: attachment.mime } } : { videoMessage: { caption, mimetype: attachment.mime } }, { userJid: '447700900099@s.whatsapp.net', messageId: id, quoted: this.store.quote(chat, reply) }));
    this.media.set(id, path); this.events.emit('changed');
  }
  async react(message: Message, emoji: string): Promise<void> { this.store.reactions({ remoteJid: message.chat, id: message.id }, emoji); this.events.emit('changed'); }
  async download(message: Message): Promise<string> {
    const path = this.media.get(message.id);
    if (!path) throw new Error('Demo media is unavailable.');
    return path;
  }
}
