import importlib.util
from pathlib import Path
import random
import unittest

SPEC = importlib.util.spec_from_file_location('mask_candidates', Path(__file__).parents[1] / 'tools/research/analyze-raw-evidence.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def inst(mask, sources=(), destinations=()):
    return {'pc': 0, 'opcode': 'fixture', 'active_mask': mask,
            'sources': list(sources), 'destinations': list(destinations)}


class MaskCandidates(unittest.TestCase):
    def test_partial_write_preserves_other_lane(self):
        counts, examples = MODULE.compare_stream([inst(3, destinations=['R0']),
                                                  inst(1, destinations=['R0']), inst(3, ['R0'])])
        self.assertEqual(counts['different_candidate'], 1)
        self.assertEqual(examples[0]['lane'], 1)
        self.assertEqual(examples[0]['mask_sensitive_writer_ordinal'], 0)

    def test_zero_mask_and_read_before_write(self):
        counts, examples = MODULE.compare_stream([inst(2, destinations=['R0']), inst(0, destinations=['R0']),
                                                  inst(2, ['R0'], ['R0'])])
        self.assertEqual(counts['zero_mask_records'], 1)
        self.assertEqual(counts['masked_candidate_found'], 1)
        self.assertFalse(examples)

    def test_no_lane_writer_is_not_fabricated(self):
        counts, examples = MODULE.compare_stream([inst(1, destinations=['R0']), inst(2, ['R0'])])
        self.assertEqual(counts['coarse_candidate_without_lane_write'], 1)
        self.assertIsNone(examples[0]['mask_sensitive_writer_ordinal'])

    def test_independent_backward_scan_oracle(self):
        rng = random.Random(20261023)
        for _ in range(100):
            program = [inst(rng.randrange(16), [f'R{rng.randrange(3)}'], [f'R{rng.randrange(3)}'])
                       for _ in range(30)]
            expected = []
            for i, item in enumerate(program):
                for source_index, source in enumerate(item['sources']):
                    for lane in range(4):
                        if not item['active_mask'] & (1 << lane):
                            continue
                        masked = coarse = None
                        for prior in range(i - 1, -1, -1):
                            candidate = program[prior]
                            if source in candidate['destinations'] and candidate['active_mask']:
                                if coarse is None:
                                    coarse = prior
                                if candidate['active_mask'] & (1 << lane):
                                    masked = prior
                                    break
                        if masked != coarse:
                            expected.append((i, source_index, lane, masked, coarse))
            _, examples = MODULE.compare_stream(program, example_limit=10000)
            actual = [(e['consumer_ordinal'], e['source_index'], e['lane'],
                       e['mask_sensitive_writer_ordinal'], e['coarse_writer_ordinal']) for e in examples]
            self.assertEqual(expected, actual)

    def test_invalid_mask_is_rejected(self):
        for mask in (-1, 2**32, True):
            with self.assertRaises(ValueError):
                MODULE.compare_stream([inst(mask)])


if __name__ == '__main__':
    unittest.main()
