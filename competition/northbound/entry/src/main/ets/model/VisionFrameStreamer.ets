import image from '@ohos.multimedia.image';
import http from '@ohos.net.http';
import { BusinessError } from '@ohos.base';

export const DEFAULT_VISION_ENDPOINT: string =
  'http://127.0.0.1:9200/v1/frames/dayu200-living';

const FRAME_INTERVAL_MS: number = 250;
const INITIAL_DELAY_MS: number = 500;
const HTTP_TIMEOUT_MS: number = 2500;
const JPEG_QUALITY: number = 72;

export interface VisionStreamStatus {
  running: boolean;
  connected: boolean;
  personDetected: boolean;
  fallDetected: boolean;
  framesSent: number;
  framesFailed: number;
  lastLatencyMs: number;
  orientationState: string;
  fallEventId?: string;
  evidenceSaved?: boolean;
  evidenceFile?: string;
  error?: string;
}

interface VisionEvidenceSnapshot {
  saved: boolean;
  fileName?: string;
}

interface VisionFallEvent {
  evidenceId: string;
  snapshot?: VisionEvidenceSnapshot;
}

interface VisionInferenceResponse {
  ok: boolean;
  personDetected?: boolean;
  fall?: boolean;
  source: string;
  rotation?: number | string;
  suspended?: boolean;
  refused?: boolean;
  reason?: string;
  event?: VisionFallEvent;
}

/**
 * 从已经显示出来的相机 Surface 抓帧，一次只传一张 JPEG。
 * 视觉链路失败不影响预览和监控。
 */
export class VisionFrameStreamer {
  private surfaceId: string = '';
  private endpoint: string = '';
  private running: boolean = false;
  private generation: number = 0;
  private timerId: number = -1;
  private framesSent: number = 0;
  private framesFailed: number = 0;
  private lastLatencyMs: number = 0;
  private personDetected: boolean = false;
  private fallDetected: boolean = false;
  private orientationState: string = 'ready';
  private fallEventId: string = '';
  private evidenceSaved: boolean = false;
  private evidenceFile: string = '';
  private activeRequest: http.HttpRequest | null = null;
  private statusListener: ((status: VisionStreamStatus) => void) | null = null;

  setStatusListener(listener: (status: VisionStreamStatus) => void): void {
    this.statusListener = listener;
  }

  start(surfaceId: string, endpoint: string = DEFAULT_VISION_ENDPOINT): void {
    this.stop();
    if (surfaceId.length === 0 || endpoint.length === 0) {
      this.notify(false, 'Vision surface or endpoint unavailable');
      return;
    }
    this.surfaceId = surfaceId;
    this.endpoint = endpoint;
    this.running = true;
    this.framesSent = 0;
    this.framesFailed = 0;
    this.lastLatencyMs = 0;
    this.personDetected = false;
    this.fallDetected = false;
    this.orientationState = 'ready';
    this.fallEventId = '';
    this.evidenceSaved = false;
    this.evidenceFile = '';
    this.generation += 1;
    const currentGeneration: number = this.generation;
    this.notify(false);
    this.scheduleNext(currentGeneration, INITIAL_DELAY_MS);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timerId !== -1) {
      clearTimeout(this.timerId);
      this.timerId = -1;
    }
    if (this.activeRequest !== null) {
      const request: http.HttpRequest = this.activeRequest;
      this.activeRequest = null;
      try {
        request.destroy();
      } catch (err) {
        console.warn('[VisionFrameStreamer] HttpRequest destroy failed');
      }
    }
    this.surfaceId = '';
    this.endpoint = '';
    this.notify(false);
  }

  private scheduleNext(generation: number, delayMs: number): void {
    if (!this.running || generation !== this.generation) {
      return;
    }
    this.timerId = setTimeout(() => {
      this.timerId = -1;
      this.captureAndSend(generation);
    }, delayMs);
  }

  private async captureAndSend(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || this.surfaceId.length === 0) {
      return;
    }

    let pixelMap: image.PixelMap | null = null;
    let packer: image.ImagePacker | null = null;
    let request: http.HttpRequest | null = null;
    const startedAt: number = Date.now();
    try {
      // 按 Surface 当前呈现的样子抓，不要做反向变换：检测端的低位人体坐标是绝对的，
      // 横屏旋转后反变换会对不上。
      pixelMap = await image.createPixelMapFromSurface(this.surfaceId);
      packer = image.createImagePacker();
      const jpeg: ArrayBuffer = await packer.packToData(pixelMap, {
        format: 'image/jpeg',
        quality: JPEG_QUALITY
      });
      if (!this.running || generation !== this.generation) {
        return;
      }

      request = http.createHttp();
      this.activeRequest = request;
      const response: http.HttpResponse = await request.request(this.endpoint, {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'image/jpeg',
          'X-Eldercare-Frame-Ts': `${Date.now()}`
        },
        extraData: jpeg,
        expectDataType: http.HttpDataType.OBJECT,
        usingCache: false,
        connectTimeout: HTTP_TIMEOUT_MS,
        readTimeout: HTTP_TIMEOUT_MS
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`Vision HTTP ${response.responseCode}`);
      }
      const inference: VisionInferenceResponse = JSON.parse(
        JSON.stringify(response.result)
      ) as VisionInferenceResponse;
      this.personDetected = inference.personDetected === true;
      this.fallDetected = inference.fall === true;
      const rotationState: string = inference.rotation === undefined ? '' : `${inference.rotation}`;
      if (inference.refused === true) {
        this.orientationState = 'refused';
      } else if (inference.suspended === true) {
        this.orientationState = rotationState === 'calibrating' ? 'calibrating' : 'suspended';
      } else {
        this.orientationState = 'ready';
      }
      if (inference.event !== undefined && inference.event.evidenceId.length > 0) {
        this.fallEventId = inference.event.evidenceId;
        this.evidenceSaved = inference.event.snapshot !== undefined &&
          inference.event.snapshot.saved === true;
        this.evidenceFile = inference.event.snapshot !== undefined &&
          inference.event.snapshot.fileName !== undefined ? inference.event.snapshot.fileName : '';
      }
      this.framesSent += 1;
      this.lastLatencyMs = Date.now() - startedAt;
      this.notify(true);
    } catch (err) {
      if (this.running && generation === this.generation) {
        const error: BusinessError = err as BusinessError;
        this.framesFailed += 1;
        this.lastLatencyMs = Date.now() - startedAt;
        this.notify(false, error.message || 'Vision frame upload failed');
      }
    } finally {
      const shouldDestroyRequest: boolean = request !== null && this.activeRequest === request;
      if (shouldDestroyRequest) {
        this.activeRequest = null;
      }
      if (shouldDestroyRequest && request !== null) {
        try {
          request.destroy();
        } catch (err) {
          console.warn('[VisionFrameStreamer] HttpRequest destroy failed');
        }
      }
      if (packer !== null) {
        try {
          await packer.release();
        } catch (err) {
          console.warn('[VisionFrameStreamer] ImagePacker release failed');
        }
      }
      if (pixelMap !== null) {
        try {
          await pixelMap.release();
        } catch (err) {
          console.warn('[VisionFrameStreamer] PixelMap release failed');
        }
      }
      this.scheduleNext(generation, FRAME_INTERVAL_MS);
    }
  }

  private notify(connected: boolean, error?: string): void {
    if (this.statusListener === null) {
      return;
    }
    const status: VisionStreamStatus = {
      running: this.running,
      connected: connected,
      personDetected: this.personDetected,
      fallDetected: this.fallDetected,
      framesSent: this.framesSent,
      framesFailed: this.framesFailed,
      lastLatencyMs: this.lastLatencyMs,
      orientationState: this.orientationState
    };
    if (this.fallEventId.length > 0) {
      status.fallEventId = this.fallEventId;
      status.evidenceSaved = this.evidenceSaved;
      status.evidenceFile = this.evidenceFile;
    }
    if (error !== undefined && error.length > 0) {
      status.error = error;
    }
    this.statusListener(status);
  }
}
