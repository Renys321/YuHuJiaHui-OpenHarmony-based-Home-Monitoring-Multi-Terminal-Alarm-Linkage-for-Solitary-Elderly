// 短信验证码
export type SmsPurpose = 'login' | 'register' | 'reset' | 'cancel';

class CodeEntry {
  code: string = '';
  expire: number = 0;
}

export class SmsService {
  private static codes: Map<string, CodeEntry> = new Map<string, CodeEntry>();
  static readonly TTL: number = 5 * 60 * 1000;

  private static key(phone: string, purpose: SmsPurpose): string {
    return `${purpose}:${phone}`;
  }

  static send(phone: string, purpose: SmsPurpose): string {
    let code: string = '';
    for (let i = 0; i < 6; i++)
      code = `${code}${Math.floor(Math.random() * 10)}`;
    const entry = new CodeEntry();
    entry.code = code;
    entry.expire = Date.now() + SmsService.TTL;
    SmsService.codes.set(SmsService.key(phone, purpose), entry);
    return code;
  }

  static verify(phone: string, purpose: SmsPurpose, code: string): boolean {
    const key = SmsService.key(phone, purpose);
    const entry = SmsService.codes.get(key);
    if (entry === undefined)
      return false;
    if (Date.now() > entry.expire) {
      SmsService.codes.delete(key);
      return false;
    }
    if (entry.code !== code)
      return false;
    SmsService.codes.delete(key); // 一次性
    return true;
  }
}
