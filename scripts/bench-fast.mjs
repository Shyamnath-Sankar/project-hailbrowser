// Fast-mode benchmark: local fixture pages for the hard cases (Enter-only search, duplicate
// buttons, hover menus, modal dialogs, autocomplete, pagination, inner scroll panels, new tabs…).
// Each page reports success to this server, so a pass is what the page saw, not the model's DONE.
// Makes real model calls (keys from the environment), so it is not part of `npm test`.
//
//   INCEPTION_API_KEY=sk_... node scripts/bench-fast.mjs
//   OPENROUTER_API_KEY=sk-or-... DECISION_MODEL=inception/mercury-decide node scripts/bench-fast.mjs
//   BENCH_MODE=normal  → run the same tasks in Chat mode (Inception: mercury-2) for comparison
//   BENCH_ONLY=enter,dup → run a subset; BENCH_OUT=file.json → save results
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BACKEND = process.env.INCEPTION_API_KEY ? 'inception' : 'openrouter';
const KEY = process.env.INCEPTION_API_KEY || process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('Set INCEPTION_API_KEY or OPENROUTER_API_KEY.'); process.exit(2); }
const MODEL = process.env.DECISION_MODEL || (BACKEND === 'inception' ? 'mercury-decide' : 'respan/span-01-lite:free');
const MODE = process.env.BENCH_MODE === 'normal' ? 'normal' : 'ultrafast';
const CHAT_MODEL = process.env.CHAT_MODEL || (BACKEND === 'inception' ? 'mercury-2' : 'google/gemini-2.5-flash');
const ONLY = process.env.BENCH_ONLY ? new Set(process.env.BENCH_ONLY.split(',')) : null;
const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const BRIDGE_PORT = Number(process.env.BENCH_PORT) || 22402;
const TRUST_FILE = path.join(os.tmpdir(), `hail-trust-bench-${process.pid}.json`);

// ---------- fixtures ----------
const page = (name, title, body, script = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}.card{border:1px solid #ccc;padding:8px;margin:6px;display:inline-block;width:180px}</style>
${body}<p id="out"></p>
<script>const ok=(d)=>{document.getElementById('out').textContent='Done: '+d;fetch('/ok/${name}/'+encodeURIComponent(d));};${script}</script>`;

const PRODUCTS = [['Bose QC45', 24900], ['Sony WH-1000XM5', 26990], ['JBL Tune 510', 3499], ['boAt Rockerz 450', 1299], ['Sennheiser HD 450', 9990], ['Apple AirPods Max', 59900]];
const DESTS = ['Amsterdam', 'Athens', 'Bangkok', 'Barcelona', 'Berlin', 'Bogotá', 'Cairo', 'Cape Town', 'Chicago', 'Delhi', 'Dubai', 'Dublin',
  'Florence', 'Hanoi', 'Havana', 'Helsinki', 'Istanbul', 'Jakarta', 'Lima', 'Lisbon', 'London', 'Madrid', 'Manila', 'Marrakesh', 'Mexico City',
  'Miami', 'Milan', 'Montreal', 'Mumbai', 'Munich', 'Nairobi', 'Naples', 'Oslo', 'Paris', 'Prague', 'Quito', 'Reykjavik', 'Rome', 'Santiago',
  'Seoul', 'Seville', 'Singapore', 'Stockholm', 'Sydney', 'Taipei', 'Tallinn', 'Tbilisi', 'Toronto', 'Valencia', 'Vienna', 'Warsaw', 'Kyoto'];

const TASKS = [
  { name: 'form', goal: 'Search flights to Tokyo with the nonstop box ticked', expect: 'tokyo/true',
    html: page('form', 'Flights', `<h1>Flights</h1><form id="f"><label>Destination <input id="q"></label> <label><input type="checkbox" id="ns"> Nonstop</label> <button>Search</button></form>`,
      `f.onsubmit=(e)=>{e.preventDefault();ok(q.value.trim().toLowerCase()+'/'+ns.checked)}`) },
  { name: 'enter', goal: 'Search the shop for blue lamp', expect: 'blue lamp',
    html: page('enter', 'Shop', `<h1>Lamp shop</h1><input id="q" aria-label="Search products"><p>Type and press Enter to search.</p>`,
      `q.addEventListener('keydown',(e)=>{if(e.key==='Enter')ok(q.value.trim().toLowerCase())})`) },
  { name: 'dup', goal: 'Add the Sony WH-1000XM5 to the cart', expect: 'Sony WH-1000XM5',
    html: page('dup', 'Headphones', `<h1>Headphones</h1>${PRODUCTS.map(([n, p]) => `<div class="card"><h3>${n}</h3><p>₹${p.toLocaleString('en-IN')}</p><button>Add to cart</button></div>`).join('')}`,
      `document.querySelectorAll('.card button').forEach((b)=>b.onclick=()=>ok(b.parentElement.querySelector('h3').textContent))`) },
  { name: 'sort', goal: 'Search for headphones and sort by price, lowest first', expect: 'headphones/asc',
    html: page('sort', 'Store', `<h1>Store</h1><input id="q" aria-label="Search"> <button id="go">Search</button>
      <label>Sort by <select id="s"><option value="rel">Relevance</option><option value="asc">Price: low to high</option><option value="desc">Price: high to low</option></select></label><div id="res"></div>`,
      `let searched='';const rep=()=>{if(searched&&s.value!=='rel')ok(searched+'/'+s.value)};
       go.onclick=()=>{searched=q.value.trim().toLowerCase();res.textContent='12 results for '+searched;rep()};s.onchange=rep`) },
  { name: 'menu', goal: 'Sort the products by price from high to low', expect: 'Price: High to Low',
    html: page('menu', 'Catalog', `<h1>Catalog</h1><button id="b" aria-haspopup="menu" aria-expanded="false">Sort: Featured</button>
      <ul id="m" role="menu" hidden><li role="menuitem">Newest</li><li role="menuitem">Price: Low to High</li><li role="menuitem">Price: High to Low</li></ul>
      ${PRODUCTS.slice(0, 4).map(([n]) => `<div class="card">${n}</div>`).join('')}`,
      `b.onclick=()=>{m.hidden=!m.hidden;b.setAttribute('aria-expanded',String(!m.hidden))};m.querySelectorAll('li').forEach((li)=>li.onclick=()=>{m.hidden=true;ok(li.textContent)})`) },
  { name: 'hover', goal: 'Open the Laptops page from the Products menu', expect: 'laptops',
    html: page('hover', 'Megastore', `<style>.dd{display:inline-block;position:relative}.dd .sub{display:none;position:absolute;background:#fff;border:1px solid #999;padding:6px}.dd:hover .sub{display:block}.sub a{display:block;padding:4px}</style>
      <nav><span class="dd"><a href="#" id="p" onclick="return false">Products</a><span class="sub"><a href="#" id="lap">Laptops</a><a href="#">Phones</a><a href="#">Tablets</a></span></span> <a href="#" onclick="return false">About</a></nav><h1>Welcome</h1>`,
      `lap.onclick=(e)=>{e.preventDefault();ok('laptops')}`) },
  { name: 'cookie', goal: 'Subscribe to the newsletter with the email test@example.com', expect: 'test@example.com',
    html: page('cookie', 'News', `<h1>Daily news</h1><label>Email <input id="em" type="email"></label> <button id="sub">Subscribe</button>
      <div id="ov" role="dialog" aria-modal="true" aria-label="Cookies" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;padding:20px">We use cookies to improve your experience. <button id="acc">Accept all</button> <button id="rej">Reject non-essential</button></div></div>`,
      `acc.onclick=rej.onclick=()=>ov.remove();sub.onclick=()=>ok(em.value.trim())`) },
  { name: 'escape', goal: 'Open the Pricing section', expect: 'pricing',
    html: page('escape', 'SaaS', `<h1>Acme Cloud</h1><button id="ov1">Overview</button> <button id="pr">Pricing</button>
      <dialog id="d"><h2>What's new</h2><p>Version 5 is here with faster sync. Press Esc to dismiss this announcement.</p></dialog>`,
      `d.showModal();pr.onclick=()=>ok('pricing')`) },
  { name: 'autocomplete', goal: 'Set the origin to Zurich and search', expect: 'Zurich (ZRH)',
    html: page('autocomplete', 'Trains', `<h1>Trains</h1><label>From <input id="from" role="combobox" aria-expanded="false" autocomplete="off"></label><ul id="sug" role="listbox"></ul> <button id="go">Search</button>`,
      `const C=['Zurich (ZRH)','Zagreb (ZAG)','Zaragoza (ZAZ)','Zermatt (ZMT)'];
       from.oninput=()=>{const v=from.value.toLowerCase();sug.innerHTML='';if(!v)return;C.filter((c)=>c.toLowerCase().startsWith(v.slice(0,2))).forEach((c)=>{const li=document.createElement('li');li.setAttribute('role','option');li.textContent=c;li.onclick=()=>{from.value=c;sug.innerHTML=''};sug.append(li)})};
       go.onclick=()=>{if(C.includes(from.value))ok(from.value)}`) },
  { name: 'offscreen', goal: 'Click the Load report button', expect: 'report',
    html: page('offscreen', 'Dashboard', `<h1>Dashboard</h1><div style="height:2600px;background:linear-gradient(#fff,#eef)">${'<p>Weekly metrics overview.</p>'.repeat(5)}</div><button id="lr">Load report</button>`,
      `lr.onclick=()=>ok('report')`) },
  { name: 'pages', goal: 'Open Item 27', expect: 'Item 27',
    html: page('pages', 'Inventory', `<h1>Inventory</h1><ul id="l"></ul><button id="prev">Previous</button> <span id="pg"></span> <button id="next">Next</button>`,
      `let p=0;const draw=()=>{l.innerHTML='';for(let i=p*10+1;i<=p*10+10;i++){const a=document.createElement('a');a.href='#';a.textContent='Item '+i;a.onclick=(e)=>{e.preventDefault();ok(a.textContent)};const li=document.createElement('li');li.append(a);l.append(li)}pg.textContent='Page '+(p+1)+' of 3'};
       next.onclick=()=>{if(p<2){p++;draw()}};prev.onclick=()=>{if(p>0){p--;draw()}};draw()`) },
  { name: 'newtab', goal: 'Open the help article and click Confirm', expect: 'confirmed',
    html: page('newtab', 'Support', `<h1>Support</h1><p>Need help?</p><a href="/t/newtab-article" target="_blank">Read the help article</a>`) },
  { name: 'panel', goal: 'Choose Kyoto from the destinations list', expect: 'Kyoto',
    html: page('panel', 'Destinations', `<h1>Pick a destination</h1><div id="list" style="height:160px;overflow:auto;border:1px solid #999;width:260px">${DESTS.map((d) => `<button style="display:block;width:100%;height:34px">${d}</button>`).join('')}</div>`,
      `list.querySelectorAll('button').forEach((b)=>b.onclick=()=>ok(b.textContent))`) },
  { name: 'date', goal: 'Set the check-in date to 2026-12-24 and continue', expect: '2026-12-24',
    html: page('date', 'Hotel', `<h1>Book a room</h1><label>Check-in <input type="date" id="d"></label> <button id="c">Continue</button>`, `c.onclick=()=>ok(d.value)`) },
  { name: 'filters', goal: 'Show only Sony headphones under ₹5,000', expect: 'Sony/under5k',
    html: page('filters', 'Filters', `<h1>Headphones</h1><fieldset><legend>Brand</legend>${['Sony', 'Bose', 'JBL'].map((b) => `<label><input type="checkbox" name="brand" value="${b}"> ${b}</label>`).join(' ')}</fieldset>
      <fieldset><legend>Price</legend><label><input type="radio" name="price" value="under5k"> Under ₹5,000</label> <label><input type="radio" name="price" value="mid"> ₹5,000–₹15,000</label> <label><input type="radio" name="price" value="over"> Over ₹15,000</label></fieldset><button id="ap">Apply filters</button>`,
      `ap.onclick=()=>ok([...document.querySelectorAll('[name=brand]:checked')].map((c)=>c.value).join(',')+'/'+(document.querySelector('[name=price]:checked')?.value||''))`) },
  { name: 'unlabeled', goal: 'Search for cat videos', expect: /cat/,
    html: page('unlabeled', 'Tube', `<header><form id="f"><input name="search_query" id="q"><button type="submit" aria-label="Search">🔍</button></form></header><h2>Recommended</h2>${'<div class="card">Video</div>'.repeat(4)}`,
      `f.onsubmit=(e)=>{e.preventDefault();ok(q.value.trim().toLowerCase())}`) },
  { name: 'tabs', goal: 'Open the Reviews tab and mark the first review as helpful', expect: 'Asha',
    html: page('tabs', 'Product', `<h1>Sony WH-1000XM5</h1><div role="tablist"><button role="tab" aria-selected="true" id="t1">Description</button><button role="tab" aria-selected="false" id="t2">Specs</button><button role="tab" aria-selected="false" id="t3">Reviews</button></div>
      <div id="p1">Industry-leading noise cancelling.</div><div id="p2" hidden>30h battery.</div><div id="p3" hidden>${['Asha', 'Ravi', 'Meera'].map((n) => `<div class="card"><b>${n}</b>: Great sound. <button data-n="${n}">Helpful</button></div>`).join('')}</div>`,
      `const tabs=[t1,t2,t3],ps=[p1,p2,p3];tabs.forEach((t,i)=>t.onclick=()=>{tabs.forEach((x,j)=>x.setAttribute('aria-selected',String(i===j)));ps.forEach((p,j)=>p.hidden=i!==j)});
       document.querySelectorAll('[data-n]').forEach((b)=>b.onclick=()=>ok(b.dataset.n))`) },
  // ---- harder: reasoning over the page, several requirements, forms inside dialogs ----
  { name: 'cheapest', goal: 'Add the cheapest headphones to the cart', expect: 'boAt Rockerz 450',
    html: page('cheapest', 'Deals', `<h1>Headphone deals</h1>${[...PRODUCTS].sort(() => 0.5 - Math.sin(PRODUCTS.length)).map(([n, p]) => `<div class="card"><h3>${n}</h3><p>₹${p.toLocaleString('en-IN')}</p><button>Add to cart</button></div>`).join('')}`,
      `document.querySelectorAll('.card button').forEach((b)=>b.onclick=()=>ok(b.parentElement.querySelector('h3').textContent))`) },
  { name: 'trip', goal: 'Find trains from Zurich to Paris for 2 travellers', expect: 'Zurich (ZRH)>Paris (PAR)/2',
    html: page('trip', 'Rail', `<h1>Rail search</h1>
      <label>From <input id="from" role="combobox" autocomplete="off"></label><ul id="s1" role="listbox"></ul>
      <label>To <input id="to" role="combobox" autocomplete="off"></label><ul id="s2" role="listbox"></ul>
      <label>Travellers <select id="pax"><option>1</option><option>2</option><option>3</option><option>4</option></select></label> <button id="go">Find trains</button>`,
      `const C=['Zurich (ZRH)','Paris (PAR)','Prague (PRG)','Zagreb (ZAG)','Porto (OPO)'];
       const ac=(inp,ul)=>{inp.oninput=()=>{const v=inp.value.toLowerCase();ul.innerHTML='';if(!v)return;C.filter((c)=>c.toLowerCase().startsWith(v.slice(0,2))).forEach((c)=>{const li=document.createElement('li');li.setAttribute('role','option');li.textContent=c;li.onclick=()=>{inp.value=c;ul.innerHTML=''};ul.append(li)})}};
       ac(from,s1);ac(to,s2);go.onclick=()=>{if(C.includes(from.value)&&C.includes(to.value))ok(from.value+'>'+to.value+'/'+pax.value)}`) },
  { name: 'multi', goal: 'Search for headphones, sort by price from low to high and show only items in stock', expect: 'headphones/asc/instock',
    html: page('multi', 'Store', `<h1>Store</h1><input id="q" aria-label="Search"> <button id="go">Search</button>
      <label>Sort by <select id="s"><option value="rel">Relevance</option><option value="asc">Price: low to high</option><option value="desc">Price: high to low</option></select></label>
      <label><input type="checkbox" id="st"> In stock only</label><div id="res"></div>`,
      `let searched='';const rep=()=>{if(searched&&s.value==='asc'&&st.checked)ok(searched+'/asc/instock')};
       go.onclick=()=>{searched=q.value.trim().toLowerCase();res.textContent='24 results for '+searched;rep()};s.onchange=rep;st.onchange=rep`) },
  { name: 'modalform', goal: 'Add a new delivery address in Berlin with postcode 10115', expect: 'Berlin/10115',
    html: page('modalform', 'Account', `<h1>Your addresses</h1><p>No saved addresses.</p><button id="add">Add address</button>
      <dialog id="d"><h2>New address</h2><label>City <input id="city"></label><br><label>Postcode <input id="pc"></label><br><button id="save">Save address</button> <button id="cancel">Cancel</button></dialog>`,
      `add.onclick=()=>d.showModal();cancel.onclick=()=>d.close();save.onclick=()=>{if(city.value.trim()&&pc.value.trim()){d.close();ok(city.value.trim()+'/'+pc.value.trim())}}`) },
  // ---- questions: scored on the answer in run_task's output ----
  { name: 'price-q', goal: 'What does the JBL Tune 510 cost?', answer: /3,?499/,
    html: page('price-q', 'Headphones', `<h1>Headphones</h1>${PRODUCTS.map(([n, p]) => `<div class="card"><h3>${n}</h3><p>₹${p.toLocaleString('en-IN')}</p></div>`).join('')}`) },
  { name: 'cheapest-q', goal: 'Which headphones on this page are the cheapest, and what do they cost?', answer: /boAt Rockerz 450[\s\S]*1,?299|1,?299[\s\S]*boAt Rockerz 450/i,
    html: page('cheapest-q', 'Deals', `<h1>Deals</h1>${[...PRODUCTS].reverse().map(([n, p]) => `<div class="card"><h3>${n}</h3><p>₹${p.toLocaleString('en-IN')}</p></div>`).join('')}`) },
  { name: 'footer-q', goal: 'What is the customer support phone number?', answer: /\+41 44 555 01 23/,
    html: page('footer-q', 'Acme', `<h1>Acme Store</h1><div style="height:2600px">${'<p>Great products for everyone.</p>'.repeat(6)}</div><footer>Customer support: +41 44 555 01 23 (Mon–Fri)</footer>`) },
  { name: 'count-q', goal: 'Search the shop for blue lamp and tell me how many results there are', expect: 'blue lamp', answer: /\b7\b|seven/i,
    html: page('count-q', 'Lamp shop', `<h1>Lamp shop</h1><input id="q" aria-label="Search products"><div id="res"></div>`,
      `q.addEventListener('keydown',(e)=>{if(e.key==='Enter'){const v=q.value.trim().toLowerCase();res.innerHTML='<h2>7 results for '+v+'</h2>'+'<p>Lamp</p>'.repeat(7);ok(v)}})`) },
  { name: 'missing-q', goal: 'According to this page, what is the warranty period of the Sony WH-1000XM5?', answer: (a) => /not|no |doesn't|does not|isn't/i.test(a) && !/\d+\s*-?\s*(year|month)/i.test(a),
    html: page('missing-q', 'Sony WH-1000XM5', `<h1>Sony WH-1000XM5</h1><p>Industry-leading noise cancelling, 30-hour battery, ₹26,990.</p>`) },
];
const EXTRA = { 'newtab-article': page('newtab', 'Help article', `<h1>Help article</h1><p>Follow these steps, then confirm.</p><button id="cf">Confirm</button>`, `cf.onclick=()=>ok('confirmed')`) };

// ---------- server ----------
const results = new Map();
const server = http.createServer((req, res) => {
  const okm = /^\/ok\/([\w-]+)\/(.*)$/.exec(req.url);
  if (okm) { results.set(okm[1], decodeURIComponent(okm[2])); res.writeHead(204); return res.end(); }
  const t = /^\/t\/([\w-]+)/.exec(req.url);
  const html = t && (TASKS.find((x) => x.name === t[1])?.html || EXTRA[t[1]]);
  res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html || 'not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const passed = (task, got) => got != null && (task.expect instanceof RegExp ? task.expect.test(got) : got.toLowerCase() === task.expect.toLowerCase());
// Question tasks are scored on the answer run_task returns (text after "Answer:").
const answerOf = (text) => /\n\nAnswer:\n([\s\S]*?)(\n\nSteps:|$)/.exec(text)?.[1]?.trim() ?? null;
const answered = (task, text) => { const a = answerOf(text); return a != null && (typeof task.answer === 'function' ? task.answer(a) : task.answer.test(a)); };

// ---------- run ----------
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'] });
let client;
const rows = [];
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage?.local)); i++) await new Promise((r) => setTimeout(r, 100));
  await sw.evaluate(async (port, key, model, backend, chatModel, noChat) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    settings.bridge = { enabled: true, port };
    settings.providers = { [backend]: { apiKey: key, baseUrl: '' } };
    settings.normal = { provider: backend, model: chatModel, vision: false, maxSteps: 25 };
    settings.ultrafast = { backend, [`${backend}Model`]: model, textProvider: backend, textModel: chatModel, maxActions: 15, useChatModel: !noChat };
    await chrome.storage.local.set({ settings });
  }, BRIDGE_PORT, KEY, MODEL, BACKEND, CHAT_MODEL, !!process.env.BENCH_NO_CHAT);

  client = new Client({ name: 'bench', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, env: { ...process.env, HAILBROWSER_TRUST_FILE: TRUST_FILE }, args: ['mcp-server/src/index.js', '--port', String(BRIDGE_PORT)], stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: r.isError };
  };

  console.log(`mode: ${MODE} · backend: ${BACKEND} · ${MODE === 'normal' ? `chat model: ${CHAT_MODEL}` : `decision model: ${MODEL}`}\n`);
  for (const task of TASKS) {
    if (ONLY && !ONLY.has(task.name)) continue;
    results.delete(task.name);
    await call('tabs_create', { url: `${base}/t/${task.name}` });
    const t0 = Date.now();
    const r = await call('run_task', { goal: task.goal, mode: MODE });
    const secs = (Date.now() - t0) / 1000;
    await new Promise((res) => setTimeout(res, 300)); // let the page's success ping land
    const got = results.get(task.name);
    const ok = (task.expect == null || passed(task, got)) && (!task.answer || answered(task, r.text));
    const actions = Number(/(\d+) actions/.exec(r.text)?.[1] ?? /(\d+) steps?/i.exec(r.text)?.[1] ?? NaN);
    const status = r.isError ? 'error' : /✅|Done/.test(r.text.split('\n')[0]) ? 'done' : /Blocked|⚠️/.test(r.text) ? 'blocked' : 'other';
    const calls = /(\d+) decisions · (\d+) text calls/.exec(r.text);
    const decisions = Number(calls?.[1] ?? 0), textCalls = Number(calls?.[2] ?? 0);
    rows.push({ task: task.name, pass: ok, status, actions, secs, decisions, textCalls, got: got ?? null, note: r.isError ? r.text.slice(0, 160) : '' });
    if (process.env.BENCH_VERBOSE) console.log(r.text);
    console.log(`${ok ? '✅' : '❌'} ${task.name.padEnd(13)} ${status.padEnd(8)} ${String(actions).padStart(3)} actions ${secs.toFixed(1).padStart(6)}s  ${task.answer ? `answer: ${(answerOf(r.text) || '(none)').replace(/\s+/g, ' ').slice(0, 90)}` : got == null ? '(page saw nothing)' : `page: ${got}`}${r.isError ? `  ${r.text.slice(0, 120)}` : ''}`);
  }
} finally {
  await client?.close().catch(() => {});
  await browser.close();
  server.close();
}

const pass = rows.filter((r) => r.pass).length;
const falseDone = rows.filter((r) => !r.pass && r.status === 'done').length;
const avg = rows.reduce((a, r) => a + r.secs, 0) / (rows.length || 1);
const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
console.log(`\nScore: ${pass}/${rows.length} passed · ${falseDone} false "done" · avg ${avg.toFixed(1)}s per task`);
if (MODE === 'ultrafast') console.log(`Model calls: ${sum('decisions')} decisions · ${sum('textCalls')} text-helper calls · ${sum('actions') || 0} actions in total`);
if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ mode: MODE, backend: BACKEND, model: MODE === 'normal' ? CHAT_MODEL : MODEL, rows }, null, 2));
