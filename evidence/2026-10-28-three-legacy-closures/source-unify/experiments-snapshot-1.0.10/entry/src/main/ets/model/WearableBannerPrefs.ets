import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';

/**
 * 随身求助顶部横幅的关闭/收起状态持久化（1.0.8）。
 *
 * 用户反馈（2026-10-27）：顶部横幅常驻、不能关闭、视觉突兀。1.0.8 起：
 *  - 无事件时完全不显示；
 *  - 待处理（ALARM）只能“收起”成小胶囊，不能整条消失（随身求助 tab 保持红点提示）；
 *  - 已确认（ACKED）可关闭，且同一 alarmId 关闭后不再出现；
 *  - 关闭/收起状态按 `alarmId + 状态` 持久化到 preferences；
 *  - 新 alarmId、或同一 alarmId 从 ACKED 变回 ALARM 时重新显示。
 *
 * 只存 UI 偏好：不含告警内容、时间、位置、设备数据，也未放宽任何权限。
 */
export const WEARABLE_BANNER_STORE: string = 'eldercare_wearable_banner';
export const WEARABLE_BANNER_ACKED_KEY_PREFIX: string = 'wb_acked_';
export const WEARABLE_BANNER_ALARM_KEY_PREFIX: string = 'wb_alarm_';

export const BANNER_STATE_SHOWN: string = 'shown';
export const BANNER_STATE_COLLAPSED: string = 'collapsed';
export const BANNER_STATE_DISMISSED: string = 'dismissed';

/** 已确认事件的横幅最多再显示 10 分钟；更早的视为“无近期事件”，完全不显示 */
export const WEARABLE_ACKED_BANNER_RETENTION_MS: number = 10 * 60 * 1000;

export function wearableBannerKey(alarmId: string, phase: string): string {
  const safe: string = alarmId.length > 80 ? alarmId.substring(0, 80) : alarmId;
  return phase === 'ACKED'
    ? `${WEARABLE_BANNER_ACKED_KEY_PREFIX}${safe}`
    : `${WEARABLE_BANNER_ALARM_KEY_PREFIX}${safe}`;
}

/** 读一条横幅偏好；读失败/不存在都返回空字符串（调用方按“显示”处理，绝不因读失败藏匿告警）。 */
export class WearableBannerStore {
  static async get(context: common.UIAbilityContext, key: string): Promise<string> {
    try {
      const store = await preferences.getPreferences(context, { name: WEARABLE_BANNER_STORE });
      const value = await store.get(key, '') as string;
      return typeof value === 'string' ? value : '';
    } catch (error) {
      console.warn(`[WearableBanner] load failed: ${error}`);
      return '';
    }
  }

  static async set(context: common.UIAbilityContext, key: string, value: string): Promise<void> {
    try {
      const store = await preferences.getPreferences(context, { name: WEARABLE_BANNER_STORE });
      await store.put(key, value);
      await store.flush();
    } catch (error) {
      console.warn(`[WearableBanner] save failed: ${error}`);
    }
  }
}
