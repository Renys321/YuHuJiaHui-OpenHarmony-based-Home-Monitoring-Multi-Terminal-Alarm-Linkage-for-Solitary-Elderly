/**
 * 守护对象资料的本机持久化（姓名/年龄/性别/住址/病史）。
 * 后端健康档案只覆盖年龄/病史等健康字段，没有姓名/住址/性别；
 * 这里用 Preferences 存在本机，并同步到 AppStorage 的 gv.elderOverride 供页面展示。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { Elder } from '../model/Elder';

class HealthExtra {
  heightCm: number = 0;
  weightKg: number = 0;
  medications: string = '';
  systolic: number = 0;
  diastolic: number = 0;
  fastingGlucose: number = 0;
}

export class ElderProfileLocal {
  private static readonly STORE: string = 'elder_profile_local';

  static load(ctx: common.Context): Promise<Elder | null> {
    return preferences.getPreferences(ctx, ElderProfileLocal.STORE).then((store) => {
      return store.get('owner', '').then((ownerV) => {
        const owner = ownerV as string;
        const current = AppStorage.get<string>('gv.guardianId') ?? '';
        if (owner.length === 0 || owner !== current) return null;
        return store.get('name', '').then((nameV) => {
        const name = nameV as string;
        if (name.length === 0) return null;
        return store.get('age', 0).then((ageV) => {
          return store.get('gender', 'male').then((genderV) => {
            return store.get('address', '').then((addressV) => {
              return store.get('medicalHistory', '').then((historyV) => {
                const e = new Elder();
                e.id = 'LOCAL';
                e.name = name;
                e.age = ageV as number;
                e.gender = (genderV as string) === 'female' ? 'female' : 'male';
                e.address = addressV as string;
                e.medicalHistory = historyV as string;
                return store.get('healthExtra', '').then((extraV) => {
                  try {
                    const x = JSON.parse(extraV as string) as HealthExtra;
                    e.heightCm = Number(x.heightCm) || 0;
                    e.weightKg = Number(x.weightKg) || 0;
                    e.medications = typeof x.medications === 'string' ? x.medications : '';
                    e.systolic = Number(x.systolic) || 0;
                    e.diastolic = Number(x.diastolic) || 0;
                    e.fastingGlucose = Number(x.fastingGlucose) || 0;
                  } catch (err) { /* 兼容旧数据 */ }
                  return e;
                });
              });
            });
          });
        });
        });
      });
    });
  }

  static save(ctx: common.Context, e: Elder): Promise<void> {
    return preferences.getPreferences(ctx, ElderProfileLocal.STORE).then((store) => {
      return store.put('owner', AppStorage.get<string>('gv.guardianId') ?? '').then(() => {
      return store.put('name', e.name).then(() => {
        return store.put('age', e.age).then(() => {
          return store.put('gender', e.gender).then(() => {
            return store.put('address', e.address).then(() => {
              return store.put('medicalHistory', e.medicalHistory).then(() => {
                const extra = JSON.stringify({
                  heightCm: e.heightCm, weightKg: e.weightKg, medications: e.medications,
                  systolic: e.systolic, diastolic: e.diastolic, fastingGlucose: e.fastingGlucose
                });
                return store.put('healthExtra', extra).then(() => store.flush());
              });
            });
          });
        });
      });
      });
    });
  }

  static clearAppStorage(): void {
    AppStorage.delete('gv.elderOverride');
  }

  static loadIntoAppStorage(ctx: common.Context): Promise<void> {
    return ElderProfileLocal.load(ctx).then((e) => {
      if (e !== null) {
        AppStorage.setOrCreate<Elder>('gv.elderOverride', e);
        AppStorage.setOrCreate<number>('gv.elderRevision', Date.now());
      }
    });
  }
}
