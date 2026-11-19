import { normalizeMessageContent, type WAMessage } from '@whiskeysockets/baileys';
import { singleLine, type MediaKind } from './model.js';

export function mediaContent(raw: WAMessage) {
  const content = normalizeMessageContent(raw.message);
  return content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.documentMessage;
}

const documentTypes: Record<string, string> = {
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/rtf': 'rtf',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt', 'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp', 'application/epub+zip': 'epub',
  'application/zip': 'zip', 'application/x-7z-compressed': '7z',
};

// Use only an inert, known extension, never a remote filename as a local path.
export function mediaExtension(kind: MediaKind, mime = '', filename = ''): string {
  if (kind !== 'document') return { image: 'img', video: 'mp4', audio: 'audio' }[kind];
  const extension = filename.toLowerCase().split('.').pop() || '';
  const type = mime.toLowerCase().split(';')[0].trim();
  return Object.hasOwn(documentTypes, type) ? documentTypes[type]
    : Object.values(documentTypes).includes(extension) ? extension : 'bin';
}

export function receivedLabel(raw: WAMessage): string {
  const content = normalizeMessageContent(raw.message);
  const audio = content?.audioMessage, document = content?.documentMessage;
  const size = Number((audio || document)?.fileLength || 0);
  const sizeText = Number.isFinite(size) && size > 0 ? ` · ${size >= 1048576 ? (size / 1048576).toFixed(1) + ' MiB' : Math.ceil(size / 1024) + ' KiB'}` : '';
  if (audio) {
    const seconds = Number(audio.seconds || 0);
    const duration = Number.isFinite(seconds) && seconds > 0 ? ` · ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';
    return `[${audio.ptt ? 'Voice message' : 'Audio'}${duration}${sizeText}]`;
  }
  if (document) {
    const name = singleLine(document.fileName || document.title || 'Document').slice(0, 180);
    return `[Document] ${name}${sizeText}${document.caption ? '\n' + document.caption : ''}`;
  }
  return '[Attachment]';
}
