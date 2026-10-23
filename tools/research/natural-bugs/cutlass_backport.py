#!/usr/bin/env python3
"""Backport only the three upstream empty-K guards onto the tested 4.1 tree.

This isolates the observed beta=0 hang from other changes in the 4.2 release.
The 4.1 beta=1 positive-control failure is retained as a separate confounder.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

HEADER = 'include/cutlass/gemm/collective/sm90_mma_array_tma_gmma_ss_warpspecialized_fp8_blockwise_scaling.hpp'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    before=args.build.resolve()/'before'
    root=args.output.resolve()
    root.mkdir(parents=True,exist_ok=False)
    shutil.copytree(before/'tree',root/'tree')
    src=root/'cutlass_repro.cu'
    shutil.copyfile(before/'cutlass_repro.cu',src)
    header=root/'tree'/HEADER
    original=header.read_text()
    edits=[('''    // WAIT on smem_pipe_read until its data are available (phase bit flips from rdPhaseBit value)
    auto barrier_token = pipeline.consumer_try_wait(smem_pipe_read);
    pipeline.consumer_wait(smem_pipe_read, barrier_token);

    // fence_operand();
    GmmaFP8Accumulation accumulation(accum, ScalePromotionInterval, size<2>(tCrA));

    warpgroup_fence_operand(accumulation());

    {''','''    auto barrier_token = pipeline.consumer_try_wait(smem_pipe_read);
    GmmaFP8Accumulation accumulation(accum, ScalePromotionInterval, size<2>(tCrA));
    warpgroup_fence_operand(accumulation());

    if (k_tile_count > 0) {
      pipeline.consumer_wait(smem_pipe_read, barrier_token);'''),
    ('    if (k_tile_count) {','    if (k_tile_count > 0) {'),
    ('''    // The pipeline is not released in the first iteration
    smem_pipe_release.advance(k_tile_count - 1);
    pipeline.consumer_release(smem_pipe_release);''','''    if (k_tile_count > 0) {
      // The pipeline is not released in the first iteration
      smem_pipe_release.advance(k_tile_count - 1);
      pipeline.consumer_release(smem_pipe_release);
    }''')]
    modified=original
    for old,new in edits:
        if modified.count(old)!=1:
            raise ValueError('upstream guard anchor mismatch')
        modified=modified.replace(old,new)
    header.write_text(modified)
    (root/'guards.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),modified.splitlines(True),fromfile=HEADER,tofile=HEADER)))
    base=json.loads((args.build/'build.json').read_text())['records'][0]
    argv=[s.replace(str(before),str(root)) for s in base['argv']]
    argv[-1]=str(root/'cutlass_backport')
    start=time.monotonic()
    process=subprocess.run(argv,capture_output=True,timeout=600)
    (root/'compile.stdout.txt').write_bytes(process.stdout)
    (root/'compile.stderr.txt').write_bytes(process.stderr)
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    record={'schema':'cutlass-empty-k-guard-backport-v1','base_commit':base['commit'],'upstream_guard_source':'59b61c606fe7aa4d33e60d3e6352cbfde98361c3','changed_headers':[HEADER],'original_header_sha256':hashlib.sha256(original.encode()).hexdigest(),'patched_header_sha256':sha(header),'patch_sha256':sha(root/'guards.patch'),'observed_source_sha256':sha(src),'argv':argv,'exit_code':process.returncode,'compile_wall_seconds':time.monotonic()-start}
    if (root/'cutlass_backport').exists():
        record['binary_sha256']=sha(root/'cutlass_backport')
    (root/'build.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record))
    raise SystemExit(process.returncode)

if __name__=='__main__':
    main()
