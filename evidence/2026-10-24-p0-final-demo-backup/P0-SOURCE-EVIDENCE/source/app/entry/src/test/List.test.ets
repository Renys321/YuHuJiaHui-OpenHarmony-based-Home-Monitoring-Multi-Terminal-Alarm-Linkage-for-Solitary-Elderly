import localUnitTest from './LocalUnit.test';
import validContractTest from './ValidContract.test';

export default function testsuite() {
  localUnitTest();
  validContractTest();
}
