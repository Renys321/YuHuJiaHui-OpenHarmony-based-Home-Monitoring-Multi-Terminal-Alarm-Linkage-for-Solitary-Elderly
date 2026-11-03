/**
 * 视频探望页 —— DAYU200 客厅摄像头实时画面（VIDEO-VISIT-CONTRACT §3）。
 *
 * 链路：现有登录 token → GuardianService POST /video/session → 一次性 ticket
 *       → @ohos.net.webSocket 连 relay /video/stream → 二进制 JPEG → PixelMap 渲染。
 *
 * 诚实边界：
 * - 只有真实收到并通过 JPEG 头尾校验的帧才进入“实时画面”；加载/失败/重连不显示假画面；
 * - 离开页面（onPageHide/aboutToDisappear）立即关 WS 并 POST /video/session/end；
 * - 隐私文案固定：“仅本次会话实时查看，不录像、不留存、不录音”；
 * - 页面只拿到 ticket，不接触也不打印 token。
 */
import { Color, FontSize, FontWeight_, Radius, Shadow_, Space } from '../common/Theme';
import { Responsive } from '../common/Responsive';
import { DateUtil } from '../common/DateUtil';
import { NavBar } from '../components/NavBar';
import { image } from '@kit.ImageKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { JpegFrameInfo } from '../core/video/FrameDecodeCore';
import { VideoConfig } from '../core/video/VideoConfig';
import { VideoSessionSnapshot, VideoSessionState } from '../core/video/VideoSessionCore';
import { VideoVisitService } from '../service/VideoVisitService';
import { GuardianService } from '../service/GuardianService';

@Entry
@Component
struct VideoVisitPage {
  @StorageLink('currentBreakpoint') bp: string = 'sm';
  @State snapshot: VideoSessionSnapshot = new VideoSessionSnapshot();
  /** 真实解码后的画面；undefined = 尚无可用帧（不显示占位图冒充画面）。 */
  @State pixelMap: image.PixelMap | undefined = undefined;
  @State frameSizeText: string = '';
  @State lastFrameClock: string = '';
  @State decodeErrorText: string = '';
  @State relayBaseText: string = '';
  @State privacyText: string = '仅本次会话实时查看，不录像、不留存、不录音';
  private service: VideoVisitService = new VideoVisitService();
  private decoding: boolean = false;
  private pendingFrame: ArrayBuffer | null = null;
  private pendingInfo: JpegFrameInfo | null = null;
  private disposed: boolean = false;
  private stopped: boolean = false;

  private pm(): number {
    return Responsive.pageMargin(this.bp);
  }

  aboutToAppear(): void {
    const ctx = this.getUIContext().getHostContext();
    if (ctx !== undefined) {
      GuardianService.init(ctx);
    }
    this.relayBaseText = VideoVisitService.resolvedRelayBase();
    if (!GuardianService.canRequestVideoSession()) {
      // 无 token 不发起任何视频请求（不新造登录态），只如实提示需重新登录。
      const snap = new VideoSessionSnapshot();
      snap.state = VideoSessionState.FAILED;
      snap.statusText = '登录已失效，请重新登录后再试探望';
      snap.errorText = '登录已失效，请重新登录后再试探望';
      snap.canRetry = false;
      this.snapshot = snap;
      return;
    }
    this.service.start(
      (snap: VideoSessionSnapshot): void => {
        if (this.disposed) return;
        this.snapshot = snap;
      },
      (data: ArrayBuffer, info: JpegFrameInfo): void => {
        this.onFrame(data, info);
      }
    );
  }

  /** 切后台/被新页面覆盖：必须停止收流并通知 relay（不得后台继续收流）。 */
  onPageHide(): void {
    this.stopVisit();
  }

  aboutToDisappear(): void {
    this.disposed = true;
    this.stopVisit();
    this.releasePixelMap();
  }

  // --------------------------------------------------------------- 生命周期

  private stopVisit(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.service.stop();
  }

  private releasePixelMap(): void {
    const old: image.PixelMap | undefined = this.pixelMap;
    this.pixelMap = undefined;
    if (old !== undefined) {
      old.release().then((): void => {
      }).catch((): void => {
      });
    }
  }

  private endVisit(): void {
    this.stopVisit();
    this.releasePixelMap();
    this.getUIContext().getRouter().back();
  }

  private retryVisit(): void {
    this.decodeErrorText = '';
    this.stopped = false;
    this.service.retry();
  }

  private clockText(): string {
    const now: Date = new Date();
    return `${DateUtil.pad(now.getHours())}:${DateUtil.pad(now.getMinutes())}:${DateUtil.pad(now.getSeconds())}`;
  }

  // --------------------------------------------------------------- 帧解码

  /** 收到一帧（已通过头尾/尺寸校验）：解码为 PixelMap 渲染；解码忙时只保留最新一帧。 */
  private onFrame(data: ArrayBuffer, info: JpegFrameInfo): void {
    if (this.disposed || this.stopped) return;
    this.lastFrameClock = this.clockText();
    if (this.decoding) {
      this.pendingFrame = data;
      this.pendingInfo = info;
      return;
    }
    this.decodeAndRender(data, info);
  }

  private async decodeAndRender(data: ArrayBuffer, info: JpegFrameInfo): Promise<void> {
    this.decoding = true;
    try {
      const source: image.ImageSource = image.createImageSource(data);
      try {
        const decoded: image.PixelMap = await source.createPixelMap();
        if (this.disposed || this.stopped) {
          await decoded.release();
        } else {
          const old: image.PixelMap | undefined = this.pixelMap;
          this.pixelMap = decoded;
          this.frameSizeText = `${info.width}×${info.height}`;
          this.decodeErrorText = '';
          if (old !== undefined) {
            await old.release();
          }
        }
      } finally {
        await source.release();
      }
    } catch (error) {
      const businessError: BusinessError = error as BusinessError;
      const message: string = typeof businessError.message === 'string' ? businessError.message : '';
      this.decodeErrorText = message.length > 0 ? `画面解码失败：${message}` : '画面解码失败，请重试';
    } finally {
      this.decoding = false;
      const pending: ArrayBuffer | null = this.pendingFrame;
      const pendingInfo: JpegFrameInfo | null = this.pendingInfo;
      this.pendingFrame = null;
      this.pendingInfo = null;
      if (pending !== null && pendingInfo !== null && !this.disposed && !this.stopped) {
        this.decodeAndRender(pending, pendingInfo);
      }
    }
  }

  // --------------------------------------------------------------- UI

  private isLoadingState(): boolean {
    return this.snapshot.state === VideoSessionState.REQUESTING ||
      this.snapshot.state === VideoSessionState.CONNECTING ||
      this.snapshot.state === VideoSessionState.WAITING_FIRST_FRAME ||
      this.snapshot.state === VideoSessionState.RECONNECTING;
  }

  @Builder
  viewport() {
    Stack({ alignContent: Alignment.Center }) {
      if (this.pixelMap !== undefined && this.snapshot.playing) {
        Image(this.pixelMap)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Contain)
      } else {
        Column() {
          if (this.isLoadingState()) {
            LoadingProgress()
              .width(44)
              .height(44)
              .color('#FFFFFF')
          } else {
            SymbolGlyph($r('sys.symbol.video_fill'))
              .fontSize(44)
              .fontColor(['rgba(255,255,255,0.5)'])
          }
          Text(this.snapshot.statusText)
            .fontSize(FontSize.body)
            .fontWeight(FontWeight_.semibold)
            .fontColor('#FFFFFF')
            .textAlign(TextAlign.Center)
            .lineHeight(20)
            .margin({ top: Space.sm })
            .padding({ left: 18, right: 18 })
          if (this.snapshot.state === VideoSessionState.WAITING_FIRST_FRAME) {
            Text(`等待 ${this.relayBaseText} 转发客厅画面…`)
              .fontSize(FontSize.mini)
              .fontColor('rgba(255,255,255,0.7)')
              .margin({ top: 4 })
          }
          if (this.snapshot.state === VideoSessionState.RECONNECTING) {
            Text('画面已暂停，连接恢复后自动继续')
              .fontSize(FontSize.mini)
              .fontColor('rgba(255,255,255,0.7)')
              .margin({ top: 4 })
          }
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }

      if (this.snapshot.playing) {
        Row() {
          Text(`第 ${this.snapshot.framesReceived} 帧`)
            .fontSize(FontSize.mini)
            .fontColor('#FFFFFF')
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .backgroundColor('rgba(0,0,0,0.45)')
            .borderRadius(Radius.pill)
          Text(`${this.snapshot.fps} fps`)
            .fontSize(FontSize.mini)
            .fontColor('#FFFFFF')
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
            .backgroundColor('rgba(0,0,0,0.45)')
            .borderRadius(Radius.pill)
            .margin({ left: 5 })
          Blank()
          if (this.frameSizeText.length > 0) {
            Text(this.frameSizeText)
              .fontSize(FontSize.mini)
              .fontColor('#FFFFFF')
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .backgroundColor('rgba(0,0,0,0.45)')
              .borderRadius(Radius.pill)
          }
        }
        .width('100%')
        .padding({ left: 8, right: 8, top: 8 })
        .position({ x: 0, y: 0 })
        .alignItems(VerticalAlign.Top)
      }
    }
    .width('100%')
    .aspectRatio(4 / 3)
    .backgroundColor('#0B1220')
    .borderRadius(Radius.tile)
    .clip(true)
    .shadow(Shadow_.card())
  }

  @Builder
  statusPanel() {
    Column() {
      Row() {
        Text('连接状态')
          .fontSize(FontSize.caption)
          .fontWeight(FontWeight_.bold)
          .fontColor(Color.textPrimary)
        Blank()
        Text(this.snapshot.playing ? '实时画面' : this.stateLabel())
          .fontSize(FontSize.mini)
          .fontWeight(FontWeight_.semibold)
          .fontColor(this.snapshot.playing ? Color.successDark :
            (this.snapshot.state === VideoSessionState.FAILED ? Color.criticalDark : Color.textSecondary))
      }
      .width('100%')

      Text(this.snapshot.statusText)
        .fontSize(FontSize.caption - 0.5)
        .fontColor(Color.textSecondary)
        .lineHeight(16)
        .margin({ top: 4 })
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })

      if (this.snapshot.playing) {
        Text(`已接收 ${this.snapshot.framesReceived} 帧 · ${this.snapshot.fps} fps` +
          (this.lastFrameClock.length > 0 ? ` · 最近帧 ${this.lastFrameClock}` : ''))
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .margin({ top: 3 })
        if (this.snapshot.cameraText.length > 0) {
          Text(`摄像头：${this.snapshot.cameraText}`)
            .fontSize(FontSize.mini)
            .fontColor(Color.textTertiary)
            .margin({ top: 2 })
        }
      }

      if (this.snapshot.droppedFrames > 0) {
        Text(`已丢弃异常帧 ${this.snapshot.droppedFrames} 个（不是有效画面）` +
          (this.snapshot.lastDropText.length > 0 ? `：${this.snapshot.lastDropText}` : ''))
          .fontSize(FontSize.mini)
          .fontColor(Color.warningDark)
          .lineHeight(14)
          .margin({ top: 3 })
          .maxLines(2)
      }
      if (this.decodeErrorText.length > 0) {
        Text(this.decodeErrorText)
          .fontSize(FontSize.mini)
          .fontColor(Color.warningDark)
          .lineHeight(14)
          .margin({ top: 3 })
          .maxLines(2)
      }
      if (this.snapshot.state === VideoSessionState.FAILED && this.snapshot.errorKind.length > 0) {
        Text(`错误类型：${this.snapshot.errorKind}`)
          .fontSize(FontSize.mini)
          .fontColor(Color.textTertiary)
          .margin({ top: 3 })
      }
      Text(`中继地址：${this.relayBaseText.length > 0 ? this.relayBaseText : '未配置'}`)
        .fontSize(FontSize.mini)
        .fontColor(Color.textTertiary)
        .margin({ top: 3 })
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding(Space.md)
    .backgroundColor(Color.card)
    .borderRadius(Radius.tile)
    .alignItems(HorizontalAlign.Start)
    .margin({ top: Space.sm })
  }

  private stateLabel(): string {
    if (this.snapshot.state === VideoSessionState.FAILED) return '未连接';
    if (this.snapshot.state === VideoSessionState.ENDED) return '已结束';
    if (this.snapshot.state === VideoSessionState.RECONNECTING) return '重连中';
    return '加载中';
  }

  @Builder
  actionRow() {
    Row({ space: 10 }) {
      if (this.snapshot.canRetry) {
        Button('重新连接')
          .fontSize(FontSize.body)
          .fontWeight(FontWeight_.semibold)
          .fontColor('#FFFFFF')
          .backgroundColor(Color.primaryDark)
          .layoutWeight(1)
          .height(44)
          .borderRadius(Radius.chip)
          .onClick((): void => {
            this.retryVisit();
          })
      }
      Button(this.snapshot.state === VideoSessionState.ENDED ? '返回' : '结束探望')
        .fontSize(FontSize.body)
        .fontWeight(FontWeight_.bold)
        .fontColor(this.snapshot.state === VideoSessionState.ENDED ? Color.textPrimary : Color.criticalDark)
        .backgroundColor(this.snapshot.state === VideoSessionState.ENDED ? Color.card : Color.criticalLight)
        .layoutWeight(1)
        .height(44)
        .borderRadius(Radius.chip)
        .onClick((): void => {
          this.endVisit();
        })
    }
    .width('100%')
    .margin({ top: Space.md })
  }

  @Builder
  privacyCard() {
    Row() {
      SymbolGlyph($r('sys.symbol.info_circle'))
        .fontSize(14)
        .fontColor([Color.primaryDark])
        .margin({ top: 1 })
      Column() {
        Text(this.privacyText)
          .fontSize(FontSize.mini + 0.5)
          .fontWeight(FontWeight_.semibold)
          .fontColor(Color.textPrimary)
          .lineHeight(15)
        Text('画面仅在本机内存中解码渲染，退出页面即停止接收；relay 不提供公网回放。')
          .fontSize(FontSize.mini)
          .fontColor(Color.textSecondary)
          .lineHeight(14)
          .margin({ top: 2 })
          .maxLines(2)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 6 })
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .backgroundColor('#EFF6FF')
    .borderRadius(Radius.chip)
    .margin({ top: Space.md })
  }

  build() {
    Column() {
      NavBar({ title: '视频探望' })
      Scroll() {
        Column() {
          Row() {
            Column() {
              Text('客厅实时画面')
                .fontSize(FontSize.h2)
                .fontWeight(FontWeight_.extrabold)
                .fontColor(Color.textPrimary)
              Text('DAYU200 摄像头 · 低帧率实时预览 · 仅供本次探望')
                .fontSize(FontSize.caption)
                .fontColor(Color.textSecondary)
                .margin({ top: 2 })
            }
            .alignItems(HorizontalAlign.Start)
            .layoutWeight(1)
          }
          .width('100%')
          .margin({ bottom: Space.sm })

          this.viewport()
          this.statusPanel()
          this.actionRow()
          this.privacyCard()
        }
        .width('100%')
        .padding({ left: this.pm(), right: this.pm(), top: Space.md, bottom: Space.xl })
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.bg)
  }
}
