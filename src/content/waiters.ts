import type { WaitCondition } from "../shared/types";
import { findMedia } from "./media";
import { resolveIndex } from "./indexer";

export interface WaitOutcome {
  met: boolean;
  detail: string;
}

/**
 * Polls a condition inside the page. This is what makes long waits free: a
 * 20-minute video costs zero model calls because nothing leaves the frame until
 * the condition flips.
 */
export function waitUntil(condition: WaitCondition, timeoutMs: number): Promise<WaitOutcome> {
  const startUrl = location.href;
  const deadline = Date.now() + timeoutMs;

  // Progress tracking for video_ended. A video that stops advancing is the
  // common real-world case (an overlay, an ad, a buffering failure), and
  // noticing it in 45 seconds beats burning a 20-minute timeout to learn the
  // same thing.
  const stallMs = Math.max(((condition as { stallSeconds?: number }).stallSeconds ?? 45) * 1000, 5000);
  let lastTime = -1;
  let lastProgressAt = Date.now();

  const describeMedia = (): string => {
    const el = findMedia();
    if (!el) return "";
    const duration = Number.isFinite(el.duration) ? Math.round(el.duration) : 0;
    return ` (at ${Math.round(el.currentTime)}/${duration}s, ${el.paused ? "paused" : "playing"}${
      el.muted ? ", muted" : ""
    })`;
  };

  const satisfied = (): boolean => {
    switch (condition.type) {
      case "video_ended": {
        const el = findMedia();
        if (!el) return false;
        if (el.ended) return true;
        // Some players stop a beat short of duration and never fire `ended`.
        return el.duration > 0 && el.duration - el.currentTime < 1.5 && el.paused;
      }
      case "url_changed":
        return location.href !== (condition.from ?? startUrl);
      case "selector_visible": {
        const el = document.querySelector(condition.selector);
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      }
      case "selector_gone":
        return document.querySelector(condition.selector) === null;
      case "text_present":
        return (document.body?.innerText ?? "").includes(condition.text);
      case "element_enabled": {
        const el = resolveIndex(condition.index);
        if (!el) return false;
        return !(el as HTMLButtonElement).disabled;
      }
    }
  };

  return new Promise((resolve) => {
    if (satisfied()) {
      resolve({ met: true, detail: `${condition.type} was already true` });
      return;
    }

    const timer = setInterval(() => {
      let done = false;
      try {
        done = satisfied();
      } catch {
        // A detached node or a cross-origin player can throw mid-wait; keep going.
      }

      if (done) {
        clearInterval(timer);
        resolve({ met: true, detail: `${condition.type} met${describeMedia()}` });
        return;
      }

      if (condition.type === "video_ended") {
        const el = findMedia();
        if (!el) {
          clearInterval(timer);
          resolve({ met: false, detail: "the video element disappeared while waiting" });
          return;
        }
        // Round to whole seconds so sub-second jitter does not read as progress.
        const now = Math.floor(el.currentTime);
        if (now !== lastTime) {
          lastTime = now;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > stallMs) {
          clearInterval(timer);
          const secs = Math.round((Date.now() - lastProgressAt) / 1000);
          resolve({
            met: false,
            detail: `playback has not advanced for ${secs}s${describeMedia()} - something is blocking the player (an overlay, an ad, a buffering failure, or a click-to-continue prompt). Snapshot the page, clear it, then resume playback.`,
          });
          return;
        }
      }

      if (Date.now() > deadline) {
        clearInterval(timer);
        resolve({
          met: false,
          detail: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${condition.type}${describeMedia()}`,
        });
      }
    }, 700);
  });
}
