import { muteDeadline } from './mutes.js';
import { DatabaseSync } from 'node:sqlite';
import { proto, normalizeMessageContent, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { isChatJid, type Chat, type Message, type ReplyTarget } from './model.js';
import { mentionParts, personId, profileName, senderId, quotedPreview, messageContext } from './identities.js';

type Row = { chat: string; id: string; sender: string; mine: number; time: number; text: string; kind: Message['kind']; reactions: string; quote: string | null };
export const HISTORY_LIMIT = 10_000;
export const PAGE_SIZE = 60;

export function describeMessage(raw: WAMessage): Omit<Message, 'reactions'> | undefined {
  const chat = raw.key.remoteJid, id = raw.key.id;
  if (!chat || !id || !isChatJid(chat) || !raw.message) return;
  const envelope = raw.message;
  const content = normalizeMessageContent(envelope);
  if (!content || content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage && Object.keys(content).length === 1) return;
  const base = { chat, id, sender: raw.pushName || senderId(raw) || (chat.endsWith('@g.us') ? 'Unknown participant' : chat), mine: !!raw.key.fromMe, time: Number(raw.messageTimestamp || Math.floor(Date.now() / 1000)) };
  // Do not retain or expose view-once/disappearing content in this first prototype.
  const privateMedia = envelope.viewOnceMessage || envelope.viewOnceMessageV2 || envelope.viewOnceMessageV2Extension;
  const expires = envelope.ephemeralMessage || raw.ephemeralDuration || content.extendedTextMessage?.contextInfo?.expiration || content.imageMessage?.contextInfo?.expiration || content.videoMessage?.contextInfo?.expiration;
  if (privateMedia || expires) return { ...base, text: '[View this disappearing/view-once message on your phone]', kind: 'unsupported' };
  const quote = quotedPreview(raw);
  const visible = { ...base, quote };
  if (content.imageMessage) return { ...visible, text: content.imageMessage.caption || '[Image]', kind: 'image', raw };
  if (content.videoMessage) return { ...visible, text: content.videoMessage.caption || '[Video]', kind: 'video', raw };
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (text != null) return { ...visible, text, kind: 'text', raw };
  return { ...base, text: '[Unsupported message — open on your phone]', kind: 'unsupported' };
}

export class Store {
  readonly db: DatabaseSync;
  private selfIds: string[] = [];
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      PRAGMA cache_size=-2048; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', updated INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, expiration INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS person_aliases(lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS person_phone ON person_aliases(pn);
      CREATE TABLE IF NOT EXISTS messages(chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, id TEXT NOT NULL, sender TEXT NOT NULL, mine INTEGER NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, raw BLOB, reactions TEXT NOT NULL DEFAULT '', PRIMARY KEY(chat,id));
      CREATE INDEX IF NOT EXISTS message_time ON messages(chat,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS message_global_time ON messages(time DESC);
      CREATE TABLE IF NOT EXISTS reactions(chat TEXT NOT NULL,id TEXT NOT NULL,sender TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(chat,id,sender),FOREIGN KEY(chat,id) REFERENCES messages(chat,id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS chat_mutes(id TEXT PRIMARY KEY, deadline INTEGER NOT NULL, revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mute_deadline ON chat_mutes(deadline);
      CREATE INDEX IF NOT EXISTS mute_revision ON chat_mutes(revision);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth(category TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(category,id));`);
    if (!(this.db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).some(column => column.name === 'expiration')) this.db.exec('ALTER TABLE chats ADD COLUMN expiration INTEGER NOT NULL DEFAULT 0');
    if (!(this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(column => column.name === 'quote')) this.db.exec('ALTER TABLE messages ADD COLUMN quote TEXT');
    // Existing names have unknown provenance: preserve them until contact sync
    // supplies an explicitly saved name (2). Profile updates (0) cannot erase them.
    if (!(this.db.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]).some(column => column.name === 'source')) this.db.exec('ALTER TABLE contacts ADD COLUMN source INTEGER NOT NULL DEFAULT 1');
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0) < 1) {
      this.transaction(() => {
        // Stream retained history once; do not load message/media blobs together.
        for (const row of this.db.prepare('SELECT raw FROM messages WHERE raw IS NOT NULL ORDER BY time,id').iterate()) {
          let raw: proto.WebMessageInfo;
          try { raw = proto.WebMessageInfo.decode(row.raw as Uint8Array); }
          catch { continue; } // Skip damaged protocol rows; database failures still roll back.
          if (raw.key) this.rememberPerson({ ...raw, key: raw.key });
        }
        this.db.exec('PRAGMA user_version=1');
      });
    }
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  contact(id: string, name?: string | null, source = 2): void {
    const person = personId(id), clean = profileName(name);
    if (!person || !clean || isChatJid(clean)) return;
    this.db.prepare(`INSERT INTO contacts(id,name,source) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE
      SET name=excluded.name,source=excluded.source WHERE excluded.source>=contacts.source`).run(person, clean, source);
  }
  alias(first?: string | null, second?: string | null): boolean {
    const a = personId(first), b = personId(second);
    if (!a || !b || a === b || a.split('@')[1] === b.split('@')[1]) return false;
    const [lid, pn] = a.endsWith('@lid') ? [a,b] : [b,a];
    return !!this.db.prepare('INSERT INTO person_aliases VALUES (?,?) ON CONFLICT(lid) DO UPDATE SET pn=excluded.pn WHERE pn<>excluded.pn').run(lid,pn).changes;
  }
  // Account identity is a display overlay, never a replacement for saved names.
  // Keep only the current account's two IDs; aliases stay in the existing index.
  setSelf(me?: { id?: string; lid?: string }): boolean {
    const ids = [...new Set([personId(me?.id), personId(me?.lid)].filter((id): id is string => !!id))];
    if (ids.join('|') === this.selfIds.join('|')) return false;
    this.alias(me?.id, me?.lid);
    this.selfIds = ids;
    return true;
  }
  private selfAliases(): string[] { return [...new Set(this.selfIds.flatMap(id => this.personIds(id)))]; }
  private isSelf(id: string): boolean { return this.selfIds.length > 0 && this.personIds(id).some(alias => this.selfIds.includes(alias)); }
  private personIds(id: string): string[] {
    const person = personId(id);
    if (!person) return [];
    const aliases = [person];
    if (person.endsWith('@lid')) {
      const row = this.db.prepare('SELECT pn FROM person_aliases WHERE lid=?').get(person);
      if (typeof row?.pn === 'string') aliases.push(row.pn);
    } else {
      for (const row of this.db.prepare('SELECT lid FROM person_aliases WHERE pn=? LIMIT 8').all(person)) aliases.push(String(row.lid));
    }
    return aliases;
  }
  personName(id: string): string | undefined {
    if (this.isSelf(id)) return 'You';
    const aliases = this.personIds(id), person = aliases[0];
    if (!person) return;
    const slots = aliases.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT name FROM contacts WHERE id IN (${slots}) AND name NOT GLOB '*@lid' AND name NOT GLOB '*@s.whatsapp.net' ORDER BY source DESC, id=? DESC LIMIT 1`).get(...aliases, person);
    if (typeof row?.name === 'string' && !isChatJid(row.name)) return row.name;
    const chat = this.db.prepare(`SELECT name FROM chats WHERE id IN (${slots}) AND name<>'' AND name NOT GLOB '*@lid' AND name NOT GLOB '*@s.whatsapp.net' ORDER BY id=? DESC LIMIT 1`).get(...aliases,person);
    return typeof chat?.name === 'string' && !isChatJid(chat.name) ? chat.name : undefined;
  }
  personLabel(id: string): string {
    const name = this.personName(id);
    if (name) return name;
    const ids = this.personIds(id), phone = ids.find(jid => jid.endsWith('@s.whatsapp.net'));
    if (phone && /^\d+@/.test(phone)) return '+' + phone.split('@')[0];
    const person = ids[0];
    return person ? `Unknown participant (…${person.split('@')[0].slice(-4)})` : 'Unknown participant';
  }
  directChat(id: string): Chat {
    const aliases = this.personIds(id), person = aliases[0];
    if (!person) throw new Error('This participant has no available direct-chat identity.');
    const slots = aliases.map(() => '?').join(',');
    const existing = this.db.prepare(`SELECT id,updated,unread FROM chats WHERE id IN (${slots}) ORDER BY id=? DESC,updated DESC LIMIT 1`).get(...aliases, person);
    const target = existing ? String(existing.id) : person;
    return { id: target, name: this.personLabel(person), updated: Number(existing?.updated || 0), unread: Number(existing?.unread || 0), preview: '' };
  }
  private rememberPerson(raw: WAMessage): void {
    const id = senderId(raw);
    if (raw.key.remoteJid?.endsWith('@g.us')) this.alias(id, raw.key.participantAlt);
    else this.alias(raw.key.remoteJid, raw.key.remoteJidAlt);
    if (id && !raw.key.fromMe) this.contact(id, raw.pushName, 0);
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
    this.rememberPerson(raw);
    let message = describeMessage(raw);
    if (!message) return false;
    if (this.expiration(message.chat) > 0) message = { ...message, text: '[View this disappearing message on your phone]', kind: 'unsupported', raw: undefined };
    this.chat(message.chat, undefined, message.time);
    const result = this.db.prepare(`INSERT INTO messages(chat,id,sender,mine,time,text,kind,raw,quote) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chat,id) DO NOTHING`)
      .run(message.chat, message.id, message.sender, +message.mine, message.time, message.text, message.kind, message.raw ? proto.WebMessageInfo.encode(message.raw).finish() : null, message.raw ? message.quote ?? null : null);
    if (notify && !message.mine && result.changes) this.db.prepare('UPDATE chats SET unread=unread+1 WHERE id=?').run(message.chat);
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
    const self = this.selfAliases(), slots = self.map(() => '?').join(',') || 'NULL';
    return (this.db.prepare(`SELECT c.id, coalesce(nullif(c.name,''),p.name,c.id) name, c.updated,c.unread,
      coalesce((SELECT substr(text,1,140) FROM messages m WHERE m.chat=c.id ORDER BY time DESC,id DESC LIMIT 1),'') preview
      FROM chats c LEFT JOIN contacts p ON p.id=c.id WHERE c.id LIKE ? ESCAPE '\\' OR coalesce(nullif(c.name,''),p.name,c.id) LIKE ? ESCAPE '\\'
      OR (c.id IN (${slots}) AND 'You' LIKE ? ESCAPE '\\')
      ORDER BY c.updated DESC,c.id LIMIT 200`).all(pattern, pattern, ...self, pattern) as Chat[])
      .map(chat => self.includes(personId(chat.id) || '') ? { ...chat, name: 'You' }
        : personId(chat.name) ? { ...chat, name: this.personLabel(chat.id) } : chat);
  }
  listContacts(search = ''): Chat[] {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const self = this.selfAliases(), slots = self.map(() => '?').join(',') || 'NULL';
    return (this.db.prepare(`SELECT id,name,0 updated,0 unread,'' preview FROM contacts WHERE id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
      OR (id IN (${slots}) AND 'You' LIKE ? ESCAPE '\\') ORDER BY name LIMIT 200`).all(pattern, pattern, ...self, pattern) as Chat[])
      .map(chat => self.includes(personId(chat.id) || '') ? { ...chat, name: 'You' }
        : personId(chat.name) ? { ...chat, name: this.personLabel(chat.id) } : chat);
  }
  displayName(id: string): string | undefined {
    if (personId(id)) return this.personLabel(id);
    if (!isChatJid(id)) return;
    const row = this.db.prepare("SELECT nullif(name,'') name FROM chats WHERE id=?").get(id);
    return typeof row?.name === 'string' ? row.name : undefined;
  }
  private present(row: Row): Message {
    const raw = this.raw({ remoteJid: row.chat, id: row.id });
    const group = row.chat.endsWith('@g.us');
    const id = raw ? senderId(raw) : personId(group ? row.sender : row.chat);
    // Old rows may contain the group JID as sender. Never resolve that to a title.
    const pushName = profileName(raw?.pushName);
    const fallback = (pushName && !isChatJid(pushName) ? pushName : undefined) || (!isChatJid(row.sender) ? row.sender : undefined);
    const sender = (id && this.personName(id)) || fallback || (id ? this.personLabel(id) : 'Unknown participant');
    const parts = mentionParts(row.text, raw, jid => this.personLabel(jid));
    const context = messageContext(raw?.message);
    const original = context?.quotedMessage && context.stanzaId ? this.raw({ remoteJid: context.remoteJid || row.chat, id: context.stanzaId }) : undefined;
    const quote = raw ? quotedPreview(raw, jid => this.personLabel(jid), original) : undefined;
    return { ...row, sender, senderId: row.mine ? undefined : id, mine: !!row.mine,
      text: parts ? parts.map(part => part.text).join('') : row.text, parts, quote: quote ?? row.quote ?? undefined };
  }
  messages(chat: string, offset = 0): Message[] {
    // Resolve names at read time so retained history benefits from later sync.
    return (this.db.prepare(`SELECT chat,id,sender,mine,time,text,kind,quote,coalesce((SELECT substr(group_concat(emoji,' '),1,512) FROM reactions r WHERE r.chat=messages.chat AND r.id=messages.id),'') reactions FROM messages WHERE chat=? ORDER BY time DESC,id DESC LIMIT ? OFFSET ?`).all(chat, PAGE_SIZE, offset) as Row[])
      .reverse().map(row => this.present(row));
  }
  message(chat: string, id: string): Message | undefined {
    const row = this.db.prepare(`SELECT chat,id,sender,mine,time,text,kind,quote,
      coalesce((SELECT substr(group_concat(emoji,' '),1,512) FROM reactions r WHERE r.chat=messages.chat AND r.id=messages.id),'') reactions
      FROM messages WHERE chat=? AND id=?`).get(chat, id) as Row | undefined;
    return row ? this.present(row) : undefined;
  }
  setMute(id: string, value: number | null): void {
    if (!isChatJid(id)) return;
    const deadline = muteDeadline(value);
    if (deadline === undefined) return;
    // Keep explicit unmutes too: the newest setting wins across phone/LID aliases.
    this.db.prepare(`INSERT INTO chat_mutes(id,deadline,revision) SELECT ?,?,coalesce(max(revision),0)+1 FROM chat_mutes WHERE true
      ON CONFLICT(id) DO UPDATE SET deadline=excluded.deadline,revision=excluded.revision`).run(personId(id) || id,deadline);
  }
  muted(id: string, now = Date.now()): boolean {
    const aliases = personId(id) ? this.personIds(id) : [id];
    const row = this.db.prepare(`SELECT deadline FROM chat_mutes WHERE id IN (${aliases.map(() => '?').join(',')}) ORDER BY revision DESC LIMIT 1`).get(...aliases);
    const deadline = Number(row?.deadline || 0);
    return deadline < 0 || deadline > now;
  }
  muteRevision(): number { return Number(this.db.prepare('SELECT coalesce(max(revision),0) revision FROM chat_mutes').get()?.revision); }
  restoreMutes(settings: Map<string, number | null>, startedAtRevision: number): void {
    this.transaction(() => {
      const liveRevision = this.muteRevision();
      this.db.prepare('UPDATE chat_mutes SET deadline=0 WHERE revision<=?').run(startedAtRevision);
      for (const [id, value] of settings) {
        const aliases = personId(id) ? this.personIds(id) : [id];
        const newer = this.db.prepare(`SELECT 1 FROM chat_mutes WHERE id IN (${aliases.map(() => '?').join(',')}) AND revision>? AND revision<=? LIMIT 1`).get(...aliases, startedAtRevision, liveRevision);
        if (!newer) this.setMute(id, value);
      }
      this.completeMuteSync();
    });
  }
  muteSyncReady(): boolean { return this.db.prepare("SELECT value FROM preferences WHERE key='mute-sync'").get()?.value === 'complete'; }
  completeMuteSync(): void { this.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('mute-sync','complete')").run(); }
  notificationUnreadChats(now = Date.now()): Record<string, number> {
    if (!this.muteSyncReady()) return {};
    const result: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT id,unread FROM chats WHERE unread>0').iterate()) {
      const id = String(row.id);
      if (!this.muted(id, now)) result[id] = Number(row.unread);
    }
    return result;
  }
  nextMuteExpiry(now = Date.now()): number | undefined {
    const deadline = this.db.prepare('SELECT min(deadline) deadline FROM chat_mutes WHERE deadline>?').get(now)?.deadline;
    return typeof deadline === 'number' ? deadline : undefined;
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
