from __future__ import annotations

import os
import threading
import time
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from scoring import combine_slop_score, slop_pattern_score, stylometric_features

MODEL_NAME = os.getenv("LAYA_MODEL", "multilingual").strip().lower()
MODEL_SPECS = {
    "english": "aac6fef/laya-mlx",
    "multilingual": "aac6fef/laya-multilingual-mlx",
    "typed-decisions": "aac6fef/laya-typed-decisions-mlx",
}

if MODEL_NAME not in MODEL_SPECS:
    raise RuntimeError(
        f"Unknown LAYA_MODEL={MODEL_NAME!r}. "
        f"Choose one of: {', '.join(MODEL_SPECS)}"
    )

app = FastAPI(title="Slop Finder Local Helper", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.+$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_agent = None
_model_error: str | None = None
_model_lock = threading.Lock()


class Block(BaseModel):
    id: str
    text: str = Field(min_length=1, max_length=6000)
    tag: str | None = None
    site: str | None = None


class AnalyzeRequest(BaseModel):
    url: str = ""
    title: str = ""
    blocks: list[Block] = Field(min_length=1, max_length=24)


def questions() -> dict[str, Any]:
    return {
        "genericity": {
            "type": "noul",
            "instructions": (
                "Is the post unusually generic, vague, platitudinous, or low in concrete personal details, "
                "specific evidence, examples, names, numbers, or firsthand information?"
            ),
        },
        "templated_style": {
            "type": "noul",
            "instructions": (
                "Does the post use a conspicuously formulaic social-media template or LLM-like rhetorical "
                "structure, such as staged hooks, symmetrical bullet points, repeated sentence patterns, "
                "contrived contrasts, or predictable conclusion formulas?"
            ),
        },
        "synthetic_tone": {
            "type": "noul",
            "instructions": (
                "Does the prose have an unnaturally polished, homogenized, synthetic, or assistant-like tone "
                "that reads more like generated copy than an individual person's natural voice?"
            ),
        },
        "engagement_bait": {
            "type": "noul",
            "instructions": (
                "Is the post mainly engineered to harvest reactions, comments, reposts, or clicks through "
                "hooks, open loops, generic questions, forced controversy, or calls for engagement?"
            ),
        },
        "low_information": {
            "type": "noul",
            "instructions": (
                "Is there little substantive information relative to the amount of text, with filler, "
                "restatement, broad claims, or obvious advice dominating the post?"
            ),
        },
    }



def get_agent():
    global _agent, _model_error
    if _agent is not None:
        return _agent

    with _model_lock:
        if _agent is not None:
            return _agent

        try:
            import laya_mlx as laya

            checkpoint = MODEL_SPECS[MODEL_NAME]
            _agent = laya.load(
                checkpoint,
                dtype="float16",
                batch_size=16,
                cache_prompts=True,
            )
            _model_error = None
            return _agent
        except Exception as exc:
            _model_error = f"{type(exc).__name__}: {exc}"
            raise


def probability(answer: Any) -> float:
    if not isinstance(answer, dict):
        return 0.0

    for key in ("noul", "probability", "confidence"):
        value = answer.get(key)
        if isinstance(value, (int, float)):
            return max(0.0, min(1.0, float(value)))
    return 0.0


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "laya-mlx",
        "mode": "ai-slop",
        "model": MODEL_NAME,
        "checkpoint": MODEL_SPECS[MODEL_NAME],
        "loaded": _agent is not None,
        "last_error": _model_error,
        "note": "The MLX checkpoint is loaded lazily on the first analysis request.",
    }


@app.post("/warmup")
def warmup():
    started = time.perf_counter()
    try:
        get_agent()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not load Laya-MLX: {exc}") from exc

    return {
        "ok": True,
        "engine": "laya-mlx",
        "mode": "ai-slop",
        "model": MODEL_NAME,
        "checkpoint": MODEL_SPECS[MODEL_NAME],
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }


@app.post("/analyze")
def analyze(payload: AnalyzeRequest):
    try:
        agent = get_agent()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not load Laya-MLX: {exc}") from exc

    qs = questions()
    results = []
    started = time.perf_counter()

    for block in payload.blocks:
        state = {
            "context": "social media post",
            "site": block.site or "",
            "page_title": payload.title[:300],
            "page_url": payload.url[:1000],
            "element_tag": block.tag or "",
            "post_text": block.text.strip(),
        }

        try:
            raw = agent.predict(state, qs)
            answers = raw.get("answers", raw)
        except Exception as exc:
            results.append(
                {
                    "id": block.id,
                    "text": block.text,
                    "error": f"{type(exc).__name__}: {exc}",
                    "signals": {},
                    "risk": 0.0,
                }
            )
            continue

        signals = {name: probability(answers.get(name, {})) for name in qs}
        pattern_score = slop_pattern_score(block.text)
        structural = stylometric_features(block.text)
        signals["formula_patterns"] = round(pattern_score, 4)
        for key, value in structural.items():
            if key != "specificity":
                signals[key] = value
        risk = combine_slop_score(signals, pattern_score, block.text, structural)

        secondary = sorted(
            signals.items(),
            key=lambda item: item[1],
            reverse=True,
        )
        primary_label = secondary[0][0] if secondary else "ai_slop"

        results.append(
            {
                "id": block.id,
                "text": block.text,
                "tag": block.tag,
                "site": block.site,
                "signals": signals,
                "primary_label": primary_label,
                "risk": round(float(risk), 4),
            }
        )

    results.sort(key=lambda item: item.get("risk", 0.0), reverse=True)

    return {
        "ok": True,
        "engine": "laya-mlx",
        "mode": "ai-slop",
        "model": MODEL_NAME,
        "checkpoint": MODEL_SPECS[MODEL_NAME],
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "count": len(results),
        "results": results,
    }
