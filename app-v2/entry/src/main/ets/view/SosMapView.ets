/**
 * MANUAL_SOS 求助位置地图卡（ArkUI 侧容器）。
 *
 * 结构：
 * - 顶部：状态徽章 + 来源 + “求助后更新”标记（全部来自 core/location 的纯逻辑状态）；
 * - 中部：6 位经纬度 / 定位时间 / 年龄 / 说明（真实缺失时显示“--”“时间未知”，不伪造）；
 * - 地图：Web 组件加载本地 rawfile/map.html（纯 JS 自绘瓦片，无地图 SDK/Key/远程 JS），
 *   通过 runJavaScript 传入 **已转换为 GCJ-02** 的 JSON；Web 侧只做墨卡托投影，不再转换坐标系。
 *
 * 失败降级：页面/瓦片加载失败时，本卡片保留状态与经纬度文字，且绝不显示假位置；
 * 地图失败不影响告警文本、ACK 与处置登记（这些都在页面其它卡片里）。
 */
import { webview } from '@kit.ArkWeb';
import { Color, FontSize, FontWeight_, Radius, Space } from '../common/Theme';
import { SecondaryButton } from '../components/Buttons';

@Component
export struct SosMapView {
  /** 交给 Web 的 JSON（坐标已 GCJ-02；由 core/location/sosMapPayloadJson 生成）。 */
  @Prop @Watch('onPayloadChanged') payloadJson: string = '{}';
  @Prop available: boolean = false;
  @Prop statusText: string = '暂无定位';
  @Prop badgeBg: string = '#F1F5F9';
  @Prop badgeFg: string = '#475569';
  @Prop coordText: string = '--';
  @Prop timeText: string = '定位时间未知';
  @Prop receivedText: string = '';
  @Prop ageText: string = '';
  @Prop noteText: string = '';
  @Prop sourceText: string = '';
  @Prop updatedText: string = '';
  /** 正在查询“最近定位”兜底数据。 */
  @Prop loading: boolean = false;
  /** 兜底查询失败的真实文案（为空表示没有失败）。 */
  @Prop retryMessage: string = '';
  onRetry_?: () => void;
  @State mapError: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private pageReady: boolean = false;
  private readyTimerId: number = -1;

  aboutToAppear(): void {
    // Web 本地页面应很快加载完；超时仍无 onPageEnd 视为地图不可用（不影响其它卡片）。
    this.readyTimerId = setTimeout(() => {
      if (!this.pageReady) {
        this.mapError = true;
      }
    }, 12000);
  }

  aboutToDisappear(): void {
    if (this.readyTimerId !== -1) {
      clearTimeout(this.readyTimerId);
      this.readyTimerId = -1;
    }
  }

  private onPayloadChanged(): void {
    this.pushPayload();
  }

  private onMapPageEnd(): void {
    this.pageReady = true;
    this.mapError = false;
    if (this.readyTimerId !== -1) {
      clearTimeout(this.readyTimerId);
      this.readyTimerId = -1;
    }
    this.pushPayload();
  }

  /** runJavaScript 里对 payloadJson 再做一次 JSON.stringify，避免引号/中文把脚本拼坏。 */
  private pushPayload(): void {
    if (!this.pageReady) return;
    if (this.payloadJson.length === 0) return;
    const script: string =
      'window.SosMap && window.SosMap.update(' + JSON.stringify(this.payloadJson) + ');';
    this.controller.runJavaScript(script).catch((): void => {
      // 地图脚本失败不影响告警文本/ACK；页面仍显示经纬度与状态文字。
      this.mapError = true;
    });
  }

  @Builder
  headerRow() {
    Row() {
      Text('求助位置')
        .fontSize(FontSize.h3)
        .fontWeight(FontWeight_.bold)
        .fontColor(Color.textPrimary)
      Text(this.statusText)
        .fontSize(FontSize.mini)
        .fontWeight(FontWeight_.bold)
        .fontColor(this.badgeFg)
        .padding({ left: 8, right: 8, top: 3, bottom: 3 })
        .backgroundColor(this.badgeBg)
        .borderRadius(Radius.pill)
        .margin({ left: 6 })
      if (this.updatedText.length > 0) {
        Text(this.updatedText)
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.bold)
          .fontColor('#C2410C')
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .backgroundColor('#FFEDD5')
          .borderRadius(Radius.pill)
          .margin({ left: 4 })
      }
      Blank()
      if (this.sourceText.length > 0) {
        Text(this.sourceText)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
      }
    }
    .width('100%')
  }

  @Builder
  textRows() {
    Column() {
      Row() {
        Text(this.coordText)
          .fontSize(FontSize.body + 1)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
        Blank()
        Text(this.ageText)
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
      }
      .width('100%')

      Text(this.timeText)
        .fontSize(FontSize.mini)
        .fontColor(Color.textSecondary)
        .width('100%')
        .margin({ top: 3 })

      if (this.receivedText.length > 0) {
        Text(this.receivedText)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .width('100%')
          .margin({ top: 2 })
      }

      if (this.noteText.length > 0) {
        Text(this.noteText)
          .fontSize(FontSize.mini)
          .fontColor(Color.warningDark)
          .width('100%')
          .lineHeight(15)
          .margin({ top: 3 })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  mapArea() {
    Stack() {
      Web({ src: $rawfile('map.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(false)
        .onlineImageAccess(true)
        .horizontalScrollBarAccess(false)
        .verticalScrollBarAccess(false)
        .zoomAccess(false)
        .width('100%')
        .height('100%')
        .backgroundColor('#E3E9F2')
        .onPageEnd(() => {
          this.onMapPageEnd();
        })

      if (this.mapError) {
        Column() {
          Text('地图加载失败')
            .fontSize(FontSize.caption)
            .fontWeight(FontWeight_.bold)
            .fontColor(Color.textSecondary)
          Text('已保留上方经纬度与定位状态文字；告警文本、确认（ACK）与处置登记不受影响。')
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .textAlign(TextAlign.Center)
            .lineHeight(15)
            .margin({ top: 4 })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .padding(Space.md)
        .backgroundColor('#E9EEF5')
      }
    }
    .width('100%')
    .height(210)
    .borderRadius(Radius.button)
    .clip(true)
    .margin({ top: Space.sm })
    .backgroundColor('#E9EEF5')
  }

  build() {
    Column() {
      this.headerRow()
      this.textRows()
      this.mapArea()
      if (this.loading) {
        Row() {
          LoadingProgress()
            .width(16)
            .height(16)
            .color(Color.primary)
          Text('正在查询最近定位…')
            .fontSize(FontSize.mini)
            .fontColor(Color.textSecondary)
            .margin({ left: 6 })
        }
        .width('100%')
        .margin({ top: 6 })
      } else if (this.retryMessage.length > 0) {
        Column() {
          Text(this.retryMessage)
            .fontSize(FontSize.mini)
            .fontColor(Color.warningDark)
            .width('100%')
            .lineHeight(15)
          Row() {
            SecondaryButton({
              label: '重新查询定位',
              onClick_: () => {
                if (this.onRetry_ !== undefined) {
                  this.onRetry_();
                }
              }
            })
          }
          .width(150)
          .margin({ top: 4 })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .margin({ top: 6 })
      }
      Text('地图瓦片来自高德（GCJ-02）；坐标仅用于位置参考。地图不可用时不影响告警确认与处置。')
        .fontSize(FontSize.mini)
        .fontColor(Color.textTertiary)
        .width('100%')
        .lineHeight(15)
        .margin({ top: 6 })
    }
    .padding(Space.lg - 2)
    .width('100%')
    .backgroundColor(Color.card)
    .borderRadius(Radius.card)
    .shadow({ radius: 12, color: 'rgba(15,23,42,0.06)', offsetX: 0, offsetY: 4 })
    .alignItems(HorizontalAlign.Start)
  }
}
