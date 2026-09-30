import type { ContentReply, WorkerToContent } from "../shared/messages";
import type { PageSnapshot } from "../shared/types";
import { indexPage, resolveIndex } from "./indexer";
import { classifyPage } from "./classifier";
import { controlMedia, hasPlayableMedia, mediaState } from "./media";
import { waitUntil } from "./waiters";
import { textDigest, toMarkdown, transcript } from "./extract";
import { clearOverlay, drawOverlay } from "./overlay";

function snapshot(startIndex: number, frameId: number, wantText: boolean): PageSnapshot {
  const elements = indexPage(frameId, startIndex);
  const digest = textDigest(wantText ? 6000 : 1500);
  return {
    url: location.href,
    title: document.title,
    pageType: classifyPage(digest, hasPlayableMedia()),
    elements,
    media: mediaState(),
    textDigest: digest,
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
    },
    at: Date.now(),
  };
}

function setValue(index: number, value: string, kind: "select" | "check"): ContentReply {
  const el = resolveIndex(index);
  if (!el) return { ok: false, error: `index ${index} is no longer on the page` };
  if (kind === "select" && el instanceof HTMLSelectElement) {
    const match =
      Array.from(el.options).find((o) => o.value === value) ??
      Array.from(el.options).find((o) => o.text.trim() === value.trim());
    if (!match) return { ok: false, error: `no option matching "${value}"` };
    el.value = match.value;
  } else if (kind === "check" && el instanceof HTMLInputElement) {
    el.checked = value === "true";
  } else {
    return { ok: false, error: `element ${index} is a ${el.tagName}, not a ${kind}` };
  }
  // Frameworks listen for these rather than reading .value directly.
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, kind: "void" };
}

chrome.runtime.onMessage.addListener(
  (msg: WorkerToContent, _sender, respond: (reply: ContentReply) => void) => {
    try {
      switch (msg.type) {
        case "snapshot":
          respond({
            ok: true,
            kind: "snapshot",
            snapshot: snapshot(msg.startIndex, msg.frameId, msg.wantText),
          });
          return false;

        case "wait_until":
          waitUntil(msg.condition, msg.timeoutMs).then((r) =>
            respond({ ok: true, kind: "wait", met: r.met, detail: r.detail }),
          );
          return true; // async

        case "media":
          // A media op reports what the player actually did - a clamped rate, a
          // forced mute - rather than just succeeding, so the agent plans its
          // wait against reality.
          controlMedia(msg.op, msg.rate).then((r) =>
            respond({ ok: true, kind: "media", applied: r.ok, detail: r.detail }),
          );
          return true;

        case "extract":
          respond({
            ok: true,
            kind: "text",
            text: msg.what === "transcript" ? transcript() : toMarkdown(),
          });
          return false;

        case "overlay":
          if (msg.show) drawOverlay(indexPage(0, 0));
          else clearOverlay();
          respond({ ok: true, kind: "void" });
          return false;

        case "resolve_index":
          respond(
            resolveIndex(msg.index)
              ? { ok: true, kind: "void" }
              : { ok: false, error: `index ${msg.index} not found` },
          );
          return false;

        case "set_value":
          respond(setValue(msg.index, msg.value, msg.kind));
          return false;
      }
    } catch (err) {
      respond({ ok: false, error: String(err) });
    }
    return false;
  },
);
