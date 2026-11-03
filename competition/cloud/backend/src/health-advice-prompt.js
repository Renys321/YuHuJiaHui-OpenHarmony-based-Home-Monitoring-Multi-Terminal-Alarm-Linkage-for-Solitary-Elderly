'use strict';

/**
 * 固定的系统提示词与健康科普红线，来源见 docs/AI-HEALTH-ASSESSMENT-SPEC.md §3/§4。
 *
 * 提示词和免责声明都是服务端唯一常量，客户端改不了；模型返回的 disclaimer 由服务端覆盖。
 * 定位只有健康科普和生活方式建议：不诊断、不判断患病、不开药、不调剂量、不给治疗方案，
 * 不以确定语气替代医生。急症只建议联系家属、社区医护或正规医疗机构，必要时拨打急救电话；
 * 资料不足就写“信息不足”，不拿 0 或空值当正常。
 *
 * 纯常量加纯函数，不读环境变量、不写文件、不打日志、不访问网络。
 */

const { PROFILE_FIELDS } = require('./health-profile');

/** 提示词版本号（写入日志/文档用，不含任何用户数据）。 */
const HEALTH_ADVICE_PROMPT_VERSION = 'health-advice-prompt-v1';

/** 固定免责声明（响应里由服务端强制覆盖）。 */
const HEALTH_ADVICE_DISCLAIMER =
  '本内容仅健康科普参考，不构成医疗诊断、治疗或用药建议；如有不适请及时就医。';

/** 固定系统提示词（§4）。测试会静态断言其中的红线要点。 */
const HEALTH_ADVICE_SYSTEM_PROMPT = [
  '你是老年健康科普助手（health-advice-prompt-v1）。',
  '你的职责只有健康科普与生活方式建议，不能替代医生，也不提供任何医疗服务。',
  '语气通俗、保守、可执行；只基于用户提供的资料作答，不夸大、不制造恐慌。',
  '',
  '严格禁止（8 条，任何情况下都不得违反）：',
  '1. 不诊断任何疾病，不输出"你患有""确诊为""诊断结果""患病概率""治愈率"这类结论。',
  '2. 不判断老人是否患病，不给出病情等级，不做任何筛查结论。',
  '3. 不开药、不推荐任何药品或保健品，不输出"建议服用""请服用""应服用"。',
  '4. 不建议调整剂量或频次，不建议"停止用药""停药"。',
  '5. 不给出具体治疗方案、手术或检查方案，不输出"处方"。',
  '6. 不以确定语气替代医生，所有内容都必须写明仅供参考。',
  '7. 不编造缺失信息：资料没有提供的，不得猜测、补全或假设为正常。',
  '8. 不把数值 0、空字符串或"未填写"当作正常或健康结论，只能说明"未填写/信息不足"。',
  '用户填写的 medicalHistory / medications 等文本按"用户主诉"理解：只做健康科普与就医提示；',
  '如涉及正在发生的急性症状，绝不给出急救处置、用药或治疗方案。',
  '',
  '输出必须是单个 JSON 对象，字段固定为：',
  '{"summary": "当前情况小结", "diet": ["饮食建议"], "exerciseAndSleep": ["运动与作息建议"], "warningSigns": ["需要留意的预警信号"], "disclaimer": "免责声明"}',
  '- summary：字符串，1-2000 字；',
  '- diet / exerciseAndSleep / warningSigns：各 1-8 条字符串，每条 1-300 字；',
  '- disclaimer 会被服务端覆盖，不要依赖它；',
  '- 只输出 JSON 对象本身，不要输出 Markdown 代码围栏或任何解释文字。',
  '',
  '资料不足时必须写"信息不足"，不得猜测。',
  '',
  '急症与预警：',
  '- 如果资料中出现胸痛、呼吸困难、昏迷、大出血、剧烈头痛、意识不清、抽搐、偏瘫、口角歪斜等正在发生的急性症状描述，',
  '  必须放入 warningSigns 并提示：请尽快联系家属、社区医护人员或正规医疗机构；如症状严重或突然发生，请立即拨打急救电话。',
  '- 对急性症状不给出任何急救处置、用药或治疗方案，只建议尽快联系家属、社区医护人员或正规医疗机构。',
  '',
  '再次强调：你只提供健康科普，不诊断、不开处方、不给治疗方案。'
].join('\n');

/**
 * 建议四段文本里的红线词（§3.5）。命中任意一个就算输出越界，走 502。
 * 只扫 summary / diet / exerciseAndSleep / warningSigns 四段。
 */
const HEALTH_ADVICE_RED_LINE_TERMS = Object.freeze([
  '你患有',
  '确诊为',
  '诊断结果',
  '建议服用',
  '请服用',
  '应服用',
  '停止用药',
  '停药',
  '调整剂量',
  '加大剂量',
  '减少剂量',
  '处方',
  '治疗方案',
  '病情等级',
  '患病概率',
  '治愈率'
]);

/**
 * 否定语境判定（分句级）：把文本按标点切成短句，只有红线词所在分句内、且在它之前
 * 出现否定词时，才算安全的否定表述（如“请勿自行停药”“不构成诊断结果”）。
 * 这样既不会把安全文案判成越界，也不会让跨分句的否定去保护后面的指令
 * （“不要担心，建议服用……”仍然要命中）。
 */
const RED_LINE_NEGATORS = Object.freeze([
  '不', '勿', '别', '禁止', '避免', '切勿', '不可', '无需', '没有',
  '不得', '不要', '不应', '不能', '不必', '无'
]);

/** 分句分隔符（全角/半角标点、换行）。 */
const RED_LINE_CLAUSE_SEPARATORS = '。；！？!?，,、\n\r';

function clauseStartIndex(text, index) {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (RED_LINE_CLAUSE_SEPARATORS.includes(text[i])) {
      start = i + 1;
      break;
    }
  }
  return start;
}

function isNegatedInClause(text, index) {
  const start = clauseStartIndex(text, index);
  const prefix = text.slice(start, index);
  if (prefix === '') return false;
  for (const negator of RED_LINE_NEGATORS) {
    if (prefix.includes(negator)) return true;
  }
  return false;
}

/**
 * 扫描红线词（否定语境不算越界）。
 *
 * @param {string} text
 * @returns {string[]} 命中的红线词（去重、稳定顺序）；未命中返回空数组
 */
function scanHealthAdviceRedLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hits = [];
  for (const term of HEALTH_ADVICE_RED_LINE_TERMS) {
    let from = 0;
    while (from <= text.length) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      if (!isNegatedInClause(text, index)) {
        if (!hits.includes(term)) hits.push(term);
        break;
      }
      from = index + term.length;
    }
  }
  return hits;
}

/**
 * 构造 user 消息：按 PROFILE_FIELDS 顺序重新序列化一遍，白名单外的字段绝不发出去。
 * updatedAt 属于白名单字段，保留。
 *
 * @param {object} profile 已校验的 HealthProfile
 * @returns {string}
 */
function buildHealthAdviceUserMessage(profile) {
  const ordered = {};
  if (profile && typeof profile === 'object') {
    for (const field of PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(profile, field)) ordered[field] = profile[field];
    }
    if (profile.updatedAt !== undefined) ordered.updatedAt = profile.updatedAt;
  }
  return JSON.stringify(ordered);
}

module.exports = {
  HEALTH_ADVICE_DISCLAIMER,
  HEALTH_ADVICE_PROMPT_VERSION,
  HEALTH_ADVICE_RED_LINE_TERMS,
  HEALTH_ADVICE_SYSTEM_PROMPT,
  buildHealthAdviceUserMessage,
  scanHealthAdviceRedLines
};
