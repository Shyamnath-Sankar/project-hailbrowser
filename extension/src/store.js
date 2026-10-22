// Small persistent collections in chrome.storage.local: an index of item summaries (newest
// first) plus one key per item, so saving one task/chat/report never rewrites the others.

export function collection(name, { max = 50, summary = (item) => ({}), protect = () => false } = {}) {
  const indexKey = `${name}:index`;
  const key = (id) => `${name}:${id}`;
  let queue = Promise.resolve();
  // Index updates are read-modify-write: run them one at a time.
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const index = async () => (await chrome.storage.local.get(indexKey))[indexKey] || [];

  return {
    /** Summaries, newest first: [{id, ...summary(item)}]. */
    index,
    async get(id) {
      return (await chrome.storage.local.get(key(id)))[key(id)] || null;
    },
    async all() {
      const ids = (await index()).map((e) => e.id);
      if (!ids.length) return [];
      const got = await chrome.storage.local.get(ids.map(key));
      return ids.map((id) => got[key(id)]).filter(Boolean);
    },
    /** Save an item and move it to the front. Beyond `max`, the oldest unprotected items are dropped. */
    put(item) {
      return serial(async () => {
        let entries = (await index()).filter((e) => e.id !== item.id);
        entries.unshift({ id: item.id, ...summary(item) });
        const drop = [];
        if (entries.length > max) {
          const tail = entries.slice(max).map((e) => e.id);
          const items = await chrome.storage.local.get(tail.map(key));
          for (const id of tail) if (!protect(items[key(id)])) drop.push(id);
          entries = entries.filter((e) => !drop.includes(e.id));
        }
        await chrome.storage.local.set({ [key(item.id)]: item, [indexKey]: entries });
        if (drop.length) await chrome.storage.local.remove(drop.map(key));
        return drop;
      });
    },
    remove(id) {
      return serial(async () => {
        await chrome.storage.local.set({ [indexKey]: (await index()).filter((e) => e.id !== id) });
        await chrome.storage.local.remove(key(id));
      });
    },
  };
}

let seq = 0;
/** Short unique id with a prefix, e.g. uid("c") -> "clq3k2x9a1". */
export function uid(prefix) {
  return `${prefix}${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 5)}`;
}
