import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "helper"))

from scoring import combine_slop_score, slop_pattern_score  # noqa: E402


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

    def test_consensus_style_scores_high(self):
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
        self.assertGreater(score, 0.85)

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
                "templated_style": 0.2133,
                "synthetic_tone": 0.4707,
                "engagement_bait": 0.1213,
                "low_information": 0.2627,
            },
            pattern,
            text,
        )
        self.assertGreater(pattern, 0.40)
        self.assertGreater(score, 0.80)


if __name__ == "__main__":
    unittest.main()
