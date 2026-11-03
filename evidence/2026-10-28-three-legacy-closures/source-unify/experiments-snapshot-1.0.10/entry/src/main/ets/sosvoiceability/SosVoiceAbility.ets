import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import UIAbility from '@ohos.app.ability.UIAbility';
import Want from '@ohos.app.ability.Want';
import hilog from '@ohos.hilog';
import media from '@ohos.multimedia.media';
import audio from '@ohos.multimedia.audio';
import fs from '@ohos.file.fs';
import http from '@ohos.net.http';

const DOMAIN = 0x0000;
const TAG = 'SosVoice';

/**
 * 预置语音资源白名单（按需维护）。
 *
 * **只允许**这 5 个文件名，且只作为 rawfile 的资源名使用，绝不拼接成文件系统路径。
 * 远程留言只允许从这 5 个里选；未知名字一律拒绝播放并回报失败，
 * **绝不**回退播放 sos.wav（回退会把错误资源伪装成成功）。
 */
const VOICE_RESOURCES: string[] = [
  'check_in.wav',
  'please_respond.wav',
  'medicine_reminder.wav',
  'family_message.wav',
  'emergency_contacting.wav'
];

/** 告警求助（MANUAL_SOS / FALL）沿用的旧资源，仅在"没有 voiceResource 参数"时使用。 */
const SOS_CANDIDATES: string[] = ['sos.wav', 'sos.m4a', 'sos.mp3', 'sos.aac', 'sos.ogg'];

/** 回执落点的固定本地路径：HAP 不接受任意 callback URL。 */
const CALLBACK_PATH = '/playback-result';
const CALLBACK_HOST_PREFIX = 'http://127.0.0.1:';
const CALLBACK_TIMEOUT_MS = 4000;
/** 回执正文长度上限（字节）。 */
const ERROR_CODE_MAX = 48;

/**
 * 校验 voiceResource 参数。
 *
 * 精确匹配、大小写敏感；拒绝 `/`、`\`、`..`、`:`、`?`、`#`、`%`、URL、
 * 绝对路径与任意扩展名变形。**不把参数拼进任何路径。**
 *
 * @returns 合法的资源名；非法时返回空串
 */
export function resolveVoiceResource(value: string): string {
  if (value.length === 0 || value.length > 64) {
    return '';
  }
  // 逐字符黑名单：路径分隔符、上跳、URL/查询/编码标记
  const forbidden: string[] = ['/', '\\', ':', '?', '#', '%', ' ', '\t', '\n', '\r'];
  for (let i = 0; i < forbidden.length; i++) {
    if (value.indexOf(forbidden[i]) >= 0) {
      return '';
    }
  }
  if (value.indexOf('..') >= 0) {
    return '';
  }
  // 只接受白名单里的精确名字（大小写敏感）
  for (let i = 0; i < VOICE_RESOURCES.length; i++) {
    if (VOICE_RESOURCES[i] === value) {
      return value;
    }
  }
  return '';
}

/** 从 want.parameters 里安全地读取一个字符串参数（SDK 声明为 Record<string, Object>）。 */
export function readStringParam(want: Want, key: string): string {
  try {
    const params: Record<string, Object> | undefined = want.parameters;
    if (params === undefined || params === null) {
      return '';
    }
    const raw: Object | undefined = params[key];
    if (raw === undefined || raw === null) {
      return '';
    }
    if (typeof raw === 'string') {
      return raw as string;
    }
    if (typeof raw === 'number') {
      return String(raw as number);
    }
    return '';
  } catch (e) {
    return '';
  }
}

/** callbackPort 必须是合法端口。 */
export function parseCallbackPort(value: string): number {
  if (value.length === 0 || value.length > 5) {
    return 0;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x30 || code > 0x39) {
      return 0;
    }
  }
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return 0;
  }
  return port;
}

/** callbackNonce 必须是本机生成的一次性随机串（URL 安全、足够长）。 */
export function isValidCallbackNonce(value: string): boolean {
  if (value.length < 22 || value.length > 128) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    const isUpper = c >= 'A' && c <= 'Z';
    const isLower = c >= 'a' && c <= 'z';
    const isDigit = c >= '0' && c <= '9';
    const isSymbol = c === '-' || c === '_';
    if (!isUpper && !isLower && !isDigit && !isSymbol) {
      return false;
    }
  }
  return true;
}

/** playbackMessageId 必须与 southbound 的回执协议格式一致。 */
export function isValidPlaybackMessageId(value: string): boolean {
  if (value.length < 6 || value.length > 64) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    const isUpper = c >= 'A' && c <= 'Z';
    const isLower = c >= 'a' && c <= 'z';
    const isDigit = c >= '0' && c <= '9';
    const isSymbol = c === '-' || c === '_' || c === '.';
    if (!isUpper && !isLower && !isDigit && !isSymbol) {
      return false;
    }
  }
  return true;
}

/** 回调地址只能是固定路径下的 127.0.0.1。 */
export function buildCallbackUrl(port: number): string {
  if (port < 1 || port > 65535) {
    return '';
  }
  return `${CALLBACK_HOST_PREFIX}${port}${CALLBACK_PATH}`;
}

/** 清理失败码：只允许 [A-Z0-9_]，避免把任意文本回传出去。 */
function sanitizeErrorCode(code: string): string {
  if (code.length === 0) {
    return '';
  }
  let out = '';
  for (let i = 0; i < code.length && out.length < ERROR_CODE_MAX; i++) {
    const c = code.charAt(i);
    const isUpper = c >= 'A' && c <= 'Z';
    const isDigit = c >= '0' && c <= '9';
    const isUnderscore = c === '_';
    if (isUpper || isDigit || isUnderscore) {
      out += c;
    }
  }
  return out;
}

/**
 * 语音播放 Ability。
 *
 * 用法一（告警求助，旧行为，保持不变）：
 *   aa start -a SosVoiceAbility -b com.dsh.eldercare
 *   → 播放随包携带的 sos.wav，播完自动退出。
 *
 * 用法二（远程留言，本工作包新增）：
 *   aa start -a SosVoiceAbility -b com.dsh.eldercare \
 *     --ps voiceResource medicine_reminder.wav \
 *     --ps playbackMessageId cmsg-xxxx \
 *     --ps callbackPort 45123 \
 *     --ps callbackNonce <一次性随机串>
 *   → 播放指定预置语音；AVPlayer 真正进入 completed 后，POST 回执到
 *     127.0.0.1:<callbackPort>/playback-result，然后退出。
 *     只有收到这条回执，南向代理才会向后端回报 PLAYED。
 *
 * 为什么用本地 HTTP 回执（而不是 aa 退出码 / sleep）：
 *   `aa start` 的退出码只说明 Ability 被拉起；Ability 结束后父进程也无法读取
 *   它的返回值。本工程已声明 ohos.permission.INTERNET（module.json5），
 *   @ohos.net.http 在同机回环上与南向代理通信是可行且可校验的：
 *   端口 + 一次性 nonce + messageId 三者同时匹配才算完成，且**只有 AVPlayer
 *   的 completed/error 回调**才会触发回执。
 *
 * ── 真机踩坑记录（OH 4.1）─────────────────────────────────────────
 *  ✗ player.fdSrc = rawfile 的 fd
 *      → 5400106 "Unsupport Format: Could not determine type of stream"
 *  ✗ player.url = 'file://<沙箱路径>.wav'
 *      → 401 "Invalid Parameter: The input parameter is not fd:// or network address"
 *  ✓ 先把 rawfile 写入应用沙箱，再用**真实文件 fd**交给播放器：
 *      ① url = 'fd://<fd>'（OH 4.1 明确要求 fd:// 形式）
 *      ② 若①失败，自动降级为 fdSrc = {fd, offset:0, length}
 *  ⚠ OH 7.0 实测：默认音频流会被路由到 WIRED_HEADSET，必须显式
 *      audioRendererInfo.usage = STREAM_USAGE_ALARM 才会走板载扬声器。
 * ─────────────────────────────────────────────────────────────────
 */
export default class SosVoiceAbility extends UIAbility {
  private player: media.AVPlayer | null = null;
  private fileFd: number = -1;
  private fileSize: number = 0;
  private attempt: number = 0;      // 0 = fd://    1 = fdSrc
  private released: boolean = false;
  private terminated: boolean = false;
  private path: string = '';
  /** 本次要播的资源候选：远程留言时只有一个（严格对应 voiceId），告警时是旧列表。 */
  private candidates: string[] = SOS_CANDIDATES;
  /** 是否是远程留言模式：为 true 时禁止回退到 sos.wav。 */
  private remoteMode: boolean = false;

  /* ---- 回执上下文（只有同时具备 port + nonce + messageId 才回执）---- */
  private callbackUrl: string = '';
  private callbackMessageId: string = '';
  private callbackNonce: string = '';
  private callbackSent: boolean = false;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 1) 读回执上下文（远程留言模式）
    const resourceParam = readStringParam(want, 'voiceResource');
    const messageIdParam = readStringParam(want, 'playbackMessageId');
    const portParam = readStringParam(want, 'callbackPort');
    const nonceParam = readStringParam(want, 'callbackNonce');
    this.callbackMessageId = messageIdParam;
    this.callbackNonce = nonceParam;
    const port = parseCallbackPort(portParam);
    const resource = resolveVoiceResource(resourceParam);
    const remoteParamPresent = resourceParam.length > 0 || messageIdParam.length > 0 ||
      portParam.length > 0 || nonceParam.length > 0;

    if (remoteParamPresent) {
      // 远程留言模式
      this.remoteMode = true;
      if (port === 0 || !isValidCallbackNonce(this.callbackNonce) ||
        !isValidPlaybackMessageId(this.callbackMessageId)) {
        // 任意留言参数出现就必须提供完整且合法的回执上下文；否则不得退化成 SOS 播放。
        hilog.error(DOMAIN, TAG, '%{public}s', '回执上下文不完整，拒绝播放');
        this.finish('', 'CALLBACK_CONTEXT_INVALID');
        return;
      }
      this.callbackUrl = buildCallbackUrl(port);
      if (resource === '') {
        // 未知/非法资源：拒绝播放，且**绝不**回退 sos.wav
        hilog.error(DOMAIN, TAG, '%{public}s', 'voiceResource 非法或不在白名单，拒绝播放');
        this.finish('', 'UNKNOWN_VOICE');
        return;
      }
      this.candidates = [resource];
      hilog.info(DOMAIN, TAG, '远程留言模式: resource=%{public}s', resource);
    } else {
      // 告警求助模式：保持原有行为
      this.remoteMode = false;
      this.candidates = SOS_CANDIDATES;
      hilog.info(DOMAIN, TAG, '%{public}s', 'SosVoiceAbility onCreate：开始播放求助语音');
    }

    this.prepareAndPlay();
  }

  /** 从 rawfile 里挑第一个存在的语音文件 */
  private async pickAudio(): Promise<string> {
    const rm = this.context.resourceManager;
    for (let i = 0; i < this.candidates.length; i++) {
      try {
        const d = await rm.getRawFileContent(this.candidates[i]);
        if (d.byteLength > 0) {
          return this.candidates[i];
        }
      } catch (e) {
        // 该候选不存在，继续
      }
    }
    return '';
  }

  /** 把 rawfile 释放到沙箱并打开为只读 fd，然后尝试播放 */
  private async prepareAndPlay(): Promise<void> {
    try {
      const name: string = await this.pickAudio();
      if (name.length === 0) {
        hilog.error(DOMAIN, TAG, '%{public}s', '未找到任何语音文件，退出');
        this.finish('', 'RESOURCE_MISSING');
        return;
      }
      const rm = this.context.resourceManager;
      const data = await rm.getRawFileContent(name);
      // 远程留言模式下只允许播放白名单资源；名字已在白名单校验过，这里再确认一次
      if (this.remoteMode && resolveVoiceResource(name) === '') {
        hilog.error(DOMAIN, TAG, '%{public}s', '解析出的资源名不在白名单，拒绝播放');
        this.finish('', 'UNKNOWN_VOICE');
        return;
      }
      this.path = this.context.filesDir + '/' + name;

      /* ⚠ 必须先删除旧文件再写：只用 READ_WRITE|CREATE 会保留旧内容，
         当新语音比旧语音短时，fd:// 播放会把旧文件的尾部一起播出来。 */
      try {
        if (fs.accessSync(this.path)) {
          fs.unlinkSync(this.path);
        }
      } catch (e) {
        // 文件本就不存在，忽略
      }
      const w = fs.openSync(this.path,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(w.fd, data.buffer as ArrayBuffer);
      fs.closeSync(w);

      this.fileSize = data.byteLength;
      const ro = fs.openSync(this.path, fs.OpenMode.READ_ONLY);
      this.fileFd = ro.fd;
      hilog.info(DOMAIN, TAG, '语音已就绪: %{public}s (%{public}d 字节, fd=%{public}d)',
        this.path, this.fileSize, this.fileFd);
      this.tryPlay();
    } catch (e) {
      hilog.error(DOMAIN, TAG, '准备语音失败: %{public}s', JSON.stringify(e));
      this.finish('', 'PREPARE_FAILED');
    }
  }

  private tryPlay(): void {
    media.createAVPlayer().then((player: media.AVPlayer) => {
      this.player = player;

      /* ⚠ OH 7.0 实测：默认音频流会被路由到 WIRED_HEADSET（板子未插耳机就没声音）。
         必须显式指定为**告警**用途，音频策略才会强制走板载扬声器。 */
      try {
        player.audioRendererInfo = {
          usage: audio.StreamUsage.STREAM_USAGE_ALARM,
          rendererFlags: 0
        } as audio.AudioRendererInfo;
        hilog.info(DOMAIN, TAG, '%{public}s', '音频流已设为 STREAM_USAGE_ALARM（强制扬声器）');
      } catch (e) {
        hilog.error(DOMAIN, TAG, '设置音频流失败: %{public}s', JSON.stringify(e));
      }

      player.on('stateChange', (state: media.AVPlayerState) => {
        if (this.player !== player || this.released) {
          return;
        }
        hilog.info(DOMAIN, TAG, 'AVPlayer state = %{public}s (attempt=%{public}d)', state, this.attempt);
        if (state === 'initialized') {
          player.prepare();
        } else if (state === 'prepared') {
          /* 音量拉满：求助场景必须能被听见（默认音量偏低，实测板载输出很轻） */
          try {
            player.setVolume(1.0);
            hilog.info(DOMAIN, TAG, '%{public}s', '播放音量已设为 1.0');
          } catch (e) {
            hilog.error(DOMAIN, TAG, '设置音量失败: %{public}s', JSON.stringify(e));
          }
          player.play();
        } else if (state === 'playing') {
          hilog.info(DOMAIN, TAG, '%{public}s', '开始播报…');
        } else if (state === 'completed') {
          // ★ 关键：只有真实播放完成才回调 COMPLETED。
          hilog.info(DOMAIN, TAG, '%{public}s', 'AVPlayer completed：音频真实播放完成');
          this.finish('COMPLETED', '');
        }
      });

      player.on('error', (err: Error) => {
        if (this.player !== player || this.released) {
          return;
        }
        hilog.error(DOMAIN, TAG, 'AVPlayer error(attempt=%{public}d): %{public}s',
          this.attempt, err.message);
        this.nextAttempt();
      });

      if (this.attempt === 0) {
        player.url = `fd://${this.fileFd}`;                                    // ① fd://
      } else {
        player.fdSrc = { fd: this.fileFd, offset: 0, length: this.fileSize };  // ② 降级
      }
    }).catch((e: Error) => {
      hilog.error(DOMAIN, TAG, '创建播放器失败: %{public}s', e.message);
      this.finish('', 'PLAYER_CREATE_FAILED');
    });
  }

  /** 一种方式失败后换下一种；都失败则退出（远程留言模式不会回退到 sos.wav）。 */
  private nextAttempt(): void {
    const p = this.player;
    if (p !== null) {
      try {
        p.release();
      } catch (e) {
        // 忽略
      }
      this.player = null;
    }
    // 换播放方式需要重新打开 fd（release 后旧 fd 不可再用于新播放器）
    if (this.fileFd >= 0) {
      try {
        fs.closeSync(this.fileFd);
      } catch (e) {
        // 忽略
      }
      this.fileFd = -1;
      try {
        const ro = fs.openSync(this.path, fs.OpenMode.READ_ONLY);
        this.fileFd = ro.fd;
      } catch (e) {
        hilog.error(DOMAIN, TAG, '重新打开语音文件失败: %{public}s', JSON.stringify(e));
        this.finish('', 'REOPEN_FAILED');
        return;
      }
    }
    if (this.attempt === 0) {
      this.attempt = 1;
      hilog.info(DOMAIN, TAG, '%{public}s', '改用 fdSrc 方式重试');
      this.tryPlay();
    } else {
      hilog.error(DOMAIN, TAG, '%{public}s', '两种播放方式均失败');
      this.finish('', 'PLAY_METHODS_EXHAUSTED');
    }
  }

  /**
   * 结束播放并（在远程留言模式下）回报结果。
   *
   * @param result 'COMPLETED' 表示 AVPlayer 真实播放完成；'' 表示未完成/失败
   * @param errorCode 失败码（仅 [A-Z0-9_]）
   */
  private finish(result: string, errorCode: string): void {
    if (this.released) {
      return;
    }
    this.released = true;

    const p = this.player;
    if (p !== null) {
      /* ⚠ release() 会抛异常：不捕获的话后面的 fd 关闭与 terminateSelf 都不会执行，
         进程残留 → 下一次求助可能起不来。 */
      try {
        p.release();
      } catch (e) {
        hilog.error(DOMAIN, TAG, 'release 异常（已忽略）: %{public}s', JSON.stringify(e));
      }
      this.player = null;
    }
    if (this.fileFd >= 0) {
      try {
        fs.closeSync(this.fileFd);
      } catch (e) {
        // 忽略
      }
      this.fileFd = -1;
    }

    if (this.remoteMode && this.callbackUrl.length > 0 && !this.callbackSent) {
      // 先回执再退出：回执成功与否都不影响 Ability 自身的安全退出。
      this.sendCallback(result === 'COMPLETED' ? 'COMPLETED' : 'FAILED', errorCode);
      return;
    }

    hilog.info(DOMAIN, TAG, '%{public}s', '求助语音播报结束，退出 Ability');
    this.terminate();
  }

  /** 向本地南向代理回报播放结果（正文固定、有界）。 */
  private sendCallback(result: string, errorCode: string): void {
    this.callbackSent = true;
    const payload: Record<string, string> = {
      'playbackMessageId': this.callbackMessageId,
      'callbackNonce': this.callbackNonce,
      'result': result,
      'errorCode': sanitizeErrorCode(errorCode)
    };

    let request: http.HttpRequest | null = null;
    try {
      request = http.createHttp();
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: { 'content-type': 'application/json' } as Record<string, string>,
        extraData: JSON.stringify(payload),
        connectTimeout: CALLBACK_TIMEOUT_MS,
        readTimeout: CALLBACK_TIMEOUT_MS
      };
      request.request(this.callbackUrl, options, (err: Error, data: http.HttpResponse) => {
        if (err !== null && err !== undefined) {
          hilog.error(DOMAIN, TAG, '播放回执失败: %{public}s', err.message);
        } else {
          hilog.info(DOMAIN, TAG, '播放回执已发送: result=%{public}s http=%{public}d',
            result, data.responseCode);
        }
        this.releaseRequest(request);
        this.terminate();
      });
    } catch (e) {
      hilog.error(DOMAIN, TAG, '播放回执异常: %{public}s', JSON.stringify(e));
      this.releaseRequest(request);
      this.terminate();
    }
  }

  /** 释放 HTTP 请求对象（幂等）。 */
  private releaseRequest(request: http.HttpRequest | null): void {
    if (request === null) {
      return;
    }
    try {
      request.destroy();
    } catch (e) {
      // 忽略
    }
  }

  /** 退出 Ability（幂等）。 */
  private terminate(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    try {
      this.context.terminateSelf();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'terminateSelf 异常（已忽略）: %{public}s', JSON.stringify(e));
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'SosVoiceAbility onDestroy');
  }
}
