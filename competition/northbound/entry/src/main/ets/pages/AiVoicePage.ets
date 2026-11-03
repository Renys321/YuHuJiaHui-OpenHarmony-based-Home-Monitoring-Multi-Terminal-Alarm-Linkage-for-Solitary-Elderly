import { BusinessError } from '@ohos.base';
import hilog from '@ohos.hilog';
import {
  AiVoiceClient, AiVoiceEvent, AI_EVENT_READY, AI_EVENT_CLOSED, AI_EVENT_ERROR, AI_EVENT_ANSWER,
  AI_EVENT_S3_ASR, AI_EVENT_S3_ANSWER, AI_EVENT_S3_SAFE, AI_EVENT_S3_ERROR
} from '../model/AiVoiceClient';

const DOMAIN = 0x0000;
const TAG = 'AiVoicePage';

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 10000;

PersistentStorage.persistProp('dayu_quick_questions', '');
PersistentStorage.persistProp('dayu_play_target', 'all');

const STATE_CONNECTING = 'connecting';
const STATE_ONLINE = 'online';
const STATE_OFFLINE = 'offline';

const DEFAULT_QUICK_QUESTIONS: string[] = ['我头晕怎么办', '血压高平时要注意什么', '今天天气怎么样', '我不舒服'];

function clock(): string {
  const d = new Date();
  const hh = d.getHours() < 10 ? `0${d.getHours()}` : `${d.getHours()}`;
  const mm = d.getMinutes() < 10 ? `0${d.getMinutes()}` : `${d.getMinutes()}`;
  const ss = d.getSeconds() < 10 ? `0${d.getSeconds()}` : `${d.getSeconds()}`;
  return `${hh}:${mm}:${ss}`;
}

/**
 * AI 语音问答页（只读）。
 *
 * S3 板载咪头负责采音，PC 网关负责 ASR/DeepSeek/TTS 与音箱播报；
 * 本页只订阅网关的 s3_asr / s3_answer / s3_safe / s3_error 文本事件用于展示，
 * 不录音、不输入文字、不播放音频、不改变任何告警状态。
 */
@Component
export struct AiVoicePage {
  @State connection: string = STATE_CONNECTING;
  @State connectionText: string = '正在连接语音网关…';
  @State node: string = '';
  @State room: string = '';
  @State lastEventTime: string = '';
  @State asrText: string = '';
  @State asrTime: string = '';
  @State answerText: string = '';
  @State answerTime: string = '';
  @State safeText: string = '';
  @State safeTime: string = '';
  @State speakerCount: number = 0;
  @State errorText: string = '';
  @State errorTime: string = '';
  @State quickQuestions: string[] = DEFAULT_QUICK_QUESTIONS;
  @State editingQuick: boolean = false;
  @State editQ1: string = '';
  @State editQ2: string = '';
  @State editQ3: string = '';
  @State editQ4: string = '';
  @State playTarget: string = 'all';

  private client: AiVoiceClient | null = null;
  private reconnectTimer: number = -1;
  private pingTimer: number = -1;
  private disposed: boolean = false;
  private connecting: boolean = false;
  private clientEpoch: number = 0;

  aboutToAppear(): void {
    const saved = AppStorage.get<string>('dayu_quick_questions');
    if (saved !== undefined && saved.length > 0) {
      try {
        const arr = JSON.parse(saved) as string[];
        if (arr.length === 4) {
          this.quickQuestions = arr;
        }
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'quick questions parse failed');
      }
    }
    const target = AppStorage.get<string>('dayu_play_target');
    if (target !== undefined && target.length > 0) {
      this.playTarget = target;
    }
    this.openConnection();
  }

  aboutToDisappear(): void {
    this.disposed = true;
    this.clientEpoch = this.clientEpoch + 1;
    this.clearTimers();
    this.closeClient();
  }

  private openConnection(): void {
    if (this.disposed || this.connecting) {
      return;
    }
    this.connecting = true;
    this.clientEpoch = this.clientEpoch + 1;
    const epoch = this.clientEpoch;
    this.connection = STATE_CONNECTING;
    this.connectionText = '正在连接语音网关…';

    const client = new AiVoiceClient((event: AiVoiceEvent) => {
      this.onEvent(event, epoch);
    });
    this.client = client;
    client.connect().then(() => {
      if (this.disposed || epoch !== this.clientEpoch) {
        client.close();
        return;
      }
      this.connecting = false;
      this.connectionText = '已连接，等待网关握手…';
    }).catch((e: BusinessError) => {
      if (epoch !== this.clientEpoch) {
        return;
      }
      hilog.error(DOMAIN, TAG, '连接语音网关失败: %{public}s', e.message);
      this.markOffline();
    });
  }

  private markOffline(): void {
    this.connecting = false;
    this.clientEpoch = this.clientEpoch + 1;
    this.stopPing();
    const client = this.client;
    this.client = null;
    if (client !== null) {
      client.close();
    }
    this.connection = STATE_OFFLINE;
    this.connectionText = '语音网关未连接';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== -1) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = -1;
      this.openConnection();
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const client = this.client;
      if (client !== null) {
        client.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== -1) {
      clearInterval(this.pingTimer);
      this.pingTimer = -1;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer !== -1) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = -1;
    }
  }

  private closeClient(): void {
    const client = this.client;
    this.client = null;
    if (client !== null) {
      client.close();
    }
  }

  private updateSource(event: AiVoiceEvent): void {
    if (event.node.length > 0) {
      this.node = event.node;
    }
    if (event.room.length > 0) {
      this.room = event.room;
    }
    this.lastEventTime = clock();
  }

  private onEvent(event: AiVoiceEvent, epoch: number): void {
    if (this.disposed || epoch !== this.clientEpoch) {
      return;
    }
    if (event.type === AI_EVENT_READY) {
      this.connecting = false;
      this.connection = STATE_ONLINE;
      this.connectionText = '语音网关已连接';
      if (this.reconnectTimer !== -1) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = -1;
      }
      this.startPing();
      return;
    }
    if (event.type === AI_EVENT_ANSWER) {
      this.answerText = event.text;
      this.answerTime = clock();
      this.speakerCount = event.speakers;
      return;
    }
    if (event.type === AI_EVENT_S3_ASR) {
      this.updateSource(event);
      this.asrText = event.text;
      this.asrTime = clock();
      return;
    }
    if (event.type === AI_EVENT_S3_ANSWER) {
      this.updateSource(event);
      this.answerText = event.text;
      this.answerTime = clock();
      this.speakerCount = event.speakers;
      return;
    }
    if (event.type === AI_EVENT_S3_SAFE) {
      this.updateSource(event);
      this.safeText = event.text;
      this.safeTime = clock();
      this.speakerCount = event.speakers;
      return;
    }
    if (event.type === AI_EVENT_S3_ERROR) {
      this.updateSource(event);
      this.errorText = `${event.code}：${event.text}`;
      this.errorTime = clock();
      return;
    }
    if (event.type === AI_EVENT_ERROR) {
      this.errorText = event.text.length > 0 ? event.text : '语音服务失败';
      this.errorTime = clock();
      this.markOffline();
      return;
    }
    if (event.type === AI_EVENT_CLOSED) {
      this.markOffline();
    }
  }

  private sourceText(): string {
    const node = this.node.length > 0 ? this.node : '未知设备';
    const room = this.room.length > 0 ? this.room : '未知房间';
    return `${node} · ${room}`;
  }

  private stateLabel(): string {
    if (this.connection === STATE_ONLINE) {
      return '已连接';
    }
    if (this.connection === STATE_CONNECTING) {
      return '连接中';
    }
    return '未连接';
  }

  private stateColor(): string {
    if (this.connection === STATE_ONLINE) {
      return '#2F9E44';
    }
    if (this.connection === STATE_CONNECTING) {
      return '#3F7DE6';
    }
    return '#C92A2A';
  }

  /** 预设问题：点按发送文字查询，不依赖板端麦克风或键盘。 */
  private ask(text: string): void {
    if (this.client === null || this.connection !== STATE_ONLINE) {
      this.errorText = '语音网关未连接，无法提问';
      this.errorTime = clock();
      return;
    }
    this.answerText = '正在思考…';
    this.answerTime = clock();
    this.client.sendText(text, this.playTarget === 'all' ? '' : this.playTarget).catch((e: BusinessError) => {
      this.errorText = '提问发送失败：' + e.message;
      this.errorTime = clock();
    });
  }

  private startEditQuick(): void {
    this.editQ1 = this.quickQuestions[0];
    this.editQ2 = this.quickQuestions[1];
    this.editQ3 = this.quickQuestions[2];
    this.editQ4 = this.quickQuestions[3];
    this.editingQuick = true;
  }

  private saveQuick(): void {
    const arr = [this.editQ1.trim(), this.editQ2.trim(), this.editQ3.trim(), this.editQ4.trim()];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].length === 0) {
        arr[i] = DEFAULT_QUICK_QUESTIONS[i];
      }
    }
    this.quickQuestions = arr;
    AppStorage.setOrCreate('dayu_quick_questions', JSON.stringify(arr));
    this.editingQuick = false;
  }

  private setPlayTarget(target: string): void {
    this.playTarget = target;
    AppStorage.setOrCreate('dayu_play_target', target);
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text('AI 语音问答').fontSize(18).fontWeight(FontWeight.Bold)
          Text('S3 语音/快捷问题 → 网关识别与回答').fontSize(11).fontColor('#888888')
            .margin({ top: 4 })
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Text(this.stateLabel())
          .fontSize(12).fontColor(Color.White)
          .backgroundColor(this.stateColor())
          .borderRadius(10).padding({ left: 10, right: 10, top: 4, bottom: 4 })
      }
      .width('100%').padding({ left: 16, right: 16, top: 12, bottom: 8 })

      Scroll() {
        Column({ space: 12 }) {
          Column() {
            Row() {
              Text('网关连接').fontSize(15).fontWeight(FontWeight.Bold)
              Blank()
              Text(this.connectionText).fontSize(12).fontColor(this.stateColor())
            }.width('100%')

            Text('本页不录音、不改变告警状态；可点按快捷问题。')
              .fontSize(12).fontColor('#666666').margin({ top: 8 }).width('100%')

            if (this.connection === STATE_OFFLINE) {
              Text('请确认 PC 已运行 start-voice-gateway.cmd，并已执行 ' +
                'hdc rport tcp:9302 tcp:9302；页面每 3 秒自动重连。')
                .fontSize(12).fontColor('#C92A2A').margin({ top: 8 }).width('100%')
            }

            Row() {
              Text(`语音来源：${this.sourceText()}`).fontSize(13).fontColor('#333333')
              Blank()
              Text(`音箱：${this.speakerCount} 台`).fontSize(13).fontColor('#333333')
            }.width('100%').margin({ top: 12 })

            Text(this.lastEventTime.length > 0 ? `最近更新：${this.lastEventTime}` : '等待 S3 语音事件…')
              .fontSize(11).fontColor('#999999').margin({ top: 6 }).width('100%')
          }.width('100%').padding(16).backgroundColor(Color.White).borderRadius(12)
          .alignItems(HorizontalAlign.Start)

          Column() {
            Row() {
              Text('快捷提问').fontSize(15).fontWeight(FontWeight.Bold)
              Blank()
              Text(this.editingQuick ? '取消' : '设置')
                .fontSize(12).fontColor('#3F7DE6')
                .onClick(() => {
                  if (this.editingQuick) {
                    this.editingQuick = false;
                  } else {
                    this.startEditQuick();
                  }
                })
            }.width('100%')

            if (this.editingQuick) {
              Text('编辑 4 个快捷问题，保存后立即生效。').fontSize(11).fontColor('#888888')
                .margin({ top: 4 }).width('100%')
              TextInput({ text: this.editQ1, placeholder: '问题 1' })
                .fontSize(13).margin({ top: 8 }).onChange((v: string) => { this.editQ1 = v; })
              TextInput({ text: this.editQ2, placeholder: '问题 2' })
                .fontSize(13).margin({ top: 6 }).onChange((v: string) => { this.editQ2 = v; })
              TextInput({ text: this.editQ3, placeholder: '问题 3' })
                .fontSize(13).margin({ top: 6 }).onChange((v: string) => { this.editQ3 = v; })
              TextInput({ text: this.editQ4, placeholder: '问题 4' })
                .fontSize(13).margin({ top: 6 }).onChange((v: string) => { this.editQ4 = v; })
              Row({ space: 10 }) {
                Text('保存').fontSize(13).fontColor(Color.White)
                  .padding({ left: 16, right: 16, top: 8, bottom: 8 })
                  .backgroundColor('#3F7DE6').borderRadius(8)
                  .onClick(() => this.saveQuick())
                Text('恢复默认').fontSize(13).fontColor('#666666')
                  .padding({ left: 12, right: 12, top: 8, bottom: 8 })
                  .backgroundColor('#F1F3F5').borderRadius(8)
                  .onClick(() => {
                    this.editQ1 = DEFAULT_QUICK_QUESTIONS[0];
                    this.editQ2 = DEFAULT_QUICK_QUESTIONS[1];
                    this.editQ3 = DEFAULT_QUICK_QUESTIONS[2];
                    this.editQ4 = DEFAULT_QUICK_QUESTIONS[3];
                  })
              }.width('100%').margin({ top: 10 })
            } else {
              Text('点按直接提问，不需要在板上打字。').fontSize(11).fontColor('#888888')
                .margin({ top: 4 }).width('100%')
              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(this.quickQuestions, (q: string) => {
                  Text(q.length > 8 ? q.slice(0, 8) + '…' : q)
                    .fontSize(13).fontColor('#1D4ED8')
                    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
                    .margin({ right: 8, bottom: 8 })
                    .backgroundColor('#EFF6FF').borderRadius(8)
                    .onClick(() => this.ask(q))
                }, (q: string, idx: number) => `${idx}-${q}`)
              }.width('100%').margin({ top: 10 })
              Row({ space: 8 }) {
                Text('播放音箱').fontSize(11).fontColor('#888888')
                Text('全部').fontSize(11)
                  .fontColor(this.playTarget === 'all' ? Color.White : '#3F7DE6')
                  .backgroundColor(this.playTarget === 'all' ? '#3F7DE6' : '#EFF6FF')
                  .borderRadius(6).padding({ left: 8, right: 8, top: 4, bottom: 4 })
                  .onClick(() => this.setPlayTarget('all'))
                Text('厨房').fontSize(11)
                  .fontColor(this.playTarget === 'esp32-kitchen' ? Color.White : '#3F7DE6')
                  .backgroundColor(this.playTarget === 'esp32-kitchen' ? '#3F7DE6' : '#EFF6FF')
                  .borderRadius(6).padding({ left: 8, right: 8, top: 4, bottom: 4 })
                  .onClick(() => this.setPlayTarget('esp32-kitchen'))
                Text('卫生间').fontSize(11)
                  .fontColor(this.playTarget === 'esp32-bath' ? Color.White : '#3F7DE6')
                  .backgroundColor(this.playTarget === 'esp32-bath' ? '#3F7DE6' : '#EFF6FF')
                  .borderRadius(6).padding({ left: 8, right: 8, top: 4, bottom: 4 })
                  .onClick(() => this.setPlayTarget('esp32-bath'))
              }.width('100%').margin({ top: 4 })
            }
          }.width('100%').padding(16).backgroundColor(Color.White).borderRadius(12)
          .alignItems(HorizontalAlign.Start)

          if (this.safeText.length > 0) {
            Column() {
              Row() {
                Text('老人自述安全').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#237804')
                Blank()
                Text(this.safeTime).fontSize(11).fontColor('#52A82F')
              }.width('100%')
              Text(this.safeText).fontSize(18).fontWeight(FontWeight.Bold)
                .fontColor('#237804').margin({ top: 10 }).width('100%')
              Text('已记录：家属会在手机 APP 中看到；原标题告警仍需家属确认，本页不会自动 ACK。')
                .fontSize(11).fontColor('#52A82F').margin({ top: 10 }).width('100%')
            }.width('100%').padding(16).backgroundColor('#F0FDF4').borderRadius(12)
            .border({ width: 1, color: '#BBF7D0' })
            .alignItems(HorizontalAlign.Start)
          }

          if (this.asrText.length > 0) {
            Column() {
              Row() {
                Text('最新识别').fontSize(13).fontColor('#888888')
                Blank()
                Text(this.asrTime).fontSize(11).fontColor('#AAAAAA')
              }.width('100%')
              Text(this.asrText).fontSize(17).margin({ top: 6 }).width('100%')
            }.width('100%').padding(16).backgroundColor(Color.White).borderRadius(12)
            .alignItems(HorizontalAlign.Start)
          }

          if (this.answerText.length > 0) {
            Column() {
              Row() {
                Text('守巢回答').fontSize(13).fontColor('#3F7DE6')
                Blank()
                Text(this.answerTime).fontSize(11).fontColor('#AAAAAA')
              }.width('100%')
              Text(this.answerText).fontSize(17).lineHeight(25).margin({ top: 8 }).width('100%')
              Text('提示：AI 只提供生活与安全建议，不能替代医生诊断；紧急情况请拨打 120。')
                .fontSize(11).fontColor('#B26A00').margin({ top: 10 }).width('100%')
            }.width('100%').padding(16).backgroundColor('#F2F7FF').borderRadius(12)
            .alignItems(HorizontalAlign.Start)
          }

          if (this.errorText.length > 0) {
            Column() {
              Row() {
                Text('语音链路提示').fontSize(13).fontColor('#C92A2A')
                Blank()
                Text(this.errorTime).fontSize(11).fontColor('#D98A8A')
              }.width('100%')
              Text(this.errorText).fontSize(14).margin({ top: 6 }).width('100%')
            }.width('100%').padding(16).backgroundColor('#FFF4F4').borderRadius(12)
            .alignItems(HorizontalAlign.Start)
          }

          if (this.asrText.length === 0 && this.answerText.length === 0 &&
            this.safeText.length === 0 && this.errorText.length === 0) {
            Column() {
              Text('等待 S3 语音…').fontSize(16).fontWeight(FontWeight.Medium)
                .fontColor('#666666').width('100%')
              Text('老人对 S3 说话后，识别与回答会自动显示在这里；语音由房间音箱播报。')
                .fontSize(12).fontColor('#999999').margin({ top: 8 }).width('100%')
            }.width('100%').padding(20).backgroundColor(Color.White).borderRadius(12)
            .alignItems(HorizontalAlign.Start)
          }

          Text('S3 采音 · PC 网关识别与回答 · 手机 APP 同步显示；本页不修改告警与确认状态。')
            .fontSize(11).fontColor('#999999').width('100%')
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 90 })
      }
      .width('100%').layoutWeight(1).align(Alignment.Top)
    }
    .width('100%').height('100%')
    .backgroundColor('#F4F6F9')
  }
}
