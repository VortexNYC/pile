interface CaptureDisplayMediaStreamOptions extends DisplayMediaStreamOptions {
  monitorTypeSurfaces?: "exclude" | "include";
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "exclude" | "include";
  surfaceSwitching?: "exclude" | "include";
  systemAudio?: "exclude" | "include";
}

const CAPTURE_FRAME_SETTLE_DELAY_MS = 120;
const CAPTURE_FRAME_SETTLE_COUNT = 2;
const RECORDING_AUDIO_BITS_PER_SECOND = 64_000;
const RECORDING_VIDEO_BITS_PER_SECOND = 550_000;

function createDisplayStreamOptions(
  audio: boolean
): CaptureDisplayMediaStreamOptions {
  return {
    video: { frameRate: 30, displaySurface: "browser" },
    audio,
    monitorTypeSurfaces: "exclude",
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
    systemAudio: audio ? "include" : "exclude",
  };
}

export async function requestDisplayStream(
  audio: boolean
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not support screen capture.");
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia(
      createDisplayStreamOptions(audio)
    );
  } catch (error) {
    if (!audio) {
      throw error;
    }
    return navigator.mediaDevices.getDisplayMedia(
      createDisplayStreamOptions(false)
    );
  }
}

export function assertBrowserTabSurface(stream: MediaStream): void {
  const track = stream.getVideoTracks()[0];
  const displaySurface = track?.getSettings().displaySurface;
  if (displaySurface === "browser") {
    return;
  }
  for (const currentTrack of stream.getTracks()) {
    currentTrack.stop();
  }
  throw new Error(
    "Please choose the current browser tab. Window and full-screen capture are not supported."
  );
}

const waitForTrackReadable = (track: MediaStreamTrack | undefined) =>
  new Promise<void>((resolve) => {
    if (!track) {
      resolve();
      return;
    }
    if (track.readyState === "live") {
      resolve();
      return;
    }
    track.addEventListener("unmute", () => resolve(), { once: true });
    setTimeout(resolve, 1000);
  });

const waitForVideoMetadata = (video: HTMLVideoElement) =>
  new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener(
      "error",
      () => reject(new Error("Failed to load capture video.")),
      { once: true }
    );
    setTimeout(() => resolve(), 1500);
  });

const waitForSettledVideoFrames = (video: HTMLVideoElement) =>
  new Promise<void>((resolve) => {
    let settledFrames = 0;
    const step = () => {
      settledFrames += 1;
      if (settledFrames >= CAPTURE_FRAME_SETTLE_COUNT) {
        resolve();
        return;
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(step);
        return;
      }
      setTimeout(step, CAPTURE_FRAME_SETTLE_DELAY_MS);
    };
    step();
  });

export async function prepareCaptureVideo(
  video: HTMLVideoElement,
  stream: MediaStream
): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await waitForTrackReadable(stream.getVideoTracks()[0]);
  await waitForVideoMetadata(video);
  await video.play();
  await waitForSettledVideoFrames(video);
}

export function releaseCaptureVideo(video: HTMLVideoElement): void {
  video.pause();
  video.srcObject = null;
}

export function resolveRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

const canvasToBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to render screenshot blob."));
          return;
        }
        resolve(blob);
      },
      type,
      1
    );
  });

/**
 * Takes a screenshot of the current tab itself via a one-frame
 * getDisplayMedia grab — prompts the user for the tab, then draws the
 * settled frame onto a canvas.
 */
export async function captureScreenshot(): Promise<Blob> {
  const stream = await requestDisplayStream(false);
  assertBrowserTabSurface(stream);
  const video = document.createElement("video");
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error("No video track available for screenshot capture.");
    }
    await prepareCaptureVideo(video, stream);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!(width > 0 && height > 0)) {
      throw new Error("Captured screen dimensions were invalid.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to initialize screenshot canvas.");
    }
    context.drawImage(video, 0, 0, width, height);
    return await canvasToBlob(canvas, "image/png");
  } finally {
    releaseCaptureVideo(video);
    for (const currentTrack of stream.getTracks()) {
      currentTrack.stop();
    }
  }
}

export interface RecordingController {
  startedAt: number;
  stop(): Promise<{ blob: Blob; durationMs: number }>;
  stream: MediaStream;
}

export async function startDisplayRecording(): Promise<RecordingController> {
  const stream = await requestDisplayStream(true);
  assertBrowserTabSurface(stream);
  const warmupVideo = document.createElement("video");
  await prepareCaptureVideo(warmupVideo, stream);
  releaseCaptureVideo(warmupVideo);

  const mimeType = resolveRecordingMimeType();
  const recorderOptions: MediaRecorderOptions =
    mimeType.length > 0
      ? {
          audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
          mimeType,
          videoBitsPerSecond: RECORDING_VIDEO_BITS_PER_SECOND,
        }
      : {
          audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
          videoBitsPerSecond: RECORDING_VIDEO_BITS_PER_SECOND,
        };
  const recorder = new MediaRecorder(stream, recorderOptions);
  const startedAt = Date.now();
  const chunks: Blob[] = [];

  let resolveStop:
    | ((value: { blob: Blob; durationMs: number }) => void)
    | null = null;
  let rejectStop: ((reason?: unknown) => void) | null = null;
  const stopPromise = new Promise<{ blob: Blob; durationMs: number }>(
    (resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    }
  );

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  recorder.addEventListener(
    "stop",
    () => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      resolveStop?.({
        blob: new Blob(chunks, { type: mimeType || "video/webm" }),
        durationMs: Date.now() - startedAt,
      });
    },
    { once: true }
  );
  recorder.addEventListener(
    "error",
    (event) => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      rejectStop?.(event);
    },
    { once: true }
  );
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  });

  recorder.start(1000);
  return {
    startedAt,
    stream,
    stop: () => {
      if (recorder.state === "inactive") {
        return stopPromise;
      }
      recorder.stop();
      return stopPromise;
    },
  };
}
