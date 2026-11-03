/**
 * 时间格式化工具
 */
export class DateUtil {
  static pad(n: number): string {
    return n < 10 ? '0' + n : '' + n;
  }

  static formatTime(ts: number): string {
    const d = new Date(ts);
    return `${DateUtil.pad(d.getHours())}:${DateUtil.pad(d.getMinutes())}`;
  }

  static formatDate(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${DateUtil.pad(d.getMonth() + 1)}-${DateUtil.pad(d.getDate())}`;
  }

  static formatDateTime(ts: number): string {
    return `${DateUtil.formatDate(ts)} ${DateUtil.formatTime(ts)}`;
  }

  /** 相对时间："3 分钟前" / "2 小时前" / "昨天 14:32" */
  static fromNow(ts: number): string {
    const now = Date.now();
    const diff = Math.floor((now - ts) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 172800) return `昨天 ${DateUtil.formatTime(ts)}`;
    return DateUtil.formatDate(ts);
  }

  /** 持续时长："01:23" */
  static duration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }
}
