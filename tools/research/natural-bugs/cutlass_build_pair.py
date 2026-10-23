#!/usr/bin/env python3
"""Build pinned upstream CUTLASS example 68 with host-only output observation.

No kernel is changed. The public issue names example 67; grouped GEMM is example
68 in both releases. This is a release-pair, reduced-shape reproduction, not an
assertion that a single isolated patch caused every observed difference.
"""
import argparse
import difflib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import time

COMMITS = {
    "before": "e51efbfe18fe4f4cbb66ab814c55bf4aa0185491",
    "after": "59b61c606fe7aa4d33e60d3e6352cbfde98361c3",
}
EXAMPLE = "examples/68_hopper_fp8_warp_specialized_grouped_gemm_with_blockwise_scaling"
SOURCE = EXAMPLE + "/68_hopper_fp8_warp_specialized_grouped_gemm_with_blockwise_scaling.cu"

OBSERVATION = r'''
    // Research harness: host-only observation after the upstream full reference.
    size_t mismatches = 0, zero_k_mismatches = 0;
    std::string prefix = std::string("group-") + std::to_string(group_idx);
    std::ofstream observed(prefix + "-observed.bin", std::ios::binary);
    std::ofstream reference(prefix + "-reference.bin", std::ios::binary);
    std::ofstream input_c(prefix + "-c.bin", std::ios::binary);
    observed.write(reinterpret_cast<const char*>(block_D_host_kernel.data() + offset_D.at(group_idx)), m*n*sizeof(ElementD));
    reference.write(reinterpret_cast<const char*>(block_D_host_ref.data() + offset_D.at(group_idx)), m*n*sizeof(ElementD));
    input_c.write(reinterpret_cast<const char*>(block_C_host.data() + offset_C.at(group_idx)), m*n*sizeof(ElementC));
    for (int64_t j = 0; j < int64_t(m)*n; ++j) {
      auto actual = block_D_host_kernel[offset_D.at(group_idx) + j];
      mismatches += actual != block_D_host_ref[offset_D.at(group_idx) + j];
      if (k == 0) {
        // Independent epilogue oracle, no GEMM/reference-mainloop code reused.
        ElementD expected(float(beta_host.at(group_idx)) * float(block_C_host[offset_C.at(group_idx) + j]));
        zero_k_mismatches += actual != expected;
      }
    }
    std::cout << "EVIDENCE {\"group\":" << group_idx << ",\"m\":" << m << ",\"n\":" << n
      << ",\"k\":" << k << ",\"beta\":" << beta_host.at(group_idx)
      << ",\"outputs\":" << int64_t(m)*n << ",\"mismatches\":" << mismatches
      << ",\"zero_k_mismatches\":" << zero_k_mismatches << "}" << std::endl;
'''

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("/home/liuwei/cutlass"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--nvcc", default="/usr/local/cuda-13.1/bin/nvcc")
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    records = []
    for variant, commit in COMMITS.items():
        dst = root / variant
        dst.mkdir()
        tree = dst / "tree"
        tree.mkdir()
        archive = subprocess.check_output(["git", "archive", commit, "include", "tools/util/include", "examples/common", EXAMPLE], cwd=args.repo)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
            tf.extractall(tree, filter="data")
        original = (tree / SOURCE).read_text()
        # Separate process per host-shape mode; avoid upstream example's repeated
        # allocation retaining old scale-layout vectors in the same process.
        original_main = '''  std::cout << "Running tests with host problem shapes:" << std::endl;
  run(options, true);
  std::cout << "Running tests without host problem shapes:" << std::endl;
  run(options, false);'''
        replacement_main = '''  cutlass::CommandLine research_cmd(argc, args);
  int research_host_shapes = 1;
  research_cmd.get_cmd_line_argument("host-shapes", research_host_shapes, 1);
  std::cout << "EVIDENCE host_shapes=" << research_host_shapes << std::endl;
  run(options, research_host_shapes != 0);'''
        if original.count(original_main) != 1 or original.count("    passed &= this_group_passed;") != 1:
            raise ValueError("Pinned upstream observation anchor changed")
        modified = original.replace(original_main, replacement_main).replace("    passed &= this_group_passed;", OBSERVATION + "\n    passed &= this_group_passed && zero_k_mismatches == 0;")
        src = dst / "cutlass_repro.cu"
        src.write_text(modified)
        (dst / "upstream.cu").write_text(original)
        (dst / "observation.patch").write_text("".join(difflib.unified_diff(original.splitlines(True), modified.splitlines(True), fromfile=SOURCE, tofile="cutlass_repro.cu")))
        binary = dst / ("cutlass_" + variant)
        argv = [args.nvcc, "-std=c++17", "-O2", "-lineinfo", "-gencode", "arch=compute_90a,code=sm_90a", "--expt-relaxed-constexpr", "--expt-extended-lambda", str(src), "-I"+str(tree/"include"), "-I"+str(tree/"tools/util/include"), "-I"+str(tree/"examples/common"), "-I"+str(tree/EXAMPLE), "-lcuda", "-o", str(binary)]
        start = time.monotonic()
        process = subprocess.run(argv, capture_output=True, timeout=600)
        (dst / "compile.stdout.txt").write_bytes(process.stdout)
        (dst / "compile.stderr.txt").write_bytes(process.stderr)
        record = {"variant": variant, "commit": commit, "argv": argv, "exit_code": process.returncode, "compile_wall_seconds": time.monotonic()-start, "upstream_sha256": sha(original.encode()), "observed_source_sha256": sha(src.read_bytes()), "tree_archive_sha256": sha(archive)}
        if binary.exists():
            record.update(binary_sha256=sha(binary.read_bytes()), binary_bytes=binary.stat().st_size)
        records.append(record)
        (root/"build.json").write_text(json.dumps({"issue": "https://github.com/NVIDIA/cutlass/issues/2547", "scope": "release pair; example 68, reduced M/N, host-only observation", "records": records}, indent=2)+"\n")
        print(json.dumps(record), flush=True)
        if process.returncode:
            raise SystemExit(process.returncode)

if __name__ == "__main__":
    main()
