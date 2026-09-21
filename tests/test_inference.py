import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'helper'))
from inference import probability, split_for_budget, predict_signals
from scoring import decision_for


class InferenceTests(unittest.TestCase):
    def test_confidence_is_not_probability_of_true(self):
        self.assertEqual(probability({'noul': 0.01, 'confidence': 0.99}), 0.01)
        for answer in ({'confidence': 0.99}, {}, None, {'noul': float('nan')},
                       {'noul': float('inf')}, {'noul': True}, {'noul': -0.1}, {'noul': 1.1}):
            with self.subTest(answer=answer), self.assertRaises(ValueError):
                probability(answer)

    def test_windows_preserve_every_character_and_respect_budget(self):
        for text in ('word ' * 1000, 'Русский текст.\n\n' * 1000, 'a' * 1000, '🙂' * 200):
            with self.subTest(text=text[:20]):
                chunks = split_for_budget(text, len, 64)
                self.assertEqual(''.join(chunks), text)
                self.assertTrue(all(0 < len(chunk) <= 64 for chunk in chunks))
        self.assertEqual(split_for_budget('', len, 64), [])

    def test_all_windows_are_scored_with_length_weighting(self):
        class Agent:
            cfg = {'max_len': 128, 'head_max_len': 64}
            calls = []
            def tok(self, text, **kwargs):
                return {'input_ids': list(text)}
            def predict(self, text, questions):
                self.calls.append(text)
                return {'answers': {k: {'noul': 1 if 'bad' in text else 0} for k in questions}}
        agent = Agent()
        text = 'bad ' * 12 + 'good ' * 40
        signals, windows = predict_signals(agent, text, {'low_information': {}})
        self.assertEqual(''.join(agent.calls), text)
        self.assertGreater(windows, 1)
        self.assertLess(signals['low_information'], 0.3)
        self.assertTrue(all(len(chunk) <= 48 for chunk in agent.calls))

    def test_invalid_or_partial_output_does_not_become_clean(self):
        class Agent:
            cfg = {'max_len':128,'head_max_len':64}
            def tok(self, text, **kwargs): return {'input_ids':list(text)}
            def predict(self, *args): return {'answers':{'one':{'noul':0.1}}}
        with self.assertRaises(ValueError):
            predict_signals(Agent(), 'Enough input text.', {'one':{},'two':{}})

    def test_incomplete_short_and_conflicting_posts_abstain(self):
        text = 'This is a sufficiently long post with more than twelve words for a clear assessment.'
        signals = {'low_information':0.9,'templated_style':0.9}
        for kwargs, reason in (({'truncated':True},'incomplete_text'), ({'text_scope':'title_only'},'title_only')):
            decision, reasons = decision_for(text, signals, 0.95, **kwargs)
            self.assertEqual(decision, 'uncertain');self.assertIn(reason,reasons)
        self.assertEqual(decision_for('Hi everyone',signals,0.95)[0],'uncertain')
        self.assertEqual(decision_for(text,{'low_information':0.95,'templated_style':0.1},0.7)[0],'uncertain')


class ApiTests(unittest.TestCase):
    def test_model_failure_is_visible_and_does_not_hide_other_results(self):
        import app
        with patch.object(app, 'get_agent', return_value=object()), patch.object(app, 'predict_signals', side_effect=[ValueError('missing probability'), ({'low_information':0.8,'templated_style':0.8,'engagement_bait':0.7},1)]):
            result=app.analyze(app.AnalyzeRequest(blocks=[
                app.Block(id='bad',text='Invalid model response for this post.'),
                app.Block(id='ok',text='Nobody tells you this. Your potential is limitless and success is just around the corner. Save this post. Follow for more.'),
            ]))
        by_id={row['id']:row for row in result['results']}
        self.assertEqual(by_id['bad']['decision'],'uncertain')
        self.assertIsNone(by_id['bad']['risk'])
        self.assertEqual(by_id['bad']['reasons'],['analysis_failed'])
        self.assertEqual(by_id['ok']['decision'],'slop')

    def test_title_only_and_truncated_requests_are_never_flagged(self):
        import app
        with patch.object(app, 'get_agent', return_value=object()), patch.object(app, 'predict_signals',return_value=({'low_information':0.99,'templated_style':0.99},1)):
            result=app.analyze(app.AnalyzeRequest(blocks=[
                app.Block(id='title',text='Nobody tells you this. The future belongs to those who act. Save this post.',text_scope='title_only'),
                app.Block(id='cut',text='Nobody tells you this. The future belongs to those who act. Save this post.',truncated=True),
            ]))
        self.assertTrue(all(row['decision']=='uncertain' for row in result['results']))


if __name__ == '__main__': unittest.main()
