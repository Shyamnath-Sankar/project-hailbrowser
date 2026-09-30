import type { ContentReply, WorkerToContent } from "../shared/messages";
import type { IndexedElement, PageSnapshot } from "../shared/types";

/**
 * Talks to the content scripts. Each frame indexes itself into a distinct index
 * range, and the results merge into one list so the model sees unique indices
 * across the whole page, iframes included.
 */

const FRAME_STRIDE = 1000;

export async function sendToFrame(
  tabId: number,
  frameId: number,
  msg: WorkerToContent,
): Promise<ContentReply> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, msg, { frameId })) as
      | ContentReply
      | undefined;
    return reply ?? { ok: false, error: "no reply from content script" };
  } catch (err) {
    // A frame can navigate away mid-call, or have no content script (chrome://).
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

/** Frame that owns a merged index, so actions go to the right content script. */
export const frameOf = (element: IndexedElement): number => element.frameId;

async function listFrames(tabId: number): Promise<number[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) return [0];
    return frames
      .filter((f) => f.url.startsWith("http") || f.frameId === 0)
      .map((f) => f.frameId)
      .slice(0, 8);
  } catch {
    return [0];
  }
}

/**
 * Snapshots the page. The main frame supplies url/title/type; child frames only
 * contribute their interactive elements.
 */
export async function captureSnapshot(tabId: number, wantText: boolean): Promise<PageSnapshot> {
  const frames = await listFrames(tabId);
  const ordered = [0, ...frames.filter((f) => f !== 0)];

  const replies = await Promise.all(
    ordered.map((frameId, i) =>
      sendToFrame(tabId, frameId, {
        type: "snapshot",
        wantText,
        frameId,
        startIndex: i * FRAME_STRIDE,
      }).then((reply) => ({ frameId, reply })),
    ),
  );

  let main: PageSnapshot | undefined;
  const elements: IndexedElement[] = [];
  let mediaFrameId: number | undefined;

  for (const { frameId, reply } of replies) {
    if (!reply.ok || reply.kind !== "snapshot") continue;
    if (frameId === 0) {
      main = reply.snapshot;
      if (reply.snapshot.media?.present) mediaFrameId = 0;
    }
    elements.push(...reply.snapshot.elements);
    // A child frame holding the video is the norm on course platforms.
    if (frameId !== 0 && reply.snapshot.media?.present && mediaFrameId === undefined) {
      mediaFrameId = frameId;
      if (main && !main.media?.present) {
        main = { ...main, media: reply.snapshot.media, pageType: "video" };
      }
    }
  }

  if (!main) {
    // The main frame has no content script (a chrome:// page, the web store, or
    // a PDF viewer). Report what the tab API knows so the model can navigate away.
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    return {
      url: tab?.url ?? "unknown",
      title: tab?.title ?? "",
      pageType: "unknown",
      elements: [],
      textDigest:
        "This page cannot be inspected or acted on by the extension (browser-internal page, extension gallery, or a PDF). Navigate to a normal web page to continue.",
      scroll: { y: 0, height: 0 },
      at: Date.now(),
    };
  }

  return { ...main, elements, mediaFrameId };
}

/** Stable fingerprint of page state, used by the stuck detector. */
export function snapshotFingerprint(snapshot: PageSnapshot): string {
  const labels = snapshot.elements
    .slice(0, 40)
    .map((el) => `${el.index}:${el.label.slice(0, 24)}`)
    .join("|");
  const mediaBucket = snapshot.media
    ? `${Math.floor(snapshot.media.currentTime / 15)}`
    : "-";
  return [
    snapshot.url,
    snapshot.pageType,
    Math.floor(snapshot.scroll.y / 200),
    mediaBucket,
    labels,
  ].join("#");
}
