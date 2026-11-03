/** HarmonyOS 响应头解析：实际键名不固定，必须按 ASCII 大小写不敏感方式枚举。 */

export type HttpHeaderValue = string | string[];

export class ContentLengthResult {
  present: boolean = false;
  valid: boolean = true;
  value: number = -1;
}

function matchingHeaderValues(headers: Object, requestedName: string): string[] {
  const values: string[] = [];
  try {
    const map = headers as Record<string, HttpHeaderValue>;
    const keys: string[] = Object.keys(headers);
    const requested: string = requestedName.toLowerCase();
    for (let i = 0; i < keys.length; i++) {
      const key: string = keys[i];
      if (key.toLowerCase() !== requested) continue;
      const raw: HttpHeaderValue = map[key];
      if (typeof raw === 'string') {
        values.push(raw.trim());
      } else if (Array.isArray(raw)) {
        for (let j = 0; j < raw.length; j++) {
          values.push(raw[j].trim());
        }
      } else {
        // 键存在但值类型异常：保留空标记，调用方会按无效响应拒绝。
        values.push('');
      }
    }
  } catch (_) {
    return [];
  }
  return values;
}

/**
 * 返回唯一响应头值。重复但完全相同的值可接受；空值或冲突值返回空串。
 * 该策略避免 Content-Type 冲突时误把其中一个值当作可信值。
 */
export function headerValue(headers: Object, requestedName: string): string {
  const values: string[] = matchingHeaderValues(headers, requestedName);
  if (values.length === 0 || values[0].length === 0) return '';
  const expected: string = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i].length === 0 || values[i] !== expected) return '';
  }
  return expected;
}

/** 缺失与无效必须分开表示；无效、负数、冲突和非安全整数均拒绝。 */
export function parseContentLength(headers: Object): ContentLengthResult {
  const result = new ContentLengthResult();
  const values: string[] = matchingHeaderValues(headers, 'content-length');
  if (values.length === 0) return result;
  result.present = true;
  let expected: number = -1;
  for (let i = 0; i < values.length; i++) {
    const text: string = values[i];
    if (!/^[0-9]+$/.test(text)) {
      result.valid = false;
      return result;
    }
    const parsed: number = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      result.valid = false;
      return result;
    }
    if (expected >= 0 && parsed !== expected) {
      result.valid = false;
      return result;
    }
    expected = parsed;
  }
  result.value = expected;
  return result;
}
