import { publicUrl } from "../utils/assetUrl";

const MAX_IDLE_MS = 10_000;

/** Starts the opening only after the loader has gone and releases the decoder when it ends. */
export function playBootIntro(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const listeners = new AbortController();
    let timer = 0;
    let lastTime = 0;
    const finish = (): void => {
      if (listeners.signal.aborted) return;
      listeners.abort();
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      video.pause();
      video.removeAttribute("src");
      video.load();
      resolve();
    };
    const waitForProgress = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(finish, MAX_IDLE_MS);
    };
    const options = { signal: listeners.signal };
    signal.addEventListener("abort", finish, { once: true });
    video.addEventListener("ended", finish, options);
    video.addEventListener("error", finish, options);
    video.addEventListener("timeupdate", () => {
      if (video.currentTime > lastTime) {
        lastTime = video.currentTime;
        waitForProgress();
      }
    }, options);
    video.loop = false;
    video.src = publicUrl("assets/ui/cinematic/intro.mp4");
    waitForProgress();
    void video.play().catch(finish);
  });
}
