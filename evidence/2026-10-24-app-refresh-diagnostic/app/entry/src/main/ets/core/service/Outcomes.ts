/**
 * 登录/刷新/ACK 结果对象（纯逻辑，可测）。
 */

export class LoginOutcome {
  ok: boolean = false;
  kind: string = '';
  message: string = '';
  retryAfterSeconds: number = 0;
}

export class RefreshOutcome {
  ok: boolean = false;
  partial: boolean = false;
  message: string = '';
  updatedAt: number = 0;
  /** Diagnostic correlation id; no credentials or payloads. */
  diagId: string = '';
  unauthorized: boolean = false;
  /** 响应返回时会话已切换，本次结果被丢弃（页面不得据此更新 UI）。 */
  stale: boolean = false;
}

export class AckOutcome {
  accepted: boolean = false;
  kind: string = '';
  message: string = '';
  serverStatus: string = '';
}
