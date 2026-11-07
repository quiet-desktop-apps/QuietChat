// Fetch an unpaired QR to check compatibility without accessing an account.
// Never print, retain, or scan this test QR.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AppEvents } from '../src/model.js';
import { MediaCache } from '../src/media.js';
import { WhatsAppTransport } from '../src/transport.js';

process.umask(0o077);
const directory = await mkdtemp(join(tmpdir(), 'quietchat-probe-'));
const store = new Store(join(directory, 'probe.db'));
const events = new AppEvents();
const transport = new WhatsAppTransport(store, events, new MediaCache(join(directory, 'media')));
const started = Date.now();
let timer: NodeJS.Timeout | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('No QR received within 30 seconds.')), 30_000);
    events.on('qr', qr => { if (qr) resolve(); });
    events.on('notice', () => reject(new Error('WhatsApp adapter reported an error.')));
    events.on('connection', state => {
      console.log(`Connection: ${state.phase}`);
      if (state.phase === 'logged-out') reject(new Error('Server rejected the unpaired session.'));
    });
    void transport.start().catch(reject);
  });
  console.log(`Received a real WhatsApp pairing QR in ${Date.now() - started}ms. No account linked. QR discarded.`);
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
finally { clearTimeout(timer); transport.stop(); store.close(); await rm(directory, { recursive: true }); }
