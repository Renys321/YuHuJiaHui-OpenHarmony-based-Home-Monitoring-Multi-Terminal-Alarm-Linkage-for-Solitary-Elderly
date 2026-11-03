import localUnitTest from './LocalUnit.test';
import deviceIdentityTest from './DeviceIdentity.test';

export default function testsuite() {
  localUnitTest();
  deviceIdentityTest();
}
