from __future__ import annotations

import math
import re
from collections import Counter


WORD_RE = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*", re.UNICODE)
URL_RE = re.compile(r"https?://|www\.|\b[a-z0-9-]+\.(?:com|org|net|dev|io|ai|app|me)\b", re.I)


def _clip(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _matches(text: str, patterns: list[str]) -> int:
    lower = text.lower()
    return sum(1 for pattern in patterns if pattern in lower)


def authored_prose(text: str) -> str:
    """Exclude explicit quotations/code from lexical evidence, not model context."""
    text = re.sub(r"```[\s\S]*?```|`[^`\n]+`", " ", text)
    text = re.sub(r"(?m)^\s*>.*$", " ", text)
    return re.sub(r'"[^"\n]*"|“[^”]*”|«[^»]*»', " ", text)


# Links and version components are not additional prose context. Keep the full
# original text for the model; use this only to decide whether a style verdict
# has enough evidence to be displayed.
LINK_RE = re.compile(
    r"(?:https?://|www\.)[^\s<>]+|"
    r"(?<![\w@])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:/[^\s<>]*)?",
    re.I,
)


def prose_word_count(text: str) -> int:
    prose = LINK_RE.sub(" ", authored_prose(text))
    return sum(any(char.isalpha() for char in word) for word in WORD_RE.findall(prose))


def short_text_is_unsupported(text: str, structural: dict[str, float], pattern_score: float) -> bool:
    count = prose_word_count(text)
    if count < 12:
        return True
    # For short messages, a model's impression of tone alone is unreliable.
    # Repeated rhetoric or explicit formula clusters can corroborate it; normal
    # punctuation, a list, and a product link cannot.
    support = max(pattern_score, structural.get("cta_bait", 0.0),
                  structural.get("conditional_template", 0.0),
                  structural.get("contrast_template", 0.0))
    return count < 30 and support < 0.30


def rhetorical_features(text: str) -> dict[str, float]:
    prose = authored_prose(text).lower().replace("’", "'")
    conditionals = len(re.findall(
        r"\b(?:if\b[^.!?\n]{3,100}\bthen\b|если\b[^.!?\n]{3,100}\bто\b)", prose))
    contrasts = len(re.findall(
        r"\b(?:not\s+[^.!?\n]{2,80}?\bbut\b|не\s+[^.!?\n]{2,80}?\bа\b|"
        r"it(?:'s| is) not about[^.!?\n]{2,80}[.!?]?\s*it(?:'s| is) about|"
        r"дело не в[^.!?\n]{2,80}?\bа в)", prose))
    # Typography and a single conditional are weak evidence in every language.
    words = len(WORD_RE.findall(prose))
    dashes = len(re.findall(r"[—–]", prose))
    dash_style = min(0.25, max(0, dashes - 1) / max(words, 40) * 3)
    return {
        "conditional_template": round(min(0.65, conditionals * 0.10 + max(0, conditionals - 1) * 0.15), 4),
        "contrast_template": round(min(0.75, contrasts * 0.18), 4),
        "dash_style": round(dash_style, 4),
    }


def slop_pattern_score(text: str) -> float:
    """Narrow score for recognizable mass-produced social-copy formulas."""
    text = authored_prose(text)
    lower = text.lower()
    score = 0.0

    phrase_weights = {
        "nobody tells you": 0.18,
        "no one tells you": 0.16,
        "here is the truth": 0.14,
        "here's the truth": 0.14,
        "here’s the truth": 0.14,
        "the truth is": 0.08,
        "changed everything": 0.13,
        "uncomfortable truths": 0.18,
        "save this post": 0.18,
        "bookmark this": 0.14,
        "follow for more": 0.18,
        "repost this": 0.14,
        "share this with": 0.12,
        "comment below": 0.12,
        "adapt or get left behind": 0.16,
        "the future belongs to": 0.12,
        "let that sink in": 0.12,
        "agree?": 0.07,
        "thoughts?": 0.05,
        "what do you think?": 0.05,
        "here's what i learned": 0.12,
        "here’s what i learned": 0.12,
        "here's why": 0.08,
        "here’s why": 0.08,
        "let's break it down": 0.12,
        "let’s break it down": 0.12,
        "the takeaway": 0.08,
        "game changer": 0.08,
        "game-changer": 0.08,
        "unlock your": 0.10,
        "unlock the": 0.07,
        "supercharge": 0.08,
        "revolutionize": 0.07,
        "никто не говорит": 0.18,
        "вот правда": 0.12,
        "правда в том": 0.08,
        "изменило мою жизнь": 0.14,
        "изменила мою жизнь": 0.14,
        "сохрани этот пост": 0.18,
        "подпишись": 0.12,
        "согласны?": 0.07,
        "что думаете?": 0.05,
        "давайте разбер": 0.10,
    }

    for phrase, weight in phrase_weights.items():
        if phrase in lower:
            score += weight

    listicle_patterns = [
        r"\b\d{1,2}\s+(lessons|truths|ways|things|rules|habits|tools|mistakes|steps|tips|secrets)\b",
        r"\b\d{1,2}\s+(уроков|правил|ошибок|шагов|способов|инструментов|советов|секретов)\b",
    ]
    if any(re.search(pattern, lower) for pattern in listicle_patterns):
        score += 0.18

    if re.search(r"it(?:'s| is) not about .{2,90}it(?:'s| is) about", lower):
        score += 0.18
    if re.search(r"you (?:do not|don't) need .{2,80}you need", lower):
        score += 0.16
    if re.search(r"дело не в .{2,90}(?:дело )?в", lower):
        score += 0.16

    beats = len(
        re.findall(r"\b[a-z][a-z -]{1,28} beats [a-z][a-z -]{1,28}", lower)
    )
    if beats >= 2:
        score += min(0.24, 0.08 * beats)

    numbered = len(re.findall(r"(?:^|\s)[1-9][.)]\s", text))
    if numbered >= 3:
        score += min(0.18, numbered * 0.035)

    return _clip(score)


def stylometric_features(text: str) -> dict[str, float]:
    """Cheap local signals aimed at *slop style*, not authorship."""
    text = authored_prose(text)
    compact = " ".join(text.split())
    lower = compact.lower()
    words = WORD_RE.findall(lower)
    word_count = len(words)

    # Repeated n-grams / repetitive phrasing.
    repetition = 0.0
    if word_count >= 18:
        bigrams = list(zip(words, words[1:]))
        trigrams = list(zip(words, words[1:], words[2:]))
        repeated_bigrams = sum(v - 1 for v in Counter(bigrams).values() if v > 1)
        repeated_trigrams = sum(v - 1 for v in Counter(trigrams).values() if v > 1)
        repetition = _clip(
            (repeated_bigrams / max(1, len(bigrams))) * 4.0
            + (repeated_trigrams / max(1, len(trigrams))) * 6.0
        )

    # List / bullet cadence.
    numbered = len(re.findall(r"(?:^|[\n ])\d{1,2}[.)]\s+", text))
    bullets = len(re.findall(r"(?:^|\n)\s*[-•*]\s+", text))
    colon_list = bool(re.search(r":\s*(?:[-•*]|\d+[.)])", text))
    listicle = _clip(numbered * 0.16 + bullets * 0.12 + (0.18 if colon_list else 0.0))

    # Calls to action / engagement farming.
    cta_phrases = [
        "save this", "bookmark this", "follow for more", "repost", "retweet",
        "share this", "comment below", "drop a comment", "drop your", "agree?",
        "thoughts?", "what do you think", "link below", "dm me", "tag someone",
        "сохрани", "подпишись", "репост", "пиши в комментар", "согласны?",
        "что думаете", "ссылка ниже",
    ]
    cta = _clip(_matches(lower, cta_phrases) * 0.22)

    # Generic hype language that frequently appears in mass-produced copy.
    buzzwords = [
        "game changer", "game-changing", "revolutionary", "revolutionize",
        "unlock", "supercharge", "transform your", "next level", "incredible",
        "powerful", "seamless", "seamlessly", "ultimate guide", "secret sauce",
        "crush it", "skyrocket", "must-have", "mind-blowing", "insane results",
        "changing everything", "future is here", "don't miss", "do not miss",
        "прорыв", "революцион", "изменит всё", "меняет всё", "не пропусти",
        "секрет успеха", "новый уровень",
    ]
    buzzword_score = _clip(_matches(lower, buzzwords) * 0.13)

    # Regular sentence cadence is only a weak signal. It matters when there are
    # enough sentences and their lengths are suspiciously uniform.
    sentences = [
        WORD_RE.findall(part.lower())
        for part in re.split(r"[.!?]+|\n+", text)
        if len(WORD_RE.findall(part.lower())) >= 3
    ]
    cadence = 0.0
    if len(sentences) >= 4:
        lengths = [len(s) for s in sentences]
        mean = sum(lengths) / len(lengths)
        variance = sum((x - mean) ** 2 for x in lengths) / len(lengths)
        cv = math.sqrt(variance) / max(mean, 1.0)
        cadence = _clip((0.48 - cv) / 0.38)

    # Concrete grounding is negative evidence. It is intentionally capped:
    # generated promo copy can also contain numbers and links.
    specificity = 0.0
    if URL_RE.search(text):
        specificity += 0.18
    number_hits = len(re.findall(r"(?<!\w)(?:[$€£₽]?\d+(?:[.,]\d+)?%?|\d+(?:ms|s|gb|mb|kb|x))\b", lower))
    specificity += min(0.24, number_hits * 0.06)
    code_hits = len(
        re.findall(
            r"\b(?:[a-z]+_[a-z0-9_]+|(?-i:[a-z]+[A-Z][A-Za-z0-9]*)|[\w.-]+\.(?:py|js|ts|tsx|jsx|json|csv|md|swift)|api|sdk|github|commit|parser|regression test|endpoint|latency|benchmark)\b",
            text,
            re.I,
        )
    )
    specificity += min(0.22, code_hits * 0.055)
    firsthand = _matches(
        lower,
        [
            "i built", "i fixed", "i debugged", "i tested", "i shipped", "i ported",
            "i measured", "i found", "i added", "i spent", "we built", "we fixed",
            "we tested", "мы сделали", "я сделал", "я починил", "я проверил",
        ],
    )
    specificity += min(0.18, firsthand * 0.07)
    specificity = _clip(specificity)

    return {
        "repetition": round(repetition, 4),
        "listicle": round(listicle, 4),
        "cta_bait": round(cta, 4),
        "buzzword_hype": round(buzzword_score, 4),
        "regular_cadence": round(cadence, 4),
        "specificity": round(specificity, 4),
        **rhetorical_features(text),
    }


def combine_slop_score(
    signals: dict[str, float],
    pattern_score: float,
    text: str,
    structural: dict[str, float] | None = None,
) -> float:
    """Heuristic style score, not an authorship or calibrated probability.

    Low substance and formulaic rhetoric must agree. Correlated lexical features
    share a capped contribution instead of each earning another bonus.
    """
    structural = structural if structural is not None else stylometric_features(text)
    low_info = _clip(signals.get("low_information", 0.0))
    templated = _clip(signals.get("templated_style", 0.0))
    semantic = math.sqrt(low_info * templated)
    rhetoric = max(structural.get("conditional_template", 0.0),
                   structural.get("contrast_template", 0.0))
    lexical = max(_clip(pattern_score), structural.get("cta_bait", 0.0),
                  0.5 * structural.get("buzzword_hype", 0.0),
                  0.5 * structural.get("repetition", 0.0), 0.5 * rhetoric)
    score = 0.90 * semantic + 0.10 * lexical
    if low_info >= 0.5 and templated >= 0.5 and rhetoric >= 0.35:
        score += min(0.02, structural.get("dash_style", 0.0) * 0.08)

    # Lack of text is uncertainty, not evidence of low-quality writing.
    if short_text_is_unsupported(text, structural, pattern_score):
        score = min(score, 0.39)
    return round(_clip(score), 4)


def decision_for(text: str, signals: dict[str, float], risk: float,
                 *, truncated: bool = False, text_scope: str = "post") -> tuple[str, list[str]]:
    reasons = []
    if truncated:
        reasons.append("incomplete_text")
    if text_scope == "title_only":
        reasons.append("title_only")
    if prose_word_count(text) < 12:
        reasons.append("too_short")
    elif short_text_is_unsupported(text, stylometric_features(text), slop_pattern_score(text)):
        reasons.append("insufficient_style_evidence")
    low = signals.get("low_information", 0.0)
    style = signals.get("templated_style", 0.0)
    if abs(low - style) > 0.55:
        reasons.append("conflicting_signals")
    if reasons:
        return "uncertain", reasons
    return ("slop" if risk >= 0.65 else "not_flagged"), []
