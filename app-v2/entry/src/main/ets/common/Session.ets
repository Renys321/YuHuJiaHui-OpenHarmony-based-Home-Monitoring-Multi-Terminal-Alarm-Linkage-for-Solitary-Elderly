import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

export class HistoryItem {
  phone: string = '';
  nickname: string = '';
  lastLogin: number = 0;
}

export class Session {
  private static readonly STORE: string = 'elder_care_session';
  private static readonly MAX_HISTORY: number = 5;

  static save(ctx: common.Context, phone: string, remember: boolean): Promise<void> {
    return preferences.getPreferences(ctx, Session.STORE).then((store) => {
      return store.put('phone', phone).then(() => {
        return store.put('token', `mock-token-${Date.now()}`).then(() => {
          return store.put('remember', remember).then(() => {
            return store.flush();
          });
        });
      });
    });
  }

  static load(ctx: common.Context): Promise<string> {
    return preferences.getPreferences(ctx, Session.STORE).then((store) => {
      return store.get('phone', '').then((v) => v as string);
    });
  }

  static clear(ctx: common.Context): Promise<void> {
    return preferences.getPreferences(ctx, Session.STORE).then((store) => {
      return store.delete('phone').then(() => {
        return store.delete('token').then(() => {
          return store.delete('remember').then(() => {
            return store.flush();
          });
        });
      });
    });
  }

  static addHistory(ctx: common.Context, phone: string, nickname: string): Promise<void> {
    return preferences.getPreferences(ctx, Session.STORE).then((store) => {
      return store.get('history', '').then((raw) => {
        const src: string = raw as string;
        const list: string[] = [];
        if (src.length > 0) {
          const parts: string[] = src.split(';');
          for (let i = 0; i < parts.length; i++) {
            const p: string = parts[i];
            if (p.length > 0 && p.indexOf(`${phone},`) !== 0)
              list.push(p);
          }
        }
        const safeNick: string = nickname.split(',').join(' ').split(';').join(' ');
        list.unshift(`${phone},${safeNick},${Date.now()}`);
        const trimmed: string[] = list.slice(0, Session.MAX_HISTORY);
        return store.put('history', trimmed.join(';')).then(() => {
          return store.flush();
        });
      });
    });
  }

  static removeHistory(ctx: common.Context, phone: string): Promise<void> {
    return preferences.getPreferences(ctx, Session.STORE).then((store) => {
      return store.get('history', '').then((raw) => {
        const src: string = raw as string;
        if (src.length === 0)
          return store.flush();
        const kept: string[] = [];
        const parts: string[] = src.split(';');
        for (let i = 0; i < parts.length; i++)
          if (parts[i].length > 0 && parts[i].indexOf(`${phone},`) !== 0)
            kept.push(parts[i]);
        return store.put('history', kept.join(';')).then(() => {
          return store.flush();
        });
      });
    });
  }

  static getHistory(ctx: common.Context): Promise<HistoryItem[]> {
    return preferences.getPreferences(ctx, Session.STORE).then((store) => {
      return store.get('history', '').then((raw) => {
        const result: HistoryItem[] = [];
        const src: string = raw as string;
        if (src.length === 0)
          return result;
        const parts: string[] = src.split(';');
        for (let i = 0; i < parts.length; i++) {
          const f: string[] = parts[i].split(',');
          if (f.length >= 3) {
            const item = new HistoryItem();
            item.phone = f[0];
            item.nickname = f[1];
            item.lastLogin = Number(f[2]);
            result.push(item);
          }
        }
        return result;
      });
    });
  }
}
