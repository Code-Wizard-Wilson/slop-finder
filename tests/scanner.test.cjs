const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const extractionCode = fs.readFileSync('extension/extraction.js', 'utf8');
const scannerCode = fs.readFileSync('extension/content.js', 'utf8');

function scanner(html, responder, url = 'https://www.reddit.com/r/test/') {
  const dom = new JSDOM(html, {url, runScripts: 'outside-only'});
  const { window } = dom;
  const timers = new Map(); let timerId = 0; const listeners = [];
  window.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = () => 0;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({width:600,height:300,top:0,bottom:300});
  window.chrome = {
    runtime: {sendMessage: responder, onMessage: {addListener: (fn) => listeners.push(fn), removeListener: (fn) => { const i=listeners.indexOf(fn); if(i>=0) listeners.splice(i,1); }}},
    storage: {local: {get: (_defaults, cb) => cb({slopThreshold:65,calibrationVersion:4}), set: async () => {}}, onChanged: {addListener:()=>{},removeListener:()=>{}}},
  };
  window.eval(extractionCode); window.eval(scannerCode);
  return {
    window, dom,
    async tick() { await Promise.resolve(); const jobs=[...timers.values()];timers.clear();for(const job of jobs) job();await Promise.resolve();await Promise.resolve(); },
    message(type, extra={}) { let result; for(const fn of listeners)fn({type,...extra},null,r=>result=r);return result; },
    close() { window.__slopFinderScanner.destroy(); dom.window.close(); },
  };
}
const post = (text, id='one') => `<shreddit-post id="${id}" post-title="A sufficiently long Reddit title"><div slot="text-body">${text}</div></shreddit-post>`;
const response = (payload, decision='slop', risk=0.9) => ({ok:true,data:{scoring_version:"0.5.0",results:payload.blocks.map(block=>({...block,risk,decision,signals:{low_information:risk}}))}});

test('Reddit post flows from DOM to helper to visible mark; uncertain title stays unmarked', async () => {
  let payload;
  const s=scanner(post('A long enough authored body to send to the model, with details.')+'<shreddit-post post-title="A title with absolutely no body available"></shreddit-post>', async msg=>{
    payload=msg.payload;
    const r=response(payload);
    r.data.results.forEach(x=>{if(x.text_scope==='title_only')x.decision='uncertain';});
    return r;
  });
  try {
    await s.tick(); await s.tick();
    assert.equal(payload.blocks.length,2);
    assert.equal(payload.blocks[1].text_scope,'title_only');
    assert.equal(s.window.document.querySelectorAll('.slop-finder-overlay').length,1);
    assert.equal(s.message('LAYA_STATUS').scanned,2);
  } finally {s.close();}
});

test('recycled node cannot receive stale result or revive it on threshold change', async () => {
  const pending=[];
  const s=scanner(post('The old post content has enough words to be analyzed.'),msg=>new Promise(resolve=>pending.push({resolve,payload:msg.payload})));
  try {
    await s.tick(); await s.tick(); assert.equal(pending.length,1);
    const root=s.window.document.querySelector('shreddit-post');
    root.id='two';root.querySelector('[slot=text-body]').textContent='The new post is a specific question about a real error.';
    s.window.__slopFinderScanner.rescan();await s.tick();
    pending[0].resolve(response(pending[0].payload));await s.tick();await s.tick();
    assert.equal(root.querySelector('.slop-finder-overlay'),null);
    assert.equal(pending.length,2);
    pending[1].resolve(response(pending[1].payload,'not_flagged',0.1));await s.tick();
    s.message('LAYA_CONFIG',{threshold:0.4});
    assert.equal(root.querySelector('.slop-finder-overlay'),null);
  } finally {s.close();}
});

test('expanded old Reddit selftext is re-analyzed after title-only result', async () => {
  const calls=[];
  const s=scanner('<div class="thing link" data-fullname="t3_a"><a class="title">A sufficiently long title without the selftext</a></div>',async msg=>{
    calls.push(msg.payload);return response(msg.payload,msg.payload.blocks[0].text_scope==='title_only'?'uncertain':'slop');
  },'https://old.reddit.com/r/test/');
  try {
    await s.tick();await s.tick();assert.equal(s.window.document.querySelector('.slop-finder-overlay'),null);
    const body=s.window.document.createElement('div');body.className='usertext-body';body.innerHTML='<div class="md">Here is the expanded body with enough words to be evaluated.</div>';
    s.window.document.querySelector('.thing').append(body);await s.tick();await s.tick();
    assert.equal(calls.length,2);assert.equal(calls[1].blocks[0].text_scope,'post');
    assert.ok(s.window.document.querySelector('.slop-finder-overlay'));
  } finally {s.close();}
});

test('threshold refresh cannot flag incomplete content even with a high score', async () => {
  const s=scanner(post('Very long text. '.repeat(500)),async msg=>response(msg.payload,'uncertain',0.99));
  try {
    await s.tick();await s.tick();s.message('LAYA_CONFIG',{threshold:0.4});
    assert.equal(s.window.document.querySelector('.slop-finder-overlay'),null);
  } finally {s.close();}
});

test('changing threshold updates the count and recent matches as well as the tape', async () => {
  const s=scanner(post('A sufficiently long example post for the threshold regression.'),async msg=>response(msg.payload,'slop',0.75));
  try {
    await s.tick();await s.tick();
    assert.equal(s.message('LAYA_STATUS').flagged,1);
    s.message('LAYA_CONFIG',{threshold:0.9});
    assert.equal(s.message('LAYA_STATUS').flagged,0);
    assert.equal(s.message('LAYA_STATUS').recentFindings.length,0);
    assert.equal(s.window.document.querySelector('.slop-finder-overlay'),null);
  } finally {s.close();}
});

test('posts inside open shadow roots receive local styles and can be cleared', async () => {
  const s=scanner('<feed-shell></feed-shell>',async msg=>response(msg.payload));
  try {
    const shadow=s.window.document.querySelector('feed-shell').attachShadow({mode:'open'});
    shadow.innerHTML=post('The post content lives inside an open shadow root and should still be marked.');
    await s.tick();await s.tick();
    assert.ok(shadow.querySelector('.slop-finder-overlay'));
    assert.ok(shadow.querySelector('#slop-finder-styles'));
    s.message('LAYA_CLEAR');
    assert.equal(shadow.querySelector('.slop-finder-overlay'),null);
    assert.equal(s.message('LAYA_STATUS').flagged,0);
  } finally {s.close();}
});

test('manual rescan retries a completed post', async () => {
  let calls=0;
  const s=scanner(post('A completed post with enough text to be sent for analysis.'),async msg=>{calls++;return response(msg.payload,'not_flagged',0.1);});
  try {
    await s.tick();await s.tick();assert.equal(calls,1);
    s.message('LAYA_RESCAN');await s.tick();await s.tick();assert.equal(calls,2);
  } finally {s.close();}
});

test('outdated helper cannot silently ignore the new uncertainty contract', async () => {
  const s=scanner(post('A sufficiently long body for checking an outdated helper response.'),async msg=>{
    const r=response(msg.payload);delete r.data.scoring_version;return r;
  });
  try {
    await s.tick();await s.tick();
    assert.equal(s.window.document.querySelector('.slop-finder-overlay'),null);
    assert.match(s.message('LAYA_STATUS').helperError,/Restart the local helper/);
  } finally {s.close();}
});

test('a boxless Reddit host with visible body is scanned and gets a body overlay', async () => {
  const s=scanner(post('Visible text inside a boxless web component must still be analyzed.'),async msg=>response(msg.payload));
  try {
    const root=s.window.document.querySelector('shreddit-post');
    root.getBoundingClientRect=()=>({width:0,height:0,top:0,bottom:0});
    root.style.display='contents';
    await s.tick();await s.tick();
    assert.equal(s.message('LAYA_STATUS').scanned,1);
    assert.ok(root.querySelector('[slot=text-body] > .slop-finder-overlay'));
    s.message('LAYA_CONFIG',{threshold:.95});
    assert.equal(root.querySelector('.slop-finder-overlay'),null);
  } finally {s.close();}
});

test('DOM containers without extractable author text report why they were skipped', async () => {
  let requests=0;
  const s=scanner('<shreddit-post><button>Like comment share</button></shreddit-post>',async msg=>{requests++;return response(msg.payload);});
  try {
    await s.tick();await s.tick();
    const status=s.message('LAYA_STATUS');
    assert.equal(status.candidateRoots,1);
    assert.equal(status.scanned,0);
    assert.equal(status.skippedMissingText,1);
    assert.equal(requests,0);
  } finally {s.close();}
});

test('destroyed scanner does not apply an in-flight answer', async () => {
  let complete;
  const s=scanner(post('This request finishes only after the scanner instance has been destroyed.'),msg=>new Promise(resolve=>complete=()=>resolve(response(msg.payload))));
  try {
    await s.tick();await s.tick();
    s.window.__slopFinderScanner.destroy();complete();await s.tick();
    assert.equal(s.window.document.querySelector('.slop-finder-overlay'),null);
  } finally {s.close();}
});


test('LinkedIn 2026 card reaches the helper and increments scanned', async () => {
  let payload;
  const html = `<main>
    <div role="listitem" componentkey="update-card-focus-456">
      <div data-testid="expandable-text-box">A concrete LinkedIn post body with enough readable authored text for local analysis.</div>
      <button aria-label="Like this post">Like</button>
    </div>
  </main>`;
  const s = scanner(html, async msg => {
    payload = msg.payload;
    return response(payload, 'not_flagged', 0.12);
  }, 'https://www.linkedin.com/feed/');
  try {
    await s.tick(); await s.tick();
    assert.equal(payload.blocks.length, 1);
    assert.equal(payload.blocks[0].site, 'linkedin');
    assert.match(payload.blocks[0].text, /concrete LinkedIn post body/);
    const status = s.message('LAYA_STATUS');
    assert.equal(status.candidateRoots, 1);
    assert.equal(status.scanned, 1);
    assert.equal(status.skippedMissingText, 0);
  } finally { s.close(); }
});
