import { Store, HISTORY_LIMIT } from '../src/store.js';
import { DemoTransport } from '../src/demo.js';
import { AppEvents } from '../src/model.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'quietchat-benchmark-'));
const store = new Store(join(directory, 'bench.db'));
try {
  const start = process.memoryUsage().rss;
  await new DemoTransport(store, new AppEvents()).start();
  store.transaction(() => {
    for (let i = 0; i < 12_000; i++) store.put({ key: { remoteJid: 'bench@s.whatsapp.net', id: `${i}` }, messageTimestamp: i + 1, message: { conversation: `Synthetic message ${i}: ${'bounded history '.repeat(8)}` } });
    store.prune();
  });
  for (let i = 0; i < 500; i++) { store.listChats(); store.messages('bench@s.whatsapp.net', (i % 100) * 60); }
  await new Promise(resolve => setTimeout(resolve, 1000));
  const MiB = (bytes: number) => +(bytes / 1048576).toFixed(1);
  console.log(JSON.stringify({ scope: 'Offline synthetic workload; no live WhatsApp connection, terminal, or player', node: process.version, retainedMessageLimit: HISTORY_LIMIT, retainedMessages: store.db.prepare('SELECT count(*) count FROM messages').get()?.count, startupRssMiB: MiB(start), afterWorkloadRssMiB: MiB(process.memoryUsage().rss), peakRssMiB: MiB(process.resourceUsage().maxRSS * 1024) }, null, 2));
} finally { store.close(); await rm(directory, { recursive: true }); }
