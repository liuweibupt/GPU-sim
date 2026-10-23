"""Offline publication tamper tests using only before/gold controls, never model answers.

Set LIGER_REVIEW_PACKAGE to a curated controls-only package. These integration
tests skip when the recorded package is absent; they never call GPU tools.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import numpy as np

from verify_publication import verify_package


ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(os.environ.get('LIGER_REVIEW_PACKAGE', ROOT / 'out/research/liger-faults/publication-review-controls/package'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless((PACKAGE / 'publication-manifest.json').is_file(), 'requires retained controls-only publication package')
class PublicationTamperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='liger-publication-review-', dir=PACKAGE.parent)
        self.package = Path(self.temporary.name) / 'package'
        # Every mutation unlinks first; hard-linked immutable fixture bytes must
        # never be modified through a test copy.
        shutil.copytree(PACKAGE, self.package, copy_function=os.link)

    def tearDown(self):
        self.temporary.cleanup()

    def replace_bytes(self, path, data):
        if path.exists():
            path.unlink()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def replace_json(self, path, data):
        self.replace_bytes(path, (json.dumps(data, indent=2) + '\n').encode())

    def rehash_manifest(self):
        path = self.package / 'publication-manifest.json'
        manifest = json.loads(path.read_text())
        manifest['files'] = [{'path': str(p.relative_to(self.package)), 'sha256': sha(p), 'bytes': p.stat().st_size}
                             for p in sorted(self.package.rglob('*')) if p.is_file() and p != path]
        self.replace_json(path, manifest)

    def verify(self):
        return verify_package(self.package)

    def candidate_pair(self, family='poly'):
        root = self.package / 'gold-evaluator-check-v3' / family
        return root, json.loads((root / 'candidate.json').read_text()), json.loads((root / 'runtime-record.json').read_text())

    def rewrite_candidate_pair(self, root, candidate, record):
        self.replace_json(root / 'candidate.json', candidate)
        record['candidate_json_sha256'] = sha(root / 'candidate.json')
        self.replace_json(root / 'runtime-record.json', record)
        self.rehash_manifest()

    def test_complete_official_controls_survive_collection_and_offline_verification(self):
        receipt = self.verify()
        self.assertEqual(len(receipt['runs']), 9)
        self.assertEqual(sum(r['cases'] for r in receipt['runs']), 168)
        self.assertEqual(sum(r['outputs'] for r in receipt['runs']), 921657)
        gold = [r for r in receipt['runs'] if r['category'] == 'core-upstream-gold-control']
        self.assertEqual(len(gold), 3)
        self.assertTrue(all(r['cases'] == r['passed'] for r in gold))

    def test_unmanifested_file_is_rejected(self):
        (self.package / 'unlisted.txt').write_text('not in inventory')
        with self.assertRaises(AssertionError):
            self.verify()

    def test_changed_complete_output_bytes_are_rejected(self):
        artifact = next((self.package / 'controls-v2/sparse/gold').glob('*.npz'))
        self.replace_bytes(artifact, artifact.read_bytes() + b'changed')
        with self.assertRaises(AssertionError):
            self.verify()

    def test_missing_gold_executor_family_cannot_disappear_after_rehash(self):
        shutil.rmtree(self.package / 'gold-evaluator-check-v3/grpo')
        self.rehash_manifest()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_declared_candidates_cannot_disappear_from_directory_set(self):
        records = [{'trialId': f'liger-{family}.{condition}.r{rep}', 'buildStatus': 'passed'}
                   for family in ['poly', 'sparse', 'grpo'] for condition in ['raw', 'diagnostic'] for rep in [1, 2, 3]]
        self.replace_json(self.package / 'candidate-execution-summary.json', records)
        self.rehash_manifest()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_coherent_self_reported_candidate_tree_hash_is_recomputed(self):
        root, candidate, record = self.candidate_pair()
        candidate['candidateTreeSHA256'] = record['candidateTreeSHA256'] = 'b' * 64
        self.rewrite_candidate_pair(root, candidate, record)
        with self.assertRaises(AssertionError):
            self.verify()

    def test_candidate_before_identity_is_bound_to_catalog(self):
        root, candidate, record = self.candidate_pair()
        candidate['files'][0]['beforeSHA256'] = 'c' * 64
        self.rewrite_candidate_pair(root, candidate, record)
        with self.assertRaises(AssertionError):
            self.verify()

    def test_runtime_hidden_status_must_match_verified_case(self):
        root, candidate, record = self.candidate_pair()
        record['cases'][0]['status'] = 'failed'
        self.rewrite_candidate_pair(root, candidate, record)
        with self.assertRaises(AssertionError):
            self.verify()

    def test_evaluator_source_identity_is_bound(self):
        root, candidate, record = self.candidate_pair()
        record['evaluator_sha256'] = 'd' * 64
        self.rewrite_candidate_pair(root, candidate, record)
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rehashed_actual_and_reference_still_need_independent_oracle(self):
        root = self.package / 'controls-v2/sparse/gold'
        summary = json.loads((root / 'summary.json').read_text())
        row = summary['records'][0]
        artifact = root / row['artifact']['path']
        with np.load(artifact, allow_pickle=False) as z:
            arrays = dict(z)
        arrays['actual'].flat[0] = .123456
        arrays['reference'].flat[0] = .123456
        artifact.unlink()
        np.savez_compressed(artifact, **arrays)
        row['artifact'].update(sha256=sha(artifact), bytes=artifact.stat().st_size)
        self.replace_json(root / (row['id'] + '.json'), row)
        self.replace_json(root / 'summary.json', summary)
        self.rehash_manifest()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_rehashed_imported_source_change_is_rejected(self):
        root = self.package / 'controls-v2/poly/before'
        summary = json.loads((root / 'summary.json').read_text())
        source = self.package / 'sources/1540/before' / summary['imported_source_files'][0]['path']
        self.replace_bytes(source, source.read_bytes() + b'\n# independently changed source\n')
        self.rehash_manifest()
        with self.assertRaises(AssertionError):
            self.verify()


if __name__ == '__main__':
    unittest.main(verbosity=2)
