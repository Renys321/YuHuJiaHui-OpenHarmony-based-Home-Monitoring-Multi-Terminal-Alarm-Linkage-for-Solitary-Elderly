/**
 * 按“会话代际”隔离的单飞（single-flight）执行器（纯逻辑，可测）。
 *
 * - 同一 scope 内复用进行中的任务；
 * - scope 变化后绝不复用旧任务；
 * - 旧任务的 finally 只在它仍是当前任务时才清锁，不能误清新一代的锁。
 */
export class ScopedSingleFlight<T> {
  private inFlight: Promise<T> | null = null;
  private inFlightScope: number = -1;

  hasInFlight(): boolean {
    return this.inFlight !== null;
  }

  scopeOfInFlight(): number {
    return this.inFlightScope;
  }

  run(scope: number, factory: () => Promise<T>): Promise<T> {
    if (this.inFlight !== null && this.inFlightScope === scope) {
      return this.inFlight;
    }
    const created: Promise<T> = factory().finally((): void => {
      // 只有当前锁仍是本任务时才释放，避免旧任务清掉新一代的锁。
      if (this.inFlight === created) {
        this.inFlight = null;
        this.inFlightScope = -1;
      }
    });
    this.inFlight = created;
    this.inFlightScope = scope;
    return created;
  }
}
