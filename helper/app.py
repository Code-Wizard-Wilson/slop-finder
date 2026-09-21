from __future__ import annotations

import os
import threading
import time
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from scoring import combine_slop_score, slop_pattern_score, stylometric_features, decision_for
from inference import predict_signals

SCORING_VERSION = "0.5.0"
SCORING_REVISION = "0.5.2"
MODEL_NAME = os.getenv("LAYA_MODEL", "multilingual").strip().lower()
MLX_CACHE_LIMIT_MB = max(0, int(os.getenv("MLX_CACHE_LIMIT_MB", "512")))
MLX_CACHE_LIMIT_BYTES = MLX_CACHE_LIMIT_MB * 1024 * 1024
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

app = FastAPI(title="Slop Finder Local Helper", version="0.5.2")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^(chrome-extension|moz-extension)://.+$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_agent = None
_mx = None
_model_error: str | None = None
_model_lock = threading.Lock()
_inference_lock = threading.Lock()


class Block(BaseModel):
    id: str
    text: str = Field(min_length=1, max_length=6000)
    tag: str | None = None
    site: str | None = None
    text_scope: Literal["post", "title_only"] = "post"
    truncated: bool = False


class AnalyzeRequest(BaseModel):
    url: str = ""
    title: str = ""
    blocks: list[Block] = Field(min_length=1, max_length=24)


def questions() -> dict[str, Any]:
    return {
        "low_information": {
            "type": "noul",
            "instructions": "Does this text mostly consist of vague advice, empty motivational slogans, or generic promotional filler?",
            "criteria": {
                "false": "Concrete information, personal experience, an actual question, or a specific opinion.",
                "true": "Mostly generic slogans or inflated empty prose with no useful substance.",
            },
        },
        "templated_style": {
            "type": "noul",
            "instructions": "Does the text use repeated motivational slogans, generic business language, or formulaic promotional rhetoric?",
            "criteria": {
                "false": "Natural conversation, specific information, a help request, or a factual explanation.",
                "true": "Boilerplate promotional or motivational copy, repetitive slogans, generic business filler.",
            },
        },
        "engagement_bait": {
            "type": "noul",
            "instructions": "Does this text use clickbait or engagement bait instead of offering useful content?",
        },
    }


def get_agent():
    global _agent, _mx, _model_error
    if _agent is not None:
        return _agent

    with _model_lock:
        if _agent is not None:
            return _agent

        try:
            import mlx.core as mx
            import laya_mlx as laya

            _mx = mx
            # MLX keeps unused Metal buffers in a free cache by default. For a
            # background browser helper this can otherwise grow to many GB over
            # a long scrolling session. This limit affects only *free cached*
            # buffers; active model/inference memory is not constrained by it.
            mx.set_cache_limit(MLX_CACHE_LIMIT_BYTES)

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


def mlx_memory() -> dict[str, int | float | None]:
    if _mx is None:
        return {
            "active_bytes": None,
            "cache_bytes": None,
            "peak_bytes": None,
            "cache_limit_bytes": MLX_CACHE_LIMIT_BYTES,
        }
    return {
        "active_bytes": int(_mx.get_active_memory()),
        "cache_bytes": int(_mx.get_cache_memory()),
        "peak_bytes": int(_mx.get_peak_memory()),
        "cache_limit_bytes": MLX_CACHE_LIMIT_BYTES,
    }


def trim_mlx_cache_if_needed() -> None:
    if _mx is None:
        return
    # set_cache_limit() reclaims on subsequent allocations. Explicitly clear
    # only when the free cache is already above our target after a request.
    if _mx.get_cache_memory() > MLX_CACHE_LIMIT_BYTES:
        _mx.clear_cache()


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "laya-mlx",
        "scoring_version": SCORING_VERSION,
        "scoring_revision": SCORING_REVISION,
        "mode": "ai-slop",
        "model": MODEL_NAME,
        "checkpoint": MODEL_SPECS[MODEL_NAME],
        "loaded": _agent is not None,
        "mlx_cache_limit_mb": MLX_CACHE_LIMIT_MB,
        "last_error": _model_error,
        "note": "The MLX checkpoint is loaded lazily on the first analysis request.",
    }


@app.get("/memory")
def memory():
    return {
        "ok": True,
        "engine": "laya-mlx",
        "scoring_version": SCORING_VERSION,
        "scoring_revision": SCORING_REVISION,
        "model": MODEL_NAME,
        **mlx_memory(),
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
        "scoring_version": SCORING_VERSION,
        "scoring_revision": SCORING_REVISION,
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
        try:
            with _inference_lock:
                try:
                    signals, window_count = predict_signals(agent, block.text.strip(), qs)
                finally:
                    trim_mlx_cache_if_needed()
        except Exception as exc:
            results.append({
                "id": block.id, "text": block.text,
                "error": f"{type(exc).__name__}: {exc}",
                "signals": {}, "risk": None,
                "decision": "uncertain", "reasons": ["analysis_failed"],
            })
            continue

        pattern_score = slop_pattern_score(block.text)
        structural = stylometric_features(block.text)
        signals["formula_patterns"] = round(pattern_score, 4)
        for key, value in structural.items():
            if key != "specificity":
                signals[key] = value
        risk = combine_slop_score(signals, pattern_score, block.text, structural)

        decision, reasons = decision_for(block.text, signals, risk,
            truncated=block.truncated, text_scope=block.text_scope)

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
                "decision": decision,
                "reasons": reasons,
                "window_count": window_count,
                "text_scope": block.text_scope,
                "truncated": block.truncated,
            }
        )

    results.sort(key=lambda item: item.get("risk") or 0.0, reverse=True)

    return {
        "ok": True,
        "engine": "laya-mlx",
        "scoring_version": SCORING_VERSION,
        "scoring_revision": SCORING_REVISION,
        "mode": "ai-slop",
        "model": MODEL_NAME,
        "checkpoint": MODEL_SPECS[MODEL_NAME],
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        "count": len(results),
        "results": results,
    }
