"""Token-budgeted inference and strict interpretation of Laya's typed answers."""
from __future__ import annotations

import math
from typing import Any, Callable


def probability(answer: Any) -> float:
    # confidence describes certainty in either answer, not P(true).
    if not isinstance(answer, dict):
        raise ValueError("Missing typed model answer")
    value = answer.get("noul")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Missing noul probability")
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Invalid noul probability")
    return float(value)


def split_for_budget(text: str, count_tokens: Callable[[str], int], budget: int) -> list[str]:
    """Keep every character while fitting each window in the actual tokenizer budget."""
    if budget < 16:
        raise ValueError("Model context budget is too small")
    remaining, chunks = text, []
    while remaining:
        if count_tokens(remaining) <= budget:
            chunks.append(remaining)
            break
        low, high = 1, len(remaining)
        while low < high:
            mid = (low + high + 1) // 2
            if count_tokens(remaining[:mid]) <= budget:
                low = mid
            else:
                high = mid - 1
        cut = low
        # Prefer a paragraph/sentence/word boundary without dropping content.
        for separator in ("\n\n", ". ", "! ", "? ", "\n", " "):
            boundary = remaining.rfind(separator, cut // 2, cut)
            if boundary >= 0:
                cut = boundary + len(separator)
                break
        chunk = remaining[:cut]
        while count_tokens(chunk) > budget and cut > 1:
            cut -= 1
            chunk = remaining[:cut]
        if count_tokens(chunk) > budget:
            raise ValueError("A character exceeds the model token budget")
        chunks.append(chunk)
        remaining = remaining[cut:]
    return chunks


def predict_signals(agent: Any, text: str, questions: dict) -> tuple[dict[str, float], int]:
    # The old state put URL/title before text, which consumed the context budget.
    # Question head + special tokens are reserved; only authored text is state.
    budget = int(agent.cfg.get("max_len", 512)) - int(agent.cfg.get("head_max_len", 192)) - 16
    chunks = split_for_budget(text, lambda s: len(agent.tok(s, add_special_tokens=False)["input_ids"]), budget)
    if not chunks:
        raise ValueError("No authored text")
    sums = dict.fromkeys(questions, 0.0)
    total = 0
    for chunk in chunks:
        raw = agent.predict(chunk, questions)
        if not isinstance(raw, dict) or not isinstance(raw.get("answers"), dict):
            raise ValueError("Invalid model response")
        answers = raw["answers"]
        # Length-weighted evidence prevents a stock introduction from overriding
        # a substantive body; a long filler body cannot hide behind a good hook.
        weight = max(1, len(chunk.strip()))
        for name in questions:
            sums[name] += probability(answers.get(name)) * weight
        total += weight
    return {name: value / total for name, value in sums.items()}, len(chunks)
