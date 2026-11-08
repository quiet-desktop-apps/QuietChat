// Private JSON-lines IPC: stdout contains protocol frames only, never library logs.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { normalizeMessageContent } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { AppEvents, type Message, type Transport, type ReplyTarget } from './model.js';
import { Store, PAGE_SIZE } from './store.js';
import { acquireLock, dataDirectory } from './paths.js';
import { DemoTransport } from './demo.js';
import { WhatsAppTransport } from './transport.js';
import { inspectAttachment, MediaCache, Viewer } from './media.js';
import { NativeAssets, boundedFetch, pageMetadata } from './native-assets.js';

const output = process.stdout.write.bind(process.stdout);
const emit = (type: string, data: object = {}) => output(JSON.stringify({ type, ...data }) + '\n');
const discard = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
globalThis.console = new Console({ stdout: discard, stderr: discard });
process.umask(0o077);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { demo: { type: 'boolean' }, 'data-dir': { type: 'string' } } });
  const temporary = values.demo ? mkdtempSync(join(tmpdir(), 'quietchat-native-demo-')) : undefined;
  const directory = dataDirectory(temporary || values['data-dir']);
  const unlock = acquireLock(directory);
  const store = new Store(join(directory, 'quietchat.db')); store.prune();
  const cache = new MediaCache(join(directory, 'media'));
  const assets = new NativeAssets(join(directory, 'native-previews'));
  try { await cache.init(); await assets.init(); }
  catch (error) { store.close(); unlock(); if (temporary) rmSync(temporary, { recursive: true, force: true }); throw error; }
  const events = new AppEvents();
  const transport: Transport = values.demo ? new DemoTransport(store, events, cache) : new WhatsAppTransport(store, events, cache);
  const viewer = new Viewer(message => emit('notice', { message }));
  const qrPath = join(directory, 'native-pairing.png');
  const settingsPath = join(directory, 'native-settings.json');
  let settings = { notifications: true, background: true, thumbnails: true };
  try { const saved = JSON.parse(await readFile(settingsPath, 'utf8')); for (const key of Object.keys(settings) as (keyof typeof settings)[]) if (typeof saved[key] === 'boolean') settings[key] = saved[key]; } catch {}
  let closing = false, generation = 0, pending = 0, changed: NodeJS.Timeout | undefined;
  function shutdown(): void {
    if (closing) return;
    closing = true; clearTimeout(changed); transport.stop(); viewer.close();
    rmSync(qrPath, { force: true }); store.close(); unlock();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    process.exit(0);
  }
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); process.stdin.once('end', shutdown);
  process.once('uncaughtException', () => { emit('fatal', { message: 'The connection stopped unexpectedly. Reopen QuietChat; the saved session is retained.' }); shutdown(); });
  process.once('unhandledRejection', () => { emit('fatal', { message: 'An internal connection error occurred. Reopen QuietChat.' }); shutdown(); });
  events.on('connection', connection => emit('connection', { connection }));
  events.on('notice', message => emit('notice', { message }));
  let unreadRevision = 0;
  const unreadState = () => ({ revision: unreadRevision, unread: store.unread(), unread_chats: store.unreadChats() });
  events.on('changed', () => { unreadRevision++; if (!changed) changed = setTimeout(() => { changed = undefined; emit('changed', unreadState()); }, 120); });
  events.on('incoming', message => {
    unreadRevision++;
    const raw = store.raw({ remoteJid: message.chat, id: message.id });
    emit('incoming', { message: { ...message, text: message.text.slice(0,300), parts: undefined, raw: undefined }, chat_name: store.displayName(message.chat) || message.chat,
      avatar_id: message.senderId || raw?.key.participant || message.chat, ...unreadState() });
  });
  events.on('qr', qr => {
    const own = ++generation;
    if (!qr) { void unlink(qrPath).catch(() => {}); emit('qr', { path: null }); return; }
    void QRCode.toFile(qrPath, qr, { width: 360, margin: 4, errorCorrectionLevel: 'M' }).then(() => {
      if (own === generation && !closing) emit('qr', { path: qrPath });
    }).catch(() => emit('notice', { message: 'Could not render pairing QR.' }));
  });
  const getMessage = (chat: string, id: string): Message => {
    const message = store.message(chat,id); if (!message) throw new Error('This message is no longer stored.'); return message;
  };
  const messageView = (message: Message) => {
    const content = normalizeMessageContent(store.raw({ remoteJid: message.chat, id: message.id })?.message);
    const link = content?.extendedTextMessage;
    let remaining = 16000;
    const parts = message.parts?.flatMap(part => {
      const text = part.text.slice(0, remaining); remaining -= text.length;
      return text ? [{ ...part, text }] : [];
    });
    return { ...message, text: message.text.slice(0,16000), parts, raw: undefined,
      preview: link?.title || link?.description ? { title: link.title?.slice(0,160), description: link.description?.slice(0,400), url: link.matchedText } : undefined,
      thumbnail: !!(content?.imageMessage?.jpegThumbnail || content?.videoMessage?.jpegThumbnail || link?.jpegThumbnail || values.demo && (message.kind === 'image' || message.kind === 'video')) };
  };
  async function handle(command: Record<string, unknown>): Promise<unknown> {
    const action = String(command.action), chat = String(command.chat || ''), id = String(command.message || '');
    const reply = command.reply as ReplyTarget | undefined;
    switch (action) {
      case 'chats': return { chats: command.contacts ? store.listContacts(String(command.search || '')) : store.listChats(String(command.search || '')), ...unreadState() };
      case 'messages': {
        const offset = Math.max(0, Math.floor(Number(command.offset) || 0));
        return { chat, offset, messages: store.messages(chat, offset).map(messageView), page_size: PAGE_SIZE, name: store.displayName(chat) || chat };
      }
      case 'person': return store.directChat(String(command.person || ''));
      case 'read': store.markViewed(chat); events.emit('changed'); return unreadState();
      case 'send': {
        if (String(command.text || '').length > 16000) throw new Error('Messages are limited to 16,000 characters.');
        if (command.path) await transport.sendMedia(chat, await inspectAttachment(String(command.path)), String(command.text || ''), reply);
        else await transport.sendText(chat, String(command.text || ''), reply);
        return {};
      }
      case 'react': await transport.react(getMessage(chat,id), String(command.emoji || '').slice(0,32)); return {};
      case 'attachment': return inspectAttachment(String(command.path));
      case 'media': { const message = getMessage(chat,id); const path = await transport.download(message); viewer.open(path, message.kind === 'video' ? 'video' : 'image'); return {}; }
      case 'previewAttachment': { const attachment = await inspectAttachment(String(command.path)); viewer.open(attachment.path, attachment.kind); return {}; }
      case 'thumbnail': {
        const message = getMessage(chat,id), content = normalizeMessageContent(store.raw({ remoteJid: chat, id })?.message);
        const embedded = content?.imageMessage?.jpegThumbnail || content?.videoMessage?.jpegThumbnail || content?.extendedTextMessage?.jpegThumbnail;
        const key = `message:${chat}:${id}`;
        const cached = await assets.cached(key); if (cached) return { path: cached };
        if (embedded?.length) return { path: await assets.thumbnail(key, Buffer.from(embedded)) };
        if (values.demo || command.download) return { path: await assets.thumbnail(key, await transport.download(message)) };
        return { path: null };
      }
      case 'avatar': {
        if (values.demo) return { path: await assets.thumbnail('demo-avatar', fileURLToPath(new URL('../../test/fixtures/demo.png', import.meta.url))) };
        const cached = await assets.cached(`avatar:${chat}`); if (cached) return { path: cached };
        const url = await (transport as WhatsAppTransport).profilePicture(chat);
        if (!url) return { path: null };
        return { path: await assets.thumbnail(`avatar:${chat}`, await boundedFetch(url, 'image/*')) };
      }
      case 'urlPreview': {
        const url = String(command.url);
        if (values.demo) return { url, title: 'A native link preview', description: 'Offline preview. No website was contacted.', path: await assets.thumbnail('demo-link', fileURLToPath(new URL('../../test/fixtures/demo.png', import.meta.url))) };
        const html = await boundedFetch(url, 'text/html');
        const metadata = pageMetadata(html.toString('utf8'), url);
        let path: string | undefined;
        if (metadata.image) try { path = await assets.thumbnail(`url:${url}`, await boundedFetch(metadata.image, 'image/*')); } catch {}
        return { ...metadata, path };
      }
      case 'settings': {
        for (const key of Object.keys(settings) as (keyof typeof settings)[]) if (typeof command[key] === 'boolean') settings[key] = command[key] as boolean;
        await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 }); return settings;
      }
      case 'stats': return { rss: process.memoryUsage().rss, unread: store.unread() };
      case 'demoQr': {
        if (!values.demo) throw new Error('Only available in offline demo.');
        events.emit('qr', command.clear ? undefined : 'QuietChat-offline-QR-rendering-test'); return {};
      }
      case 'demoIncoming': {
        if (!values.demo) throw new Error('Only available in offline demo.');
        const target = chat || 'demo-sam@s.whatsapp.net', mid = randomUUID();
        store.put({ key: { remoteJid: target, id: mid }, pushName: target.includes('sam') ? 'Sam' : 'Alex', messageTimestamp: Math.floor(Date.now()/1000)+1,
          message: { conversation: String(command.text || 'A new message while QuietChat is in the tray. 👋') } }, true);
        events.emit('incoming', getMessage(target,mid)); events.emit('changed'); return {};
      }
      case 'quit': shutdown(); return {};
      default: throw new Error('Unknown native command.');
    }
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    if (input.length > 128 * 1024) { emit('fatal', { message: 'Invalid oversized command.' }); shutdown(); return; }
    let end: number;
    while ((end = input.indexOf('\n')) >= 0) {
      const line = input.slice(0,end); input = input.slice(end+1);
      let command: Record<string,unknown>;
      try { command = JSON.parse(line); } catch { emit('notice', { message: 'Invalid native command.' }); continue; }
      if (pending >= 8) { emit('response', { id: command.id, error: 'The connection is busy; try again.' }); continue; }
      pending++;
      void handle(command).then(result => emit('response', { id: command.id, result })).catch(error => emit('response', { id: command.id, error: (error as Error).message })).finally(() => pending--);
    }
  });
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  emit('ready', { directory, version, demo: !!values.demo, settings });
  await transport.start();
  if (values.demo) {
    const now = Math.floor(Date.now()/1000), chat = 'demo-alex@s.whatsapp.net';
    store.put({ key: { remoteJid: chat, id: 'native-own', fromMe: true }, messageTimestamp: now - 10,
      message: { conversation: 'A proper native window.\nSelect any part of this text and press Ctrl+C. ✨' } });
    store.put({ key: { remoteJid: chat, id: 'native-link' }, pushName: 'Alex', messageTimestamp: now - 5,
      message: { extendedTextMessage: { text: 'Let’s keep this simple: https://example.com/native-chat', matchedText: 'https://example.com/native-chat', title: 'Native, lightweight conversations', description: 'A preview card without loading a browser engine.' } } });
    events.emit('changed');
  }
}
main().catch(error => { emit('fatal', { message: (error as Error).message }); process.exit(1); });
