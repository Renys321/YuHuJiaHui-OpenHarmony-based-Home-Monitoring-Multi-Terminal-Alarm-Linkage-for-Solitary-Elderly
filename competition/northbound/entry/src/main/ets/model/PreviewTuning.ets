import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';

/** DAYU200 相机预览的显示参数；只影响显示，不会写回相机会话。 */
export const PREVIEW_TUNING_STORE: string = 'eldercare_preview_tuning';
export const PREVIEW_WIDTH_KEY: string = 'widthPct';
export const PREVIEW_SCALE_KEY: string = 'scalePct';
export const DEFAULT_PREVIEW_WIDTH_PCT: number = 60;
export const DEFAULT_PREVIEW_SCALE_PCT: number = 130;
export const MIN_PREVIEW_WIDTH_PCT: number = 30;
export const MAX_PREVIEW_WIDTH_PCT: number = 90;
export const MIN_PREVIEW_SCALE_PCT: number = 70;
export const MAX_PREVIEW_SCALE_PCT: number = 160;

export interface PreviewTuningSettings {
  widthPct: number;
  scalePct: number;
}

export function normalizePreviewTuning(widthValue: number, scaleValue: number): PreviewTuningSettings {
  let width: number = DEFAULT_PREVIEW_WIDTH_PCT;
  let scale: number = DEFAULT_PREVIEW_SCALE_PCT;
  if (Number.isFinite(widthValue)) {
    const roundedWidth: number = Math.round(widthValue / 10) * 10;
    if (roundedWidth >= MIN_PREVIEW_WIDTH_PCT && roundedWidth <= MAX_PREVIEW_WIDTH_PCT) {
      width = roundedWidth;
    }
  }
  if (Number.isFinite(scaleValue)) {
    const roundedScale: number = Math.round(scaleValue / 5) * 5;
    if (roundedScale >= MIN_PREVIEW_SCALE_PCT && roundedScale <= MAX_PREVIEW_SCALE_PCT) {
      scale = roundedScale;
    }
  }
  return { widthPct: width, scalePct: scale };
}

/** 只存这两个显示值，不存相机/会话状态。 */
export class PreviewTuningStore {
  static async load(context: common.UIAbilityContext): Promise<PreviewTuningSettings> {
    try {
      const store = await preferences.getPreferences(context, { name: PREVIEW_TUNING_STORE });
      const widthValue = await store.get(PREVIEW_WIDTH_KEY, DEFAULT_PREVIEW_WIDTH_PCT) as number;
      const scaleValue = await store.get(PREVIEW_SCALE_KEY, DEFAULT_PREVIEW_SCALE_PCT) as number;
      return normalizePreviewTuning(widthValue, scaleValue);
    } catch (error) {
      console.warn(`[PreviewTuning] load failed: ${error}`);
      return { widthPct: DEFAULT_PREVIEW_WIDTH_PCT, scalePct: DEFAULT_PREVIEW_SCALE_PCT };
    }
  }

  static async save(context: common.UIAbilityContext, settings: PreviewTuningSettings): Promise<void> {
    try {
      const store = await preferences.getPreferences(context, { name: PREVIEW_TUNING_STORE });
      const normalized: PreviewTuningSettings = normalizePreviewTuning(settings.widthPct, settings.scalePct);
      await store.put(PREVIEW_WIDTH_KEY, normalized.widthPct);
      await store.put(PREVIEW_SCALE_KEY, normalized.scalePct);
      await store.flush();
    } catch (error) {
      console.warn(`[PreviewTuning] save failed: ${error}`);
    }
  }
}
