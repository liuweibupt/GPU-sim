"""GTSim evaluation gated by an exact multi-kernel SASS launch bundle."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from pathlib import Path

from gpu_tile_sim.calibration.component_microbench import load_component_profiles
from gpu_tile_sim.calibration.cublas_launch_schedule import load_cublas_launch_schedule_profiles
from gpu_tile_sim.calibration.cublaslt_schedule import load_cublaslt_schedule_profiles
from gpu_tile_sim.calibration.dependent_memory import load_dependent_memory_profiles
from gpu_tile_sim.calibration.directional_l2 import load_directional_l2_profiles
from gpu_tile_sim.calibration.kernel_floor import load_kernel_floor_profiles
from gpu_tile_sim.calibration.library_dispatch import load_library_dispatch_profiles
from gpu_tile_sim.calibration.matrix_schedule import load_matrix_schedule_profiles
from gpu_tile_sim.calibration.native_matrix import load_native_matrix_profiles
from gpu_tile_sim.calibration.scalar_memory import load_scalar_memory_profiles
from gpu_tile_sim.comparison.microbench_predictor import IndependentMicrobenchmarkPredictor
from gpu_tile_sim.comparison.records import ModalTraceRecord, records_from_trace_file
from gpu_tile_sim.comparison.source_schedule import GraphInvocation, graph_invocations_for_record
from gpu_tile_sim.comparison.trace_bundle import SASS_EXECUTION_BUNDLE_FORMAT
from gpu_tile_sim.hardware.configs import GPU_CONFIGS

MODEL_NAME = "gtsim_dynamic_sass_envelope"


@dataclass(frozen=True, slots=True)
class SassBundleEvaluationSources:
    suite_root: Path
    artifact_root: Path
    trace_profile_path: Path
    component_manifest: Path
    dispatch_manifest: Path
    scalar_memory_manifest: Path
    dependent_memory_manifest: Path
    directional_l2_manifest: Path
    cublaslt_schedule_manifest: Path
    cublas_launch_schedule_manifest: Path
    native_matrix_manifest: Path
    repository_root: Path
    matrix_schedule_manifest: Path | None = None
    kernel_floor_manifest: Path | None = None
    static_sass_manifest: Path | None = None
    event_endpoint_overhead_us: float = 0.0
    event_endpoint_gpu_config: str | None = None


def evaluate_sass_bundle(sources: SassBundleEvaluationSources) -> dict[str, object]:
    """Predict only after the physical SASS launch stream matches the source schedule."""

    metadata_path = sources.artifact_root / "hardware_timings.json"
    metadata = _read_object(metadata_path)
    profiles = _read_object(sources.trace_profile_path)
    validate_static_sass_provenance(sources, profiles)
    _validate_bundle(metadata_path, metadata, profiles)
    profile_by_case = {str(case["case"]): case for case in profiles["cases"]}
    source_records = _records_for_cases(sources.suite_root, metadata)
    records = tuple(
        _attach_sass_execution(record, profile_by_case[str(case["case"])])
        for case, record in zip(metadata["cases"], source_records, strict=True)
    )
    contracts = [
        validate_physical_launch_contract(record, profile_by_case[str(case["case"])])
        for case, record in zip(metadata["cases"], source_records, strict=True)
    ]
    predictor = load_independent_predictor(sources)
    rows = [
        _prediction_row(case, record, contract=contract, predictor=predictor)
        for case, record, contract in zip(metadata["cases"], records, contracts, strict=True)
    ]
    return {
        "format": 1,
        "model": MODEL_NAME,
        "gpu": metadata["gpu"],
        "job_name": metadata["job_name"],
        "record_count": len(rows),
        "target_latency_used_for_model_parameters": False,
        "dynamic_sass_consumed": True,
        "binary_contract": architecture_native_binary_contract(metadata),
        "sass_usage": (
            "exact physical kernel count and contiguous order gate source-dispatch mapping; "
            "each launch consumes its dynamic SASS warp-order, register dependency, shared-bank, "
            "async-copy, matrix, and TMA execution envelope"
        ),
        "dispatch_policy": (
            "verified multi-kernel streams use the uncontended lower envelope from repeated "
            "independent dispatch microbenchmarks; single-kernel timing is unchanged"
        ),
        "artifact_metadata_sha256": _sha256(metadata_path),
        "trace_profiles_sha256": _sha256(sources.trace_profile_path),
        "profile_provenance": _profile_provenance(sources),
        "rows": rows,
    }


def architecture_native_binary_contract(metadata: dict[str, object]) -> dict[str, object]:
    """Describe the non-negotiable timing/trace architecture identity."""

    return {
        "target_gpu": metadata["gpu"],
        "compute_capability": int(metadata["compute_capability"]),
        "target_architecture_compilation": True,
        "timing_and_trace_use_same_binary_sha256": True,
        "cross_architecture_cubin_reuse": False,
    }


def validate_physical_launch_contract(
    record: ModalTraceRecord,
    case_profile: dict[str, object],
) -> dict[str, object]:
    """Reject a SASS bundle that cannot represent the modeled source launch stream."""

    invocations = graph_invocations_for_record(record)
    expected = sum(invocation.count for invocation in invocations)
    observed = int(case_profile["trace_file_count"])
    if observed != expected:
        raise ValueError(
            f"physical launch count mismatch for {record.record_id}: "
            f"source={expected}, SASS={observed}"
        )
    traces = list(case_profile["traces"])
    if len(traces) != observed:
        raise ValueError(f"incomplete per-launch SASS profiles: {record.record_id}")
    _validate_launch_indices(record, traces)
    return {
        "source_launch_count": expected,
        "sass_launch_count": observed,
        "source_dispatch_segments": _dispatch_segments(invocations, traces),
        "launches": [_launch_contract(dict(trace)) for trace in traces],
    }


def _validate_launch_indices(record: ModalTraceRecord, traces: list[object]) -> None:
    indices = [int(dict(trace)["kernel_index"]) for trace in traces]
    expected = list(range(indices[0], indices[0] + len(indices)))
    if indices != expected:
        raise ValueError(f"SASS launch order is incomplete: {record.record_id}")


def _dispatch_segments(
    invocations: tuple[GraphInvocation, ...],
    traces: list[object],
) -> list[dict[str, object]]:
    segments = []
    offset = 0
    for invocation in invocations:
        count = int(invocation.count)
        segment = [dict(trace) for trace in traces[offset : offset + count]]
        segments.append(
            {
                "dispatch_kind": str(invocation.dispatch_kind),
                "launch_count": count,
                "kernel_indices": [trace["kernel_index"] for trace in segment],
            }
        )
        offset += count
    return segments


def load_independent_predictor(
    sources: SassBundleEvaluationSources,
) -> IndependentMicrobenchmarkPredictor:
    root = sources.repository_root
    components = load_component_profiles(
        sources.component_manifest, repository_root=root, configs=GPU_CONFIGS
    )
    dispatch = load_library_dispatch_profiles(
        sources.dispatch_manifest, repository_root=root, configs=GPU_CONFIGS
    )
    scalar = load_scalar_memory_profiles(
        sources.scalar_memory_manifest,
        repository_root=root,
        configs=GPU_CONFIGS,
        dispatch_profiles=dispatch,
    )
    dependent = load_dependent_memory_profiles(
        sources.dependent_memory_manifest, repository_root=root, configs=GPU_CONFIGS
    )
    directional_l2 = load_directional_l2_profiles(
        sources.directional_l2_manifest, repository_root=root, configs=GPU_CONFIGS
    )
    schedules = load_cublaslt_schedule_profiles(
        sources.cublaslt_schedule_manifest, repository_root=root, configs=GPU_CONFIGS
    )
    launches = load_cublas_launch_schedule_profiles(
        sources.cublas_launch_schedule_manifest, repository_root=root, configs=GPU_CONFIGS
    )
    native = load_native_matrix_profiles(
        sources.native_matrix_manifest,
        repository_root=root,
        configs=GPU_CONFIGS,
        component_profiles=components,
    )
    matrix_schedules = (
        {}
        if sources.matrix_schedule_manifest is None
        else load_matrix_schedule_profiles(
            sources.matrix_schedule_manifest, repository_root=root, configs=GPU_CONFIGS
        )
    )
    kernel_floors = (
        {}
        if sources.kernel_floor_manifest is None
        else load_kernel_floor_profiles(
            sources.kernel_floor_manifest, repository_root=root, configs=GPU_CONFIGS
        )
    )
    if sources.event_endpoint_overhead_us > 0.0:
        if sources.event_endpoint_gpu_config not in kernel_floors:
            raise ValueError("event endpoint calibration names an unavailable GPU config")
        kernel_floors = {
            name: (
                profile.subtract_endpoint_overhead(sources.event_endpoint_overhead_us)
                if name == sources.event_endpoint_gpu_config
                else profile
            )
            for name, profile in kernel_floors.items()
        }
        matrix_schedules = {
            name: (
                profile.subtract_endpoint_overhead(sources.event_endpoint_overhead_us)
                if name == sources.event_endpoint_gpu_config
                else profile
            )
            for name, profile in matrix_schedules.items()
        }
    return IndependentMicrobenchmarkPredictor(
        components,
        dispatch_profiles=dispatch,
        scalar_memory_profiles=scalar,
        dependent_memory_profiles=dependent,
        directional_l2_profiles=directional_l2,
        cublaslt_schedule_profiles=schedules,
        cublas_launch_schedule_profiles=launches,
        native_matrix_profiles=native,
        matrix_schedule_profiles=matrix_schedules,
        kernel_floor_profiles=kernel_floors,
        use_sustained_composite_dispatch=True,
    )


def _records_for_cases(
    suite_root: Path,
    metadata: dict[str, object],
) -> tuple[ModalTraceRecord, ...]:
    gpu = str(metadata["gpu"])
    records = []
    cache: dict[str, tuple[ModalTraceRecord, ...]] = {}
    for case in metadata["cases"]:
        operator = str(case["operator"])
        if operator not in cache:
            cache[operator] = records_from_trace_file(
                suite_root / gpu / f"{operator}.jsonl",
                source_gpu=gpu,
            )
        candidates = cache[operator]
        matching = [record for record in candidates if record.index == int(case["index"])]
        if len(matching) != 1:
            raise ValueError(f"expected one frozen record for {case['case']}")
        record = matching[0]
        if record.params != case["params"]:
            raise ValueError(f"frozen/SASS parameter mismatch: {case['case']}")
        records.append(record)
    return tuple(records)


def _attach_sass_execution(
    record: ModalTraceRecord, case_profile: dict[str, object]
) -> ModalTraceRecord:
    traces = [dict(value) for value in case_profile["traces"]]
    summaries = [dict(trace["instruction_summary"]) for trace in traces]
    if not summaries:
        raise ValueError(f"SASS profile has no launch summaries: {record.record_id}")
    executions = [dict(summary["sass_execution"]) for summary in summaries]
    record_envelope = {
        "sass_execution_launches": executions,
        "sass_trace_sha256s": [str(summary["trace_sha256"]) for summary in summaries],
        "binding_scope": "record_physical_launch_stream",
    }
    return replace(record, sass_instruction_summary=record_envelope)


def _prediction_row(
    case: dict[str, object],
    record: ModalTraceRecord,
    *,
    contract: dict[str, object],
    predictor: IndependentMicrobenchmarkPredictor,
) -> dict[str, object]:
    prediction = predictor.predict_ms(record)
    if prediction is None:
        raise ValueError(f"trace-assisted model does not support {record.record_id}")
    return {
        "record_id": record.record_id,
        "source_gpu": record.source_gpu,
        "gpu_config": record.gpu_config,
        "kernel": record.kernel,
        "index": record.index,
        "model": MODEL_NAME,
        "predicted_ms": prediction,
        "same_binary_measured_ms": dict(case["hardware"])["measured_ms"],
        "physical_launch_contract": contract,
    }


def _launch_contract(trace: dict[str, object]) -> dict[str, object]:
    schedule = dict(trace["schedule"])
    summary = dict(trace["instruction_summary"])
    return {
        "kernel_index": trace["kernel_index"],
        "kernel_name": schedule["kernel_name"],
        "grid": schedule["grid"],
        "block": schedule["block"],
        "cta_count": schedule["cta_count"],
        "num_warps": schedule["num_warps"],
        "registers_per_thread": schedule["registers_per_thread"],
        "shared_bytes": schedule["shared_bytes"],
        "dynamic_instruction_count": trace["dynamic_instruction_count"],
        "global_load_sector_requests": summary["global_load_sector_requests"],
        "global_store_sector_requests": summary["global_store_sector_requests"],
    }


def _validate_bundle(
    metadata_path: Path,
    metadata: dict[str, object],
    profiles: dict[str, object],
) -> None:
    if profiles.get("format") != SASS_EXECUTION_BUNDLE_FORMAT:
        raise ValueError("SASS execution profile format is stale; regenerate the bundle")
    if profiles.get("artifact_metadata_sha256") != _sha256(metadata_path):
        raise ValueError("SASS profiles do not match artifact metadata")
    if profiles.get("gpu") != metadata.get("gpu"):
        raise ValueError("SASS profile GPU mismatch")
    if int(profiles.get("case_count", 0)) != len(metadata["cases"]):
        raise ValueError("SASS profile case count mismatch")
    if profiles.get("sass_execution_envelope") is not True:
        raise ValueError("trace profile does not contain dynamic SASS execution envelopes")
    validate_architecture_native_profiles(metadata, profiles)


def validate_architecture_native_profiles(
    metadata: dict[str, object], profiles: dict[str, object]
) -> None:
    """Reject timing/trace bundles assembled from different GPU architectures."""

    hardware_arch = int(metadata["compute_capability"])
    if int(profiles.get("compute_capability", -1)) != hardware_arch:
        raise ValueError("SASS profile architecture differs from hardware timing architecture")
    hardware_gpu = str(metadata["gpu"])
    timing_cases = {str(case["case"]): dict(case) for case in metadata["cases"]}
    profile_names = {str(case["case"]) for case in profiles["cases"]}
    if profile_names != set(timing_cases):
        raise ValueError("SASS profile cases differ from hardware timing cases")
    for case in profiles["cases"]:
        profile_case = dict(case)
        timing_case = timing_cases[str(profile_case["case"])]
        if str(profile_case["gpu"]) != hardware_gpu:
            raise ValueError("SASS profile case GPU differs from hardware timing GPU")
        if profile_case["binary_sha256"] != timing_case["binary_sha256"]:
            raise ValueError("SASS trace binary differs from the binary used for hardware timing")
        for trace in profile_case["traces"]:
            traced = dict(trace)
            binary_arch = int(dict(traced["schedule"])["binary_version"])
            execution = dict(dict(traced["instruction_summary"])["sass_execution"])
            if binary_arch != hardware_arch or int(execution["binary_version"]) != hardware_arch:
                raise ValueError(
                    "SASS binary architecture differs from the GPU that produced hardware timing"
                )


def _profile_provenance(sources: SassBundleEvaluationSources) -> dict[str, object]:
    names = (
        "component_manifest",
        "dispatch_manifest",
        "scalar_memory_manifest",
        "dependent_memory_manifest",
        "directional_l2_manifest",
        "cublaslt_schedule_manifest",
        "cublas_launch_schedule_manifest",
        "native_matrix_manifest",
    )
    provenance = {
        name: {"path": str(path := getattr(sources, name)), "sha256": _sha256(path)}
        for name in names
    }
    optional_names = (
        "matrix_schedule_manifest",
        "kernel_floor_manifest",
        "static_sass_manifest",
    )
    for name in optional_names:
        path = getattr(sources, name)
        if path is not None:
            provenance[name] = {"path": str(path), "sha256": _sha256(path)}
    return provenance


def validate_static_sass_provenance(
    sources: SassBundleEvaluationSources,
    profiles: dict[str, object],
) -> None:
    observed = profiles.get("static_sass_manifest_sha256")
    if observed is None:
        if sources.static_sass_manifest is not None:
            raise ValueError("SASS profile did not consume the declared static-SASS manifest")
        return
    if sources.static_sass_manifest is None:
        raise ValueError("SASS profile requires its static-SASS manifest")
    if observed != _sha256(sources.static_sass_manifest):
        raise ValueError("SASS profile static-SASS provenance mismatch")


def _read_object(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
