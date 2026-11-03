/**
 * 屏幕自适应工具
 */
import { mediaquery, UIContext } from '@kit.ArkUI';

export class Responsive {
  static readonly BP_SM: string = 'sm';
  static readonly BP_MD: string = 'md';
  static readonly BP_LG: string = 'lg';

  /** 在 Index 的 aboutToAppear 中调用一次，传入 this.getUIContext() */
  static init(uiContext: UIContext): void {
    AppStorage.setOrCreate('currentBreakpoint', Responsive.BP_SM);
    const mq = uiContext.getMediaQuery();

    const sm = mq.matchMediaSync('(320vp<=width<600vp)');
    sm.on('change', (result: mediaquery.MediaQueryResult) => {
      if (result.matches) {
        AppStorage.setOrCreate('currentBreakpoint', Responsive.BP_SM);
      }
    });

    const md = mq.matchMediaSync('(600vp<=width<840vp)');
    md.on('change', (result: mediaquery.MediaQueryResult) => {
      if (result.matches) {
        AppStorage.setOrCreate('currentBreakpoint', Responsive.BP_MD);
      }
    });

    const lg = mq.matchMediaSync('(840vp<=width)');
    lg.on('change', (result: mediaquery.MediaQueryResult) => {
      if (result.matches) {
        AppStorage.setOrCreate('currentBreakpoint', Responsive.BP_LG);
      }
    });
  }

  /** 传感器栅格列模板：手机 2 列 / 折叠展开 3 列 / 平板 4 列 */
  static sensorColumns(bp: string): string {
    if (bp === Responsive.BP_LG) {
      return '1fr 1fr 1fr 1fr';
    }
    if (bp === Responsive.BP_MD) {
      return '1fr 1fr 1fr';
    }
    return '1fr 1fr';
  }

  /** 页面水平安全边距：窄屏收紧、宽屏放宽 */
  static pageMargin(bp: string): number {
    if (bp === Responsive.BP_LG) {
      return 32;
    }
    if (bp === Responsive.BP_MD) {
      return 24;
    }
    return 14;
  }

  /** 内容最大宽度（vp）：大屏居中阅读，手机不限制 */
  static contentMaxWidth(bp: string): number {
    if (bp === Responsive.BP_LG) {
      return 880;
    }
    if (bp === Responsive.BP_MD) {
      return 680;
    }
    return 100000;
  }
}
