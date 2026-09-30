import type { IndexedElement } from "../shared/types";

const HOST_ID = "__pb_overlay_host";

/**
 * Draws numbered boxes over indexed elements (set-of-marks). The model sees the
 * same numbers in the text list, so a screenshot and the list agree.
 */
export function drawOverlay(elements: IndexedElement[]): void {
  clearOverlay();
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .box { position:fixed; border:2px solid #E8542F; box-sizing:border-box; }
    .tag { position:fixed; background:#E8542F; color:#fff; font:600 11px/1.4 ui-monospace,monospace;
           padding:0 3px; border-radius:2px; transform:translateY(-100%); white-space:nowrap; }
  `;
  shadow.append(style);

  for (const el of elements) {
    if (el.box.w < 2 || el.box.h < 2) continue;
    const box = document.createElement("div");
    box.className = "box";
    box.style.left = `${el.box.x}px`;
    box.style.top = `${el.box.y}px`;
    box.style.width = `${el.box.w}px`;
    box.style.height = `${el.box.h}px`;

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = String(el.index);
    tag.style.left = `${el.box.x}px`;
    tag.style.top = `${Math.max(el.box.y, 12)}px`;

    shadow.append(box, tag);
  }
  document.documentElement.append(host);
}

export function clearOverlay(): void {
  document.getElementById(HOST_ID)?.remove();
}
