import { describe, it, expect } from '@ohos/hypium';
import { DeviceDto, SensorsDto, ClimateSensorDto, MotionSensorDto, RawSensorDto, parseDevice } from '../main/ets/core/api/Contracts';
import { mapDevice, DEVICE_OFFLINE_AFTER_MS } from '../main/ets/core/view/ViewMapper';
import { DeviceView, SensorView } from '../main/ets/core/view/Models';

function climateDto(deviceId: string, roomName: string, temp: number, rh: number,
  valid: boolean | null, online: boolean): DeviceDto {
  const dto = new DeviceDto();
  dto.id = deviceId;
  dto.deviceId = deviceId;
  dto.roomId = roomName;
  dto.roomName = roomName;
  dto.online = online;
  dto.monitorOnline = 1;
  dto.state = 'NORMAL';
  dto.lastSeenTs = 1792680000000;
  const sensors = new SensorsDto();
  const climate = new ClimateSensorDto();
  climate.tempC = temp;
  climate.rh = rh;
  climate.ok = true;
  climate.valid = valid;
  sensors.climate = climate;
  dto.sensors = sensors;
  return dto;
}

function kitchenDto(valid: boolean | null, temp: number, rh: number,
  gasValid: boolean | null, gasRaw: number): DeviceDto {
  const dto = climateDto('esp32-kitchen', '厨房', temp, rh, valid, true);
  const gas = new RawSensorDto();
  gas.raw = gasRaw;
  gas.ok = true;
  gas.valid = gasValid;
  dto.sensors.gas = gas;
  const smoke = new RawSensorDto();
  smoke.raw = 79;
  smoke.ok = true;
  smoke.valid = gasValid;
  dto.sensors.smoke = smoke;
  return dto;
}

function kitchenRawDto(gasValid: boolean | null, gasRaw: number | null,
  smokeValid: boolean | null, smokeRaw: number | null, online: boolean): DeviceDto {
  const dto = climateDto('esp32-kitchen', '厨房', 24.5, 50.0, true, online);
  const gas = new RawSensorDto();
  gas.raw = gasRaw;
  gas.ok = true;
  gas.valid = gasValid;
  dto.sensors.gas = gas;
  const smoke = new RawSensorDto();
  smoke.raw = smokeRaw;
  smoke.ok = true;
  smoke.valid = smokeValid;
  dto.sensors.smoke = smoke;
  return dto;
}

function bathWithMotion(lastPresent: boolean, lastActiveTs: number,
  countPresent: boolean, countToday: number): DeviceDto {
  const dto = climateDto('esp32-bath', '卫生间', 24.5, 50.0, true, true);
  const motion = new MotionSensorDto();
  motion.lastActiveTsPresent = lastPresent;
  motion.lastActiveTs = lastActiveTs;
  motion.countTodayPresent = countPresent;
  motion.countToday = countToday;
  dto.sensors.motion = motion;
  return dto;
}

function sensorOf(view: DeviceView, kind: string): SensorView | null {
  for (let i = 0; i < view.sensors.length; i++) {
    if (view.sensors[i].kind === kind) return view.sensors[i];
  }
  return null;
}

export default function validContractTest() {
  describe('validContractViewMapper', () => {
    it('validTrueZeroIsAValidReading', 0, () => {
      const view = mapDevice(kitchenDto(true, 0.0, 0.0, true, 276), 1792680001000);
      const climate = sensorOf(view, 'climate');
      expect(climate !== null).assertTrue();
      if (climate !== null) {
        expect(climate.state).assertEqual('ok');
        expect(climate.validity).assertEqual('valid');
      }
    });

    it('validFalseIsInvalid', 0, () => {
      const view = mapDevice(kitchenDto(false, 24.5, 50.0, false, 276), 1792680001000);
      const climate = sensorOf(view, 'climate');
      expect(climate !== null).assertTrue();
      if (climate !== null) {
        expect(climate.state).assertEqual('invalid');
        expect(climate.validity).assertEqual('invalid');
      }
    });

    it('missingValidRemainsUnknown', 0, () => {
      const view = mapDevice(kitchenDto(null, 24.5, 50.0, null, 276), 1792680001000);
      const climate = sensorOf(view, 'climate');
      expect(climate !== null).assertTrue();
      if (climate !== null) {
        expect(climate.validity).assertEqual('unknown');
      }
    });

    it('gasValidStillKeepsAlarmDisabled', 0, () => {
      const view = mapDevice(kitchenDto(true, 24.5, 50.0, true, 276), 1792680001000);
      const gas = sensorOf(view, 'gas');
      expect(gas !== null).assertTrue();
      if (gas !== null) {
        expect(gas.state).assertEqual('disabled');
        expect(gas.validity).assertEqual('valid');
        expect(gas.detailText.indexOf('报警未启用') >= 0).assertTrue();
      }
    });

    it('bathHasNoGasOrSmokeCards', 0, () => {
      const dto = climateDto('esp32-bath', '卫生间', 24.5, 50.0, true, true);
      const view = mapDevice(dto, 1792680001000);
      expect(sensorOf(view, 'climate') !== null).assertTrue();
      expect(sensorOf(view, 'gas')).assertEqual(null);
      expect(sensorOf(view, 'smoke')).assertEqual(null);
    });

    it('offlineUsesHistoricalReadingPresentation', 0, () => {
      const dto = climateDto('esp32-kitchen', '厨房', 24.5, 50.0, true, false);
      const view = mapDevice(dto, 1792680001000);
      const climate = sensorOf(view, 'climate');
      expect(view.online).assertFalse();
      expect(climate !== null).assertTrue();
      if (climate !== null) {
        expect(climate.state).assertEqual('offline');
        expect(climate.valueText.indexOf('上次读数') >= 0).assertTrue();
      }
    });

    it('staleLastSeenForcesOfflineEvenIfApiSaysOnline', 0, () => {
      const dto = kitchenDto(true, 24.5, 50.0, true, 276);
      dto.online = true;
      const now = 1792680000000 + DEVICE_OFFLINE_AFTER_MS + 1;
      const view = mapDevice(dto, now);
      const climate = sensorOf(view, 'climate');
      expect(view.online).assertFalse();
      expect(climate !== null).assertTrue();
      if (climate !== null) {
        expect(climate.state).assertEqual('offline');
        expect(climate.valueText.indexOf('上次读数') >= 0).assertTrue();
      }
    });

    it('boundaryIsFreshButMissingOrFutureIsNot', 0, () => {
      const base = 1792680000000;
      expect(isFreshForTest(true, base, base + DEVICE_OFFLINE_AFTER_MS)).assertTrue();
      expect(isFreshForTest(true, base, base + DEVICE_OFFLINE_AFTER_MS + 1)).assertFalse();
      expect(isFreshForTest(true, 0, base)).assertFalse();
      expect(isFreshForTest(true, base + 6 * 60 * 1000, base)).assertFalse();
      expect(isFreshForTest(false, base, base)).assertFalse();
    });
    it('gasZeroRawIsAValidRawReadingButAlarmStillDisabled', 0, () => {
      const view = mapDevice(kitchenRawDto(true, 0, true, 79, true), 1792680001000);
      const gas = sensorOf(view, 'gas');
      expect(gas !== null).assertTrue();
      if (gas !== null) {
        expect(gas.state).assertEqual('disabled');
        expect(gas.validity).assertEqual('valid');
        expect(gas.valueText).assertEqual('原始 ADC 0');
        expect(gas.detailText.indexOf('报警未启用') >= 0).assertTrue();
        expect(gas.detailText.indexOf('正常') >= 0).assertFalse();
      }
    });

    it('smokeRawIsRenderedAsRawAdcNotNormal', 0, () => {
      const view = mapDevice(kitchenRawDto(true, 276, true, 79, true), 1792680001000);
      const smoke = sensorOf(view, 'smoke');
      expect(smoke !== null).assertTrue();
      if (smoke !== null) {
        expect(smoke.valueText).assertEqual('原始 ADC 79');
        expect(smoke.state).assertEqual('disabled');
        expect(smoke.detailText.indexOf('报警未启用') >= 0).assertTrue();
        expect(smoke.detailText.indexOf('正常') >= 0).assertFalse();
      }
    });

    it('gasInvalidDoesNotReuseOldValueAsCurrent', 0, () => {
      const view = mapDevice(kitchenRawDto(false, 276, true, 79, true), 1792680001000);
      const gas = sensorOf(view, 'gas');
      expect(gas !== null).assertTrue();
      if (gas !== null) {
        expect(gas.state).assertEqual('invalid');
        expect(gas.validity).assertEqual('invalid');
        expect(gas.valueText.indexOf('上次读数') >= 0).assertTrue();
        expect(gas.detailText.indexOf('读数无效') >= 0).assertTrue();
      }
    });

    it('gasMissingValidIsUnknownNotTrue', 0, () => {
      const view = mapDevice(kitchenRawDto(null, 276, null, 79, true), 1792680001000);
      const gas = sensorOf(view, 'gas');
      expect(gas !== null).assertTrue();
      if (gas !== null) {
        expect(gas.validity).assertEqual('unknown');
        expect(gas.state).assertEqual('disabled');
      }
    });

    it('missingRawDoesNotBecomeZero', 0, () => {
      const view = mapDevice(kitchenRawDto(true, null, true, null, true), 1792680001000);
      const gas = sensorOf(view, 'gas');
      const smoke = sensorOf(view, 'smoke');
      expect(gas !== null).assertTrue();
      expect(smoke !== null).assertTrue();
      if (gas !== null && smoke !== null) {
        expect(gas.state).assertEqual('waiting');
        expect(gas.valueText).assertEqual('--');
        expect(smoke.state).assertEqual('waiting');
        expect(smoke.valueText).assertEqual('--');
      }
    });

    it('offlineKitchenKeepsHistoricalRawWithOfflineState', 0, () => {
      const view = mapDevice(kitchenRawDto(true, 276, true, 79, false), 1792680001000);
      const gas = sensorOf(view, 'gas');
      expect(view.online).assertFalse();
      expect(gas !== null).assertTrue();
      if (gas !== null) {
        expect(gas.state).assertEqual('offline');
        expect(gas.valueText.indexOf('上次读数') >= 0).assertTrue();
      }
    });

    it('pirPresentFieldsMapLastActiveAndCount', 0, () => {
      const base = 1792680000000;
      const view = mapDevice(bathWithMotion(true, base - 5000, true, 3), base + 1000);
      const motion = sensorOf(view, 'motion');
      expect(motion !== null).assertTrue();
      if (motion !== null) {
        expect(motion.valueText.indexOf('最近活动') >= 0).assertTrue();
        expect(motion.detailText.indexOf('今日 3 次') >= 0).assertTrue();
      }
    });

    it('pirMissingCountDoesNotFabricateZero', 0, () => {
      const view = mapDevice(bathWithMotion(true, 0, false, 0), 1792680001000);
      const motion = sensorOf(view, 'motion');
      expect(motion !== null).assertTrue();
      if (motion !== null) {
        expect(motion.valueText.indexOf('今日暂无活动时间') >= 0).assertTrue();
        expect(motion.detailText.indexOf('今日次数未知') >= 0).assertTrue();
        expect(motion.detailText.indexOf('今日 0 次') >= 0).assertFalse();
      }
    });

    it('pirMissingBothFieldsIsUnknownNotZero', 0, () => {
      const view = mapDevice(bathWithMotion(false, 0, false, 0), 1792680001000);
      const motion = sensorOf(view, 'motion');
      expect(motion !== null).assertTrue();
      if (motion !== null) {
        expect(motion.state).assertEqual('unknown');
        expect(motion.valueText).assertEqual('--');
        expect(motion.detailText.indexOf('未收到 PIR 活动字段') >= 0).assertTrue();
        expect(motion.detailText.indexOf('今日 0 次') >= 0).assertFalse();
      }
    });

    it('kitchenHasNoPirAndBathHasNoMq', 0, () => {
      const kitchen = mapDevice(kitchenRawDto(true, 276, true, 79, true), 1792680001000);
      const bath = mapDevice(bathWithMotion(true, 1792679995000, true, 2), 1792680001000);
      expect(sensorOf(kitchen, 'motion')).assertEqual(null);
      expect(sensorOf(bath, 'gas')).assertEqual(null);
      expect(sensorOf(bath, 'smoke')).assertEqual(null);
    });

    it('motionParserPreservesMissingCountAsUnknown', 0, () => {
      const dto = parseDevice({
        deviceId: 'esp32-bath',
        roomName: '卫生间',
        online: true,
        state: 'NORMAL',
        lastSeenTs: 1792680000000,
        sensors: { motion: { lastActiveTs: 1792679995000 } }
      });
      const motion = dto.sensors.motion;
      expect(motion !== null).assertTrue();
      if (motion !== null) {
        expect(motion.lastActiveTsPresent).assertTrue();
        expect(motion.countTodayPresent).assertFalse();
      }
    });

    it('motionParserRejectsIllegalCountPresence', 0, () => {
      const dto = parseDevice({
        deviceId: 'esp32-bath',
        roomName: '卫生间',
        online: true,
        state: 'NORMAL',
        lastSeenTs: 1792680000000,
        sensors: { motion: { lastActiveTs: 0, countToday: -1 } }
      });
      const motion = dto.sensors.motion;
      expect(motion !== null).assertTrue();
      if (motion !== null) {
        expect(motion.countTodayPresent).assertFalse();
      }
    });
  });
}

function isFreshForTest(online: boolean, lastSeenTs: number, nowMs: number): boolean {
  const dto = climateDto('esp32-kitchen', '厨房', 24.5, 50.0, true, online);
  dto.lastSeenTs = lastSeenTs;
  const view = mapDevice(dto, nowMs);
  return view.online;
}
