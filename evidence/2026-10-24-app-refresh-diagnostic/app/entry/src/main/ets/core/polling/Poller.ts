/**
 * 非重叠轮询器（纯逻辑，使用真实 setTimeout；测试可用 20–50ms 间隔）。
 *
 * 不变量：同一个 Poller 实例内，任何时刻最多存在一个尚未完成的实际 tick（跨 stop/start 也成立）。
 *
 * - start() 幂等；首次 tick 在 interval 后（immediate=true 则立即；若有旧在途任务则等其完成后的下一次调度）。
 * - 上一次 tick 未完成时，本次触发跳过（不重入、不排队），继续排下一次。
 * - stop() 只停止后续调度并清定时器，**不**把尚未完成的任务当作已完成。
 * - stop 后重新 start 时，旧在途任务完成后新一代轮询继续；旧代 finally 不得清/覆盖新一代状态。
 * - tick 抛错被吞掉（由调用方在 tick 内记录状态），轮询继续。
 */
export class Poller {
  private intervalMs: number = 30000;
  private tickFn: (() => Promise<void>) | null = null;
  private immediate: boolean = false;
  private timerId: any = -1;
  private running: boolean = false;
  private inFlight: boolean = false;
  private generation: number = 0;

  constructor(intervalMs: number, tick: () => Promise<void>, immediate: boolean = false) {
    this.intervalMs = intervalMs > 0 ? intervalMs : 30000;
    this.tickFn = tick;
    this.immediate = immediate;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 仅用于测试/诊断：当前是否有未完成的实际 tick。 */
  hasInFlight(): boolean {
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    const gen: number = this.generation;
    if (this.immediate) {
      this.fire(gen);
    } else {
      this.schedule(gen);
    }
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timerId !== -1) {
      clearTimeout(this.timerId);
      this.timerId = -1;
    }
    // 注意：不清 inFlight。旧 tick 可能仍在执行，必须等它自己结束；
    // 新的 start 会通过 fire() 的 inFlight 检查保证不重叠。
  }

  private schedule(gen: number): void {
    if (!this.running || gen !== this.generation) return;
    // 同一时刻最多一个定时器，避免连续 stop/start 累积调度。
    if (this.timerId !== -1) {
      clearTimeout(this.timerId);
      this.timerId = -1;
    }
    this.timerId = setTimeout((): void => {
      this.timerId = -1;
      this.fire(gen);
    }, this.intervalMs);
  }

  private fire(gen: number): void {
    if (!this.running || gen !== this.generation) return;
    if (this.inFlight) {
      // 旧任务尚未完成：不并发启动，排到下一次再试。
      this.schedule(gen);
      return;
    }
    if (this.tickFn === null) {
      this.schedule(gen);
      return;
    }
    this.inFlight = true;
    const tick: () => Promise<void> = this.tickFn;
    tick().catch((): void => {
      // 错误状态由 tick 内部记录，轮询本身不停止。
    }).finally((): void => {
      // 旧 generation 的 finally 只释放“唯一在途”标记；不排新代定时器、不清新代状态。
      this.inFlight = false;
      if (!this.running) {
        return;
      }
      if (gen === this.generation) {
        this.schedule(gen);
        return;
      }
      // stop()→start() 后新一代在等这个旧任务：旧任务一结束就接续新一代，
      // 并清掉之前为等待旧任务而排的定时器，避免重复调度。
      if (this.timerId !== -1) {
        clearTimeout(this.timerId);
        this.timerId = -1;
      }
      this.fire(this.generation);
    });
  }
}
