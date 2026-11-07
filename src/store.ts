import { DatabaseSync } from 'node:sqlite';
import { proto, normalizeMessageContent, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { isChatJid, type Chat, type Message, type ReplyTarget } from './model.js';

type Row = { chat: string; id: string; sender: string; mine: number; time: number; text: string; kind: Message['kind']; reactions: string; quote: string | null };
export const HISTORY_LIMIT = 10_000;
export const PAGE_SIZE = 60;

export function describeMessage(raw: WAMessage): Omit<Message, 'reactions'> | undefined {
  const chat = raw.key.remoteJid, id = raw.key.id;
  if (!chat || !id || !isChatJid(chat) || !raw.message) return;
  const envelope = raw.message;
  const content = normalizeMessageContent(envelope);
  if (!content || content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage && Object.keys(content).length === 1) return;
  const base = { chat, id, sender: raw.pushName || raw.key.participant || chat, mine: !!raw.key.fromMe, time: Number(raw.messageTimestamp || Math.floor(Date.now() / 1000)) };
  // Do not retain or expose view-once/disappearing content in this first prototype.
  const privateMedia = envelope.viewOnceMessage || envelope.viewOnceMessageV2 || envelope.viewOnceMessageV2Extension;
  const expires = envelope.ephemeralMessage || raw.ephemeralDuration || content.extendedTextMessage?.contextInfo?.expiration || content.imageMessage?.contextInfo?.expiration || content.videoMessage?.contextInfo?.expiration;
  if (privateMedia || expires) return { ...base, text: '[View this disappearing/view-once message on your phone]', kind: 'unsupported' };
  const context = content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo || content.videoMessage?.contextInfo;
  const quoted = context?.quotedMessage;
  const quotedBody = normalizeMessageContent(quoted);
  const privateQuote = quoted?.ephemeralMessage || quoted?.viewOnceMessage || quoted?.viewOnceMessageV2 || quoted?.viewOnceMessageV2Extension;
  const quote = quoted ? (privateQuote ? '[Unavailable message]' : quotedBody?.conversation || quotedBody?.extendedTextMessage?.text || quotedBody?.imageMessage?.caption || quotedBody?.videoMessage?.caption || (quotedBody?.imageMessage ? '[Image]' : quotedBody?.videoMessage ? '[Video]' : '[Message]')).slice(0, 200) : undefined;
  const visible = { ...base, quote };
  if (content.imageMessage) return { ...visible, text: content.imageMessage.caption || '[Image]', kind: 'image', raw };
  if (content.videoMessage) return { ...visible, text: content.videoMessage.caption || '[Video]', kind: 'video', raw };
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (text != null) return { ...visible, text, kind: 'text', raw };
  return { ...base, text: '[Unsupported message — open on your phone]', kind: 'unsupported' };
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      PRAGMA cache_size=-2048; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, expiration INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, sender TEXT NOT NULL, mine INTEGER NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, raw BLOB, reactions TEXT NOT NULL DEFAULT '', PRIMARY KEY(chat,id));
      CREATE INDEX IF NOT EXISTS message_time ON messages(chat,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS message_global_time ON messages(time DESC);
      CREATE TABLE IF NOT EXISTS reactions(chat TEXT NOT NULL,id TEXT NOT NULL,sender TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(chat,id,sender),FOREIGN KEY(chat,id) REFERENCES messages(chat,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS auth(category TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(category,id));`);
    if (!(this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).some(column => column.name === 'expiration')) this.db.exec('ALTER TABLE chats ADD COLUMN expiration INTEGER NOT NULL DEFAULT 0');
    if (!(this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(column => column.name === 'quote')) this.db.exec('ALTER TABLE messages ADD COLUMN quote TEXT');
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  contact(id: string, name?: string | null): void {
    if (!isChatJid(id) || !name) return;
    this.db.prepare('INSERT INTO contacts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, name);
  }
  chat(id: string, name?: string | null, updated = 0, unread?: number | null, expiration?: number | null): void {
    if (!isChatJid(id)) return;
    this.db.prepare(`INSERT INTO chats(id,name,updated,unread) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE chats.name END, updated=max(chats.updated,excluded.updated),
      unread=CASE WHEN ? IS NULL THEN chats.unread ELSE max(0,?) END`).run(id, name || '', updated, Math.max(0, unread || 0), unread ?? null, unread ?? null);
    if (expiration != null) this.db.prepare('UPDATE chats SET expiration=? WHERE id=?').run(Math.max(0, expiration), id);
  }
  expiration(id: string): number { return Number(this.db.prepare('SELECT expiration FROM chats WHERE id=?').get(id)?.expiration || 0); }
  put(raw: WAMessage, notify = false): boolean {
    let message = describeMessage(raw);
    if (!message) return false;
    if (this.expiration(message.chat) > 0) message = { ...message, text: '[View this disappearing message on your phone]', kind: 'unsupported', raw: undefined };
    this.chat(message.chat, undefined, message.time);
    const result = this.db.prepare(`INSERT INTO messages(chat,id,sender,mine,time,text,kind,raw,quote) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chat,id) DO NOTHING`)
      .run(message.chat, message.id, message.sender, +message.mine, message.time, message.text, message.kind, message.raw ? proto.WebMessageInfo.encode(message.raw).finish() : null, message.raw ? message.quote ?? null : null);
    if (notify && !message.mine && result.changes) this.db.prepare('UPDATE chats SET unread=unread+1 WHERE id=?').run(message.chat);
    if (!message.chat.endsWith('@g.us') && !message.mine && raw.pushName) this.db.prepare('INSERT OR IGNORE INTO contacts VALUES (?,?)').run(message.chat, raw.pushName);
    return !!result.changes;
  }
  update(key: WAMessageKey, message: WAMessage['message']): void {
    if (!key.remoteJid || !key.id) return;
    if (message === null) { this.remove(key); return; }
    const previous = this.raw(key);
    if (!previous || !message) return;
    const next = describeMessage({ ...previous, message });
    if (next) this.db.prepare('UPDATE messages SET text=?,kind=?,raw=?,quote=? WHERE chat=? AND id=?')
      .run(next.text, next.kind, next.raw ? proto.WebMessageInfo.encode(next.raw).finish() : null, next.quote ?? null, key.remoteJid, key.id);
  }
  remove(key: WAMessageKey): void {
    if (key.remoteJid && key.id) this.db.prepare('DELETE FROM messages WHERE chat=? AND id=?').run(key.remoteJid, key.id);
  }
  removeChat(id: string): void { this.db.prepare('DELETE FROM chats WHERE id=?').run(id); }
  clearMessages(id: string): void { this.db.prepare('DELETE FROM messages WHERE chat=?').run(id); }
  listChats(search = ''): Chat[] {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT c.id, coalesce(nullif(c.name,''),p.name,c.id) name, c.updated,c.unread,
      coalesce((SELECT substr(text,1,140) FROM messages m WHERE m.chat=c.id ORDER BY time DESC,id DESC LIMIT 1),'') preview
      FROM chats c LEFT JOIN contacts p ON p.id=c.id WHERE c.id LIKE ? ESCAPE '\\' OR coalesce(nullif(c.name,''),p.name,c.id) LIKE ? ESCAPE '\\'
      ORDER BY c.updated DESC,c.id LIMIT 200`).all(pattern, pattern) as Chat[];
  }
  listContacts(search = ''): Chat[] {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(`SELECT id,name,0 updated,0 unread,'' preview FROM contacts WHERE id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 200`).all(pattern, pattern) as Chat[];
  }
  displayName(id: string): string | undefined {
    if (!isChatJid(id)) return;
    const row = this.db.prepare(`SELECT coalesce((SELECT nullif(name,'') FROM chats WHERE id=?),
      (SELECT nullif(name,'') FROM contacts WHERE id=?)) name`).get(id, id);
    return typeof row?.name === 'string' ? row.name : undefined;
  }
  messages(chat: string, offset = 0): Message[] {
    // Resolve names at read time so old history also benefits from contact sync.
    // A group title must never replace an individual participant's name.
    const directName = chat.endsWith('@g.us') ? undefined : this.displayName(chat);
    return (this.db.prepare(`SELECT chat,id,sender,mine,time,text,kind,quote,coalesce((SELECT substr(group_concat(emoji,' '),1,512) FROM reactions r WHERE r.chat=messages.chat AND r.id=messages.id),'') reactions FROM messages WHERE chat=? ORDER BY time DESC,id DESC LIMIT ? OFFSET ?`).all(chat, PAGE_SIZE, offset) as Row[])
      .reverse().map(row => ({ ...row, sender: directName || this.displayName(row.sender) || row.sender, mine: !!row.mine, quote: row.quote ?? undefined }));
  }
  message(chat: string, id: string): Message | undefined {
    const row = this.db.prepare(`SELECT chat,id,sender,mine,time,text,kind,quote,
      coalesce((SELECT substr(group_concat(emoji,' '),1,512) FROM reactions r WHERE r.chat=messages.chat AND r.id=messages.id),'') reactions
      FROM messages WHERE chat=? AND id=?`).get(chat, id) as Row | undefined;
    if (!row) return;
    const name = !chat.endsWith('@g.us') ? this.displayName(chat) : this.displayName(row.sender);
    return { ...row, sender: name || row.sender, mine: !!row.mine, quote: row.quote ?? undefined };
  }
  unread(): number { return Number(this.db.prepare('SELECT coalesce(sum(unread),0) total FROM chats').get()?.total || 0); }
  unreadChats(): Record<string, number> {
    return Object.fromEntries((this.db.prepare('SELECT id,unread FROM chats WHERE unread>0').all() as {id:string;unread:number}[]).map(row => [row.id, row.unread]));
  }
  quote(chat: string, reply?: ReplyTarget): WAMessage | undefined {
    if (!reply) return;
    if (reply.chat !== chat) throw new Error('The reply belongs to a different chat. Cancel it and select a message in this chat.');
    const raw = this.raw({ remoteJid: chat, id: reply.id });
    if (!raw?.message || this.expiration(chat)) throw new Error('The original message is no longer available. Cancel the reply to send without it.');
    return raw;
  }
  raw(key: WAMessageKey): WAMessage | undefined {
    const row = this.db.prepare('SELECT raw FROM messages WHERE chat=? AND id=?').get(key.remoteJid || '', key.id || '') as { raw: Uint8Array | null } | undefined;
    if (!row?.raw) return;
    const decoded = proto.WebMessageInfo.decode(row.raw);
    return decoded.key ? { ...decoded, key: decoded.key } : undefined;
  }
  reactions(key: WAMessageKey, emoji: string, sender = 'me'): void {
    if (!key.remoteJid || !key.id) return;
    if (!emoji) this.db.prepare('DELETE FROM reactions WHERE chat=? AND id=? AND sender=?').run(key.remoteJid, key.id, sender);
    else this.db.prepare(`INSERT INTO reactions SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE chat=? AND id=?)
      ON CONFLICT(chat,id,sender) DO UPDATE SET emoji=excluded.emoji`).run(key.remoteJid, key.id, sender, emoji, key.remoteJid, key.id);
  }
  markViewed(chat: string): void { this.db.prepare('UPDATE chats SET unread=0 WHERE id=?').run(chat); }
  prune(limit = HISTORY_LIMIT): void {
    this.db.prepare('DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages ORDER BY time DESC,rowid DESC LIMIT -1 OFFSET ?)').run(limit);
  }
  close(): void { this.db.close(); }
}
