/* Authored-text extraction shared by the scanner and DOM regression tests. */
(() => {
  const REDDIT_ROOT = "shreddit-post, [data-testid='post-container'], .thing.link[data-fullname^='t3_']";
  const LINKEDIN_ROOT = "[role='listitem'][componentkey^='update-card-focus'], .feed-shared-update-v2, [data-urn*='activity'], [data-view-name='feed-full-update'], article, [role='article']";
  const OMIT = ".slop-finder-overlay, button, [role='button'], script, style, [hidden], [aria-hidden='true'], shreddit-comment, .comment, .buttons, .tagline, .flat-list, .crosspost-preview";
  const clean = (value) => String(value || "").replace(/\u200b/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  function scopes(root) {
    const result = [root];
    for (let i = 0; i < result.length; i++) {
      if (result[i].shadowRoot && !result.includes(result[i].shadowRoot)) result.push(result[i].shadowRoot);
      for (const el of result[i].querySelectorAll("*")) {
        if (el.shadowRoot && !result.includes(el.shadowRoot)) result.push(el.shadowRoot);
      }
    }
    return [...new Set(result)];
  }

  function query(root, selector) {
    return [...new Set(scopes(root).flatMap(scope => [...scope.querySelectorAll(selector)]))];
  }

  function parentElement(node) {
    return node.parentElement || node.getRootNode?.().host || null;
  }

  function belongsTo(node, root, rootSelector) {
    for (let el = node; el && el !== root; el = parentElement(el)) {
      if (el.matches?.(OMIT)) return false;
      if (el !== node && el.matches?.(rootSelector)) return false;
    }
    return true;
  }

  function authoredText(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll(OMIT).forEach(el => el.remove());
    copy.querySelectorAll("pre").forEach(el => el.replaceWith(`\n\x60\x60\x60\n${el.textContent}\n\x60\x60\x60\n`));
    copy.querySelectorAll("code").forEach(el => el.replaceWith(`\x60${el.textContent}\x60`));
    copy.querySelectorAll("blockquote").forEach(el => {
      const quote = clean(el.textContent).split("\n").map(line => `> ${line}`).join("\n");
      el.replaceWith(`\n${quote}\n`);
    });
    copy.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
    copy.querySelectorAll("p, li, div").forEach(el => el.append("\n"));
    return clean(copy.textContent);
  }

  function selectedText(root, selectors, rootSelector) {
    const nodes = query(root, selectors.join(",")).filter(node => belongsTo(node, root, rootSelector));
    // Parent and child selectors often describe the same body. Keep it once.
    const outer = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
    return [...new Set(outer.map(authoredText).filter(Boolean))].join("\n\n");
  }

  function redditRoots(doc) {
    return query(doc, REDDIT_ROOT).filter(root => {
      const ancestor = parentElement(root);
      return !ancestor?.closest?.(REDDIT_ROOT);
    });
  }

  function extract(root, site, maxLength = 6000) {
    let text = "", title = "", body = "", textScope = "post";
    if (site === "reddit") {
      title = clean(root.getAttribute("post-title") || root.getAttribute("post-title-text"));
      if (!title) title = selectedText(root, ["[slot='title']", "[data-testid='post-title']", "[data-post-click-location='title']", "a.title", "h1", "h3"], REDDIT_ROOT);
      body = selectedText(root, ["[slot='text-body']", "[data-post-click-location='text-body']", "[data-testid='post-content']", ".usertext-body .md", ".md", "[id$='-post-rtjson-content']"], REDDIT_ROOT);
      if (body === title) body = "";
      text = clean([title, body].filter(Boolean).join("\n\n"));
      textScope = body ? "post" : "title_only";
    } else if (site === "x") {
      // The first tweetText owned by this tweet is its author's commentary.
      // A quote card's tweetText must not be appended to that commentary.
      const node = query(root, "[data-testid='tweetText']").find(el =>
        belongsTo(el, root, "article[data-testid='tweet']") && !el.closest("[data-testid='quoteTweet'], [role='link']"));
      text = node ? authoredText(node) : "";
    } else if (site === "linkedin") {
      // LinkedIn regularly changes generated CSS class names. Prefer stable
      // semantic/test attributes used by the current feed, then retain the
      // legacy selectors for older layouts.
      for (const selector of [
        "[data-testid='expandable-text-box']",
        "[data-testid='main-feed-activity-card__commentary']",
        "[data-test-id='main-feed-activity-card__commentary']",
        "[data-view-name='feed-commentary']",
        ".update-components-text",
        ".feed-shared-update-v2__description",
        ".feed-shared-text"
      ]) {
        text = selectedText(root, [selector], LINKEDIN_ROOT);
        if (text) break;
      }

      // Conservative fallback for another LinkedIn rollout: only consider
      // visible-looking authored text containers, never the whole card. This
      // avoids pulling author names, reactions and action labels into scoring.
      if (!text) {
        const candidates = query(root,
          "[data-testid*='commentary'], [data-testid*='expandable-text'], [data-view-name*='commentary']")
          .filter(node => belongsTo(node, root, LINKEDIN_ROOT))
          .map(node => authoredText(node))
          .filter(value => value.length >= 12 && value.length <= maxLength)
          .sort((a, b) => b.length - a.length);
        text = candidates[0] || "";
      }
    }
    const truncated = text.length > maxLength;
    return {
      text: text.slice(0, maxLength),
      truncated,
      text_scope: textScope,
      post_key: root.getAttribute("id") || root.getAttribute("data-fullname") || root.getAttribute("data-testid") || "",
    };
  }

  const api = { extract, redditRoots, query, scopes, authoredText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.SlopFinderExtraction = api;
})();
