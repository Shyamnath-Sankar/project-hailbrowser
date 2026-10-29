// Sites a Fast run may open. They come only from the user's goal text (a URL, a domain, or a
// well-known site name), never from model output: the model can only pick one of these offers.

const KNOWN = {
  youtube: 'https://www.youtube.com/',
  google: 'https://www.google.com/',
  gmail: 'https://mail.google.com/',
  'google maps': 'https://www.google.com/maps',
  wikipedia: 'https://en.wikipedia.org/',
  amazon: 'https://www.amazon.com/',
  flipkart: 'https://www.flipkart.com/',
  ebay: 'https://www.ebay.com/',
  github: 'https://github.com/',
  'stack overflow': 'https://stackoverflow.com/',
  stackoverflow: 'https://stackoverflow.com/',
  reddit: 'https://www.reddit.com/',
  twitter: 'https://x.com/',
  facebook: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/',
  linkedin: 'https://www.linkedin.com/',
  netflix: 'https://www.netflix.com/',
  spotify: 'https://open.spotify.com/',
  bing: 'https://www.bing.com/',
  duckduckgo: 'https://duckduckgo.com/',
  'hacker news': 'https://news.ycombinator.com/',
  imdb: 'https://www.imdb.com/',
  booking: 'https://www.booking.com/',
  airbnb: 'https://www.airbnb.com/',
};

const MAX_SITES = 5;
// A bare domain such as "flipkart.com" or "bbc.co.uk" (not part of an e-mail address).
const DOMAIN = /(?<![@\w.-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|co|in|uk|de|fr|jp|edu|gov|tv|me|info)(?:\.[a-z]{2})?)(\/[^\s"'<>]*)?/gi;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

/** [{label, url}] for every site the goal names, in order of appearance, at most 5. */
export function sitesFromGoal(goal) {
  const text = String(goal || '');
  const found = [];
  const add = (index, url) => {
    let u;
    try { u = new URL(url); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    found.push({ index, url: u.href, label: `Open ${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}` });
  };
  for (const m of text.matchAll(URL_RE)) add(m.index, m[0].replace(/[.,;:!?)]+$/, ''));
  const withoutUrls = text.replace(URL_RE, (s) => ' '.repeat(s.length));
  for (const m of withoutUrls.matchAll(DOMAIN)) add(m.index, `https://${m[1]}${(m[2] || '').replace(/[.,;:!?)]+$/, '')}`);
  // Longest names first, masking each match, so "google maps" is not also read as "google".
  // Names inside an e-mail address or a domain ("bob@gmail.com") don't count.
  let lower = withoutUrls.replace(DOMAIN, (s) => ' '.repeat(s.length)).toLowerCase();
  for (const name of Object.keys(KNOWN).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![@\\w.-])${name.replace(' ', '\\s+')}(?![\\w@.-]*\\w)`, 'g');
    lower = lower.replace(re, (s, at) => { add(at, KNOWN[name]); return ' '.repeat(s.length); });
  }
  // "x" alone is too ambiguous; "x.com" is matched as a domain above.
  const seen = new Set();
  return found.sort((a, b) => a.index - b.index)
    .filter((s) => {
      const u = new URL(s.url);
      const key = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SITES)
    .map(({ label, url }) => ({ label, url }));
}

/** True when the page is already on that site (same host, ignoring www.). */
export function onSite(pageUrl, siteUrl) {
  try {
    const a = new URL(pageUrl).hostname.replace(/^www\./, '');
    const b = new URL(siteUrl).hostname.replace(/^www\./, '');
    return a === b || a.endsWith(`.${b}`);
  } catch {
    return false;
  }
}
