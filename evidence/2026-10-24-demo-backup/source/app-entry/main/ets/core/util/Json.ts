/**
 * 安全 JSON 解析/取值工具（纯逻辑，.ts 允许动态 JSON；导出给 core 内部使用）。
 */

export function parseJsonObject(text: string): any | null {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }
  try {
    const value: any = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value;
  } catch (error) {
    return null;
  }
}

export function hasOwn(obj: any, key: string): boolean {
  return obj !== null && obj !== undefined && typeof obj === 'object' &&
    Object.prototype.hasOwnProperty.call(obj, key);
}

export function asObject(obj: any, key: string): any | null {
  if (obj === null || obj === undefined) return null;
  const value: any = obj[key];
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
}

export function asArray(obj: any, key: string): any[] {
  if (obj === null || obj === undefined) return [];
  const value: any = obj[key];
  return Array.isArray(value) ? value : [];
}

export function asString(obj: any, key: string, fallback: string = ''): string {
  if (obj === null || obj === undefined) return fallback;
  const value: any = obj[key];
  return typeof value === 'string' ? value : fallback;
}

export function asFiniteNumber(obj: any, key: string, fallback: number = 0): number {
  if (obj === null || obj === undefined) return fallback;
  const value: any = obj[key];
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

export function asBoolean(obj: any, key: string, fallback: boolean = false): boolean {
  if (obj === null || obj === undefined) return fallback;
  const value: any = obj[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 三态布尔：缺省/类型错误返回 null（表示未知）。 */
export function asTriStateBoolean(obj: any, key: string): boolean | null {
  if (obj === null || obj === undefined) return null;
  const value: any = obj[key];
  return typeof value === 'boolean' ? value : null;
}

export function isRecord(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
