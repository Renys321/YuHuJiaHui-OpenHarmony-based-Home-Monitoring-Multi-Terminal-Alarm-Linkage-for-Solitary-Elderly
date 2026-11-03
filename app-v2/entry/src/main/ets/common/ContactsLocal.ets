/**
 * 紧急联系人的本机管理存储。
 * 服务端 /api/v1/contacts 只读，没有新增/修改/删除接口；
 * 这里的修改只保存在本机，并同步 gv.contactsOverride 供页面展示。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { EmergencyContact } from '../model/Elder';

export class ContactsLocal {
  private static readonly STORE: string = 'elder_contacts_local';

  static load(ctx: common.Context): Promise<EmergencyContact[] | null> {
    return preferences.getPreferences(ctx, ContactsLocal.STORE).then((store) => {
      return store.get('owner', '').then((ownerV) => {
        const owner = ownerV as string;
        const current = AppStorage.get<string>('gv.guardianId') ?? '';
        if (owner.length === 0 || owner !== current) return null;
        return store.get('json', '').then((v) => {
        const text = v as string;
        if (text.length === 0) return null;
        const arr = JSON.parse(text) as EmergencyContact[];
        if (arr === null || arr === undefined) return null;
        const out: EmergencyContact[] = [];
        for (let i = 0; i < arr.length; i++) {
          const c = new EmergencyContact();
          c.id = arr[i].id;
          c.name = arr[i].name;
          c.relation = arr[i].relation;
          c.phone = arr[i].phone;
          c.priority = arr[i].priority;
          c.notifyEnabled = arr[i].notifyEnabled;
          out.push(c);
        }
        return out;
      });
      });
    });
  }

  static save(ctx: common.Context, list: EmergencyContact[]): Promise<void> {
    return preferences.getPreferences(ctx, ContactsLocal.STORE).then((store) => {
      return store.put('owner', AppStorage.get<string>('gv.guardianId') ?? '').then(() => {
      return store.put('json', JSON.stringify(list)).then(() => store.flush());
      });
    });
  }

  static clearAppStorage(): void {
    AppStorage.delete('gv.contactsOverride');
  }

  static loadIntoAppStorage(ctx: common.Context): Promise<void> {
    return ContactsLocal.load(ctx).then((list) => {
      if (list !== null) {
        AppStorage.setOrCreate<EmergencyContact[]>('gv.contactsOverride', list);
        AppStorage.setOrCreate<number>('gv.elderRevision', Date.now());
      }
    });
  }
}
