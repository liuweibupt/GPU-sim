import importlib.util
from pathlib import Path
import hashlib
import json
import math
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('cutlass_verify',Path(__file__).resolve().parents[1]/'tools/research/natural-bugs/cutlass_verify.py')
M=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

class FP8Reference(unittest.TestCase):
    def test_fp8_oracle_landmarks(self):
        self.assertEqual(M.fp8(0x38),1)
        self.assertEqual(M.fp8(0xC0),-2)
        self.assertEqual(M.fp8(0x01),2**-9)
        self.assertEqual(M.fp8(0x7E),448)
        self.assertEqual(M.fp8(0),M.fp8(128))
        self.assertTrue(math.isnan(M.fp8(0x7F)))
        self.assertTrue(math.isnan(M.fp8(0xFF)))


class RetainedOutputFixture(unittest.TestCase):
    """Tiny full-byte records; malicious edits are rehashed to test semantics."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cwd = self.root / 'case-0'
        self.cwd.mkdir()
        self.case = {'variant': 'after', 'case': 'all-zero', 'k': [0, 0, 0],
                     'm': 1, 'n': 4, 'host_shapes': 0, 'beta': 1, 'tool': 'normal'}
        self.groups = [{'group': index, 'm': 1, 'n': 4, 'k': 0, 'beta': 1,
                        'outputs': 4, 'mismatches': 0, 'zero_k_mismatches': 0}
                       for index in range(3)]
        self.record = {'id': self.cwd.name, **self.case, 'exit_code': 0,
                       'timed_out': False, 'groups': self.groups,
                       'result': 'passed', 'sanitizer_clean': False}
        for index in range(3):
            for kind in ('observed', 'reference', 'c'):
                (self.cwd / f'group-{index}-{kind}.bin').write_bytes(bytes([0, 0x38, 0xC0, 128]))
        self.stdout = None
        self.stderr = ''

    def evidence(self):
        return ''.join('EVIDENCE ' + json.dumps(g) + '\n' for g in self.groups)

    def memcheck(self):
        self.case['tool'] = self.record['tool'] = 'memcheck'
        self.record['sanitizer_clean'] = True
        self.stdout = ('========= COMPUTE-SANITIZER\n' + self.evidence()
                       + '========= ERROR SUMMARY: 0 errors\n')

    def save(self, omit_stream_manifest=False):
        # Recompute hashes after every edit: rejection must not depend only on
        # stale checksums, and record.json/results.json remain mutually equal.
        (self.cwd / 'stdout.txt').write_text(self.evidence() if self.stdout is None else self.stdout)
        (self.cwd / 'stderr.txt').write_text(self.stderr)
        self.record['outputs_checked'] = sum(g['outputs'] for g in self.groups)
        self.record['mismatches'] = sum(g['mismatches'] for g in self.groups)
        self.record['zero_k_mismatches'] = sum(g['zero_k_mismatches'] for g in self.groups)
        self.record['files'] = [{'path': p.name, 'bytes': p.stat().st_size,
                                 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                                for p in sorted(self.cwd.iterdir())
                                if p.name != 'record.json' and not (omit_stream_manifest and p.name == 'stdout.txt')]
        (self.cwd / 'record.json').write_text(json.dumps(self.record))
        matrix = json.dumps({'matrix': [self.case]}).encode()
        (self.root / 'matrix.json').write_bytes(matrix)
        (self.root / 'results.json').write_text(json.dumps({
            'matrix_sha256': hashlib.sha256(matrix).hexdigest(), 'records': [self.record]}))

    def check_rejected(self, message):
        self.save()
        with self.assertRaisesRegex(ValueError, message):
            M.verify(self.root)

    def test_full_bytes_and_signed_zero(self):
        (self.cwd / 'group-0-observed.bin').write_bytes(bytes([128, 0x38, 0xC0, 0]))
        self.save()
        result = M.verify(self.root)
        self.assertEqual(result['counts'], {'outputs': 12, 'mismatches': 0,
                                           'zero_k_mismatches': 0, 'zero_k_outputs': 12,
                                           'zero_k_nonzero_outputs': 6})

    def test_complete_groups_can_arrive_out_of_order(self):
        self.groups.reverse()
        self.save()
        self.assertEqual(M.verify(self.root)['counts']['outputs'], 12)

    def test_duplicate_group_cannot_replace_missing_group(self):
        self.groups[1]['group'] = 0
        self.check_rejected('duplicate group ID')

    def test_group_id_must_be_integer_and_in_range(self):
        for bad in (-1, 3, True, 0.0, '0'):
            with self.subTest(group_id=bad):
                self.groups[0]['group'] = bad
                self.check_rejected('invalid group ID')

    def test_missing_group_cannot_be_passed(self):
        self.groups.pop()
        self.check_rejected('incomplete group coverage')

    def test_timeout_preserves_empty_or_partial_evidence(self):
        self.record.update(result='timeout', exit_code=None, timed_out=True)
        self.groups.pop()
        self.save()
        self.assertEqual(M.verify(self.root)['case_results'], {'after/normal/timeout': 1})
        self.groups.clear()
        self.save()
        self.assertEqual(M.verify(self.root)['counts']['outputs'], 0)

    def test_execution_error_preserves_partial_evidence(self):
        self.record.update(result='execution_error', exit_code=-6)
        self.groups.pop()
        self.save()
        self.assertEqual(M.verify(self.root)['case_results'], {'after/normal/execution_error': 1})

    def test_duplicate_group_is_invalid_even_in_timeout(self):
        self.record.update(result='timeout', exit_code=None, timed_out=True)
        self.groups[1]['group'] = 0
        self.check_rejected('duplicate group ID')

    def test_record_groups_must_match_raw_stdout(self):
        self.stdout = self.evidence()
        self.groups[0]['mismatches'] = 1
        self.check_rejected('stdout groups disagree')

    def test_truncated_stdout_json_is_rejected(self):
        self.stdout = self.evidence() + 'EVIDENCE {"group":'
        self.save()
        with self.assertRaises(json.JSONDecodeError):
            M.verify(self.root)

    def test_truncated_output_is_rejected_after_rehash(self):
        (self.cwd / 'group-0-observed.bin').write_bytes(bytes([0, 0x38, 0xC0]))
        self.check_rejected('truncated output')

    def test_zero_k_oracle_catches_corrupted_actual_and_reference(self):
        for kind in ('observed', 'reference'):
            (self.cwd / f'group-0-{kind}.bin').write_bytes(bytes([0, 0x38, 0x38, 128]))
        self.check_rejected('recorded oracle result disagrees')

    def test_raw_stream_must_be_hash_bound(self):
        self.save(omit_stream_manifest=True)
        with self.assertRaisesRegex(ValueError, 'raw streams missing'):
            M.verify(self.root)

    def test_memcheck_zero_summary_can_be_in_stderr(self):
        self.memcheck()
        self.stderr = self.stdout
        self.stdout = self.evidence()
        self.save()
        self.assertEqual(M.verify(self.root)['case_results'], {'after/memcheck/passed': 1})

    def test_memcheck_clean_requires_raw_banner_and_zero_summary(self):
        self.memcheck()
        original = self.stdout
        changes = {
            'missing summary': original.replace('========= ERROR SUMMARY: 0 errors\n', ''),
            'nonzero summary': original.replace('0 errors', '1 errors'),
            'conflicting summaries': original + '========= ERROR SUMMARY: 1 errors\n',
            'extra singular summary': original + '========= ERROR SUMMARY: 1 error\n',
            'extra truncated summary': original + '========= ERROR SUMMARY:\n',
            'extra summary with suffix': original + '========= ERROR SUMMARY: 1 errors (truncated)\n',
            'missing banner': original.replace('========= COMPUTE-SANITIZER\n', ''),
            'truncated summary': original.replace('0 errors', '0 error'),
        }
        for name, output in changes.items():
            with self.subTest(name=name):
                self.stdout = output
                self.check_rejected('sanitizer clean flag disagrees')

    def test_memcheck_clean_flag_cannot_disagree_with_valid_summary(self):
        self.memcheck()
        self.record['sanitizer_clean'] = False
        self.check_rejected('sanitizer clean flag disagrees')

    def test_zero_summary_does_not_override_execution_failure(self):
        self.memcheck()
        for fields in ({'exit_code': 86}, {'timed_out': True}, {'result': 'execution_error'}):
            with self.subTest(fields=fields):
                self.record.update(exit_code=0, timed_out=False, result='passed')
                self.record.update(fields)
                self.check_rejected('sanitizer clean flag disagrees')

    def test_nonzero_memcheck_preserves_partial_evidence(self):
        self.groups.pop()
        self.memcheck()
        self.stdout = self.stdout.replace('0 errors', '1 errors')
        self.record.update(exit_code=86, result='execution_error', sanitizer_clean=False)
        self.save()
        self.assertEqual(M.verify(self.root)['case_results'], {'after/memcheck/execution_error': 1})

    def test_normal_run_cannot_claim_sanitizer_clean(self):
        self.record['sanitizer_clean'] = True
        self.check_rejected('sanitizer clean flag disagrees')

    def test_numerical_pass_does_not_imply_sanitizer_clean(self):
        self.memcheck()
        self.stdout = self.stdout.replace('========= ERROR SUMMARY: 0 errors\n', '')
        self.record['sanitizer_clean'] = False
        self.save()
        self.assertEqual(M.verify(self.root)['case_results'], {'after/memcheck/passed': 1})

if __name__=='__main__':
    unittest.main()
