import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { DisconnectReason, generateWAMessageFromContent, normalizeMessageContent, type AnyMessageContent, type MiscMessageGenerationOptions, type WAMessage, type WASocket, type SocketConfig } from '@whiskeysockets/baileys';
import { Store, PAGE_SIZE } from '../src/store.js';
import { sqliteAuth } from '../src/auth.js';
import { AppEvents, displayText, singleLine } from '../src/model.js';
import { inspectAttachment, MediaCache } from '../src/media.js';
import { acquireLock, dataDirectory } from '../src/paths.js';
import { reconnectDelay, WhatsAppTransport } from '../src/transport.js';
import { TerminalInput, legacyKey } from '../src/terminal-input.js';
import { configureTerminalUnicode } from '../src/terminal-unicode.js';
import unicode from 'neo-blessed/lib/unicode.js';
import { webLinks, openWebLink } from '../src/links.js';
import { bubbleLinkAt, layoutMessages, wrapMessage } from '../src/conversation.js';
import { NativeAssets, pageMetadata, publicAddress } from '../src/native-assets.js';

test('desktop notifications only originate from new incoming notifications, never history, duplicates or our own messages', async () => {
  const store = new Store(':memory:'), events = new AppEvents(), ev = new EventEmitter();
  const received: string[] = [];
  events.on('incoming', item => received.push(item.id));
  const adapter = new WhatsAppTransport(store, events, new MediaCache('/unused'), () => ({ ev, end() {} }) as unknown as WASocket);
  try {
    await adapter.start();
    const first = message('new-message');
    ev.emit('messages.upsert', { type: 'notify', messages: [first] });
    ev.emit('messages.upsert', { type: 'notify', messages: [first] });
    ev.emit('messages.upsert', { type: 'append', messages: [message('history')] });
    ev.emit('messages.upsert', { type: 'notify', messages: [{ ...message('ours'), key: { remoteJid: chat, id: 'ours', fromMe: true } }] });
    assert.deepEqual(received, ['new-message']);
    assert.equal(store.message(chat, 'new-message')?.id, 'new-message');
    assert.equal(store.unread(), 1);
    assert.deepEqual(store.unreadChats(), { [chat]: 1 });
    store.chat('another@s.whatsapp.net', 'Other chat', 0, 3);
    ev.emit('chats.update', [{ id: chat, unreadCount: 0 }]);
    assert.deepEqual(store.unreadChats(), { 'another@s.whatsapp.net': 3 }, 'Read sync must clear only its own chat');
    ev.emit('chats.update', [{ id: 'another@s.whatsapp.net', unreadCount: 0 }]);
    assert.deepEqual(store.unreadChats(), {});
    store.markViewed(chat); assert.equal(store.unread(), 0);
  } finally { adapter.stop(); store.close(); }
});

test('native previews bound metadata, restrict private addresses and clean failed decodes', async () => {
  const page = pageMetadata('<title>Fallback</title><meta content="Hello &amp; world" property="og:title"><meta name="description" content="' + 'x'.repeat(800) + '"><meta property="og:image" content="/cover.png">', 'https://example.test/article');
  assert.equal(page.title, 'Hello & world'); assert.equal(page.description.length, 400);
  assert.equal(page.image, 'https://example.test/cover.png');
  for (const address of ['127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-assets-'));
  try {
    const assets = new NativeAssets(directory); await assets.init();
    await assert.rejects(assets.thumbnail('bad', Buffer.from('not an image')), /cannot be previewed/);
    assert.deepEqual(await readdir(directory), []);
    const path = await assets.thumbnail('good', 'test/fixtures/demo.png');
    assert.equal((await readFile(path)).subarray(1,4).toString(), 'PNG');
    assert.equal(await assets.cached('good'), path);
    assert.ok((await stat(path)).size < 512 * 1024);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conversation wrapping preserves explicit lines, blank lines and long URLs without truncation', () => {
  const width = (text: string) => [...text].length;
  assert.deepEqual(wrapMessage('first\r\n\r\nsecond\n', 20, width), ['first', '', 'second', '']);
  const text = 'A long word boundary ' + 'https://example.test/' + 'a'.repeat(350);
  const lines = wrapMessage(text, 24, width);
  assert.equal(lines.join(''), text);
  assert.ok(lines.every(line => width(line) <= 24));
  assert.deepEqual(wrapMessage('\x1b[31mred\x1b[0m\ttext', 30, width), ['red    text']);
  // A combining sequence must stay intact; wide characters consume two cells.
  const cells = (text: string) => [...text].reduce((n, ch) => n + (ch === '\u0301' ? 0 : /[界😊]/u.test(ch) ? 2 : 1), 0);
  const unicode = wrapMessage('e\u0301界😊e\u0301界😊', 4, cells);
  assert.ok(unicode.every(line => cells(line) <= 4 && !line.startsWith('\u0301')));
  assert.equal(unicode.join(''), 'e\u0301界😊e\u0301界😊');
});

test('conversation bubbles align by sender, preserve captions/reactions and reflow within panel bounds', () => {
  const base = { chat: 'synthetic', id: 'one', sender: 'Alex', time: 1, text: 'Hello\n\nSecond line', kind: 'image' as const, reactions: '👍', mine: false };
  for (const width of [36, 80, 140]) {
    const bubbles = layoutMessages([base, { ...base, id: 'two', mine: true }], width, text => [...text].length);
    assert.equal(bubbles[0].left, 0);
    assert.equal(bubbles[1].left + bubbles[1].width, width);
    assert.ok(bubbles[1].left > 0);
    assert.ok(bubbles[1].top > bubbles[0].top + bubbles[0].lines.length);
    for (const bubble of bubbles) {
      assert.ok(bubble.lines.includes('[IMAGE]') && bubble.lines.includes('') && bubble.lines.includes('Second line'));
      assert.ok(bubble.lines.some(line => line.includes('Reactions:')));
      assert.ok(bubble.lines.every(line => [...line].length <= bubble.width - 4));
    }
  }
});

test('modern keyboard reports preserve Shift+Enter and control shortcuts', () => {
  assert.equal(legacyKey(13, 2), '\n');
  assert.equal(legacyKey(13), '\r');
  assert.equal(legacyKey(113, 5), '\x11');
  assert.equal(legacyKey(115, 5), '\x13');
  assert.equal(legacyKey(9, 2), '\x1b[Z');
  assert.equal(legacyKey(13, 2, 3), '');
  const input = new TerminalInput();
  let output = '';
  input.on('data', chunk => { output += chunk.toString(); });
  input.write('\x1b[13;'); input.write('2u');
  input.write('\x1b[27;2;13~\x1b[113;5u\x1b[A');
  assert.equal(output, '\n\n\x11\x1b[A');
  input.disconnect();
});

test('bracketed multiline paste is data and never becomes an Enter-to-send key', () => {
  const input = new TerminalInput();
  let output = '', pasted = '';
  input.on('data', chunk => { output += chunk.toString(); });
  input.on('paste', text => { pasted = text; });
  input.write('\x1b[200~one\r\ntwo\r');
  input.write('\x1b[20'); input.write('1~');
  assert.equal(output, ''); assert.equal(pasted, 'one\r\ntwo\r');
  input.disconnect();
});

const chat = '123@s.whatsapp.net';
function message(id: string, time = 100): WAMessage {
  return { key: { remoteJid: chat, id, fromMe: false }, pushName: 'Alex', messageTimestamp: time, message: { conversation: `Message ${id}` } };
}

test('old direct-chat messages resolve the saved name without rewriting protocol data', () => {
  const store = new Store(':memory:');
  try {
    store.put({ ...message('history'), pushName: undefined });
    assert.equal(store.messages(chat)[0].sender, chat);
    store.contact(chat, 'Saved contact');
    assert.equal(store.messages(chat)[0].sender, 'Saved contact');
    store.contact(chat, 'Renamed contact');
    assert.equal(store.messages(chat)[0].sender, 'Renamed contact');
    store.chat(chat, 'Chat display name');
    assert.equal(store.messages(chat)[0].sender, 'Renamed contact', 'Saved contacts take precedence over chat/profile titles');
    assert.equal(store.raw({ remoteJid: chat, id: 'history' })?.pushName, undefined);
  } finally { store.close(); }
});

test('group messages use participant names rather than the group title', () => {
  const store = new Store(':memory:');
  const group = 'test@g.us';
  try {
    store.chat(group, 'Weekend plans');
    store.contact(chat, 'Alex');
    store.put({ ...message('group-history'), pushName: undefined, key: { remoteJid: group, id: 'group-history', participant: chat } });
    assert.equal(store.messages(group)[0].sender, 'Alex');
    store.put({ ...message('group-push', 101), pushName: 'Sam', key: { remoteJid: group, id: 'group-push', participant: '456@s.whatsapp.net' } });
    assert.equal(store.messages(group)[1].sender, 'Sam');
  } finally { store.close(); }
});

test('history participants and profile names resolve without ever attributing messages to the group', () => {
  const store = new Store(':memory:'), group = 'demo@g.us', person = '456@lid';
  try {
    store.chat(group, 'Group title');
    store.put({ key: { remoteJid: group, id: 'old' }, participant: person, message: { conversation: 'Old history' } });
    assert.equal(store.message(group, 'old')?.senderId, person);
    assert.equal(store.message(group, 'old')?.sender, person);
    store.put({ key: { remoteJid: group, id: 'new', participant: person }, pushName: 'Profile name', message: { conversation: 'New arrival' } });
    assert.equal(store.message(group, 'old')?.sender, 'Profile name');
    store.contact('447700900001@s.whatsapp.net', 'Saved friend');
    store.alias(person, '447700900001@s.whatsapp.net');
    assert.equal(store.message(group, 'new')?.sender, 'Saved friend');
    store.contact(person, 'Changed profile', 0);
    assert.equal(store.message(group, 'old')?.sender, 'Saved friend');
    store.put({ key: { remoteJid: group, id: 'missing' }, message: { conversation: 'No identity' } });
    assert.equal(store.message(group, 'missing')?.sender, 'Unknown participant');
    assert.equal(store.message(group, 'missing')?.senderId, undefined);
    store.db.prepare('UPDATE messages SET sender=? WHERE id=?').run(group, 'missing');
    assert.equal(store.message(group, 'missing')?.sender, 'Unknown participant');
  } finally { store.close(); }
});

test('declared mentions resolve contacts and profiles, preserve protocol text, and never rewrite URLs or plain numbers', () => {
  const store = new Store(':memory:'), group = 'mentions@g.us', person = '1400123@lid';
  const text = '👋 @1400123, meet @456 and @789. Again @1400123! Plain @999, x@1400123, @14001230, https://example.test/@1400123';
  try {
    store.contact('447700900001@s.whatsapp.net', 'José & Ana <friends>');
    store.alias(person, '447700900001@s.whatsapp.net');
    store.contact('456@lid', 'Lin', 0);
    const raw: WAMessage = { key: { remoteJid: group, id: 'mention', participant: person },
      message: { extendedTextMessage: { text, contextInfo: { mentionedJid: [person, '456@lid', '789@lid'] } } } };
    store.put(raw);
    const view = store.message(group, 'mention')!;
    assert.equal(view.text, '👋 @José & Ana <friends>, meet @Lin and @789. Again @José & Ana <friends>! Plain @999, x@1400123, @14001230, https://example.test/@1400123');
    assert.deepEqual(view.parts?.filter(part => part.jid).map(part => part.jid), [person, '456@lid', '789@lid', person]);
    assert.equal(view.parts?.map(part => part.text).join(''), view.text);
    assert.equal(store.raw(raw.key)?.message?.extendedTextMessage?.text, text);
    store.contact(person, 'Saved LID name');
    assert.ok(store.message(group, 'mention')?.text.includes('@Saved LID name'));
    for (const kind of ['imageMessage', 'videoMessage'] as const) {
      store.put({ ...raw, key: { ...raw.key, id: kind }, message: { [kind]: { caption: '@456 photo', contextInfo: { mentionedJid: ['456@lid'] } } } });
      assert.equal(store.message(group, kind)?.text, '@Lin photo');
    }
    assert.throws(() => store.directChat(group), /no available/);
    assert.equal(store.directChat(person).id, person);
    store.chat('447700900001@s.whatsapp.net');
    assert.equal(store.directChat(person).id, '447700900001@s.whatsapp.net', 'Reuse an existing phone-ID conversation');
    assert.equal(store.messages('447700900001@s.whatsapp.net').length, 0, 'Opening a person must not send anything');
  } finally { store.close(); }
});

test('contact sync preserves saved names and maps LID/phone identities, including message alternate IDs', async () => {
  const store = new Store(':memory:'), events = new AppEvents(), ev = new EventEmitter();
  const adapter = new WhatsAppTransport(store, events, new MediaCache('/unused'), () => ({ ev, end: () => {} } as unknown as WASocket));
  try {
    await adapter.start();
    ev.emit('contacts.upsert', [{ id: '100@s.whatsapp.net', name: 'Address book', lid: '200@lid' }]);
    ev.emit('contacts.update', [{ id: '200@lid', notify: 'Profile replacement' }]);
    assert.equal(store.personName('200@lid'), 'Address book');
    ev.emit('contacts.upsert', [{ id: '300@lid', notify: 'Unsaved profile' }]);
    ev.emit('lid-mapping.update', { lid: '300@lid', pn: '400@s.whatsapp.net' });
    assert.equal(store.personName('400@s.whatsapp.net'), 'Unsaved profile');
    store.contact('500@s.whatsapp.net', 'Alternate identity');
    store.put({ key: { remoteJid: 'test@g.us', id: 'alt', participant: '600:2@lid', participantAlt: '500@s.whatsapp.net' }, message: { conversation: 'Hello' } });
    assert.equal(store.message('test@g.us', 'alt')?.sender, 'Alternate identity');
    assert.equal(store.message('test@g.us', 'alt')?.senderId, '600@lid');
  } finally { adapter.stop(); store.close(); }
});

test('account identity labels self chats and mentions without changing contacts, raw text or routing', () => {
  const store = new Store(':memory:'), pn = '447700900099@s.whatsapp.net', lid = '140000099@lid', group = 'self-test@g.us';
  try {
    store.contact(pn, 'Saved account name'); store.chat(pn, 'Old phone label');
    store.contact(lid, 'Profile name', 0); store.chat(lid);
    store.chat(group, 'Group title');
    const raw: WAMessage = { key: { remoteJid: group, id: 'self-mention', participant: '123@lid' },
      message: { extendedTextMessage: { text: '@140000099 and @447700900099', contextInfo: { mentionedJid: [lid, pn] } } } };
    store.put(raw);
    assert.equal(store.setSelf({ id: '447700900099:8@s.whatsapp.net' }), true);
    assert.equal(store.displayName(pn), 'You');
    assert.notEqual(store.displayName(lid), 'You', 'Unmapped IDs cannot be guessed');
    store.alias(lid, pn); // Mapping may arrive after account identity/history.
    assert.equal(store.displayName(lid), 'You');
    assert.equal(store.personName('447700900099:2@s.whatsapp.net'), 'You');
    for (const list of [store.listChats(), store.listContacts(), store.listChats('you'), store.listContacts('YOU')]) {
      assert.equal(list.filter(c => c.name === 'You').length, 2);
    }
    assert.equal(store.listChats('900099').filter(c => c.name === 'You').length, 1);
    assert.equal(store.displayName(group), 'Group title');
    assert.equal(store.personName('447700900098@s.whatsapp.net'), undefined);
    const view = store.message(group, 'self-mention')!;
    assert.equal(view.text, '@You and @You');
    assert.deepEqual(view.parts?.filter(p => p.jid).map(p => p.jid), [lid, pn]);
    assert.equal(store.raw(raw.key)?.message?.extendedTextMessage?.text, '@140000099 and @447700900099');
    assert.equal(store.directChat(lid).id, lid); assert.equal(store.directChat(pn).name, 'You');
    assert.equal(store.setSelf({ id: pn }), false, 'Device suffixes do not change identity');
    store.setSelf({ id: 'other@s.whatsapp.net', lid: '999@lid' });
    assert.equal(store.personName(pn), 'Saved account name', 'Account changes must remove the old overlay');
    store.setSelf(); assert.equal(store.personName('999@lid'), undefined);
  } finally { store.close(); }
});

test('saved login and pairing identity updates supply self labels to the shared store', async () => {
  const store = new Store(':memory:'), events = new AppEvents(), ev = new EventEmitter();
  const auth = sqliteAuth(store), pn = '447700900099@s.whatsapp.net', lid = '140000099@lid';
  auth.state.creds.me = { id: '447700900099:7@s.whatsapp.net', name: 'Profile' }; auth.save();
  let options: Partial<SocketConfig> | undefined, changes = 0;
  events.on('changed', () => { changes++; });
  const adapter = new WhatsAppTransport(store, events, new MediaCache('/unused'), config => {
    options = config; return { ev, end() {} } as unknown as WASocket;
  });
  try {
    assert.equal(store.displayName(pn), 'You', 'Saved identity works before connecting');
    await adapter.start();
    const me = { ...options!.auth!.creds.me!, lid: '140000099:3@lid' };
    Object.assign(options!.auth!.creds, { me }); ev.emit('creds.update', { me });
    assert.equal(store.displayName(lid), 'You'); assert.equal(changes, 1);
    ev.emit('creds.update', {}); assert.equal(changes, 1, 'Key saves do not trigger display refreshes');
    ev.emit('connection.update', { connection: 'open' }); assert.equal(store.displayName(lid), 'You');
    assert.equal(sqliteAuth(store).state.creds.me?.lid, me.lid);
    adapter.stop(); ev.emit('creds.update', { me: { id: 'other@s.whatsapp.net' } });
    assert.equal(store.displayName(pn), 'You', 'Stopped socket events cannot replace account identity');
  } finally { adapter.stop(); store.close(); }
});

test('existing history gains participant profiles without changing stored messages or credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-person-migration-'));
  const path = join(directory, 'test.db'), group = 'old@g.us';
  let store = new Store(path);
  try {
    store.put({ key: { remoteJid: group, id: 'old' }, participant: '123@lid', message: { conversation: 'Before name' } });
    store.put({ key: { remoteJid: group, id: 'named' }, participant: '123@lid', pushName: 'Historic profile', message: { conversation: 'With name' } });
    store.db.exec("DELETE FROM contacts; ALTER TABLE contacts DROP COLUMN source; PRAGMA user_version=0;");
    store.db.prepare("INSERT INTO auth VALUES ('test','saved','unchanged')").run();
    const before = store.raw({ remoteJid: group, id: 'old' });
    store.close(); store = new Store(path);
    assert.equal(store.message(group, 'old')?.sender, 'Historic profile');
    assert.deepEqual(store.raw({ remoteJid: group, id: 'old' }), before);
    assert.equal(store.db.prepare("SELECT value FROM auth WHERE category='test'").get()?.value, 'unchanged');
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 1);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('history deduplicates, pages chronologically, bounds retention, and excludes raw media from UI rows', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 130; i++) store.put(message(`id-${i}`, i + 1), true);
    store.put(message('id-129', 130), true);
    assert.equal(store.listChats()[0].unread, 130);
    assert.equal(store.messages(chat).length, PAGE_SIZE);
    assert.equal(store.messages(chat)[0].time, 71);
    assert.equal(store.messages(chat, PAGE_SIZE).at(-1)?.time, 70);
    assert.equal('raw' in store.messages(chat)[0], false);
    assert.equal(store.raw({ remoteJid: chat, id: 'id-129' })?.message?.conversation, 'Message id-129');
    store.prune(70);
    assert.equal(store.messages(chat, PAGE_SIZE).length, 10);
    store.markViewed(chat); assert.equal(store.listChats()[0].unread, 0);
    store.removeChat(chat); assert.equal(store.messages(chat).length, 0);
  } finally { store.close(); }
});

test('saved contact names survive push names; search treats SQL wildcard characters literally', () => {
  const store = new Store(':memory:');
  try {
    store.contact(chat, 'Alex 100%'); store.put(message('first'));
    assert.equal(store.listChats('%')[0].name, 'Alex 100%');
    assert.equal(store.listChats('_').length, 0);
    assert.equal(store.listContacts('alex').length, 1);
  } finally { store.close(); }
});

test('view-once and disappearing bodies are never persisted; unsupported broadcasts are ignored', () => {
  const store = new Store(':memory:');
  try {
    store.put({ ...message('private'), message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'secret' } } } } });
    store.put({ ...message('ephemeral'), message: { ephemeralMessage: { message: { conversation: 'secret' } } } });
    store.put({ ...message('expires'), message: { extendedTextMessage: { text: 'secret', contextInfo: { expiration: 3600 } } } });
    store.put({ ...message('broadcast'), key: { remoteJid: 'status@broadcast', id: 'broadcast' } });
    assert.equal(store.messages(chat).length, 3);
    for (const m of store.messages(chat)) {
      assert.equal(m.kind, 'unsupported'); assert.equal(m.text.includes('secret'), false);
      assert.equal(store.raw({ remoteJid: chat, id: m.id }), undefined);
    }
    assert.equal(store.listChats().length, 1);
  } finally { store.close(); }
});

test('reactions are tracked per sender; revocation removes message and reactions', () => {
  const store = new Store(':memory:'); const key = { remoteJid: chat, id: 'one' };
  try {
    store.put(message('one'));
    store.reactions(key, '👍', 'alex'); store.reactions(key, '❤️', 'me');
    assert.match(store.messages(chat)[0].reactions, /👍/);
    store.reactions(key, '', 'me'); assert.equal(store.messages(chat)[0].reactions, '👍');
    store.update(key, { conversation: 'Edited' }); assert.equal(store.messages(chat)[0].text, 'Edited');
    assert.equal(store.messages(chat)[0].reactions, '👍');
    store.update(key, null); assert.equal(store.messages(chat).length, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM reactions').get()?.n, 0);
  } finally { store.close(); }
});

test('credentials and binary Signal keys survive reopening; deletions persist and malformed auth fails visibly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-auth-test-'));
  let store = new Store(join(directory, 'test.db'));
  try {
    const auth = sqliteAuth(store); auth.state.creds.registered = true; auth.save();
    const identity = Buffer.from(auth.state.creds.signedIdentityKey.private);
    await auth.state.keys.set({ session: { one: Buffer.from([1, 2, 255]) }, 'app-state-sync-key': { key: { keyData: Buffer.from([4, 5]) } } });
    store.close(); store = new Store(join(directory, 'test.db'));
    const restored = sqliteAuth(store);
    assert.equal(restored.state.creds.registered, true);
    assert.deepEqual(Buffer.from(restored.state.creds.signedIdentityKey.private), identity);
    assert.deepEqual(Buffer.from((await restored.state.keys.get('session', ['one'])).one), Buffer.from([1, 2, 255]));
    assert.deepEqual(Buffer.from((await restored.state.keys.get('app-state-sync-key', ['key'])).key.keyData!), Buffer.from([4, 5]));
    await restored.state.keys.set({ session: { one: null } });
    assert.deepEqual(await restored.state.keys.get('session', ['one']), {});
    store.db.prepare('UPDATE auth SET value=? WHERE category=?').run('broken-json', 'creds');
    assert.throws(() => sqliteAuth(store), /JSON/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test('media downloads stream with limits, clean partial failures and evict older files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-cache-test-'));
  try {
    const cache = new MediaCache(directory, 12, 10); await cache.init();
    const first = cache.path(chat, '../unsafe', 'image'), second = cache.path(chat, 'second', 'video');
    assert.equal(first.startsWith(directory + '/'), true);
    assert.equal(first.includes('unsafe'), false);
    await cache.save(first, Readable.from([Buffer.from('12345678')]));
    await cache.save(second, Readable.from([Buffer.from('abcdefgh')]));
    assert.equal(await cache.cached(first), false);
    assert.equal((await readFile(second)).toString(), 'abcdefgh');
    await assert.rejects(cache.save(first, Readable.from([Buffer.alloc(8), Buffer.alloc(8)])), /limit/);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.part')), false);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(cache.save(first, Readable.from([Buffer.from('hello')]), controller.signal), /abort/i);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.part')), false);
    await cache.clear(); assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true }); }
});

test('attachments are inspected by content and command-like filenames stay data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-upload-test-'));
  try {
    const path = join(directory, '$(touch malicious); photo.png');
    await writeFile(path, await readFile(new URL('../../test/fixtures/demo.png', import.meta.url)));
    assert.equal((await inspectAttachment(path)).mime, 'image/png');
    assert.equal((await inspectAttachment(new URL('../../test/fixtures/demo.mp4', import.meta.url).pathname)).kind, 'video');
    await writeFile(join(directory, 'fake.jpg'), '<html>not an image</html>');
    await assert.rejects(inspectAttachment(join(directory, 'fake.jpg')), /Supported files/);
    await assert.rejects(inspectAttachment(directory), /Choose an image/);
  } finally { await rm(directory, { recursive: true }); }
});

test('terminal text cannot set titles, colors, hyperlinks, or hide text with bidi controls', () => {
  assert.equal(displayText('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(displayText('\x1b]0;malicious\x07hello'), 'hello');
  assert.equal(displayText('a\u202eb\x07'), 'ab');
  assert.equal(singleLine('one\ntwo\tthree'), 'one two three');
});

test('state directories are private and a second instance cannot share a session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-lock-test-'));
  try {
    dataDirectory(directory); assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const unlock = acquireLock(directory);
    assert.throws(() => acquireLock(directory), /already running/);
    unlock(); const next = acquireLock(directory); next();
  } finally { await rm(directory, { recursive: true }); }
});

test('QR lifecycle, saved login, disconnected sending and terminal disconnects use the real adapter with a fake socket', async () => {
  const store = new Store(':memory:'); const events = new AppEvents(); const ev = new EventEmitter();
  let options: Partial<SocketConfig> | undefined, ended = false;
  const phases: string[] = [], qrs: (string | undefined)[] = [];
  events.on('connection', state => phases.push(state.phase)); events.on('qr', qr => qrs.push(qr));
  const adapter = new WhatsAppTransport(store, events, new MediaCache('/unused'), config => {
    options = config;
    return { ev, end: () => { ended = true; }, sendMessage: async () => message('sent') } as unknown as WASocket;
  });
  try {
    await adapter.start();
    await assert.rejects(adapter.sendText(chat, 'offline'), /Not connected/);
    ev.emit('connection.update', { qr: 'test-qr-one' }); ev.emit('connection.update', { qr: 'test-qr-two' });
    assert.deepEqual(qrs, ['test-qr-one', 'test-qr-two']);
    options!.auth!.creds.registered = true; ev.emit('creds.update', {});
    assert.equal(sqliteAuth(store).state.creds.registered, true);
    ev.emit('connection.update', { connection: 'open' });
    assert.equal(qrs.at(-1), undefined); assert.equal(phases.at(-1), 'online');
    store.chat(chat, undefined, 0, undefined, 3600);
    await assert.rejects(adapter.sendText(chat, 'disappearing'), /disappearing/);
    store.chat(chat, undefined, 0, undefined, 0);
    await adapter.sendText(chat, 'hello'); assert.equal(store.messages(chat).length, 1);
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
    assert.equal(phases.at(-1), 'logged-out');
    await assert.rejects(adapter.sendText(chat, 'later'), /Not connected/);
    adapter.stop(); assert.equal(ended, true);
    ev.emit('connection.update', { qr: 'late-event' }); assert.notEqual(qrs.at(-1), 'late-event');
  } finally { adapter.stop(); store.close(); }
});

test('reconnect backoff is bounded and never loops on invalid/replaced sessions', () => {
  assert.equal(reconnectDelay(DisconnectReason.restartRequired, 0), 250);
  assert.equal(reconnectDelay(undefined, 0), 1000);
  assert.equal(reconnectDelay(undefined, 100), 30_000);
  for (const code of [DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.forbidden, DisconnectReason.connectionReplaced, DisconnectReason.multideviceMismatch]) assert.equal(reconnectDelay(code, 0), undefined);
});


test('text and media replies pass the original direct/group/self key to Baileys and persist quote previews', async () => {
  const store = new Store(':memory:');
  const events = new AppEvents(), ev = new EventEmitter();
  const self = '123456@s.whatsapp.net';
  const sent: { chat: string; options?: MiscMessageGenerationOptions }[] = [];
  const adapter = new WhatsAppTransport(store, events, new MediaCache('/unused'), () => ({
    ev, end: () => {},
    sendMessage: async (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => {
      sent.push({ chat: jid, options });
      const body = 'text' in content ? { extendedTextMessage: { text: content.text } } :
        'image' in content ? { imageMessage: { caption: content.caption } } : { videoMessage: { caption: 'video reply' } };
      return generateWAMessageFromContent(jid, body, { ...options, userJid: self, messageId: `reply-${sent.length}` });
    },
  } as unknown as WASocket));
  try {
    await adapter.start(); ev.emit('connection.update', { connection: 'open' });
    const originals: WAMessage[] = [
      { key: { remoteJid: chat, id: 'incoming', fromMe: false }, message: { conversation: 'Original incoming' } },
      { key: { remoteJid: chat, id: 'own', fromMe: true }, message: { imageMessage: { caption: 'Original own image' } } },
      { key: { remoteJid: 'group@g.us', id: 'group-message', participant: '456789@s.whatsapp.net', fromMe: false }, message: { conversation: 'Original group' } },
    ];
    for (const original of originals) {
      store.put(original);
      const target = { chat: original.key.remoteJid!, id: original.key.id! };
      await adapter.sendText(target.chat, 'A quoted reply', target);
      assert.deepEqual(sent.at(-1)?.options?.quoted?.key, store.raw(original.key)?.key);
      const raw = store.raw({ remoteJid: target.chat, id: `reply-${sent.length}` });
      const context = normalizeMessageContent(raw?.message)?.extendedTextMessage?.contextInfo;
      assert.equal(context?.stanzaId, target.id);
      assert.equal(context?.participant, original.key.fromMe ? self : original.key.participant || target.chat);
      assert.ok(store.messages(target.chat).find(m => m.id === `reply-${sent.length}`)?.quote?.startsWith('Original'));
    }
    for (const kind of ['image', 'video'] as const) {
      await adapter.sendMedia(chat, { path: '/synthetic/file', size: 1, kind, mime: kind === 'image' ? 'image/png' : 'video/mp4' }, 'caption', { chat, id: 'incoming' });
      assert.equal(sent.at(-1)?.options?.quoted?.key.id, 'incoming');
    }
    await adapter.sendText(chat, 'ordinary'); assert.equal(sent.at(-1)?.options?.quoted, undefined);
    const before = sent.length;
    await assert.rejects(adapter.sendText(chat, 'wrong chat', { chat: 'group@g.us', id: 'group-message' }), /different chat/);
    store.remove({ remoteJid: chat, id: 'incoming' });
    await assert.rejects(adapter.sendText(chat, 'missing', { chat, id: 'incoming' }), /no longer available/);
    store.put({ key: { remoteJid: chat, id: 'private' }, message: { viewOnceMessage: { message: { imageMessage: { caption: 'private' } } } } });
    await assert.rejects(adapter.sendText(chat, 'private reply', { chat, id: 'private' }), /no longer available/);
    assert.equal(sent.length, before, 'Invalid replies must never be silently sent without their quote');
  } finally { adapter.stop(); store.close(); }
});

test('existing databases gain the quote column without losing messages or login data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quietchat-migration-'));
  const path = join(directory, 'test.db');
  let store = new Store(path);
  try {
    store.put(message('existing'));
    store.db.prepare("INSERT INTO auth VALUES ('test', 'key', 'saved')").run();
    store.db.exec('ALTER TABLE messages DROP COLUMN quote');
    store.close(); store = new Store(path);
    assert.equal(store.messages(chat)[0].id, 'existing');
    assert.equal(store.db.prepare("SELECT value FROM auth WHERE category='test'").get()?.value, 'saved');
    assert.equal(store.messages(chat)[0].quote, undefined);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});


test('emoji layout, reserved cells and redraw widths agree with Alacritty', () => {
  configureTerminalUnicode();
  const width = unicode.charWidth;
  configureTerminalUnicode();
  assert.equal(unicode.charWidth, width, 'Compatibility hook must be idempotent');
  for (const [text, expected] of [['🍻', 2], ['👍', 2], ['🥂', 2], ['界', 2], ['𠀀', 2], ['🇨', 1], ['🇨🇭', 2], ['❤️', 1], ['1️⃣', 1], ['👩‍💻', 4], ['👍🏽', 4], ['café', 4]] as const) {
    assert.equal(unicode.strWidth(text), expected, text);
  }
  assert.equal(unicode.charWidth('a🍻b', 1), 2);
  assert.equal(unicode.charWidth(0x1f37b), 2);
  assert.equal('🍻👍🥂界𠀀🇨🇭'.replace(unicode.chars.all, '$1\x03'), '🍻\x03👍\x03🥂\x03界\x03𠀀\x03🇨🇭');
  const lines = wrapMessage('ab🍻cd👍ef🇨🇭', 4, unicode.strWidth);
  assert.ok(lines.every(line => unicode.strWidth(line) <= 4));
  assert.equal(lines.join(''), 'ab🍻cd👍ef🇨🇭');
});


test('web links retain query strings and balanced punctuation, excluding non-web schemes', async () => {
  const text = 'One (https://example.test/path?q=a&b=2). Two https://example.test/wiki/Thing_(detail)! file:///private javascript:alert(1)';
  assert.deepEqual(webLinks(text).map(link => link.url), ['https://example.test/path?q=a&b=2', 'https://example.test/wiki/Thing_(detail)']);
  for (const link of webLinks(text)) assert.equal(text.slice(link.start, link.end), link.url);
  assert.deepEqual(webLinks('https:// www.example.test mailto:someone@example.test'), []);
  await assert.rejects(openWebLink('file:///private'), /Only HTTP/);
  await assert.rejects(openWebLink('https://example.test/\ncommand'), /Only HTTP/);
});

test('link hit regions follow wrapped URLs, unicode widths, blank lines and multiple links', () => {
  configureTerminalUnicode();
  const url = 'https://example.test/' + 'long-path/'.repeat(12) + '?a=1&b=2';
  const second = 'https://another.test/page';
  const message = { chat: 'synthetic', id: 'link', sender: 'Alex', time: 1, text: `Heading\n\n👍 ${url} and ${second}.`, kind: 'text' as const, reactions: '', mine: false };
  for (const mine of [false, true]) {
    for (const width of [36, 80, 140]) {
      const bubble = layoutMessages([{ ...message, mine }], width, unicode.strWidth)[0];
      const pieces = bubble.links.filter(link => link.url === url);
      assert.ok(pieces.length > 1);
      assert.equal(pieces.map(link => bubble.lines[link.row].slice(link.from, link.to)).join(''), url);
      for (const link of bubble.links) {
        assert.equal(bubbleLinkAt(bubble, link.row, link.start + 2), link.url);
        assert.equal(bubbleLinkAt(bubble, link.row, link.end + 1), link.url);
        assert.equal(bubbleLinkAt(bubble, link.row, 0), undefined);
      }
      assert.equal(bubble.links.at(-1)?.url, second);
      assert.equal(bubbleLinkAt(bubble, 0, 2), undefined, 'Sender header should not activate a body link');
    }
  }
});
