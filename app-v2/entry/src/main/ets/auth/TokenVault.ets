/**
 * Token 安全存储适配器。
 *
 * - 首选 HarmonyOS Asset Store（@kit.AssetStoreKit）：系统安全存储，明文不落普通文件。
 * - 若设备/系统不支持（asset API 抛错），退化为“仅内存会话”，绝不写 Preferences/SQLite 明文。
 * - token 不打印、不进日志；密码从不经过本类。
 */
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';

export class StoredSession {
  token: string = '';
  guardianId: string = '';
  expiresAt: number = 0;
}

export class TokenVault {
  private static readonly ALIAS: string = 'eldercare_guardian_session_v1';
  private static memorySession: StoredSession | null = null;
  private static storageMode: string = 'memory';
  private static secureChecked: boolean = false;
  private static secureAvailable: boolean = false;

  static mode(): string {
    return TokenVault.storageMode;
  }

  static setMemory(session: StoredSession): void {
    TokenVault.memorySession = session;
    if (TokenVault.storageMode !== 'secure') {
      TokenVault.storageMode = 'memory';
    }
  }

  static memory(): StoredSession | null {
    return TokenVault.memorySession;
  }

  static clearMemory(): void {
    TokenVault.memorySession = null;
  }

  private static aliasBytes(): Uint8Array {
    return new util.TextEncoder().encodeInto(TokenVault.ALIAS);
  }

  private static encodeSession(session: StoredSession): Uint8Array {
    const json: string = JSON.stringify({
      token: session.token,
      guardianId: session.guardianId,
      expiresAt: session.expiresAt
    });
    return new util.TextEncoder().encodeInto(json);
  }

  private static decodeSession(bytes: Uint8Array): StoredSession | null {
    try {
      const text: string = new util.TextDecoder('utf-8').decodeWithStream(bytes);
      const parsed = JSON.parse(text) as Record<string, Object>;
      const token: Object = parsed['token'];
      const guardianId: Object = parsed['guardianId'];
      const expiresAt: Object = parsed['expiresAt'];
      if (typeof token !== 'string' || token.length === 0) return null;
      const session = new StoredSession();
      session.token = token;
      session.guardianId = typeof guardianId === 'string' ? guardianId : '';
      session.expiresAt = typeof expiresAt === 'number' ? expiresAt : 0;
      return session;
    } catch (error) {
      return null;
    }
  }

  private static removalQuery(): asset.AssetMap {
    const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    query.set(asset.Tag.ALIAS, TokenVault.aliasBytes());
    return query;
  }

  /** 返回是否成功写入系统安全存储。失败即表示只能内存会话。 */
  static async saveSecure(session: StoredSession): Promise<boolean> {
    try {
      try {
        await asset.remove(TokenVault.removalQuery());
      } catch (removeError) {
        // 不存在或不可移除时继续尝试新增。
      }
      const attrs: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      attrs.set(asset.Tag.ALIAS, TokenVault.aliasBytes());
      attrs.set(asset.Tag.SECRET, TokenVault.encodeSession(session));
      attrs.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_POWERED_ON);
      await asset.add(attrs);
      TokenVault.storageMode = 'secure';
      TokenVault.secureAvailable = true;
      TokenVault.secureChecked = true;
      return true;
    } catch (error) {
      TokenVault.storageMode = 'memory';
      TokenVault.secureAvailable = false;
      TokenVault.secureChecked = true;
      return false;
    }
  }

  static async loadSecure(): Promise<StoredSession | null> {
    try {
      const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
      query.set(asset.Tag.ALIAS, TokenVault.aliasBytes());
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const results: Array<asset.AssetMap> = await asset.query(query);
      TokenVault.secureChecked = true;
      if (!results || results.length === 0) {
        return null;
      }
      const secret: asset.Value | undefined = results[0].get(asset.Tag.SECRET);
      if (secret === undefined || !(secret instanceof Uint8Array)) {
        return null;
      }
      TokenVault.storageMode = 'secure';
      TokenVault.secureAvailable = true;
      return TokenVault.decodeSession(secret as Uint8Array);
    } catch (error) {
      TokenVault.storageMode = 'memory';
      TokenVault.secureAvailable = false;
      TokenVault.secureChecked = true;
      return null;
    }
  }

  static async clearSecure(): Promise<void> {
    try {
      await asset.remove(TokenVault.removalQuery());
    } catch (error) {
      // 无安全存储或条目不存在时忽略；调用方仍会清内存。
    }
  }

  static isSecureAvailable(): boolean {
    return TokenVault.secureAvailable;
  }

  static hasCheckedSecure(): boolean {
    return TokenVault.secureChecked;
  }
}
