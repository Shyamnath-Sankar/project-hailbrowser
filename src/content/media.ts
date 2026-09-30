import type { MediaState } from "../shared/types";

/** Picks the most plausible lesson video: the largest visible media element. */
export function findMedia(): HTMLMediaElement | null {
  const all = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"));
  let best: HTMLMediaElement | null = null;
  let bestScore = -1;
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    // An audio element has no box, so give it a nominal score above zero.
    const score = el.tagName === "AUDIO" ? 1 : rect.width * rect.height;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function mediaState(): MediaState | undefined {
  const el = findMedia();
  if (!el) return undefined;
  return {
    present: true,
    playing: !el.paused && !el.ended,
    muted: el.muted || el.volume === 0,
    currentTime: Math.round(el.currentTime),
    duration: Number.isFinite(el.duration) ? Math.round(el.duration) : 0,
    rate: el.playbackRate,
  };
}

export interface MediaOutcome {
  ok: boolean;
  /** What actually happened, including any value the player overrode. */
  detail: string;
  state?: MediaState;
}

/**
 * Turns on captions when the player exposes a text track. Two reasons: some
 * platforms only count a lesson as watched with captions rendered, and a showing
 * track populates `cues`, which is where the transcript extractor reads from.
 */
function enableCaptions(el: HTMLMediaElement): boolean {
  let enabled = false;
  for (const track of Array.from(el.textTracks)) {
    if (track.kind !== "subtitles" && track.kind !== "captions") continue;
    if (track.mode === "showing") {
      enabled = true;
      continue;
    }
    // "hidden" still populates cues without drawing them over the video.
    track.mode = enabled ? "hidden" : "showing";
    enabled = true;
  }
  return enabled;
}

/**
 * Jumps to the end of the video rather than watching it.
 *
 * Lands just short of the end and lets playback run out, so the player's own
 * `ended` handling fires the way it would after a real view. A hard jump to
 * `duration` often sets the position without ever firing `ended`, and it is the
 * `ended` handler that marks most lessons complete.
 */
async function seekToEnd(el: HTMLMediaElement): Promise<MediaOutcome> {
  const duration = el.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      ok: false,
      detail:
        "duration is unknown (a live stream, or metadata has not loaded yet) so this video cannot be skipped - watch it instead",
      state: mediaState(),
    };
  }

  // A player that restricts seeking ahead of watched content advertises it here.
  let reachable = 0;
  for (let i = 0; i < el.seekable.length; i++) {
    reachable = Math.max(reachable, el.seekable.end(i));
  }
  if (reachable > 0 && reachable < duration - 2) {
    return {
      ok: false,
      detail: `the player only allows seeking to ${Math.round(reachable)}s of ${Math.round(duration)}s, so this video cannot be skipped - watch it instead`,
      state: mediaState(),
    };
  }

  const target = Math.max(duration - 0.4, 0);
  el.currentTime = target;

  // Playing out the last fraction is what fires `ended`.
  try {
    await el.play();
  } catch {
    el.muted = true;
    try {
      await el.play();
    } catch {
      // Autoplay is fully blocked. The seek may still stand on its own.
    }
  }

  const ended = await new Promise<boolean>((resolve) => {
    if (el.ended) {
      resolve(true);
      return;
    }
    const done = (): void => {
      clearInterval(poll);
      clearTimeout(cap);
      el.removeEventListener("ended", onEnded);
      resolve(el.ended || el.currentTime >= duration - 1);
    };
    const onEnded = (): void => done();
    el.addEventListener("ended", onEnded, { once: true });
    // Watch for a player that yanks the position back to where it was.
    const poll = setInterval(() => {
      if (el.currentTime < target - 5) done();
    }, 200);
    const cap = setTimeout(done, 4000);
  });

  const state = mediaState();
  if (ended) {
    return {
      ok: true,
      // The agent still has to confirm the lesson registered: reaching the end
      // of the element is not the same as the platform crediting the view.
      detail: `skipped to the end (${Math.round(duration)}s). Now confirm the lesson itself shows complete - a player reaching its end is not proof the platform counted it.`,
      state,
    };
  }

  if (state && state.currentTime < target - 5) {
    return {
      ok: false,
      detail: `the player pulled playback back to ${state.currentTime}s, so it blocks skipping - watch this video instead`,
      state,
    };
  }

  return {
    ok: false,
    detail: `seeked to ${state?.currentTime ?? "?"}s but the video never reported ending, so the lesson probably was not credited - watch it instead`,
    state,
  };
}

export async function controlMedia(
  op: "play" | "pause" | "unmute" | "rate" | "captions" | "seek_end",
  rate?: number,
): Promise<MediaOutcome> {
  const el = findMedia();
  if (!el) return { ok: false, detail: "no media element in this frame" };

  try {
    switch (op) {
      case "play": {
        if (el.ended) {
          return { ok: true, detail: "video had already ended", state: mediaState() };
        }
        try {
          await el.play();
        } catch {
          // Autoplay policy blocks an unmuted play in a tab that has had no
          // user gesture. Muting is the documented way through; the agent is
          // told so it can unmute if the site requires audio.
          el.muted = true;
          await el.play();
          return {
            ok: true,
            detail: "played, but autoplay policy forced it muted - unmute if this lesson needs audio",
            state: mediaState(),
          };
        }
        return { ok: true, detail: "playing", state: mediaState() };
      }

      case "pause":
        el.pause();
        return { ok: true, detail: "paused", state: mediaState() };

      case "unmute": {
        el.muted = false;
        if (el.volume === 0) el.volume = 1;
        // Some players re-apply their own mute asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stillMuted = el.muted || el.volume === 0;
        return {
          ok: !stillMuted,
          detail: stillMuted ? "the player re-muted itself" : "unmuted",
          state: mediaState(),
        };
      }

      case "rate": {
        const want = rate ?? 1;
        el.playbackRate = want;
        await new Promise((resolve) => setTimeout(resolve, 150));
        const got = el.playbackRate;
        // Players commonly clamp to their own maximum or snap back to 1. Report
        // the real value so the agent's wait timeout matches reality.
        return {
          ok: true,
          detail:
            Math.abs(got - want) < 0.01
              ? `playback rate is ${got}x`
              : `asked for ${want}x but the player is at ${got}x`,
          state: mediaState(),
        };
      }

      case "captions": {
        const on = enableCaptions(el);
        return {
          ok: on,
          detail: on ? "captions enabled" : "this player exposes no caption track",
          state: mediaState(),
        };
      }

      case "seek_end": {
        if (el.ended) {
          return { ok: true, detail: "video had already ended", state: mediaState() };
        }
        // Captions first: a transcript is the only notes source left once the
        // video is not actually being watched.
        enableCaptions(el);
        return await seekToEnd(el);
      }
    }
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 200) };
  }
}

/** True when the page shows a video the agent should treat as the main content. */
export function hasPlayableMedia(): boolean {
  const el = findMedia();
  if (!el) return false;
  if (el.tagName === "AUDIO") return true;
  const rect = el.getBoundingClientRect();
  return rect.width > 200 && rect.height > 120;
}
