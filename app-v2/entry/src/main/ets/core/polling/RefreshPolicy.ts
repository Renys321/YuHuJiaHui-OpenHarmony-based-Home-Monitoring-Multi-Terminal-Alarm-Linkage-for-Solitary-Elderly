/**
 * 页面重新显示 / APP 回到前台时的刷新策略（纯逻辑，可被 Node 测试）。
 *
 * 背景（2026-10-27）：设备断开重启、网关恢复或 APP 从后台回前台时，
 * 只依赖 30s 轮询会让页面在最长 30s 内继续显示上一次成功快照（旧在线/旧读数）。
 * 页面 onPageShow 需要“必要时立即刷新”，但不能在 12s 内反复切页时重复请求。
 *
 * 规则（任一成立就刷新）：
 * 1) 网络状态不是 ok（unknown/loading/partial/offline/error/unauthorized）——上次没成功；
 * 2) 从未成功刷新过（lastUpdatedAt<=0）；
 * 3) 距上次成功刷新超过 maxAgeMs（默认 12s）；
 * 4) lastUpdatedAt 超前当前时间超过容差（设备/服务器时钟异常，不能当作新鲜）。
 *
 * 注意：刷新本身由 GuardianService 的会话代际单飞保护，重复触发不会并发打后端。
 */
export const RESUME_REFRESH_AFTER_MS: number = 12 * 1000;
const CLOCK_SKEW_TOLERANCE_MS: number = 5 * 60 * 1000;

export function shouldRefreshOnShow(lastUpdatedAt: number, netStatus: string, nowMs: number,
  maxAgeMs: number = RESUME_REFRESH_AFTER_MS): boolean {
  if (netStatus !== 'ok') return true;
  if (!Number.isFinite(lastUpdatedAt) || lastUpdatedAt <= 0) return true;
  if (!Number.isFinite(nowMs) || nowMs <= 0) return true;
  if (lastUpdatedAt > nowMs + CLOCK_SKEW_TOLERANCE_MS) return true;
  const ageMs: number = nowMs - lastUpdatedAt;
  return ageMs > maxAgeMs;
}
