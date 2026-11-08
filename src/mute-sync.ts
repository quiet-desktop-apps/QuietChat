import { decodePatches, decodeSyncdSnapshot, extractSyncdPatches, type AuthenticationState, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { isChatJid } from './model.js';

const codec = { extractSyncdPatches, decodeSyncdSnapshot, decodePatches };
// The SDK can warn and skip a malformed patch. For mute policy, partial success
// would enable alerts incorrectly, so reject the snapshot instead.
const strictLogger = pino({ level: 'silent' });
strictLogger.warn = () => { throw new Error('Invalid mute settings snapshot'); };

// Read a verified snapshot without changing Baileys' sync cursor or replaying
// its other actions (such as old chat deletions). Retain only mute values.
export async function fetchMuteSettings(socket: Pick<WASocket, 'query'>, auth: AuthenticationState, decode = codec): Promise<Map<string, number | null>> {
  const settings = new Map<string, number | null>();
  const getKey = async (id: string) => (await auth.keys.get('app-state-sync-key', [id]))[id];
  let state: Awaited<ReturnType<typeof decodeSyncdSnapshot>>['state'] | undefined;
  const options = { signal: AbortSignal.timeout(30_000) };
  for (let batch = 0; batch < 5; batch++) {
    const reply = await socket.query({ tag:'iq', attrs:{ to:'s.whatsapp.net', xmlns:'w:sync:app:state', type:'set' },
      content:[{ tag:'sync', attrs:{}, content:[{ tag:'collection', attrs:{ name:'regular_high', version:String(state?.version || 0), return_snapshot:state ? 'false' : 'true' } }] }] }, 15_000);
    const collection = (await decode.extractSyncdPatches(reply, options)).regular_high;
    if (!collection || (!state && !collection.snapshot)) throw new Error('Mute settings snapshot unavailable');
    const collect = (mutations: Awaited<ReturnType<typeof decodeSyncdSnapshot>>['mutationMap']) => {
      for (const mutation of Object.values(mutations)) {
        const [type, id] = mutation.index, action = mutation.syncAction.value?.muteAction;
        if (type !== 'mute' || !id || !isChatJid(id) || !action) continue;
        const value = action.muted ? Number(action.muteEndTimestamp ?? -1) : null;
        if (value !== null && !Number.isFinite(value)) throw new Error('Invalid mute expiry');
        settings.set(id, action.muted && value === 0 ? -1 : value);
        if (settings.size > 10_000) throw new Error('Mute settings exceed the local limit');
      }
    };
    if (collection.snapshot) {
      const decoded = await decode.decodeSyncdSnapshot('regular_high', collection.snapshot, getKey, undefined, true, strictLogger);
      settings.clear(); state = decoded.state; collect(decoded.mutationMap);
    }
    if (collection.patches.length) {
      const decoded = await decode.decodePatches('regular_high', collection.patches, state!, getKey, options, undefined, strictLogger, true);
      state = decoded.state; collect(decoded.mutationMap);
    }
    if (!collection.hasMorePatches) return settings;
  }
  throw new Error('Mute settings sync did not finish within the batch limit');
}
