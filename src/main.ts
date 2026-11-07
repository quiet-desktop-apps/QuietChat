import { mkdtempSync, rmSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { acquireLock, dataDirectory } from './paths.js';
import { Store } from './store.js';
import { AppEvents, type Transport } from './model.js';
import { MediaCache } from './media.js';
import { TerminalUI } from './ui.js';
import { WhatsAppTransport } from './transport.js';
import { DemoTransport } from './demo.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const { values } = parseArgs({ options: {
    demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' },
    'data-dir': { type: 'string' }, 'reset-session': { type: 'boolean' }, 'clear-cache': { type: 'boolean' },
  } });
  if (values.version) {
    const metadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(`QuietChat ${metadata.version}\nSource: ${fileURLToPath(new URL('../../', import.meta.url))}\nNode: ${process.version}`);
    return;
  }
  if (values.help) {
    console.log(`QuietChat — a terminal WhatsApp companion\n\n./run.sh                 Connect / display a pairing QR\n./run.sh --demo          Offline demo (no account needed)\n./run.sh --reset-session Forget local login, then pair again\n./run.sh --clear-cache   Delete downloaded media and exit\n./run.sh --data-dir DIR  Use a separate private data directory\n\nRequires Node.js 22.16+, mpv, and optionally zenity.\nF1 help · F2 QR window · F3 attach · F8 reply · Ctrl+Q quit\nUnofficial client: WhatsApp account restrictions remain possible.`);
    return;
  }
  if (!values['clear-cache'] && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Run QuietChat in an interactive terminal (or use --help).');
  const temporary = values.demo ? mkdtempSync(join(tmpdir(), 'quietchat-demo-')) : undefined;
  const directory = dataDirectory(temporary ?? values['data-dir']);
  const unlock = acquireLock(directory);
  let store: Store | undefined, transport: Transport | undefined, ui: TerminalUI | undefined;
  let quitting = false;
  const originalConsole = globalThis.console;
  function shutdown(): void {
    if (quitting) return;
    quitting = true; transport?.stop(); ui?.destroy(); globalThis.console = originalConsole;
    store?.close(); unlock();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  try {
    const qrPath = join(directory, 'pairing.png');
    if (existsSync(qrPath)) unlinkSync(qrPath);
    const cache = new MediaCache(join(directory, 'media')); await cache.init();
    if (values['clear-cache']) { await cache.clear(); console.log('QuietChat media cache cleared.'); shutdown(); return; }
    store = new Store(join(directory, 'quietchat.db'));
    if (values['reset-session']) store.db.exec('DELETE FROM auth');
    store.prune();
    const events = new AppEvents();
    transport = values.demo ? new DemoTransport(store, events) : new WhatsAppTransport(store, events, cache);
    const quit = () => { shutdown(); process.exit(0); };
    ui = new TerminalUI(store, transport, events, directory, !!values.demo, quit);
    // libsignal logs session objects directly to console; never expose session keys
    // or let those logs corrupt the terminal. User-facing failures use AppEvents.
    const discard = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    globalThis.console = new Console({ stdout: discard, stderr: discard });
    process.once('SIGINT', quit); process.once('SIGTERM', quit); process.once('SIGHUP', quit);
    const unexpectedFailure = () => {
      shutdown();
      originalConsole.error('QuietChat stopped after an unexpected internal error. Restart it; the saved login and stored history remain on disk.');
      process.exit(1);
    };
    process.once('uncaughtException', unexpectedFailure);
    process.once('unhandledRejection', unexpectedFailure);
    await transport.start();
  } catch (error) { shutdown(); throw error; }
}

main().catch(error => { console.error(`QuietChat: ${(error as Error).message}`); process.exitCode = 1; });
