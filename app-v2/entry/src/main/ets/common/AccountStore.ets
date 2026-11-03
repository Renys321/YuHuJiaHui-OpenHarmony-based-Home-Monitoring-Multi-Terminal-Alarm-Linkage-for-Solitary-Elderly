// 账号数据库 —— RelationalStore(SQLite)

import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { buffer } from '@kit.ArkTS';

export class AccountInfo {
  id: number = 0;
  phone: string = '';
  password: string = '';
  nickname: string = '';
  relation: string = '';
  createdAt: number = 0;
}

const STORE_CONFIG: relationalStore.StoreConfig = {
  name: 'elder_care.db',
  securityLevel: relationalStore.SecurityLevel.S1
};

const CREATE_TABLE: string =
  'CREATE TABLE IF NOT EXISTS account (' +
  'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
  'phone TEXT UNIQUE NOT NULL, ' +
  'password TEXT NOT NULL, ' +
  'nickname TEXT NOT NULL, ' +
  'relation TEXT NOT NULL, ' +
  'created_at INTEGER NOT NULL)';

export class AccountStore {
  static readonly DEMO_PHONE: string = '13988238823';

  static hashPassword(phone: string, pwd: string): Promise<string> {
    const md = cryptoFramework.createMd('SHA256');
    const input: cryptoFramework.DataBlob = { data: new Uint8Array(buffer.from(`${phone}::${pwd}`, 'utf-8').buffer) };
    return md.update(input).then(() => {
      return md.digest();
    }).then((digest: cryptoFramework.DataBlob) => {
      let hex: string = '';
      const bytes: Uint8Array = digest.data;
      for (let i = 0; i < bytes.length; i++) {
        const s: string = bytes[i].toString(16);
        hex += s.length === 1 ? `0${s}` : s;
      }
      return hex;
    });
  }

  private static db(ctx: common.Context): Promise<relationalStore.RdbStore> {
    return relationalStore.getRdbStore(ctx, STORE_CONFIG).then((store: relationalStore.RdbStore) => {
      return store.executeSql(CREATE_TABLE).then(() => {
        return store;
      });
    });
  }

  static findByPhone(ctx: common.Context, phone: string): Promise<AccountInfo | null> {
    return AccountStore.db(ctx).then((store: relationalStore.RdbStore) => {
      const pred = new relationalStore.RdbPredicates('account');
      pred.equalTo('phone', phone);
      return store.query(pred).then((rs: relationalStore.ResultSet) => {
        let acc: AccountInfo | null = null;
        if (rs.goToNextRow()) {
          const a = new AccountInfo();
          a.id = rs.getLong(rs.getColumnIndex('id'));
          a.phone = rs.getString(rs.getColumnIndex('phone'));
          a.password = rs.getString(rs.getColumnIndex('password'));
          a.nickname = rs.getString(rs.getColumnIndex('nickname'));
          a.relation = rs.getString(rs.getColumnIndex('relation'));
          a.createdAt = rs.getLong(rs.getColumnIndex('created_at'));
          acc = a;
        }
        rs.close();
        return acc;
      });
    });
  }

  static register(ctx: common.Context, phone: string, pwdPlain: string,
                  nickname: string, relation: string): Promise<void> {
    return AccountStore.hashPassword(phone, pwdPlain).then((hashed: string) => {
      return AccountStore.db(ctx).then((store: relationalStore.RdbStore) => {
        const bucket: relationalStore.ValuesBucket = {
          'phone': phone,
          'password': hashed,
          'nickname': nickname,
          'relation': relation,
          'created_at': Date.now()
        };
        return store.insert('account', bucket).then((rowId: number) => {
          return;
        });
      });
    });
  }

  static updatePassword(ctx: common.Context, phone: string, newPwdPlain: string): Promise<void> {
    return AccountStore.hashPassword(phone, newPwdPlain).then((hashed: string) => {
      return AccountStore.db(ctx).then((store: relationalStore.RdbStore) => {
        const pred = new relationalStore.RdbPredicates('account');
        pred.equalTo('phone', phone);
        const bucket: relationalStore.ValuesBucket = { 'password': hashed };
        return store.update(bucket, pred).then((rows: number) => {
          return;
        });
      });
    });
  }

  static verifyLogin(ctx: common.Context, phone: string, pwdPlain: string): Promise<string> {
    return AccountStore.findByPhone(ctx, phone).then((acc: AccountInfo | null) => {
      if (acc === null)
        return 'NOT_REGISTERED';
      return AccountStore.hashPassword(phone, pwdPlain).then((hashed: string) => {
        return hashed === acc.password ? 'OK' : 'WRONG_PWD';
      });
    });
  }

  static deleteAccount(ctx: common.Context, phone: string): Promise<void> {
    return AccountStore.db(ctx).then((store: relationalStore.RdbStore) => {
      const pred = new relationalStore.RdbPredicates('account');
      pred.equalTo('phone', phone);
      return store.delete(pred).then((rows: number) => {
        return;
      });
    });
  }

  static ensureSeed(ctx: common.Context): Promise<void> {
    return AccountStore.findByPhone(ctx, AccountStore.DEMO_PHONE).then((acc: AccountInfo | null) => {
      if (acc !== null)
        return;
      return AccountStore.register(ctx, AccountStore.DEMO_PHONE, '123456', '李强', '儿子');
    });
  }
}
