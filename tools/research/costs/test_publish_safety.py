import gzip
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from cost_publish_safety import matches, profiler_environment, scan_paths, sensitive_values

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('safe_profile',HERE/'profile-cost-safe.py')
profile=importlib.util.module_from_spec(spec);spec.loader.exec_module(profile)


class PublishSafetyTests(unittest.TestCase):
    def test_profiler_receives_only_allowlisted_environment(self):
        env={'PATH':'/usr/bin','HOME':'/safe/home','LANG':'C','CUDA_VISIBLE_DEVICES':'0',
             'PRIVATE_API_KEY':'dummy-only-test-value','MODAL_TOKEN_SECRET':'different-dummy-value',
             'UNRELATED_SETTING':'not-inherited'}
        clean=profiler_environment('/safe/tmp',env)
        self.assertEqual(set(clean),{'PATH','HOME','LANG','CUDA_VISIBLE_DEVICES','TMPDIR'})
        self.assertNotIn('dummy-only-test-value',str(clean))
        env['PATH']+='/dummy-only-test-value'
        with self.assertRaises(ValueError):profiler_environment('/safe/tmp',env)

    def test_nested_gzip_scan_reports_only_keys_and_layers(self):
        values=sensitive_values({'COST_API_KEY':'unit-test-sensitive-string','SAFE':'ignored'})
        raw=gzip.compress(gzip.compress(b'prefix unit-test-sensitive-string suffix'))
        result=matches(raw,values)
        self.assertEqual(result,[{'layer':2,'keys':['COST_API_KEY']}])
        self.assertNotIn('unit-test-sensitive-string',json.dumps(result))

    def test_recursive_file_scan_does_not_emit_matching_snippets(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'example.gz';p.write_bytes(gzip.compress(b'dummy-private-content'))
            scan=scan_paths([Path(tmp)],{'UNIT_SECRET':b'dummy-private-content'})
            self.assertEqual(scan['matchedFiles'],1)
            self.assertNotIn('dummy-private-content',json.dumps(scan))

    def test_sql_export_excludes_unreferenced_strings_and_unrelated_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'test.sqlite';db=sqlite3.connect(path)
            db.execute('CREATE TABLE StringIds (id INTEGER, value TEXT)')
            db.executemany('INSERT INTO StringIds VALUES (?,?)',[(1,'void cost_version_probe<(bool)0>(int)'),
                (2,'cudaGraphLaunch'),(3,'dummy-environment-do-not-export')])
            db.execute('CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (start INTEGER,end INTEGER,demangledName INTEGER,gridX INTEGER,blockX INTEGER,graphNodeId INTEGER,environment TEXT)')
            db.executemany('INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (?,?,?,?,?,?,?)',
                [(i*10,i*10+5,1,1,64,1,'dummy-environment-do-not-export') for i in range(64)])
            db.execute('CREATE TABLE CUPTI_ACTIVITY_KIND_RUNTIME (start INTEGER,end INTEGER,nameId INTEGER,environment TEXT)')
            db.execute('INSERT INTO CUPTI_ACTIVITY_KIND_RUNTIME VALUES (1,2,2,?)',('dummy-environment-do-not-export',))
            db.commit();db.close()
            exported=profile.export_rows(path)
            self.assertEqual({r['id'] for r in exported['referencedNames']},{1,2})
            self.assertNotIn('dummy-environment-do-not-export',json.dumps(exported))
            self.assertNotIn('environment',exported['tables']['CUPTI_ACTIVITY_KIND_KERNEL']['columns'])


if __name__=='__main__':unittest.main()
