/**
 * 演示模式的 AppStorage 适配层。
 *
 * 只写本例程内的 gv.* 展示状态；绝不调用 GuardianService、不写 TokenVault/AssetStore、
 * 不启动 Poller、不发送 ACK/SOS。退出演示后恢复默认空状态，真实会话与安全存储不动。
 */
import {
  AlertView, AppKeys, ContactView, DataSource, DeviceView, NetworkState, OverviewView,
  RoomView, RunMode
} from '../core/view/Models';
import { DemoController } from '../core/demo/DemoController';
import { DemoSnapshot } from '../core/demo/DemoData';

const controller: DemoController = new DemoController();

export class DemoMode {
  /** 用户主动进入演示；只填充本地示例数据。 */
  static enter(): void {
    const snapshot: DemoSnapshot = controller.enter();
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.DEMO);
    AppStorage.setOrCreate<string>(AppKeys.GUARDIAN_ID, snapshot.guardianId);
    AppStorage.setOrCreate<string>(AppKeys.TOKEN_STORAGE, 'demo');
    AppStorage.setOrCreate<string>(AppKeys.DATA_SOURCE, DataSource.DEMO);
    AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.OK);
    AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, '演示模式：本地示例数据，不连接真实设备');
    AppStorage.setOrCreate<number>(AppKeys.LAST_UPDATED_AT, snapshot.generatedAt);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.DEVICES, snapshot.devices);
    AppStorage.setOrCreate<RoomView[]>(AppKeys.ROOMS, snapshot.rooms);
    AppStorage.setOrCreate<AlertView[]>(AppKeys.ALERTS, snapshot.alerts);
    AppStorage.setOrCreate<OverviewView>(AppKeys.OVERVIEW, snapshot.overview);
    AppStorage.setOrCreate<ContactView[]>(AppKeys.CONTACTS, snapshot.contacts);
  }

  /** 退出演示：清空演示展示状态；不触碰真实会话、Token、安全存储。 */
  static exit(): void {
    controller.exit();
    AppStorage.setOrCreate<string>(AppKeys.MODE, RunMode.NONE);
    AppStorage.setOrCreate<string>(AppKeys.GUARDIAN_ID, '');
    AppStorage.setOrCreate<string>(AppKeys.TOKEN_STORAGE, 'memory');
    AppStorage.setOrCreate<string>(AppKeys.DATA_SOURCE, DataSource.NONE);
    AppStorage.setOrCreate<string>(AppKeys.NET_STATUS, NetworkState.UNKNOWN);
    AppStorage.setOrCreate<string>(AppKeys.NET_MESSAGE, '');
    AppStorage.setOrCreate<number>(AppKeys.LAST_UPDATED_AT, 0);
    AppStorage.setOrCreate<DeviceView[]>(AppKeys.DEVICES, []);
    AppStorage.setOrCreate<RoomView[]>(AppKeys.ROOMS, []);
    AppStorage.setOrCreate<AlertView[]>(AppKeys.ALERTS, []);
    AppStorage.setOrCreate<OverviewView>(AppKeys.OVERVIEW, new OverviewView());
    AppStorage.setOrCreate<ContactView[]>(AppKeys.CONTACTS, []);
  }

  static isDemo(): boolean {
    return AppStorage.get<string>(AppKeys.MODE) === RunMode.DEMO;
  }
}
