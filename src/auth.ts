import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { Store } from './store.js';

export function sqliteAuth(store: Store): { state: AuthenticationState; save: () => void } {
  const get = store.db.prepare('SELECT value FROM auth WHERE category=? AND id=?');
  const put = store.db.prepare('INSERT INTO auth VALUES (?,?,?) ON CONFLICT(category,id) DO UPDATE SET value=excluded.value');
  const remove = store.db.prepare('DELETE FROM auth WHERE category=? AND id=?');
  function read(category: string, id: string) {
    const row = get.get(category, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value, BufferJSON.reviver) : undefined;
  }
  const creds = read('creds', 'self') ?? initAuthCreds();
  const state: AuthenticationState = {
    creds,
    keys: {
      get: (type, ids) => {
        const result: Record<string, SignalDataTypeMap[typeof type]> = {};
        for (const id of ids) {
          let value = read(type, id);
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          if (value != null) result[id] = value;
        }
        return result;
      },
      set: data => store.transaction(() => {
        for (const [category, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries || {})) {
            if (value == null) remove.run(category, id);
            else put.run(category, id, JSON.stringify(value, BufferJSON.replacer));
          }
        }
      }),
    },
  };
  return { state, save: () => { put.run('creds', 'self', JSON.stringify(creds, BufferJSON.replacer)); } };
}
