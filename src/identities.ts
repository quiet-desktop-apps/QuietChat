import { jidNormalizedUser, normalizeMessageContent, type WAMessage } from '@whiskeysockets/baileys';
import { singleLine, type MessagePart } from './model.js';
import { webLinks } from './links.js';

export function personId(value?: string | null): string | undefined {
  if (!value || !/^[\w.+-]+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(value)) return;
  return jidNormalizedUser(value);
}

export function senderId(raw: WAMessage): string | undefined {
  return raw.key.remoteJid?.endsWith('@g.us')
    ? personId(raw.key.participant) || personId(raw.participant)
    : personId(raw.key.remoteJid);
}

export function profileName(value?: string | null): string | undefined {
  const name = value && singleLine(value).trim().slice(0, 128);
  return name || undefined;
}

// Only protocol-declared mentions become contact links. Ordinary @numbers,
// e-mail addresses and numbers inside URLs remain untouched.
export function mentionParts(text: string, raw: WAMessage | undefined, name: (id: string) => string | undefined): MessagePart[] | undefined {
  const content = normalizeMessageContent(raw?.message);
  const context = content?.extendedTextMessage?.contextInfo || content?.imageMessage?.contextInfo || content?.videoMessage?.contextInfo;
  const targets = new Map<string, string>();
  for (const value of (context?.mentionedJid || []).slice(0, 100)) {
    const jid = personId(value);
    if (jid) targets.set(jid.split('@')[0], jid);
  }
  if (!targets.size) return;
  const urls = webLinks(text), parts: MessagePart[] = [];
  let offset = 0, count = 0;
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_@])@(\d+)(?![\p{L}\p{N}_@])/gu)) {
    const jid = targets.get(match[1]), start = match.index;
    if (!jid || urls.some(url => start >= url.start && start < url.end)) continue;
    if (++count > 100) break;
    if (start > offset) parts.push({ text: text.slice(offset, start) });
    parts.push({ text: '@' + (name(jid) || match[1]), jid });
    offset = start + match[0].length;
  }
  if (!count) return;
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
