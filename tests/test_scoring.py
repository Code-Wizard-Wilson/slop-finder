import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "helper"))

from scoring import combine_slop_score, slop_pattern_score, stylometric_features, decision_for, prose_word_count  # noqa: E402


class ScoringRegressionTests(unittest.TestCase):
    def test_short_casual_post_stays_low(self):
        score = combine_slop_score(
            {
                "genericity": 0.0106,
                "templated_style": 0.1655,
                "synthetic_tone": 0.0476,
                "engagement_bait": 0.0260,
                "low_information": 0.0298,
            },
            0.0,
            "this is my github if you care",
        )
        self.assertLess(score, 0.25)

    def test_factual_post_stays_low(self):
        score = combine_slop_score(
            {
                "genericity": 0.0084,
                "templated_style": 0.1458,
                "synthetic_tone": 0.0876,
                "engagement_bait": 0.0201,
                "low_information": 0.0221,
            },
            0.0,
            "Apple is giving iCloud+ subscribers a discount on Apple Music.",
        )
        self.assertLess(score, 0.25)

    def test_one_dimensional_synthetic_signal_does_not_convict(self):
        score = combine_slop_score(
            {
                "genericity": 0.0949,
                "templated_style": 0.1328,
                "synthetic_tone": 0.5494,
                "engagement_bait": 0.0289,
                "low_information": 0.0321,
            },
            0.0,
            "This is cool https://inspora.design",
        )
        self.assertLess(score, 0.40)

    def test_short_announcement_is_not_convicted_by_model_consensus(self):
        score = combine_slop_score(
            {
                "genericity": 0.8226,
                "templated_style": 0.9925,
                "synthetic_tone": 0.9989,
                "engagement_bait": 0.9283,
                "low_information": 0.9508,
            },
            0.0,
            (
                "Introducing a version 50 times faster, running on your device. "
                "Here is everything you need to know."
            ),
        )
        self.assertLess(score, 0.4)

    def test_formulaic_copy_gets_pattern_boost(self):
        text = (
            "I spent 10 years learning this so you do not have to. "
            "Here are 7 uncomfortable truths that will transform your life. "
            "Save this post for later and follow for more."
        )
        pattern = slop_pattern_score(text)
        score = combine_slop_score(
            {
                "genericity": 0.0607,
                "templated_style": 0.75,
                "synthetic_tone": 0.4707,
                "engagement_bait": 0.1213,
                "low_information": 0.85,
            },
            pattern,
            text,
        )
        self.assertGreater(pattern, 0.40)
        self.assertGreater(score, 0.65)

    def test_formulaic_post_with_semantic_disagreement_is_not_forced_high(self):
        text = (
            "AI is not replacing humans. Humans using AI are replacing humans who do not. "
            "The future is already here. Adapt or get left behind. "
            "Here are 5 tools everyone should master in 2026."
        )
        pattern = slop_pattern_score(text)
        structural = stylometric_features(text)
        score = combine_slop_score(
            {
                "genericity": 0.0149,
                "templated_style": 0.1898,
                "synthetic_tone": 0.5450,
                "engagement_bait": 0.0302,
                "low_information": 0.0921,
            },
            pattern,
            text,
            structural,
        )
        self.assertLess(score, 0.65)

    def test_specific_technical_post_stays_below_threshold(self):
        text = (
            "Spent 40 minutes debugging why the parser failed only on one CSV. "
            "Turned out row 1842 had a stray quote inside a vendor name. "
            "Added a regression test and pushed the fix."
        )
        structural = stylometric_features(text)
        score = combine_slop_score(
            {
                "genericity": 0.0052,
                "templated_style": 0.0657,
                "synthetic_tone": 0.0137,
                "engagement_bait": 0.0169,
                "low_information": 0.0087,
            },
            slop_pattern_score(text),
            text,
            structural,
        )
        self.assertLess(score, 0.30)

    def test_quoted_formulas_do_not_convict(self):
        text = ('I am studying manipulative calls to action: "Save this post", '
                '"follow for more", and "bookmark this". These are examples to avoid.')
        self.assertEqual(slop_pattern_score(text), 0)
        self.assertLess(combine_slop_score({}, slop_pattern_score(text), text), 0.4)

    def test_formulas_cannot_override_zero_model_support(self):
        text = "Save this post. Follow for more. Bookmark this."
        self.assertLess(combine_slop_score({}, slop_pattern_score(text), text), 0.65)

    def test_ordinary_words_are_not_camel_case(self):
        self.assertEqual(stylometric_features(
            "Ordinary people discuss ordinary events every morning.")["specificity"], 0)
        self.assertGreater(stylometric_features("parseResponse request_id API")["specificity"], 0)

    def test_single_conditional_and_dash_do_not_convict(self):
        for text in ("If the file exists, then open it — otherwise create it.",
                     "Если файл существует, то откройте его — иначе создайте."):
            features = stylometric_features(text)
            self.assertGreater(features["conditional_template"], 0)
            self.assertEqual(features["dash_style"], 0)
            self.assertLess(combine_slop_score({}, slop_pattern_score(text), text), 0.4)

    def test_repeated_rhetoric_supports_semantic_evidence(self):
        text = ("If you want success, then take action — your future awaits. "
                "If you want freedom, then change your mindset — everything follows. "
                "If you want growth, then embrace change — the time is now.")
        features = stylometric_features(text)
        self.assertGreaterEqual(features["conditional_template"], 0.35)
        self.assertGreater(features["dash_style"], 0)
        signals = dict(templated_style=0.6, synthetic_tone=0.6,
                       genericity=0.6, low_information=0.6, engagement_bait=0.4)
        self.assertGreater(combine_slop_score(signals, 0, text, features),
                           combine_slop_score(signals, 0, text, {}))

    def test_code_and_quotes_do_not_supply_rhetorical_evidence(self):
        for text in ('«Если хочешь успеха, то работай — не завтра, а сегодня».',
                     '> If you want success, then act — not tomorrow, but today.',
                     '```If this happens, then do that — not this, but that.```'):
            features = stylometric_features(text)
            self.assertEqual(features["conditional_template"], 0)
            self.assertEqual(features["contrast_template"], 0)

    def test_repeated_russian_contrasts(self):
        features = stylometric_features("Не слова, а действия. Не страх, а смелость. Не завтра, а сегодня.")
        self.assertGreaterEqual(features["contrast_template"], 0.35)

    def test_reported_product_post_is_not_flagged(self):
        text = "Grok 4.7 works extremely well with our Build harness\nX.ai/Build"
        # Actual probabilities returned by Laya for the user's reported example.
        signals = {"low_information": 0.7484, "templated_style": 0.8704, "engagement_bait": 0.113}
        risk = combine_slop_score(signals, slop_pattern_score(text), text)
        self.assertEqual(prose_word_count(text), 8)
        self.assertLess(risk, 0.4)
        self.assertEqual(decision_for(text, signals, risk)[0], "uncertain")

    def test_links_versions_and_numbers_do_not_supply_prose_context(self):
        for suffix in ("X.ai/Build", "https://x.ai/Build", "https://example.com/a/b?x=123", "v4.7 100 200 300"):
            text = "This worked well for our project. " + suffix
            signals = {"low_information": 0.99, "templated_style": 0.99}
            risk = combine_slop_score(signals, slop_pattern_score(text), text)
            self.assertLess(risk, 0.4)
            self.assertEqual(decision_for(text, signals, risk)[0], "uncertain")

    def test_short_product_opinions_need_more_than_model_tone(self):
        for text in (
            "The latest model works extremely well with our build harness and handles the integration tests better than the previous version.",
            "Новая модель хорошо работает с нашей системой сборки и лучше предыдущей версии справляется с тестами интеграции.",
        ):
            signals = {"low_information": 0.95, "templated_style": 0.95}
            risk = combine_slop_score(signals, slop_pattern_score(text), text)
            self.assertLess(risk, 0.4)
            self.assertIn("insufficient_style_evidence", decision_for(text, signals, risk)[1])

    def test_short_formula_cluster_still_can_be_flagged(self):
        text = "Nobody tells you the truth about success. Unlock your potential. Adapt or get left behind. Save this post. Follow for more."
        signals = {"low_information": 0.9, "templated_style": 0.9}
        risk = combine_slop_score(signals, slop_pattern_score(text), text)
        self.assertGreaterEqual(risk, 0.65)
        self.assertEqual(decision_for(text, signals, risk)[0], "slop")


if __name__ == "__main__":
    unittest.main()
