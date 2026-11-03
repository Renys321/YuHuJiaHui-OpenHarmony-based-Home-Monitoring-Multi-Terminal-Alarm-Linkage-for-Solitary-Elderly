/** Device identity diagnostics. White-listed fields only; no tokens/full payloads. */

export class IdentityTrace {
  private static seq: number = 0;

  static log(refreshId: string, event: string, detail: string): void {
    console.info(`DeviceIdentityDiag|${refreshId}|${event}|${detail}`);
  }

  private static value(o: Record<string, Object>, key: string): string {
    const v: Object = o[key];
    return v === undefined || v === null ? 'null' : String(v);
  }

  private static sensorKeys(raw: Record<string, Object>): string {
    const sensors: Object = raw['sensors'];
    if (sensors === null || sensors === undefined) return 'sensors=null';
    const s = sensors as Record<string, Object>;
    return Object.keys(s).join(',');
  }

  /** A: raw response devices, before parse. */
  static raw(responseText: string): void {
    let root: Record<string, Object> | null = null;
    try {
      root = JSON.parse(responseText) as Record<string, Object>;
    } catch (e) {
      IdentityTrace.log('none', 'dto.raw.parse', 'parse_error');
      return;
    }
    const arr: Object[] = Array.isArray(root['devices']) ? root['devices'] as Object[] : [];
    IdentityTrace.log('none', 'dto.raw.count', `count=${arr.length}`);
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] as Record<string, Object>;
      const sensors: Object = d['sensors'];
      let gas = 'null';
      let smoke = 'null';
      let motion = 'null';
      let climate = 'null';
      if (sensors !== null && sensors !== undefined) {
        const s = sensors as Record<string, Object>;
        const g = s['gas'] as Record<string, Object>;
        const sm = s['smoke'] as Record<string, Object>;
        const m = s['motion'] as Record<string, Object>;
        const c = s['climate'] as Record<string, Object>;
        if (g !== null && g !== undefined) gas = `raw=${IdentityTrace.value(g, 'raw')};valid=${IdentityTrace.value(g, 'valid')}`;
        if (sm !== null && sm !== undefined) smoke = `raw=${IdentityTrace.value(sm, 'raw')};valid=${IdentityTrace.value(sm, 'valid')}`;
        if (m !== null && m !== undefined) motion = `last=${IdentityTrace.value(m, 'lastActiveTs')};count=${IdentityTrace.value(m, 'countToday')}`;
        if (c !== null && c !== undefined) climate = `temp=${IdentityTrace.value(c, 'tempC')};rh=${IdentityTrace.value(c, 'rh')}`;
      }
      IdentityTrace.log('none', 'dto.raw.device',
        `index=${i}|deviceId=${IdentityTrace.value(d, 'deviceId')}|id=${IdentityTrace.value(d, 'id')}` +
        `|roomId=${IdentityTrace.value(d, 'roomId')}|roomName=${IdentityTrace.value(d, 'roomName')}` +
        `|lastSeenTs=${IdentityTrace.value(d, 'lastSeenTs')}|keys=${IdentityTrace.sensorKeys(d)}` +
        `|climate=${climate}|motion=${motion}|gas=${gas}|smoke=${smoke}`);
    }
  }

  /** B: DTO after parseDevice/parseSensors. */
  static dto(index: number, dto: Object): void {
    const d = dto as Record<string, Object>;
    const sensors: Object = d['sensors'];
    const s = sensors as Record<string, Object>;
    const motion = s['motion'] as Record<string, Object>;
    const gas = s['gas'] as Record<string, Object>;
    const smoke = s['smoke'] as Record<string, Object>;
    IdentityTrace.log('none', 'dto.parsed',
      `index=${index}|dtoSensorsSeq=${++IdentityTrace.seq}|deviceId=${IdentityTrace.value(d, 'deviceId')}` +
      `|roomId=${IdentityTrace.value(d, 'roomId')}|roomName=${IdentityTrace.value(d, 'roomName')}` +
      `|climate=${s !== null && s !== undefined ? String(s['climate'] !== null) : 'null'}` +
      `|motion=${s !== null && s !== undefined ? String(s['motion'] !== null) : 'null'}` +
      `|door=${s !== null && s !== undefined ? String(s['door'] !== null) : 'null'}` +
      `|gas=${s !== null && s !== undefined ? String(s['gas'] !== null) : 'null'}` +
      `|smoke=${s !== null && s !== undefined ? String(s['smoke'] !== null) : 'null'}` +
      `|gasRaw=${gas !== null && gas !== undefined ? IdentityTrace.value(gas, 'raw') : 'na'}` +
      `|smokeRaw=${smoke !== null && smoke !== undefined ? IdentityTrace.value(smoke, 'raw') : 'na'}` +
      `|motionLast=${motion !== null && motion !== undefined ? IdentityTrace.value(motion, 'lastActiveTs') : 'na'}` +
      `|motionCount=${motion !== null && motion !== undefined ? IdentityTrace.value(motion, 'countToday') : 'na'}`);
  }

  /** C/D: mapped DeviceView and each SensorView. */
  static mapped(devices: Object[]): void {
    IdentityTrace.log('none', 'map.devices.count', `count=${devices.length}`);
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i] as Record<string, Object>;
      const sensors = d['sensors'] as Object[];
      IdentityTrace.log('none', 'map.device',
        `index=${i}|deviceId=${IdentityTrace.value(d, 'deviceId')}|roomId=${IdentityTrace.value(d, 'roomId')}` +
        `|roomName=${IdentityTrace.value(d, 'roomName')}|online=${IdentityTrace.value(d, 'online')}` +
        `|lastSeenTs=${IdentityTrace.value(d, 'lastSeenTs')}|sensorsLength=${sensors !== null && sensors !== undefined ? sensors.length : -1}`);
      if (sensors === null || sensors === undefined) continue;
      for (let j = 0; j < sensors.length; j++) {
        const s = sensors[j] as Record<string, Object>;
        IdentityTrace.log('none', 'map.sensor',
          `deviceIndex=${i}|sensorIndex=${j}|id=${IdentityTrace.value(s, 'id')}` +
          `|deviceId=${IdentityTrace.value(s, 'deviceId')}|roomId=${IdentityTrace.value(s, 'roomId')}` +
          `|roomName=${IdentityTrace.value(s, 'roomName')}|kind=${IdentityTrace.value(s, 'kind')}` +
          `|value=${IdentityTrace.value(s, 'valueText')}|validity=${IdentityTrace.value(s, 'validity')}`);
      }
    }
  }

  static storage(devices: Object[]): void {
    IdentityTrace.log('none', 'storage.count', `count=${devices.length}`);
    const ids: Map<string, number> = new Map<string, number>();
    let mismatches: number = 0;
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i] as Record<string, Object>;
      const id: string = IdentityTrace.value(d, 'deviceId');
      const prev: number = ids.get(id) ?? 0;
      ids.set(id, prev + 1);
      const sensors = d['sensors'] as Object[];
      if (sensors !== null && sensors !== undefined) {
        for (let j = 0; j < sensors.length; j++) {
          const s = sensors[j] as Record<string, Object>;
          if (IdentityTrace.value(s, 'deviceId') !== id) mismatches += 1;
        }
      }
    }
    let duplicateIds: string = '';
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i] as Record<string, Object>;
      const id: string = IdentityTrace.value(d, 'deviceId');
      if ((ids.get(id) ?? 0) > 1) duplicateIds += `${id},`;
    }
    IdentityTrace.log('none', 'storage.audit', `duplicateIds=${duplicateIds.length > 0 ? duplicateIds : 'none'}|sensorDeviceIdMismatches=${mismatches}`);
    IdentityTrace.mapped(devices);
  }

  static sensors(label: string, sensors: Object[]): void {
    IdentityTrace.log('none', label, `count=${sensors.length}`);
    for (let i = 0; i < sensors.length; i++) {
      const s = sensors[i] as Record<string, Object>;
      IdentityTrace.log('none', `${label}.item`,
        `index=${i}|id=${IdentityTrace.value(s, 'id')}|deviceId=${IdentityTrace.value(s, 'deviceId')}` +
        `|roomId=${IdentityTrace.value(s, 'roomId')}|roomName=${IdentityTrace.value(s, 'roomName')}` +
        `|kind=${IdentityTrace.value(s, 'kind')}|value=${IdentityTrace.value(s, 'valueText')}`);
    }
  }

  static monitor(pageId: string, activeKind: string, devices: Object[], all: Object[], filtered: Object[]): void {
    IdentityTrace.log('none', 'monitor.snapshot',
      `pageId=${pageId}|activeKind=${activeKind}|devicesLength=${devices.length}` +
      `|allSensors=${all.length}|filtered=${filtered.length}`);
    IdentityTrace.mapped(devices);
    IdentityTrace.sensors('monitor.allSensors', all);
    IdentityTrace.sensors('monitor.filtered', filtered);
    for (let i = 0; i < filtered.length; i++) {
      const s = filtered[i] as Record<string, Object>;
      IdentityTrace.log('none', 'monitor.foreachKey',
        `index=${i}|key=${IdentityTrace.value(s, 'deviceId')}_${IdentityTrace.value(s, 'kind')}`);
    }
  }
}
