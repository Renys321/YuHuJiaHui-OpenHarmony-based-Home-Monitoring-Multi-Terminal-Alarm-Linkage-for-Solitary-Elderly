/**
 * 「守护档案」摘要（纯逻辑，可被 Node 测试）。
 *
 * 数据唯一来源：GET /api/v1/health-profile 已保存的 HealthProfileView（经 GuardianService）。
 * 规则：
 * - 已保存字段原样展示；没有保存的字段显示“未填写”，不得自动补值、不得用演示/默认资料填充。
 * - 没有任何资料时 present=false，页面显示“未填写，去填写”，不显示空字段表。
 * - 只展示服务端真实返回的字段，不推断姓名、年龄、病史。
 */
import { HealthProfileView, healthTasteLabel } from './HealthModels';

export const PROFILE_NOT_FILLED: string = '未填写';

export class ProfileSummaryRow {
  label: string = '';
  value: string = '';
  filled: boolean = false;
}

export class GuardianProfileSummary {
  /** 服务端是否已有资料（present=false 时 rows 为空）。 */
  present: boolean = false;
  /** 服务端最近更新时间（缺失时为空串，页面显示“更新时间未知”）。 */
  updatedAtText: string = '';
  rows: ProfileSummaryRow[] = [];
  filledCount: number = 0;
  missingCount: number = 0;
}

function pushRow(rows: ProfileSummaryRow[], label: string, value: string, filled: boolean): void {
  const row = new ProfileSummaryRow();
  row.label = label;
  row.value = filled && value.length > 0 ? value : PROFILE_NOT_FILLED;
  row.filled = filled && value.length > 0;
  rows.push(row);
}

/** 把已保存资料转成“标签 + 值”摘要；缺字段明确写“未填写”。 */
export function buildGuardianProfileSummary(view: HealthProfileView): GuardianProfileSummary {
  const summary = new GuardianProfileSummary();
  if (view === null || view === undefined || !view.present) {
    return summary;
  }
  summary.present = true;
  summary.updatedAtText = view.hasUpdatedAt && view.updatedAtText.length > 0
    ? view.updatedAtText
    : '';
  const rows: ProfileSummaryRow[] = [];
  pushRow(rows, '年龄', view.ageText.length > 0 ? `${view.ageText} 岁` : '', view.ageText.length > 0);
  pushRow(rows, '既往病史', view.medicalHistory, view.medicalHistory.length > 0);
  pushRow(rows, '长期用药', view.medications, view.medications.length > 0);
  pushRow(rows, '身高', view.heightText.length > 0 ? `${view.heightText} cm` : '', view.heightText.length > 0);
  pushRow(rows, '体重', view.weightText.length > 0 ? `${view.weightText} kg` : '', view.weightText.length > 0);
  const pressure: string = view.systolicText.length > 0 && view.diastolicText.length > 0
    ? `${view.systolicText}/${view.diastolicText} mmHg` : '';
  pushRow(rows, '静息血压', pressure, pressure.length > 0);
  pushRow(rows, '空腹血糖', view.glucoseText.length > 0 ? `${view.glucoseText} mmol/L` : '',
    view.glucoseText.length > 0);
  pushRow(rows, '睡眠', view.sleepHoursText.length > 0 ? `${view.sleepHoursText} 小时` : '',
    view.sleepHoursText.length > 0);
  pushRow(rows, '饮食口味', view.dietTaste.length > 0 ? healthTasteLabel(view.dietTaste) : '',
    view.dietTaste.length > 0);
  pushRow(rows, '饮食禁忌', view.dietRestrictions, view.dietRestrictions.length > 0);
  pushRow(rows, '每周运动', view.exerciseTimesText.length > 0 ? `${view.exerciseTimesText} 次` : '',
    view.exerciseTimesText.length > 0);
  pushRow(rows, '运动方式', view.exerciseTypes, view.exerciseTypes.length > 0);
  pushRow(rows, '吸烟', view.smoking, view.smoking.length > 0);
  pushRow(rows, '饮酒', view.alcohol, view.alcohol.length > 0);
  pushRow(rows, '情绪', view.mood, view.mood.length > 0);
  pushRow(rows, '视力', view.vision, view.vision.length > 0);
  pushRow(rows, '听力', view.hearing, view.hearing.length > 0);
  summary.rows = rows;
  let filledCount: number = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].filled) filledCount += 1;
  }
  summary.filledCount = filledCount;
  summary.missingCount = rows.length - filledCount;
  return summary;
}
