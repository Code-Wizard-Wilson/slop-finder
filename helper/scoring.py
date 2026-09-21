from __future__ import annotations

import re


def slop_pattern_score(text: str) -> float:
    """Return a deterministic 0..1 score for recognizable slop-copy formulas.

    This is deliberately narrow: a single generic phrase is weak evidence.
    Multiple independent formula markers are required for a strong score.
    """
    lower = text.lower()
    score = 0.0

    phrase_weights = {
        "nobody tells you": 0.18,
        "here is the truth": 0.14,
        "here's the truth": 0.14,
        "changed everything": 0.13,
        "uncomfortable truths": 0.18,
        "save this post": 0.18,
        "follow for more": 0.18,
        "adapt or get left behind": 0.16,
        "the future belongs to": 0.12,
        "agree?": 0.07,
        "thoughts?": 0.05,
        "what do you think?": 0.05,
        "никто не говорит": 0.18,
        "вот правда": 0.12,
        "изменило мою жизнь": 0.14,
        "изменила мою жизнь": 0.14,
        "сохрани этот пост": 0.18,
        "подпишись": 0.12,
        "согласны?": 0.07,
    }

    for phrase, weight in phrase_weights.items():
        if phrase in lower:
            score += weight

    if re.search(
        r"\b\d{1,2}\s+(lessons|truths|ways|things|rules|habits|tools|mistakes|steps)\b",
        lower,
    ):
        score += 0.18

    if re.search(
        r"\b\d{1,2}\s+(уроков|правил|ошибок|шагов|способов|инструментов)\b",
        lower,
    ):
        score += 0.18

    if re.search(r"it(?:'s| is) not about .{2,80}it(?:'s| is) about", lower):
        score += 0.18

    if re.search(r"дело не в .{2,80}(?:дело )?в", lower):
        score += 0.16

    beats = len(
        re.findall(r"\b[a-z][a-z -]{1,28} beats [a-z][a-z -]{1,28}", lower)
    )
    if beats >= 2:
        score += min(0.24, 0.08 * beats)

    numbered = len(re.findall(r"(?:^|\s)[1-9][.)]\s", text))
    if numbered >= 3:
        score += min(0.18, numbered * 0.035)

    return max(0.0, min(1.0, score))


def combine_slop_score(
    signals: dict[str, float], pattern_score: float, text: str
) -> float:
    """Combine Laya style dimensions into a conservative 0..0.99 score.

    The score is a *style-match* confidence, not a probability that AI authored
    the text. It is intentionally precision-first: high scores require
    agreement between independent dimensions, or strong explicit formula
    patterns.
    """
    synthetic = signals.get("synthetic_tone", 0.0)
    templated = signals.get("templated_style", 0.0)
    low_info = signals.get("low_information", 0.0)
    generic = signals.get("genericity", 0.0)
    engagement = signals.get("engagement_bait", 0.0)

    # Geometric means punish one-dimensional false positives. A post that is
    # merely polished, generic, or short should not score highly unless another
    # independent slop dimension agrees.
    style_consensus = (synthetic * templated) ** 0.5
    filler_consensus = (low_info * generic) ** 0.5

    semantic = (
        0.65 * style_consensus
        + 0.20 * filler_consensus
        + 0.10 * engagement
        + 0.05 * max(low_info, generic)
    )

    # Explicit formula markers are strong evidence of slop STYLE. They still do
    # not prove authorship, hence the cap below 1.0.
    pattern_component = min(0.92, pattern_score * 2.0)
    score = 1.0 - (1.0 - semantic) * (1.0 - pattern_component)

    compact = " ".join(text.split())

    # Short posts simply do not contain enough stylistic evidence.
    if len(compact) < 80 and pattern_score < 0.20 and style_consensus < 0.70:
        score = min(score, 0.38)
    elif len(compact) < 120 and pattern_score < 0.15 and style_consensus < 0.70:
        score = min(score, 0.55)

    # Without an explicit pattern, demand agreement between synthetic tone and
    # templated structure before allowing a high score.
    if pattern_score < 0.12 and style_consensus < 0.42:
        score = min(score, 0.62)

    return max(0.0, min(0.99, score))
