/**
 * 相机预览与拍照。
 * 这里的失败都关在模块内，不影响监控、网络、告警和 ACK。
 */

import camera from '@ohos.multimedia.camera';
import image from '@ohos.multimedia.image';
import fs from '@ohos.file.fs';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import { BusinessError } from '@ohos.base';
import common from '@ohos.app.ability.common';
import { PrivatePhotoEntry, isPrivatePhotoName, selectPrivatePhotosToDelete } from './PhotoRetention';

const PHOTO_MAX_COUNT: number = 100;

export interface CameraProbeSummary {
  available: boolean;
  cameraCount: number;
  cameras: CameraProbeDevice[];
  error?: string;
}

export interface CameraProbeDevice {
  position: string;
  type: string;
}

export interface CameraPreviewSummary {
  available: boolean;
  position: string;
  width: number;
  height: number;
  photoAvailable: boolean;
  error?: string;
}

export interface CameraPhotoResult {
  success: boolean;
  fileName: string;
  bytes: number;
  error?: string;
}

export class CameraModel {
  private cameraManager: camera.CameraManager | null = null;
  private cameraInput: camera.CameraInput | null = null;
  private previewOutput: camera.PreviewOutput | null = null;
  private photoOutput: camera.PhotoOutput | null = null;
  private photoSession: camera.PhotoSession | null = null;
  private context: common.UIAbilityContext | null = null;
  private previewRunning: boolean = false;
  private previewStarting: boolean = false;
  private startGeneration: number = 0;
  private capturePending: boolean = false;
  private captureTimeoutId: number = -1;
  private photoResultListener: ((result: CameraPhotoResult) => void) | null = null;

  setPhotoResultListener(listener: (result: CameraPhotoResult) => void): void {
    this.photoResultListener = listener;
  }

  async initialize(context: common.UIAbilityContext): Promise<CameraProbeSummary> {
    this.context = context;
    try {
      const granted = await this.requestCameraPermission();
      if (!granted) {
        return { available: false, cameraCount: 0, cameras: [], error: 'Permission denied' };
      }

      this.cameraManager = camera.getCameraManager(context);
      const supportedCameras: camera.CameraDevice[] = this.cameraManager.getSupportedCameras();
      console.info(`[CameraModel] 发现 ${supportedCameras.length} 个相机设备`);
      return {
        available: supportedCameras.length > 0,
        cameraCount: supportedCameras.length,
        cameras: supportedCameras.map((device: camera.CameraDevice): CameraProbeDevice => ({
          position: this.getCameraPositionString(device.cameraPosition),
          type: this.getCameraTypeString(device.cameraType)
        }))
      };
    } catch (err) {
      const error = err as BusinessError;
      console.error(`[CameraModel] 初始化失败: ${error.code} - ${error.message}`);
      return { available: false, cameraCount: 0, cameras: [], error: `Init failed: ${error.code}` };
    }
  }

  async startPreview(context: common.UIAbilityContext, surfaceId: string): Promise<CameraPreviewSummary> {
    if (surfaceId.length === 0) {
      return this.previewFailure('Preview surface unavailable');
    }
    if (this.previewStarting) {
      return this.previewFailure('Preview start in progress');
    }

    this.previewStarting = true;
    this.startGeneration = this.startGeneration + 1;
    const generation: number = this.startGeneration;
    this.context = context;

    try {
      await this.releaseCameraResources();
      if (generation !== this.startGeneration) {
        return this.previewFailure('Preview start cancelled');
      }

      const granted: boolean = await this.requestCameraPermission(context);
      if (generation !== this.startGeneration) {
        await this.releaseCameraResources();
        return this.previewFailure('Preview start cancelled');
      }
      if (!granted) {
        return this.previewFailure('Permission denied');
      }

      this.cameraManager = camera.getCameraManager(context);
      const devices: camera.CameraDevice[] = this.cameraManager.getSupportedCameras();
      if (devices.length === 0) {
        return this.previewFailure('No camera');
      }

      const device: camera.CameraDevice = devices[0];
      const capability: camera.CameraOutputCapability = this.cameraManager.getSupportedOutputCapability(
        device,
        camera.SceneMode.NORMAL_PHOTO
      );
      if (capability.previewProfiles.length === 0) {
        return this.previewFailure('No preview profile');
      }

      const previewProfile: camera.Profile = this.selectPreviewProfile(capability.previewProfiles);
      this.cameraInput = this.cameraManager.createCameraInput(device);
      await this.cameraInput.open();
      if (generation !== this.startGeneration) {
        await this.releaseCameraResources();
        return this.previewFailure('Preview start cancelled');
      }
      this.previewOutput = this.cameraManager.createPreviewOutput(previewProfile, surfaceId);
      // 方向在页面的 XComponent 外层处理，不要在这里调 PreviewOutput.setPreviewRotation：
      // 这个会话上设了会报 7400201 Invalid Session Configuration。

      if (capability.photoProfiles.length > 0) {
        const photoProfile: camera.Profile = capability.photoProfiles[0];
        this.photoOutput = this.cameraManager.createPhotoOutput(photoProfile);
        this.photoOutput.on('photoAvailable', (err: BusinessError, photo: camera.Photo): void => {
          this.savePhoto(err, photo);
        });
      }

      this.photoSession = this.cameraManager.createSession<camera.PhotoSession>(camera.SceneMode.NORMAL_PHOTO);
      this.photoSession.beginConfig();
      if (!this.photoSession.canAddInput(this.cameraInput)) {
        throw new Error('Camera input is not supported by the photo session');
      }
      this.photoSession.addInput(this.cameraInput);
      if (!this.photoSession.canAddOutput(this.previewOutput)) {
        throw new Error('Preview output is not supported by the photo session');
      }
      this.photoSession.addOutput(this.previewOutput);

      if (this.photoOutput !== null) {
        if (this.photoSession.canAddOutput(this.photoOutput)) {
          this.photoSession.addOutput(this.photoOutput);
        } else {
          await this.photoOutput.release();
          this.photoOutput = null;
        }
      }

      await this.photoSession.commitConfig();
      if (generation !== this.startGeneration) {
        await this.releaseCameraResources();
        return this.previewFailure('Preview start cancelled');
      }
      await this.photoSession.start();
      if (generation !== this.startGeneration) {
        await this.releaseCameraResources();
        return this.previewFailure('Preview start cancelled');
      }
      this.previewRunning = true;
      console.info(`[CameraModel] 预览已启动 ${previewProfile.size.width}x${previewProfile.size.height}`);
      return {
        available: true,
        position: this.getCameraPositionString(device.cameraPosition),
        width: previewProfile.size.width,
        height: previewProfile.size.height,
        photoAvailable: this.photoOutput !== null
      };
    } catch (err) {
      const error = err as BusinessError;
      console.error(`[CameraModel] 预览启动失败: ${error.code} - ${error.message}`);
      await this.releaseCameraResources();
      return this.previewFailure(`Preview failed: ${error.code}`);
    } finally {
      this.previewStarting = false;
    }
  }

  async takePhoto(): Promise<boolean> {
    if (!this.previewRunning || this.photoOutput === null || this.capturePending) {
      return false;
    }

    this.capturePending = true;
    this.captureTimeoutId = setTimeout(() => {
      this.captureTimeoutId = -1;
      if (this.capturePending) {
        this.capturePending = false;
        this.notifyPhotoResult({ success: false, fileName: '', bytes: 0, error: 'Capture timed out' });
      }
    }, 8000);
    try {
      await this.photoOutput.capture();
      console.info('[CameraModel] 拍照请求已提交');
      return true;
    } catch (err) {
      const error = err as BusinessError;
      this.clearCaptureTimeout();
      this.capturePending = false;
      console.error(`[CameraModel] 拍照失败: ${error.code} - ${error.message}`);
      this.notifyPhotoResult({ success: false, fileName: '', bytes: 0, error: `Capture failed: ${error.code}` });
      return false;
    }
  }

  private async savePhoto(err: BusinessError, photo: camera.Photo): Promise<void> {
    this.clearCaptureTimeout();
    if (err) {
      console.error(`[CameraModel] 照片回调失败: ${err.code} - ${err.message}`);
      this.capturePending = false;
      this.notifyPhotoResult({ success: false, fileName: '', bytes: 0, error: `Photo failed: ${err.code}` });
      return;
    }

    let outputFile: fs.File | null = null;
    let outputPath: string = '';
    let saved: boolean = false;
    try {
      if (this.context === null) {
        throw new Error('Camera context unavailable');
      }

      const component: image.Component = await photo.main.getComponent(image.ComponentType.JPEG);
      const fileName: string = `eldercare-${Date.now()}.jpg`;
      const path: string = `${this.context.filesDir}/${fileName}`;
      outputPath = path;
      outputFile = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      const written: number = fs.writeSync(outputFile.fd, component.byteBuffer);
      fs.fsyncSync(outputFile.fd);
      if (written !== component.byteBuffer.byteLength) {
        throw new Error('Incomplete photo write');
      }

      try {
        fs.closeSync(outputFile);
      } catch (closeErr) {
        console.warn('[CameraModel] 照片文件关闭失败');
      }
      outputFile = null;
      saved = true;
      try {
        this.cleanupPrivatePhotos(fileName);
      } catch (cleanupErr) {
        console.warn('[CameraModel] 私有照片清理异常，已保存照片不受影响');
      }

      console.info(`[CameraModel] 照片已保存 ${fileName}, ${written} bytes`);
      this.notifyPhotoResult({ success: true, fileName: fileName, bytes: written });
    } catch (saveErr) {
      const error = saveErr as BusinessError;
      if (outputFile !== null) {
        try {
          fs.closeSync(outputFile);
        } catch (closeErr) {
          console.warn('[CameraModel] 失败照片文件关闭失败');
        }
        outputFile = null;
      }
      if (!saved && outputPath.length > 0) {
        try {
          fs.unlinkSync(outputPath);
        } catch (unlinkErr) {
          console.warn('[CameraModel] 未完整照片清理失败');
        }
      }
      console.error(`[CameraModel] 照片保存失败: ${error.code} - ${error.message}`);
      this.notifyPhotoResult({ success: false, fileName: '', bytes: 0, error: `Save failed: ${error.code}` });
    } finally {
      if (outputFile !== null) {
        try {
          fs.closeSync(outputFile);
        } catch (closeErr) {
          console.warn('[CameraModel] 照片文件关闭失败');
        }
      }
      try {
        await photo.main.release();
      } catch (releaseErr) {
        console.warn('[CameraModel] 照片对象释放失败');
      }
      this.capturePending = false;
    }
  }

  private cleanupPrivatePhotos(protectedName: string): void {
    if (this.context === null) {
      return;
    }
    const filesDir: string = this.context.filesDir;
    try {
      const entries: PrivatePhotoEntry[] = [];
      const names: string[] = fs.listFileSync(filesDir);
      names.forEach((fileName: string): void => {
        if (!isPrivatePhotoName(fileName)) {
          return;
        }
        try {
          const path: string = `${filesDir}/${fileName}`;
          const stat: fs.Stat = fs.statSync(path);
          if (stat.isFile()) {
            entries.push({ fileName: fileName, mtimeSeconds: stat.mtime });
          }
        } catch (statErr) {
          console.warn(`[CameraModel] 跳过无法读取的私有照片 ${fileName}`);
        }
      });

      const deletions: string[] = selectPrivatePhotosToDelete(
        entries, protectedName, PHOTO_MAX_COUNT);
      deletions.forEach((fileName: string): void => {
        if (fileName === protectedName || !isPrivatePhotoName(fileName)) {
          return;
        }
        try {
          fs.unlinkSync(`${filesDir}/${fileName}`);
        } catch (unlinkErr) {
          console.warn(`[CameraModel] 私有照片清理失败 ${fileName}`);
        }
      });
      if (deletions.length > 0) {
        console.info(`[CameraModel] 已清理 ${deletions.length} 张过期私有照片`);
      }
    } catch (listErr) {
      console.warn('[CameraModel] 私有照片目录清理跳过');
    }
  }

  private clearCaptureTimeout(): void {
    if (this.captureTimeoutId !== -1) {
      clearTimeout(this.captureTimeoutId);
      this.captureTimeoutId = -1;
    }
  }

  private notifyPhotoResult(result: CameraPhotoResult): void {
    if (this.photoResultListener !== null) {
      this.photoResultListener(result);
    }
  }

  private selectPreviewProfile(profiles: camera.Profile[]): camera.Profile {
    const targetWidth: number = 640;
    const targetHeight: number = 480;
    const targetAspect: number = targetWidth / targetHeight;
    const targetPixels: number = targetWidth * targetHeight;
    let selected: camera.Profile = profiles[0];
    let selectedAspectDistance: number = Math.abs(selected.size.width / selected.size.height - targetAspect);
    let selectedPixelDistance: number = Math.abs(selected.size.width * selected.size.height - targetPixels);
    for (let index = 1; index < profiles.length; index++) {
      const current: camera.Profile = profiles[index];
      const aspectDistance: number = Math.abs(current.size.width / current.size.height - targetAspect);
      const pixelDistance: number = Math.abs(current.size.width * current.size.height - targetPixels);
      if (aspectDistance < selectedAspectDistance ||
        (aspectDistance === selectedAspectDistance && pixelDistance < selectedPixelDistance)) {
        selected = current;
        selectedAspectDistance = aspectDistance;
        selectedPixelDistance = pixelDistance;
      }
    }
    return selected;
  }

  private previewFailure(error: string): CameraPreviewSummary {
    return { available: false, position: 'UNSPECIFIED', width: 0, height: 0, photoAvailable: false, error: error };
  }

  private async requestCameraPermission(requestContext: common.UIAbilityContext | null = this.context): Promise<boolean> {
    if (requestContext === null) {
      return false;
    }

    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const permission: Permissions = 'ohos.permission.CAMERA';
      const grantStatus = await atManager.checkAccessToken(
        requestContext.applicationInfo.accessTokenId,
        permission
      );
      if (grantStatus === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        return true;
      }

      const result = await atManager.requestPermissionsFromUser(requestContext, [permission]);
      return result.authResults[0] === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    } catch (err) {
      const error = err as BusinessError;
      console.error(`[CameraModel] 权限请求失败: ${error.code} - ${error.message}`);
      return false;
    }
  }

  private getCameraPositionString(position: camera.CameraPosition): string {
    switch (position) {
      case camera.CameraPosition.CAMERA_POSITION_FRONT:
        return 'FRONT';
      case camera.CameraPosition.CAMERA_POSITION_BACK:
        return 'BACK';
      default:
        return 'UNSPECIFIED';
    }
  }

  private getCameraTypeString(type: camera.CameraType): string {
    switch (type) {
      case camera.CameraType.CAMERA_TYPE_WIDE_ANGLE:
        return 'WIDE_ANGLE';
      case camera.CameraType.CAMERA_TYPE_ULTRA_WIDE:
        return 'ULTRA_WIDE';
      case camera.CameraType.CAMERA_TYPE_TELEPHOTO:
        return 'TELEPHOTO';
      case camera.CameraType.CAMERA_TYPE_TRUE_DEPTH:
        return 'TRUE_DEPTH';
      default:
        return 'UNSPECIFIED';
    }
  }

  private async releaseCameraResources(): Promise<void> {
    this.clearCaptureTimeout();
    this.capturePending = false;
    this.previewRunning = false;

    if (this.photoSession !== null) {
      try {
        await this.photoSession.stop();
      } catch (err) {
        console.warn('[CameraModel] 会话停止时已非运行状态');
      }
    }
    if (this.photoOutput !== null) {
      try {
        this.photoOutput.off('photoAvailable');
        await this.photoOutput.release();
      } catch (err) {
        console.warn('[CameraModel] 拍照输出释放失败');
      }
      this.photoOutput = null;
    }
    if (this.previewOutput !== null) {
      try {
        await this.previewOutput.release();
      } catch (err) {
        console.warn('[CameraModel] 预览输出释放失败');
      }
      this.previewOutput = null;
    }
    if (this.photoSession !== null) {
      try {
        await this.photoSession.release();
      } catch (err) {
        console.warn('[CameraModel] 会话释放失败');
      }
      this.photoSession = null;
    }
    if (this.cameraInput !== null) {
      try {
        await this.cameraInput.close();
      } catch (err) {
        console.warn('[CameraModel] 相机输入关闭失败');
      }
      this.cameraInput = null;
    }
    this.cameraManager = null;
  }

  async release(): Promise<void> {
    this.startGeneration = this.startGeneration + 1;
    await this.releaseCameraResources();
    this.context = null;
    console.info('[CameraModel] 资源已释放');
  }
}
