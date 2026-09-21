# Slop Finder

**Automatic local AI-slop style detection for X, LinkedIn, and Reddit.**

Slop Finder is a Chromium extension backed by a local [Laya-MLX](https://github.com/mizorewww/laya-mlx) helper. It watches social feeds as you scroll, scores post-writing style locally, and marks high-confidence matches with an animated tape overlay.

> The score is a **style-match confidence**, not proof that AI authored a post. Text-only AI authorship detection is inherently uncertain, so Slop Finder is intentionally calibrated for precision over recall.

## What it does

- Scans new posts automatically while scrolling.
- Supports **X / Twitter**, **LinkedIn**, and **Reddit**.
- Runs inference locally on Apple Silicon through MLX.
- No cloud API, no external scraping service, no page re-fetching.
- Uses multiple style dimensions rather than a single "AI or human" classifier.
- Applies a conservative consensus score to reduce false positives.
- Adds an animated "AI SLOP" tape only when the score crosses the configured threshold.
- Side panel shows scan counts, queue state, latency, and recent matches.

## Detection signals

Laya-MLX scores several independent dimensions:

- synthetic tone
- templated style
- low information density
- genericity
- engagement bait

Slop Finder also has a deliberately narrow deterministic pattern layer for recognizable mass-produced social-copy formulas.

The final score requires agreement between multiple signals. A short post cannot get a high score merely because one classifier thinks it sounds polished or synthetic.

Default threshold: **80%**.

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
  - extracts authored text
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
precision-first scoring layer
          |
          v
animated tape + side panel
```

The extension analyzes the DOM already rendered in your browser. It does not operate a remote crawler and does not bypass site authentication.

## Accuracy philosophy

Slop Finder optimizes for **fewer false positives**.

The scoring layer intentionally:

- downweights one-dimensional signals;
- requires agreement between synthetic tone and templated structure;
- caps scores for very short posts without explicit formula markers;
- boosts only narrow, recognizable slop-copy patterns;
- defaults to a relatively high 80% threshold.

This means some actual AI-written posts will not be flagged. That is intentional: writing style alone cannot reliably establish authorship.

## Privacy and local networking

Post text is sent only from the extension to the local helper on `127.0.0.1`.

The helper:

- listens on loopback only;
- allows browser-extension origins through CORS;
- does not contain a cloud analytics client;
- uses the locally cached MLX model after first download.

## Development

Static checks:

```bash
node --check extension/content.js
node --check extension/background.js
node --check extension/sidepanel.js
python3 -m py_compile helper/app.py helper/scoring.py
python3 -m unittest discover -s tests -v
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
