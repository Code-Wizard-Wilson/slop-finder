const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const extraction = require('../extension/extraction.js');

function page(html) { return new JSDOM(html, { url: 'https://www.reddit.com/r/test/' }).window.document; }

test('modern Reddit: title/body once; exclude comments, actions and crossposts', () => {
  const doc = page(`<shreddit-post id="t3_one" post-title="A real title">
    <a slot="title">A real title</a><div slot="text-body"><div class="md"><p>Authored body.</p><blockquote>Save this post.</blockquote><pre>if (x) return y;</pre></div></div>
    <shreddit-comment><div class="md">Comment must not be scored.</div></shreddit-comment>
    <div class="crosspost-preview"><div class="md">Someone else's post.</div></div>
    <button>100 votes</button><span>Promoted username</span>
  </shreddit-post>`);
  const [root] = extraction.redditRoots(doc);
  const post = extraction.extract(root, 'reddit');
  assert.equal(post.text, 'A real title\n\nAuthored body.\n\n> Save this post.\n\n```\nif (x) return y;\n```');
  assert.equal(post.text_scope, 'post');
});

test('old Reddit: .thing link title + expanded selftext only', () => {
  const doc = page(`<div class="thing link" data-fullname="t3_old"><div class="entry">
    <p class="title"><a class="title">How I fixed the leak</a></p><p class="tagline">posted by author</p>
    <div class="usertext-body"><div class="md"><p>Replace the washer.</p><p>Tighten a quarter turn.</p></div></div>
    <ul class="buttons"><li>save report share</li></ul></div>
    <div class="thing comment"><div class="md">Not the original author.</div></div></div>`);
  assert.equal(extraction.redditRoots(doc).length, 1);
  assert.equal(extraction.extract(extraction.redditRoots(doc)[0], 'reddit').text,
    'How I fixed the leak\n\nReplace the washer.\nTighten a quarter turn.');
});

test('redesign Reddit: post-container title and body; no unrelated article fallback', () => {
  const doc = page(`<main><article>Reddit navigation and recommended communities.</article>
    <article data-testid="post-container"><h3 data-testid="post-title">Actual title</h3>
    <div data-click-id="text"><div class="md">Actual body.</div></div></article></main>`);
  const roots = extraction.redditRoots(doc);
  assert.equal(roots.length, 1);
  assert.equal(extraction.extract(roots[0], 'reddit').text, 'Actual title\n\nActual body.');
});

test('title-only media remains title-only, even with comments and counters', () => {
  const doc = page(`<shreddit-post post-title="This changed everything"><button>500 comments</button>
    <shreddit-comment><div class="md">A sufficiently long comment that is not the original post.</div></shreddit-comment></shreddit-post>`);
  const post = extraction.extract(extraction.redditRoots(doc)[0], 'reddit');
  assert.equal(post.text, 'This changed everything');
  assert.equal(post.text_scope, 'title_only');
});

test('open shadow roots are discovered and their authored body is read', () => {
  const doc = page('<feed-shell></feed-shell>');
  const feed = doc.querySelector('feed-shell').attachShadow({mode:'open'});
  feed.innerHTML = '<shreddit-post post-title="Shadow title"></shreddit-post>';
  const root = feed.querySelector('shreddit-post');
  root.attachShadow({mode:'open'}).innerHTML = '<div slot="text-body">Shadow body.</div>';
  assert.equal(extraction.redditRoots(doc).length, 1);
  assert.equal(extraction.extract(root, 'reddit').text, 'Shadow title\n\nShadow body.');
});

test('length cap is explicit and expansion changes the extracted content', () => {
  const doc = page('<shreddit-post post-title="Title"><div slot="text-body">Short body.</div></shreddit-post>');
  const root = extraction.redditRoots(doc)[0];
  assert.equal(extraction.extract(root, 'reddit').truncated, false);
  root.querySelector('[slot=text-body]').textContent = 'Long body. '.repeat(1000);
  const post = extraction.extract(root, 'reddit', 6000);
  assert.equal(post.truncated, true);
  assert.equal(post.text.length, 6000);
});

test('nested crosspost is neither a second root nor part of author text', () => {
  const doc = page('<shreddit-post post-title="Commentary"><div slot="text-body">Author words.</div><shreddit-post post-title="Quoted title"><div slot="text-body">Quoted body.</div></shreddit-post></shreddit-post>');
  const roots = extraction.redditRoots(doc);
  assert.equal(roots.length, 1);
  assert.equal(extraction.extract(roots[0], 'reddit').text, 'Commentary\n\nAuthor words.');
});

test('X excludes quote card and LinkedIn excludes nested repost/commentary', () => {
  const doc = page(`<article data-testid="tweet"><div data-testid="tweetText">Author text.</div><div role="link"><div data-testid="tweetText">Quoted post.</div></div></article>
    <div class="feed-shared-update-v2"><div class="update-components-text"><span>My update.</span></div><div class="feed-shared-update-v2"><div class="update-components-text">Reposted text.</div></div></div>`);
  assert.equal(extraction.extract(doc.querySelector('article'), 'x').text, 'Author text.');
  assert.equal(extraction.extract(doc.querySelector('.feed-shared-update-v2'), 'linkedin').text, 'My update.');
});


test('LinkedIn 2026 semantic card extracts expandable text only', () => {
  const doc = new JSDOM(`<main>
    <div role="listitem" componentkey="update-card-focus-123">
      <div>Jane Example · 2h</div>
      <div data-testid="expandable-text-box"><p>This is the authored LinkedIn post with enough real text to analyze.</p></div>
      <button aria-label="Like">Like</button><button aria-label="Comment">Comment</button>
    </div>
  </main>`, { url: 'https://www.linkedin.com/feed/' }).window.document;
  const root = doc.querySelector('[role=listitem]');
  const post = extraction.extract(root, 'linkedin');
  assert.equal(post.text, 'This is the authored LinkedIn post with enough real text to analyze.');
  assert.doesNotMatch(post.text, /Jane Example|Like|Comment/);
});

test('LinkedIn keeps legacy commentary extraction working', () => {
  const doc = new JSDOM(`<div class="feed-shared-update-v2">
    <div class="update-components-text"><span>Legacy LinkedIn authored text.</span></div>
  </div>`, { url: 'https://www.linkedin.com/feed/' }).window.document;
  assert.equal(extraction.extract(doc.querySelector('.feed-shared-update-v2'), 'linkedin').text,
    'Legacy LinkedIn authored text.');
});
