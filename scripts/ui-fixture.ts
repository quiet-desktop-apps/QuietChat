// Offline integration harness. Never connects to WhatsApp.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AppEvents, type Transport } from '../src/model.js';
import { DemoTransport } from '../src/demo.js';
import { TerminalUI } from '../src/ui.js';

process.umask(0o077);
const directory = process.argv[2];
if (!directory) throw new Error('A temporary fixture directory is required.');
const store = new Store(join(directory, 'fixture.db'));
const events = new AppEvents();
const demo = new DemoTransport(store, events);
const transport: Transport = {
  start: () => demo.start(), stop: () => demo.stop(),
  sendText: async (chat, text, reply) => { if (text === 'fail-send') throw new Error('Simulated offline connection'); await demo.sendText(chat, text, reply); },
  sendMedia: (...args) => demo.sendMedia(...args), react: (...args) => demo.react(...args), download: message => demo.download(message),
};
const quit = () => { ui.destroy(); store.close(); process.exit(0); };
const ui = new TerminalUI(store, transport, events, directory, true, quit);
process.once('SIGTERM', quit);
process.on('SIGUSR1', () => events.emit('qr', 'QUIETCHAT OFFLINE TEST QR - NOT A WHATSAPP LOGIN'));
process.on('SIGUSR2', () => events.emit('qr', undefined));
process.on('SIGHUP', () => writeFileSync(join(directory, 'screen.txt'), ui.screen.screenshot(0, Number(ui.screen.width), 0, Number(ui.screen.height))));
await demo.start();
store.put({ key: { remoteJid: 'demo-alex@s.whatsapp.net', id: 'history-without-name' }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'History without a push name\nA second incoming line' } });
events.emit('changed');

if (process.argv.includes('--redraw-stress')) {
  const now = Math.floor(Date.now() / 1000);
  store.contact('demo-member@s.whatsapp.net', 'Taylor');
  store.chat('demo-weekend@g.us', 'Weekend group 🍻', now - 200);
  for (const chat of ['demo-alex@s.whatsapp.net', 'demo-weekend@g.us']) {
    for (let i = 0; i < 85; i++) {
      const mine = i % 3 === 0;
      store.put({ key: { remoteJid: chat, id: `stress-${i}`, fromMe: mine, ...(chat.endsWith('@g.us') ? { participant: 'demo-member@s.whatsapp.net' } : {}) },
        pushName: 'Taylor', messageTimestamp: now - 300 + i,
        message: { conversation: `${chat.endsWith('@g.us') ? 'GROUP' : 'DIRECT'} ${i}: ${'Variable width bubble '.repeat(i % 6 + 1)}${i % 4 === 0 ? '\nAnother line with café and 界 👍 ❤️ ☀️ 1️⃣ 🇨🇭 👩‍💻 👍🏽 🥂' : ''}` } });
    }
  }
  process.on('SIGCONT', () => { ui.screen.realloc(); ui.screen.render(); });
  events.emit('changed');
}

if (process.argv.includes('--interaction')) {
  ui.screen.program.on('mouse', data => appendFileSync(join(directory, 'mouse.jsonl'), JSON.stringify(data) + '\n'));
  const now = Math.floor(Date.now() / 1000);
  const chat = 'demo-alex@s.whatsapp.net';
  store.put({ key: { remoteJid: chat, id: 'link-test' }, pushName: 'Alex', messageTimestamp: now + 1,
    message: { conversation: 'A wrapped link: https://example.test/' + 'section/'.repeat(18) + '?x=1&y=$value' } });
  store.put({ key: { remoteJid: chat, id: 'copy-test' }, pushName: 'Alex', messageTimestamp: now + 2,
    message: { conversation: 'Copy this conversation text\nSecond pasted line' } });
  events.emit('changed');
}

// A populated database is not sufficient: the debounced chat-list render must
// finish before the PTY harness sends its first key.
const markReady = () => {
  const screen = ui.screen.screenshot(0, Number(ui.screen.width), 0, Number(ui.screen.height));
  if (!screen.includes('Alex · demo') || !screen.includes('Sam · demo')) return;
  writeFileSync(join(directory, 'ready'), 'ready\n');
  ui.screen.removeListener('render', markReady);
};
ui.screen.on('render', markReady);
