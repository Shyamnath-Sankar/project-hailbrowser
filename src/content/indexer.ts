import type { IndexedElement } from "../shared/types";

const INTERACTIVE_TAGS = new Set([
  "a", "button", "input", "select", "textarea", "summary", "video", "audio", "label",
]);
const INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch",
  "textbox", "combobox", "slider", "treeitem",
]);

/** Elements indexed for the current page, keyed by the index the model sees. */
let registry = new Map<number, Element>();

export function resolveIndex(index: number): Element | undefined {
  return registry.get(index);
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  if (rect.bottom < -200 || rect.top > window.innerHeight + 2000) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) === 0) return false;
  return true;
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  const tabIndex = (el as HTMLElement).tabIndex;
  if (tabIndex >= 0 && el.hasAttribute("tabindex")) return true;
  if (el.hasAttribute("onclick")) return true;
  // Clickable-looking containers that carry a cursor and an accessible name.
  if (getComputedStyle(el).cursor === "pointer" && (el.getAttribute("aria-label") || "").length > 0) {
    return true;
  }
  return false;
}

function labelFor(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();

  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const explicit = el.labels?.[0]?.textContent?.trim();
    if (explicit) return explicit;
    if (el.placeholder) return el.placeholder;
    if (el instanceof HTMLInputElement && el.value && el.type === "submit") return el.value;
    if (el.name) return el.name;
  }

  if (el instanceof HTMLImageElement && el.alt) return el.alt;
  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim();

  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 120);

  if (el instanceof HTMLAnchorElement && el.href) return el.href.slice(0, 80);
  return el.tagName.toLowerCase();
}

function describeTag(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el instanceof HTMLInputElement) return `input[${el.type}]`;
  const role = el.getAttribute("role");
  if (role && !INTERACTIVE_TAGS.has(tag)) return `${tag}[${role}]`;
  return tag;
}

/** Walks light DOM plus open shadow roots in document order. */
function* walk(root: Document | ShadowRoot | Element): Generator<Element> {
  for (const child of Array.from(root.children)) {
    yield child;
    if (child.shadowRoot) yield* walk(child.shadowRoot);
    yield* walk(child);
  }
}

/**
 * Builds the indexed element list the model reasons over.
 * `startIndex` lets each frame occupy a distinct range so indices stay unique.
 */
export function indexPage(frameId: number, startIndex: number): IndexedElement[] {
  registry = new Map();
  const out: IndexedElement[] = [];
  let next = startIndex;
  const seen = new Set<Element>();

  for (const el of walk(document)) {
    if (seen.has(el) || out.length >= 200) continue;
    if (!isInteractive(el) || !isVisible(el)) continue;

    // Skip a wrapper whose only purpose is to hold the interactive child we
    // already recorded, which keeps the list readable.
    const parent = el.parentElement;
    if (parent && seen.has(parent) && parent.children.length === 1) continue;

    seen.add(el);
    const rect = el.getBoundingClientRect();
    const index = next++;
    registry.set(index, el);

    const entry: IndexedElement = {
      index,
      tag: describeTag(el),
      label: labelFor(el),
      box: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      frameId,
    };
    const role = el.getAttribute("role");
    if (role) entry.role = role;
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") entry.checked = el.checked;
      else if (el.value) entry.value = el.value.slice(0, 80);
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) entry.value = el.value.slice(0, 80);
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLSelectElement) {
      entry.value = el.value;
      if (el.disabled) entry.disabled = true;
    } else if (el instanceof HTMLButtonElement && el.disabled) {
      entry.disabled = true;
    }
    out.push(entry);
  }
  return out;
}
