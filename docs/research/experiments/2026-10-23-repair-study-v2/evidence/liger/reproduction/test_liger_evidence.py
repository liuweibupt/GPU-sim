"""CPU adversarial verifier tests; synthetic records are not GPU experiment results."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from run import array_identity, reference
from verify import sha, verify


class RetainedEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='liger-verifier-test-')
        self.root = Path(self.temporary.name)
        self.capture = self.root / 'capture'
        self.capture.mkdir()
        self.plan_path = self.root / 'plan.json'
        self.inputs_path = self.root / 'inputs.json'

    def tearDown(self):
        self.temporary.cleanup()

    def fixture(self, family='sparse'):
        parameters = dict(rows=2, width=3, dtype='float32', seed=1, atol=2e-5, rtol=2e-5)
        x = np.array([[3., 1., -2.], [-1., 0.5, 2.]], dtype=np.float32)
        arrays = {'x': x.copy(), 'input_before_0': x.copy(), 'input_after_0': x.copy()}
        if family == 'poly':
            parameters.update(weights=[0.6, -0.2, 0.3], bias=-0.25, eps=1e-5)
            arrays['weights'] = np.array(parameters['weights'], dtype=np.float32)
            arrays['bias'] = np.array(parameters['bias'], dtype=np.float32)
            for number, key in [(1, 'weights'), (2, 'bias')]:
                arrays[f'input_before_{number}'] = arrays[key].copy()
                arrays[f'input_after_{number}'] = arrays[key].copy()
        elif family == 'grpo':
            parameters = dict(batch=2, length=3, vocab=5, dtype='float32', temperature=.7, masked=True, layout='dense', seed=1, atol=2e-5, rtol=2e-5)
            logits = np.arange(40, dtype=np.float32).reshape(2, 4, 5) / 20
            ids = np.array([[0, 1, 2], [3, 4, 0]], dtype=np.int64)
            mask = np.array([[True, False, True], [False, True, True]])
            arrays = {'logits': logits, 'ids': ids, 'mask': mask}
            for number, key in enumerate(['logits', 'ids', 'mask']):
                arrays[f'input_before_{number}'] = arrays[key].astype(np.float32)
                arrays[f'input_after_{number}'] = arrays[key].astype(np.float32)
        else:
            parameters.update(offset=0., distribution='unit-fixture')
        case = {'id': family + '-unit-only', 'family': family, 'partition': 'hidden', 'parameters': parameters}
        self.plan = {'format': 'unit-test-only', 'cases': [case]}
        self.plan_path.write_text(json.dumps(self.plan))
        self.family = family
        self.arrays = arrays
        self.arrays['reference'] = reference(family, arrays, parameters)
        self.arrays['actual'] = self.arrays['reference'].astype(np.float32)
        self.row = {**case, 'actual_shape': list(self.arrays['actual'].shape), 'actual_dtype': 'float32', 'passed': True,
                    'outputs': self.arrays['actual'].size, 'mismatches': 0, 'nonfinite': 0, 'inputs_unchanged': True}
        if family == 'grpo':
            self.row['input_strides'] = {'ids': [3, 1], 'mask': [3, 1], 'ids_offset': 0, 'mask_offset': 0}
        self.bind_inputs()
        self.inputs_path.write_text(json.dumps({'plan_sha256': sha(self.plan_path), 'cases': [copy.deepcopy(self.row)]}))
        self.save()

    def bind_inputs(self):
        inputs = {k: v for k, v in self.arrays.items() if k not in ['actual', 'reference'] and not k.startswith('input_before_') and not k.startswith('input_after_')}
        self.row['input_array_identities'] = array_identity(inputs)

    def save(self, records=None):
        artifact = self.capture / 'arrays.npz'
        np.savez_compressed(artifact, **self.arrays)
        self.row['artifact'] = {'path': artifact.name, 'sha256': sha(artifact), 'bytes': artifact.stat().st_size}
        self.summary = {'family': self.family, 'plan_sha256': sha(self.plan_path), 'records': [self.row] if records is None else records, 'compiler_artifacts': []}
        (self.capture / (self.row['id'] + '.json')).write_text(json.dumps(self.row))
        (self.capture / 'summary.json').write_text(json.dumps(self.summary))

    def check(self):
        return verify(self.capture, self.plan_path, self.family, input_manifest_path=self.inputs_path)

    def test_complete_arrays_for_three_mathematical_oracles(self):
        for family in ['sparse', 'poly', 'grpo']:
            with self.subTest(family=family):
                self.fixture(family)
                receipt = self.check()
                self.assertTrue(receipt['all_passed'])
                self.assertEqual(receipt['outputs'], 6)
                self.assertEqual(receipt['input_binding'], 'frozen-control-input-manifest')

    def test_missing_case_stays_in_denominator(self):
        self.fixture()
        self.save(records=[])
        receipt = self.check()
        self.assertEqual(receipt['expected_cases'], 1)
        self.assertEqual(receipt['completed_cases'], 0)
        self.assertFalse(receipt['all_passed'])
        self.assertEqual(receipt['cases'][0]['passed'], False)
        self.assertTrue(receipt['cases'][0]['missing'])

    def test_duplicate_case_is_rejected(self):
        self.fixture()
        self.save(records=[self.row, self.row])
        with self.assertRaises(AssertionError):
            self.check()

    def test_changed_output_cannot_hide_behind_matching_saved_reference(self):
        self.fixture()
        self.arrays['actual'][0, 0] = .125
        self.arrays['reference'][0, 0] = .125
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_shape_truncation_rejected_even_with_updated_counts_and_hashes(self):
        self.fixture()
        self.arrays['actual'] = self.arrays['actual'][:, :2]
        self.arrays['reference'] = self.arrays['reference'][:, :2]
        self.row['outputs'] = 4
        self.row['actual_shape'] = [2, 2]
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_nonfinite_output_is_not_a_success(self):
        self.fixture()
        self.arrays['actual'][0, 0] = np.nan
        self.row.update(mismatches=1, nonfinite=1, passed=False)
        self.save()
        receipt = self.check()
        self.assertFalse(receipt['all_passed'])
        self.assertEqual(receipt['passed_cases'], 0)
        self.row['passed'] = True
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_input_mutation_rejected_despite_correct_output(self):
        self.fixture()
        self.arrays['input_after_0'][0, 0] += 1
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_coherent_replacement_of_inputs_oracle_and_self_hash_is_rejected(self):
        self.fixture()
        for key in ['x', 'input_before_0', 'input_after_0']:
            self.arrays[key] = np.zeros_like(self.arrays[key])
        self.arrays['reference'] = reference(self.family, self.arrays, self.row['parameters'])
        self.arrays['actual'] = self.arrays['reference'].astype(np.float32)
        self.bind_inputs()
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_changed_stride_with_same_values_is_rejected(self):
        self.fixture('grpo')
        self.row['input_strides']['ids'] = [6, 2]
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_wrong_output_dtype_fails_despite_equal_values(self):
        self.fixture()
        self.row['actual_dtype'] = 'float64'
        self.row['passed'] = False
        self.save()
        self.assertFalse(self.check()['all_passed'])
        self.row['passed'] = True
        self.save()
        with self.assertRaises(AssertionError):
            self.check()

    def test_changed_archive_bytes_are_rejected(self):
        self.fixture()
        artifact = self.capture / 'arrays.npz'
        artifact.write_bytes(artifact.read_bytes() + b'changed')
        with self.assertRaises(AssertionError):
            self.check()


if __name__ == '__main__':
    unittest.main(verbosity=2)
