/** Turns the page into compact text the model can actually read. */

const DROP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "NAV", "FOOTER", "IFRAME"]);

function pickMain(): Element {
  const candidates = ["main", "[role=main]", "article", "#content", ".content"];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && (el as HTMLElement).innerText?.trim().length > 200) return el;
  }
  return document.body ?? document.documentElement;
}

/** Visible text, collapsed, for the snapshot digest and the classifier. */
export function textDigest(limit = 6000): string {
  const root = pickMain();
  const parts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || DROP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue?.trim();
      if (!text) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let total = 0;
  while (walker.nextNode() && total < limit) {
    const text = walker.currentNode.nodeValue!.replace(/\s+/g, " ").trim();
    parts.push(text);
    total += text.length + 1;
  }
  return parts.join(" ").slice(0, limit);
}

/** Heading-aware markdown, used when the agent needs to read a lesson closely. */
export function toMarkdown(limit = 12000): string {
  const root = pickMain();
  const lines: string[] = [];
  const visit = (el: Element) => {
    if (DROP.has(el.tagName)) return;
    const tag = el.tagName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      const text = (el as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      if (text) lines.push(`${"#".repeat(Number(heading[1]))} ${text}`);
      return;
    }
    if (tag === "li") {
      const text = (el as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      if (text) lines.push(`- ${text}`);
      return;
    }
    if (tag === "p" || tag === "blockquote") {
      const text = (el as HTMLElement).innerText.replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
      return;
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(root);
  const joined = lines.join("\n\n");
  return (joined.trim() ? joined : textDigest(limit)).slice(0, limit);
}

/**
 * Pulls a transcript from whatever the page exposes: an open transcript panel,
 * WebVTT text tracks, or caption cues already loaded by the player.
 */
export function transcript(limit = 20000): string {
  const panelSelectors = [
    "[class*=transcript i]",
    "[data-purpose*=transcript]",
    "[aria-label*=transcript i]",
    ".ytd-transcript-segment-list-renderer",
  ];
  for (const sel of panelSelectors) {
    const el = document.querySelector(sel) as HTMLElement | null;
    const text = el?.innerText?.replace(/\s+\n/g, "\n").trim();
    if (text && text.length > 200) return text.slice(0, limit);
  }

  const video = document.querySelector("video");
  if (video) {
    const out: string[] = [];
    for (const track of Array.from(video.textTracks)) {
      if (track.kind !== "subtitles" && track.kind !== "captions") continue;
      const cues = track.cues;
      if (!cues) continue;
      for (const cue of Array.from(cues)) {
        const text = (cue as VTTCue).text?.replace(/\s+/g, " ").trim();
        if (text) out.push(text);
      }
    }
    if (out.length) return out.join(" ").slice(0, limit);
  }
  return "";
}
