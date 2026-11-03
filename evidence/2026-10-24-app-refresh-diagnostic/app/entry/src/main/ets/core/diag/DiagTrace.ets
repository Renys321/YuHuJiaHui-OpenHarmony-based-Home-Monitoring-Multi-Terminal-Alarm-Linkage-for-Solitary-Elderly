/** One-shot refresh diagnostics. No token/password/Authorization/Cookie is logged. */
import { hilog } from '@kit.PerformanceAnalysisKit';
import process from '@ohos.process';

const DOMAIN: number = 0x0001;
const TAG: string = 'AppRefreshDiag';

export class DiagTrace {
  static currentRefreshId: string = 'none';
  private static seq: number = 0;

  static next(origin: string): string {
    DiagTrace.seq += 1;
    DiagTrace.currentRefreshId = `r${Date.now()}-${DiagTrace.seq}-${origin}`;
    return DiagTrace.currentRefreshId;
  }

  static log(refreshId: string, event: string, detail: string): void {
    const line: string = `${refreshId}|pid=${process.pid}|${event}|${detail}`;
    hilog.info(DOMAIN, TAG, '%{public}s', line);
  }

  static deviceSummary(devices: Array<Object>): string {
    let kitchen: string = 'kitchen=absent';
    let bath: string = 'bath=absent';
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i] as Record<string, Object>;
      const id: string = typeof d['deviceId'] === 'string' ? d['deviceId'] as string : '';
      if (id === 'esp32-kitchen') {
        const sensors = d['sensors'] as Record<string, Object>;
        if (sensors !== null && sensors !== undefined) {
          const gas = sensors['gas'] as Record<string, Object>;
          const smoke = sensors['smoke'] as Record<string, Object>;
          kitchen = `kitchen=lastSeen:${String(d['lastSeenTs'])}` +
            `,gasRaw:${gas !== null && gas !== undefined ? String(gas['raw']) : 'na'}` +
            `,gasValid:${gas !== null && gas !== undefined ? String(gas['valid']) : 'na'}` +
            `,smokeRaw:${smoke !== null && smoke !== undefined ? String(smoke['raw']) : 'na'}` +
            `,smokeValid:${smoke !== null && smoke !== undefined ? String(smoke['valid']) : 'na'}`;
        }
      } else if (id === 'esp32-bath') {
        const sensors = d['sensors'] as Record<string, Object>;
        if (sensors !== null && sensors !== undefined) {
          const motion = sensors['motion'] as Record<string, Object>;
          bath = `bath=lastSeen:${String(d['lastSeenTs'])}` +
            `,motionLast:${motion !== null && motion !== undefined ? String(motion['lastActiveTs']) : 'na'}` +
            `,motionCount:${motion !== null && motion !== undefined ? String(motion['countToday']) : 'na'}`;
        }
      }
    }
    return `${kitchen},${bath}`;
  }

  static sensorSummary(devices: Array<Object>): string {
    let kitchen: string = 'kitchen=absent';
    let bath: string = 'bath=absent';
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i] as Record<string, Object>;
      const id: string = typeof d['deviceId'] === 'string' ? d['deviceId'] as string : '';
      const sensors = d['sensors'] as Array<Object>;
      if (sensors === null || sensors === undefined) continue;
      for (let j = 0; j < sensors.length; j++) {
        const s = sensors[j] as Record<string, Object>;
        const kind: string = typeof s['kind'] === 'string' ? s['kind'] as string : '';
        if (id === 'esp32-kitchen' && (kind === 'gas' || kind === 'smoke')) {
          if (kitchen === 'kitchen=absent') kitchen = 'kitchen=';
          kitchen += `${kind}:${String(s['valueText'])}/${String(s['state'])}/${String(s['validity'])}|`;
        } else if (id === 'esp32-bath' && kind === 'motion') {
          bath = `bath=motion:${String(s['valueText'])}/${String(s['detailText'])}/${String(s['state'])}`;
        }
      }
    }
    return `${kitchen},${bath}`;
  }
}
