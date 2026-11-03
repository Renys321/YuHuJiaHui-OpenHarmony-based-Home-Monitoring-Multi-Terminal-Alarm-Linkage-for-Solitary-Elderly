import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';
import UIAbility from '@ohos.app.ability.UIAbility';
import Want from '@ohos.app.ability.Want';
import hilog from '@ohos.hilog';
import window from '@ohos.window';

const DOMAIN = 0x0000;
const GUARD_FOREGROUND_EVENT = 'eldercare.guard.foreground';

export default class EntryAbility extends UIAbility {
  /** 前台补发计数：退到后台时自增，用来作废还没到点的延迟补发 */
  private guardForegroundGeneration: number = 0;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageCreate');

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, 'testTag', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, 'testTag', 'Succeeded in loading the content.');
    });

    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
    } catch (err) {
      hilog.error(DOMAIN, 'testTag', 'Failed to set colorMode. Cause: %{public}s', JSON.stringify(err));
    }
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onForeground');
    this.guardForegroundGeneration = this.guardForegroundGeneration + 1;
    const generation: number = this.guardForegroundGeneration;
    this.context.eventHub.emit(GUARD_FOREGROUND_EVENT, true);
    // 页面可能还没挂上 eventHub 监听，500ms 后补发一次；期间退回后台就作废
    setTimeout((): void => {
      if (generation === this.guardForegroundGeneration) {
        hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability foreground recovery event');
        this.context.eventHub.emit(GUARD_FOREGROUND_EVENT, true);
      }
    }, 500);
  }

  onBackground(): void {
    hilog.info(DOMAIN, 'testTag', '%{public}s', 'Ability onBackground');
    this.guardForegroundGeneration = this.guardForegroundGeneration + 1;
    this.context.eventHub.emit(GUARD_FOREGROUND_EVENT, false);
  }
}
