import { describe, it, expect } from '@ohos/hypium';
import {
  ClimateSensorDto, DeviceDto, MotionSensorDto, RawSensorDto, SensorsDto
} from '../main/ets/core/api/Contracts';
import { mapDevices } from '../main/ets/core/view/ViewMapper';
import { DeviceView, SensorView } from '../main/ets/core/view/Models';

function makeDto(id: string, roomId: string, roomName: string, sensors: SensorsDto,
  online: boolean = true): DeviceDto {
  const dto = new DeviceDto();
  dto.id = id;
  dto.deviceId = id;
  dto.roomId = roomId;
  dto.roomName = roomName;
  dto.online = online;
  dto.monitorOnline = 1;
  dto.state = 'NORMAL';
  dto.lastSeenTs = 1792680000000;
  dto.sensors = sensors;
  return dto;
}

function buildFixture(): DeviceDto[] {
  const kitchenSensors = new SensorsDto();
  const kitchenGas = new RawSensorDto();
  kitchenGas.raw = 275;
  kitchenGas.ok = true;
  kitchenGas.valid = true;
  kitchenSensors.gas = kitchenGas;
  const kitchenSmoke = new RawSensorDto();
  kitchenSmoke.raw = 351;
  kitchenSmoke.ok = true;
  kitchenSmoke.valid = true;
  kitchenSensors.smoke = kitchenSmoke;
  const kitchenClimate = new ClimateSensorDto();
  kitchenClimate.tempC = 24.0;
  kitchenClimate.rh = 50.0;
  kitchenClimate.valid = true;
  kitchenSensors.climate = kitchenClimate;

  const bathSensors = new SensorsDto();
  const bathMotion = new MotionSensorDto();
  bathMotion.lastActiveTs = 1792679995000;
  bathMotion.countToday = 45;
  bathSensors.motion = bathMotion;

  const livingSensors = new SensorsDto();
  const livingClimate = new ClimateSensorDto();
  livingClimate.tempC = 0.0;
  livingClimate.rh = 0.0;
  livingClimate.valid = false;
  livingSensors.climate = livingClimate;

  const offlineOne = new SensorsDto();
  const offlineTwo = new SensorsDto();

  return [
    makeDto('dayu200-living', '客厅', '客厅', livingSensors),
    makeDto('esp32-kitchen', '厨房', '厨房', kitchenSensors),
    makeDto('esp32-bath', '卫生间', '卫生间', bathSensors),
    makeDto('old-device-a', '历史房间A', '历史房间A', offlineOne, false),
    makeDto('old-device-b', '历史房间B', '历史房间B', offlineTwo, false)
  ];
}

function findDevice(views: DeviceView[], id: string): DeviceView | null {
  for (let i = 0; i < views.length; i++) {
    if (views[i].deviceId === id) return views[i];
  }
  return null;
}

function findSensor(views: DeviceView[], deviceId: string, kind: string): SensorView | null {
  const d = findDevice(views, deviceId);
  if (d === null) return null;
  for (let i = 0; i < d.sensors.length; i++) {
    if (d.sensors[i].kind === kind) return d.sensors[i];
  }
  return null;
}

export default function deviceIdentityTest() {
  describe('deviceIdentityMapping', () => {
    it('fiveDeviceViewsKeepDistinctIdentity', 0, () => {
      const views = mapDevices(buildFixture(), 1792680001000);
      expect(views.length).assertEqual(5);
      expect(findDevice(views, 'dayu200-living') !== null).assertTrue();
      expect(findDevice(views, 'esp32-kitchen') !== null).assertTrue();
      expect(findDevice(views, 'esp32-bath') !== null).assertTrue();
      expect(findDevice(views, 'old-device-a') !== null).assertTrue();
      expect(findDevice(views, 'old-device-b') !== null).assertTrue();
    });

    it('kitchenSensorsBelongToKitchen', 0, () => {
      const views = mapDevices(buildFixture(), 1792680001000);
      const gas = findSensor(views, 'esp32-kitchen', 'gas');
      const smoke = findSensor(views, 'esp32-kitchen', 'smoke');
      expect(gas !== null).assertTrue();
      expect(smoke !== null).assertTrue();
      if (gas !== null && smoke !== null) {
        expect(gas.deviceId).assertEqual('esp32-kitchen');
        expect(smoke.deviceId).assertEqual('esp32-kitchen');
        expect(gas.roomId).assertEqual('厨房');
        expect(smoke.roomId).assertEqual('厨房');
      }
    });

    it('bathMotionBelongsToBath', 0, () => {
      const views = mapDevices(buildFixture(), 1792680001000);
      const motion = findSensor(views, 'esp32-bath', 'motion');
      expect(motion !== null).assertTrue();
      if (motion !== null) {
        expect(motion.deviceId).assertEqual('esp32-bath');
        expect(motion.roomId).assertEqual('卫生间');
      }
    });

    it('sensorIdentityNeverCrossesDevice', 0, () => {
      const views = mapDevices(buildFixture(), 1792680001000);
      for (let i = 0; i < views.length; i++) {
        const d = views[i];
        for (let j = 0; j < d.sensors.length; j++) {
          expect(d.sensors[j].deviceId).assertEqual(d.deviceId);
          expect(d.sensors[j].roomId).assertEqual(d.roomId);
        }
      }
    });

    it('foreachKeysAreUnique', 0, () => {
      const views = mapDevices(buildFixture(), 1792680001000);
      const keys: string[] = [];
      for (let i = 0; i < views.length; i++) {
        const d = views[i];
        for (let j = 0; j < d.sensors.length; j++) {
          keys.push(`${d.deviceId}_${d.sensors[j].kind}_${j}`);
        }
      }
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          expect(keys[i] === keys[j]).assertFalse();
        }
      }
    });
  });
}
