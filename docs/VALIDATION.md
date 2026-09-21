# Version 0.5 validation

## What changed

Reddit extraction now separates title and selftext from comments, action controls,
usernames, and crossposts. Supported DOM families are `shreddit-post`, the redesign's
`data-testid="post-container"`, and old Reddit's `.thing.link[data-fullname]`.
Open shadow roots are traversed. A title-only media/link post is marked uncertain;
expanding a self-post causes a fresh analysis. Images and comments are not classified.

The model now answers two concrete questions about empty content and formulaic
rhetoric, with explicit positive/negative criteria. These prompts replaced five
broad questions that missed generic filler in measured examples. Engagement bait
is reported separately. Low substance and formulaic style share the main score;
correlated lexical signals share a maximum 10% contribution. A single punctuation
mark, list, or conditional is not enough. Repeated conditional/contrast patterns
and dashes can support agreement. The score is not a calibrated probability.

The helper validates typed `noul` answers instead of interpreting confidence in a
negative answer as P(true). Errors, missing context, and conflicting signals stay
uncertain. Text is split to the checkpoint's tokenizer budget, with all windows
scored and length-weighted. Page URLs and titles no longer displace the post text.
Inference is serialized to avoid overlapping MLX calls from multiple tabs.

## Automated coverage

- `npm ci && npm test`: extraction and scanner integration in jsdom, including
  modern/redesign/old Reddit, nested comments and crossposts, code and quotes,
  shadow DOM styles, expansion, stale results, threshold refresh, and manual rescan.
- `python3 -m unittest discover -s tests -v`: scoring, tokenizer windows, invalid
  model responses, and uncertain API outcomes. FastAPI dependencies are required.
- `python3 -m py_compile helper/*.py scripts/evaluate.py`
- `node --check extension/content.js` (and the other extension scripts).

## Runtime checks

All 37 automated tests passed (21 Python, 16 JavaScript). An additional real-model
HTTP check confirmed `not_flagged` for a concrete Reddit debugging question,
`slop` for formulaic promotion, and `uncertain` for a title-only post.
A 5,644-character input was split into two windows; token-level checks against
Laya's prepared inputs confirmed that neither window was silently truncated.
The same three-case request passed against the running 0.5.0 helper on port 8765.

## Real model evaluation

Run with the helper's Python environment on Apple Silicon:

```sh
helper/.venv/bin/python scripts/evaluate.py --output /tmp/slop-development.json
helper/.venv/bin/python scripts/evaluate.py --dataset tests/fixtures/holdout_cases.json --output /tmp/slop-holdout.json
```

On 2026-09-21, Laya multilingual with laya-mlx 0.1.0 and float16 was evaluated on
38 hand-authored English/Russian examples: 24 development cases and 14 separate
held-out cases. Threshold: 0.65. Before means the local pre-0.5 implementation,
including the earlier 0.4.3 changes. Per-case observations and source hashes are
in [evaluation-0.5.json](evaluation-0.5.json).

| Outcome across 38 cases | Before | 0.5 |
| --- | ---: | ---: |
| Slop detected out of 13 | 4 | 12 |
| Slop missed | 9 | 1 |
| Non-slop/incomplete posts incorrectly marked | 1 | 0 |

The false positive before the change was an explicitly incomplete post, which
should have received no verdict. The separate 14-case holdout contained 5 slop
posts: 0.5 detected 4, marked none of the 8 useful posts, and abstained on the
media title. `holdout_empty_business` remains a known false negative; its score
is 0.426. No rule or threshold was added just to make that holdout pass.

These small constructed sets are regression evidence, **not real-feed precision
or recall estimates**. Authorship was not tested. More naturally sampled,
independently labeled posts are needed to measure population accuracy.

## Browser limitations and manual check

A live Browser connection was unavailable during this validation, and a direct
public Reddit request returned a gate page. No live-feed visual pass is claimed.
DOM-to-helper-message-to-overlay behavior is covered by integration tests.

After reloading the unpacked extension and refreshing existing tabs, check:

1. Modern Reddit text posts and old.reddit.com expanded self-posts get scanned.
2. Post titles without selftext remain unmarked and increase Uncertain.
3. Expanding a post triggers a new analysis.
4. Scrolling/recycling posts never transfers a tape from a previous post.
5. Changing the threshold updates tape, current flagged count, and recent matches.
6. X and LinkedIn still scan authored commentary.

## Scanner 0.5.1 follow-up

A DOM container is not necessarily an eligible post. The scanner now reports
missing text, too-short text, and viewport exclusions separately. Boxless Reddit
hosts are evaluated using their rendered body/title, with the overlay attached to
a rendered element. Frequent mutations no longer postpone a scheduled scan.
Scanner versions are independent of the scoring protocol (still 0.5.0).
All 19 JavaScript tests passed, including boxless hosts and post-destroy results.
The particular user-reported tab was not accessible to the Browser tool, so its
exact failure mode has not been confirmed.

## Short-post fix, scoring revision 0.5.2

The user-reported post "Grok 4.7 works extremely well with our Build harness"
followed by "X.ai/Build" reproduced a false positive at 0.7264. The model assigned
0.7484 to low information and 0.8704 to templated style, despite no lexical cues.
The old minimum-length check counted both version components and URL fragments
as extra words. The text actually contains eight prose words.

Prose length now excludes URLs and numeric-only tokens. Posts below 12 prose
words remain uncertain; posts below 30 require supporting formula/CTA/repeated
rhetoric evidence before they can receive a style mark. This rule is independent
of product names and does not establish whether a short claim is true.

25 Python tests passed. A fresh five-case Laya run left the reported post, its
HTTPS variant, and two similar product opinions unmarked; an explicit short
formula-cluster post remained flagged. Re-scoring the saved outputs of the prior
38 cases introduced no new missed slop detections or false marks; three useful
posts changed from not_flagged to uncertain. The old 38-case model predictions
were reused for this deterministic scoring comparison, not re-generated.

## LinkedIn scanner 0.5.2 follow-up

The user-reported LinkedIn state (`DOM posts > 0`, `Scanned = 0`, visible cards
reported as `without readable post text`) reproduced the gap in the extractor:
the scanner could identify feed containers, but the current LinkedIn body uses
the semantic `data-testid="expandable-text-box"` node and newer feed cards can
use `role="listitem"` with `componentkey="update-card-focus…"`.

Scanner 0.5.2 now recognizes those feed roots and reads the authored body from
`expandable-text-box` / commentary test attributes before falling back to older
LinkedIn class names. The extractor still avoids reading the whole card so author
metadata, reactions, and action buttons do not become model input. LinkedIn's
minimum readable body is 20 characters.

The JavaScript DOM suite now contains 22 passing tests. New cases verify both the
2026 semantic LinkedIn card and the legacy LinkedIn layout, plus an end-to-end
scanner case where a semantic LinkedIn card reaches the helper and increments
`Scanned`. The helper suite remains 25/25 under `helper/.venv`.
