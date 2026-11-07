import { EventEmitter } from 'node:events';
import type { WAMessage } from '@whiskeysockets/baileys';

export type Chat = { id: string; name: string; updated: number; unread: number; preview: string };
export type Message = {
  chat: string; id: string; sender: string; mine: boolean; time: number;
  text: string; kind: 'text' | 'image' | 'video' | 'unsupported';
  raw?: WAMessage; reactions: string; quote?: string;
};
export type ReplyTarget = Pick<Message, 'chat' | 'id'>;
export type Attachment = { path: string; kind: 'image' | 'video'; mime: string; size: number };
export type Connection = { phase: 'connecting' | 'qr' | 'online' | 'offline' | 'logged-out'; detail: string };
export class AppEvents extends EventEmitter<{
  changed: []; incoming: [Message]; connection: [Connection]; qr: [string | undefined]; notice: [string];
}> {}
export interface Transport {
  start(): Promise<void>;
  stop(): void;
  sendText(chat: string, text: string, reply?: ReplyTarget): Promise<void>;
  sendMedia(chat: string, attachment: Attachment, caption: string, reply?: ReplyTarget): Promise<void>;
  react(message: Message, emoji: string): Promise<void>;
  download(message: Message): Promise<string>;
}

// Remote text must never be interpreted as terminal control sequences or UI markup.
export function displayText(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
export function singleLine(value: string): string { return displayText(value).replace(/[\r\n\t]+/g, ' '); }
export function isChatJid(jid: string): boolean { return /@(s\.whatsapp\.net|lid|g\.us)$/.test(jid); }
