/**
 * 串行异步操作队列（纯逻辑，可测）。
 *
 * 用于 Token 安全存储这类“必须保持调用顺序”的异步操作：
 * 旧登录 save、登出 clear、新登录 save 必须按调用顺序执行，
 * 不允许慢的旧 save 在 logout/new-login 之后才落盘。
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /** 入队一个异步操作；返回该操作自身的 Promise（可带结果）。前一个失败不阻塞后续。 */
  enqueue<T>(action: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.tail.then(action, action);
    this.tail = run.then((): void => {}, (): void => {});
    return run;
  }
}
