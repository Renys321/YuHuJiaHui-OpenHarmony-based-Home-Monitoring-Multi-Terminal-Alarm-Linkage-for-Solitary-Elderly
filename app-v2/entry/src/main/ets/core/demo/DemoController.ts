/**
 * 演示模式进程内状态机（纯逻辑、可 Node 测试）。
 * 不持有 Token、不写安全存储、不调用 API；退出即回到 none，不自动恢复演示。
 */
import { RunMode } from '../view/Models';
import { DemoSnapshot, buildDemoSnapshot } from './DemoData';

export class DemoController {
  private currentMode: string = RunMode.NONE;
  private currentSnapshot: DemoSnapshot | null = null;

  /** 用户主动进入演示：创建独立快照并标记 demo。 */
  enter(nowMs: number = Date.now()): DemoSnapshot {
    this.currentMode = RunMode.DEMO;
    this.currentSnapshot = buildDemoSnapshot(nowMs);
    return this.currentSnapshot;
  }

  /** 退出演示：清空进程内演示状态。 */
  exit(): void {
    this.currentMode = RunMode.NONE;
    this.currentSnapshot = null;
  }

  mode(): string {
    return this.currentMode;
  }

  isDemo(): boolean {
    return this.currentMode === RunMode.DEMO;
  }

  snapshot(): DemoSnapshot | null {
    return this.currentSnapshot;
  }
}
