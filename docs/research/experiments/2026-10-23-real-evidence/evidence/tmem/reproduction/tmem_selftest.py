#!/usr/bin/env python3
"""Synthetic verifier-only tests; these are never counted as GPU experiments."""
import gzip
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import tmem_compare_repro as audit


class IntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        code = b'synthetic verifier fixture, not measured GPU code\n'
        (self.folder / 'code.ptx').write_bytes(code)
        self.summary = {'source_commit': audit.COMMITS['after'], 'runs': [], 'gpu': 'synthetic verifier fixture',
                        'torch_version': 'fixture', 'triton_version': 'fixture', 'wheel_sha256': 'fixture',
                        'libtriton_sha256': 'fixture', 'upstream': {'module_sha256': 'fixture'},
                        'output_elements': 0, 'mismatch_elements': 0, 'numeric_wrong_cases': 0}
        for p in audit.PARAMS:
            for choice in [0, 1]:
                mode, cols, early, outer = p
                params = dict(choice=choice, mode=mode, columns=cols, early=early, outer_choice=outer)
                value = 3 if mode == 'first' or (mode == 'select' and choice) else 5
                if mode == 'chain': value = 3 if choice == outer else 5
                outputs = []
                for name, n, expected in [('selected', 4096, value)] + ([('temporary', 128*cols, 7)] if cols else []):
                    outputs.append({'name': name, 'actual': [expected]*n, 'reference': [expected]*n,
                                    'mismatch_count': 0, 'mismatch_indices': []})
                    self.summary['output_elements'] += n
                case = {'id': str(len(self.summary['runs'])), 'parameters': params, 'numeric_correct': True,
                        'outputs': outputs, 'compiled_kernels': [{'hash': 'fixture', 'artifacts': [
                            {'path': 'code.ptx', 'sha256': audit.sha(code), 'bytes': len(code)}]}]}
                row = {'id': case['id'], 'parameters': params, 'numeric_correct': True,
                       'compiled_kernel_hashes': ['fixture']}
                self.summary['runs'].append(row)
                self.save_case(row, case)
        self.save_summary()

    def tearDown(self): self.tmp.cleanup()

    def save_summary(self):
        (self.folder / 'summary.json').write_text(json.dumps(self.summary))

    def save_case(self, row, case):
        raw = json.dumps(case).encode(); compressed = gzip.compress(raw, mtime=0)
        path = 'case-' + row['id'] + '.json.gz'; (self.folder / path).write_bytes(compressed)
        row['artifact'] = dict(path=path, sha256=audit.sha(compressed), bytes=len(compressed), uncompressed_sha256=audit.sha(raw))

    def test_valid_synthetic_fixture(self):
        result = audit.validate(self.folder, 'after')
        self.assertEqual(result['cases'], 16)
        self.assertEqual(result['output_elements'], 172032)

    def test_truncated_record_rejected(self):
        path = self.folder / self.summary['runs'][0]['artifact']['path']
        path.write_bytes(path.read_bytes()[:-3])
        with self.assertRaisesRegex(ValueError, 'compressed binding'):
            audit.validate(self.folder, 'after')

    def test_changed_generated_code_rejected(self):
        (self.folder / 'code.ptx').write_bytes(b'changed code')
        with self.assertRaisesRegex(ValueError, 'generated code binding'):
            audit.validate(self.folder, 'after')

    def test_self_consistent_wrong_reference_rejected(self):
        row = self.summary['runs'][0]
        case = json.loads(gzip.decompress((self.folder / row['artifact']['path']).read_bytes()))
        case['outputs'][0]['actual'] = case['outputs'][0]['reference'] = [7]*4096
        self.save_case(row, case); self.save_summary()
        with self.assertRaisesRegex(ValueError, 'independent CPU oracle'):
            audit.validate(self.folder, 'after')

    def test_non_upstream_parameters_rejected(self):
        row = self.summary['runs'][0]
        case = json.loads(gzip.decompress((self.folder / row['artifact']['path']).read_bytes()))
        case['parameters']['choice'] = 2; row['parameters'] = case['parameters']
        self.save_case(row, case); self.save_summary()
        with self.assertRaisesRegex(ValueError, 'non-upstream case'):
            audit.validate(self.folder, 'after')

    def plain_fixture(self):
        root = ET.Element('testsuites'); suite = ET.SubElement(root, 'testsuite')
        for row in self.summary['runs']:
            ET.SubElement(suite, 'testcase', name=row['id'])
        return root

    def test_plain_outcomes_match(self):
        path = self.folder / 'plain.xml'; path.write_bytes(ET.tostring(self.plain_fixture()))
        self.assertTrue(audit.validate_plain(path, self.folder)['outcomes_match_observed_suite'])

    def test_plain_observer_difference_rejected(self):
        root = self.plain_fixture()
        ET.SubElement(root.find('.//testcase'), 'failure').text = 'Mismatched elements: 4096'
        path = self.folder / 'plain.xml'; path.write_bytes(ET.tostring(root))
        with self.assertRaisesRegex(ValueError, 'outcomes differ'):
            audit.validate_plain(path, self.folder)


if __name__ == '__main__': unittest.main()
