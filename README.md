# Slop Finder

**Automatic local AI-slop style detection for X, LinkedIn, and Reddit.**

Slop Finder is a Chromium extension backed by a local [Laya-MLX](https://github.com/mizorewww/laya-mlx) helper. It watches social feeds as you scroll, scores post-writing style locally, and marks strong style matches with an animated tape overlay.

> The score is a **heuristic style-match score**, not proof that AI authored a post. Text-only AI authorship detection is inherently uncertain, so Slop Finder is designed to abstain when context is insufficient.

## Demo

[▶ Watch Slop Finder in action](docs/slop-finder-demo.mp4)

## What it does

- Scans new posts automatically while scrolling.
- Supports **X / Twitter**, **LinkedIn**, and **Reddit**.
- Runs inference locally on Apple Silicon through MLX.
- No cloud API, no external scraping service, no page re-fetching.
- Uses multiple style dimensions rather than a single "AI or human" classifier.
- Applies a conservative consensus score to reduce false positives.
- Adds an animated "AI SLOP" tape only when the score crosses the configured threshold.
- Side panel shows scan counts, queue state, latency, and recent matches.

## Detection logic

Laya-MLX assesses **low information content** and **formulaic rhetoric** using
explicit criteria. Both must support the result. Engagement bait is also shown
as a diagnostic signal.

Lexical formulas, repetition, repeated English/Russian conditionals and contrasts
provide a capped supporting contribution. Repeated long dashes only support
already agreeing signals. Lists, polished writing, or a single dash do not
independently convict a post. Quotes and code are excluded from these lexical rules.

Scores are **heuristic points out of 100**, not probabilities. The default marking
threshold is **65/100**. Short, title-only, truncated, conflicting, or failed
analyses remain uncertain and are not taped, even if the threshold is lowered.

## Reddit support

- Modern Reddit (`shreddit-post`), the redesign's post containers, and old.reddit.com.
- Title and selftext extraction without comments, vote counts, usernames, or crosspost text.
- Re-analysis when selftext expands or a feed node changes.
- Open shadow-root traversal and tape styles.
- Title-only link/image posts remain uncertain. Images and comments are not classified.

## Requirements

- Apple Silicon Mac
- macOS 14+
- Python 3.11+
- Chrome, Edge, or another Chromium browser
- Internet access once to download the MLX checkpoint

The default model is:

```text
aac6fef/laya-multilingual-mlx
```

Model weights are downloaded from Hugging Face on first use and cached locally.

## Install

Clone the repository:

```bash
git clone https://github.com/Code-Wizard-Wilson/slop-finder.git
cd slop-finder
```

Install the local helper:

```bash
cd helper
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

The helper binds only to:

```text
127.0.0.1:8765
```

Then install the browser extension:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension/` folder.
5. Open X, LinkedIn, or Reddit and scroll.

No Analyze button is required.

## Optional model selection

The multilingual MLX checkpoint is the default.

```bash
LAYA_MODEL=multilingual ./run.sh
LAYA_MODEL=english ./run.sh
LAYA_MODEL=typed-decisions ./run.sh
```

## Architecture

```text
X / LinkedIn / Reddit DOM
          |
          v
Chromium content script
  - finds post containers
  - extraction.js separates authored text
  - watches DOM mutations
          |
          v
extension service worker
          |
          v
127.0.0.1:8765
          |
          v
Laya-MLX
  - semantic style dimensions
          +
semantic + capped structural scoring layer
          |
          v
animated tape + side panel
```

The extension analyzes the DOM already rendered in your browser. It does not operate a remote crawler and does not bypass site authentication.

## Accuracy and evaluation

The detector aims to reduce false positives without relying on a phrase blacklist.
It scores the complete supplied text in tokenizer-sized windows instead of silently
losing the end of longer posts. Multiple tabs share serialized model inference.

A small real-model regression run improved slop detections from **4/13 to 12/13**
across 38 constructed examples, and incorrect marks from **1 to 0**. These numbers
are not estimates of real-feed accuracy. One held-out generic business post still
went undetected. See [validation, limitations, and reproduction commands](docs/VALIDATION.md).

## Privacy and local networking

Post text is sent only from the extension to the local helper on `127.0.0.1`.

The helper:

- listens on loopback only;
- allows browser-extension origins through CORS;
- does not contain a cloud analytics client;
- uses the locally cached MLX model after first download.

## Memory usage

Slop Finder limits the free MLX/Metal allocator cache to **512 MB** by default so long feed-scanning sessions do not retain many gigabytes of unused GPU/unified-memory buffers. This does not cap active model memory.

Override the cache target when starting the helper:

```bash
MLX_CACHE_LIMIT_MB=256 ./run.sh
MLX_CACHE_LIMIT_MB=1024 ./run.sh
```

Inspect MLX memory from the running helper:

```bash
curl http://127.0.0.1:8765/memory
```

The endpoint reports active, free-cache, and peak MLX memory in bytes.

## Development

Static checks:

```bash
node --check extension/extraction.js
node --check extension/content.js
node --check extension/background.js
node --check extension/sidepanel.js
python3 -m py_compile helper/app.py helper/scoring.py helper/inference.py scripts/evaluate.py
python3 -m unittest discover -s tests -v
npm ci
npm test
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

Warm the model:

```bash
curl -X POST http://127.0.0.1:8765/warmup
```

## Credits

- [Laya](https://github.com/NandhaKishorM/laya) by Convai Innovations and upstream contributors
- [laya-mlx](https://github.com/mizorewww/laya-mlx) by mizorewww

Slop Finder is an independent project and is not affiliated with X, LinkedIn, Reddit, Convai Innovations, or the Laya-MLX author.

## License

MIT. See [LICENSE](LICENSE).
