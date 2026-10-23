// Controlled tensor-TMA version probe. No performance or natural-AI-fault claim.
// NVIDIA CUDA Programming Guide 13.0, section 10.29.2; PTX mbarrier semantics.
#include <cuda.h>
#include <cudaTypedefs.h>
#include <cuda_runtime.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#define CUDA_OK(call) do { cudaError_t e = (call); if (e != cudaSuccess) { \
  std::fprintf(stderr, "%s:%d: %s: %s\n", __FILE__, __LINE__, #call, cudaGetErrorString(e)); \
  std::exit(90); } } while (0)
constexpr int MAX_ROWS = 8, MAX_COLS = 64, MAX_WORDS = MAX_ROWS * MAX_COLS * 2;
constexpr int ABSENT = -777777;
constexpr unsigned MAX_WAIT_POLLS = 1000000;

struct Event {
  int role, iteration, transfer, slot, expected_generation, observed_generation;
  int representative_value, phase, wait_success, source_line, thread, ordinal;
  unsigned polls, barrier_address, destination_address;
};

__device__ __forceinline__ unsigned shared_address(const void* p) {
  return static_cast<unsigned>(__cvta_generic_to_shared(p));
}
__device__ __forceinline__ void proxy_fence() {
  asm volatile("fence.proxy.async.shared::cta;" ::: "memory"); // CONTRACT_PROXY_FENCE
}
__device__ __forceinline__ void init_barrier(unsigned address) {
  asm volatile("mbarrier.init.shared::cta.b64 [%0], 1;" :: "r"(address) : "memory"); // CONTRACT_MBARRIER_INIT
}
__device__ __forceinline__ void tensor_copy(unsigned dst, const CUtensorMap* map, int y, unsigned bar) {
  asm volatile("cp.async.bulk.tensor.2d.shared::cluster.global.mbarrier::complete_tx::bytes "
               "[%0], [%1, {0, %2}], [%3];"
               :: "r"(dst), "l"(map), "r"(y), "r"(bar) : "memory"); // CONTRACT_TENSOR_TMA_ISSUE
}
__device__ __forceinline__ void arrive_expect(unsigned bar, unsigned bytes) {
  asm volatile("mbarrier.arrive.expect_tx.release.cta.shared::cta.b64 _, [%0], %1;"
               :: "r"(bar), "r"(bytes) : "memory"); // CONTRACT_EXPECT_TX
}
__device__ __forceinline__ bool wait_acquire(unsigned bar, unsigned phase) {
  unsigned done;
  asm volatile("{ .reg .pred p; "
               "mbarrier.try_wait.parity.acquire.cta.shared::cta.b64 p, [%1], %2, 1000; "
               "selp.u32 %0, 1, 0, p; }"
               : "=r"(done) : "r"(bar), "r"(phase) : "memory"); // CONTRACT_ACQUIRE_WAIT
  return done != 0;
}
__device__ __forceinline__ void log_event(Event* out, int index, int role, int g, int transfer,
    int slot, int expected, int observed, int value, int phase, int success, unsigned polls,
    unsigned bar, unsigned dst, int ordinal, int line) {
  out[index] = {role, g, transfer, slot, expected, observed, value, phase, success, line,
                static_cast<int>(threadIdx.x), ordinal, polls, bar, dst};
}

__global__ void tma_version_kernel(const __grid_constant__ CUtensorMap map, int rows, int cols,
    int padded_cols, int generations, int variant, int* output, int* tags, Event* events,
    int* device_status) {
  __shared__ __align__(128) int buffers[2][MAX_WORDS];
  __shared__ __align__(8) unsigned long long barriers[2];
  __shared__ int failed;
  const int tid = threadIdx.x, count = rows * cols, words = rows * padded_cols * 2;
  const unsigned bytes = words * sizeof(int);
  int phase[2] = {0, 0}; // Per-slot barrier phase; never interpreted as full data generation.
  int ordinal = 0;
  if (tid == 0) {
    failed = 0;
    init_barrier(shared_address(&barriers[0]));
    init_barrier(shared_address(&barriers[1]));
    proxy_fence();
  }
  __syncthreads(); // CONTRACT_INITIALIZATION_BARRIER

  // Both slots are first filled by TMA and waited to completion. No uninitialized fault reads.
  for (int transfer = 0; transfer < generations + 2; ++transfer) {
    const bool initial = transfer < 2;
    const int g = initial ? -1 : transfer - 2;
    const int slot = initial ? transfer : (g & 1);
    const int base = initial ? transfer * 2 : 4 + g * 4;
    if (tid == 0) {
      const unsigned bar = shared_address(&barriers[slot]);
      const unsigned dst = shared_address(buffers[slot]);
      tensor_copy(dst, &map, transfer * rows, bar);
      log_event(events, base, 0, g, transfer, slot, g, ABSENT, ABSENT, phase[slot], 0, 0,
                bar, dst, ordinal++, __LINE__); // EVENT_TMA_ISSUED
      // Official example order: issue first, then arrive with expected transaction bytes.
      // Arrival count remains one until this arrive; bytes alone cannot complete the phase.
      arrive_expect(bar, bytes);
      unsigned polls = 0;
      bool success = false;
      while (polls < MAX_WAIT_POLLS && !success) {
        success = wait_acquire(bar, phase[slot]);
        ++polls;
      }
      if (!success) {
        failed = transfer + 1;
        *device_status = failed;
      } else {
        // Actual loads and event occur AFTER acquire wait returned true, not before instruction.
        log_event(events, base + 1, 1, g, transfer, slot, g, buffers[slot][1], buffers[slot][0],
                  phase[slot], 1, polls, bar, dst, ordinal++, __LINE__); // EVENT_WAIT_RETURNED_TRUE
        phase[slot] ^= 1;
      }
    }
    __syncthreads(); // CONTRACT_TMA_VISIBILITY_BARRIER
    if (failed) return; // Uniform return. Host refuses all numerical claims after timeout.
    if (initial) continue;

    const int faulty_slot = slot ^ 1;
    int read_slot = slot;
    if (variant == 1) read_slot = faulty_slot; // CONTROLLED_FAULT_WRONG_COMPLETED_SLOT
    if (variant == 2) read_slot = slot; // CONTROLLED_REPAIR_SELECT_EXPECTED_SLOT
    if (tid >= 32) {
      for (int index = tid - 32; index < count; index += 32) {
        const int offset = ((index / cols) * padded_cols + index % cols) * 2;
        output[g * count + index] = buffers[read_slot][offset];
        tags[g * count + index] = buffers[read_slot][offset + 1]; // CONTRACT_CONSUMER_LOAD
      }
      if (tid == 32) {
        log_event(events, base + 2, 2, g, transfer, read_slot, g, buffers[read_slot][1],
                  buffers[read_slot][0], -1, 0, 0, shared_address(&barriers[read_slot]),
                  shared_address(buffers[read_slot]), ordinal++, __LINE__); // EVENT_CONSUMER_SAMPLE
      }
    }
    // All generic reads finish before any next TMA overwrite. Include an async-proxy fence.
    proxy_fence();
    __syncthreads(); // CONTRACT_READER_COMPLETION_BARRIER
    if (tid == 0) {
      log_event(events, base + 3, 3, g, transfer, slot, g, ABSENT, ABSENT, -1, 0, 0,
                shared_address(&barriers[slot]), shared_address(buffers[slot]), ordinal++,
                __LINE__); // EVENT_REUSE_READY
    }
  }
  if (tid == 0) {
    asm volatile("mbarrier.inval.shared::cta.b64 [%0];" :: "r"(shared_address(&barriers[0])) : "memory");
    asm volatile("mbarrier.inval.shared::cta.b64 [%0];" :: "r"(shared_address(&barriers[1])) : "memory");
  }
}

static int value_for(uint32_t seed, int generation, int index) {
  if (generation < 0) return -(1000000 + index);
  return static_cast<int>((seed ^ (uint32_t(generation + 1) * 2654435769u)
      ^ (uint32_t(index + 11) * 2246822507u)) & 8388607u);
}
static void array_json(const std::vector<int>& a) {
  std::putchar('[');
  for (size_t i = 0; i < a.size(); ++i) std::printf("%s%d", i ? "," : "", a[i]);
  std::putchar(']');
}
static std::string escape_json(const char* s) {
  std::string result;
  for (; *s; ++s) { if (*s == '"' || *s == '\\') result += '\\'; result += *s; }
  return result;
}
static long long integer(const char* s, long long low, long long high) {
  char* end = nullptr;
  const long long value = std::strtoll(s, &end, 10);
  if (!s[0] || !end || *end || value < low || value > high) {
    std::fprintf(stderr, "invalid integer argument\n"); std::exit(64);
  }
  return value;
}

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr, "usage: tma_version_probe ROWS COLS GENERATIONS SEED correct|wrong-slot|repaired\n");
    return 64;
  }
  const int rows = integer(argv[1], 1, MAX_ROWS), cols = integer(argv[2], 1, MAX_COLS);
  const int generations = integer(argv[3], 1, 32);
  const uint32_t seed = integer(argv[4], 0, 4294967295LL);
  const std::string variant_name = argv[5];
  const int variant = variant_name == "correct" ? 0 : variant_name == "wrong-slot" ? 1
                    : variant_name == "repaired" ? 2 : -1;
  if (variant < 0) return 64;
  cudaDeviceProp prop{};
  CUDA_OK(cudaGetDeviceProperties(&prop, 0));
  if (prop.major < 9) { std::fprintf(stderr, "TMA requires compute capability >= 9.0\n"); return 65; }
  const int padded_cols = (cols + 3) / 4 * 4, count = rows * cols;
  const int words = rows * padded_cols * 2, event_count = 4 + generations * 4;
  std::vector<int> input((generations + 2) * words), output(generations * count), tags(output.size());
  std::vector<int> reference(output.size()), expected_tags(output.size());
  for (int section = 0; section < generations + 2; ++section) {
    const int g = section < 2 ? -1 : section - 2;
    for (int row = 0; row < rows; ++row) for (int col = 0; col < padded_cols; ++col) {
      const int offset = section * words + (row * padded_cols + col) * 2;
      input[offset] = col < cols ? value_for(seed, g, row * cols + col) : -2000000;
      input[offset + 1] = g;
    }
  }
  for (int g = 0; g < generations; ++g) for (int i = 0; i < count; ++i) {
    reference[g * count + i] = value_for(seed, g, i);
    expected_tags[g * count + i] = g;
  }
  int *d_input, *d_output, *d_tags, *d_status;
  Event* d_events;
  CUDA_OK(cudaMalloc(&d_input, input.size() * sizeof(int)));
  CUDA_OK(cudaMalloc(&d_output, output.size() * sizeof(int)));
  CUDA_OK(cudaMalloc(&d_tags, tags.size() * sizeof(int)));
  CUDA_OK(cudaMalloc(&d_events, event_count * sizeof(Event)));
  CUDA_OK(cudaMalloc(&d_status, sizeof(int)));
  CUDA_OK(cudaMemcpy(d_input, input.data(), input.size() * sizeof(int), cudaMemcpyHostToDevice));
  CUDA_OK(cudaMemset(d_output, 0xa5, output.size() * sizeof(int)));
  CUDA_OK(cudaMemset(d_tags, 0xa5, tags.size() * sizeof(int)));
  CUDA_OK(cudaMemset(d_events, 0, event_count * sizeof(Event)));
  CUDA_OK(cudaMemset(d_status, 0, sizeof(int)));

  CUtensorMap map{};
  void* entry = nullptr;
  cudaDriverEntryPointQueryResult entry_status;
  CUDA_OK(cudaGetDriverEntryPointByVersion("cuTensorMapEncodeTiled", &entry, 12000,
                                         cudaEnableDefault, &entry_status));
  if (entry_status != cudaDriverEntryPointSuccess || !entry) return 66;
  auto encode = reinterpret_cast<PFN_cuTensorMapEncodeTiled_v12000>(entry);
  const uint64_t dim[2] = {uint64_t(2 * padded_cols), uint64_t((generations + 2) * rows)};
  const uint64_t stride[1] = {uint64_t(2 * padded_cols * sizeof(int))};
  const uint32_t box[2] = {uint32_t(2 * padded_cols), uint32_t(rows)}, element_stride[2] = {1, 1};
  const CUresult encode_status = encode(&map, CU_TENSOR_MAP_DATA_TYPE_INT32, 2, d_input, dim, stride,
      box, element_stride, CU_TENSOR_MAP_INTERLEAVE_NONE, CU_TENSOR_MAP_SWIZZLE_NONE,
      CU_TENSOR_MAP_L2_PROMOTION_NONE, CU_TENSOR_MAP_FLOAT_OOB_FILL_NONE);
  if (encode_status != CUDA_SUCCESS) { std::fprintf(stderr, "tensor map encode failed: %d\n", int(encode_status)); return 67; }
  tma_version_kernel<<<1, 64>>>(map, rows, cols, padded_cols, generations, variant,
                               d_output, d_tags, d_events, d_status);
  CUDA_OK(cudaGetLastError());
  CUDA_OK(cudaDeviceSynchronize());
  int device_status = -1;
  CUDA_OK(cudaMemcpy(&device_status, d_status, sizeof(int), cudaMemcpyDeviceToHost));
  if (device_status) { std::fprintf(stderr, "bounded mbarrier wait timed out at transfer %d\n", device_status - 1); return 68; }
  CUDA_OK(cudaMemcpy(output.data(), d_output, output.size() * sizeof(int), cudaMemcpyDeviceToHost));
  CUDA_OK(cudaMemcpy(tags.data(), d_tags, tags.size() * sizeof(int), cudaMemcpyDeviceToHost));
  std::vector<Event> events(event_count);
  CUDA_OK(cudaMemcpy(events.data(), d_events, event_count * sizeof(Event), cudaMemcpyDeviceToHost));
  int value_errors = 0, tag_errors = 0;
  for (size_t i = 0; i < output.size(); ++i) {
    value_errors += output[i] != reference[i]; tag_errors += tags[i] != expected_tags[i];
  }
  std::printf("{\"format\":\"gpu-tensor-tma-version-probe-v1\",\"mechanism\":\"tensor-tma-2d\","
      "\"device\":\"%s\",\"compute_capability\":[%d,%d],\"shape\":[%d,%d],\"padded_cols\":%d,"
      "\"generations\":%d,\"seed\":%u,\"variant\":\"%s\",\"cta\":[0,0,0],\"threads\":64,"
      "\"transfer_bytes\":%d,\"device_status\":0,\"wait_poll_limit\":%u,"
      "\"tensor_map\":{\"rank\":2,\"dtype\":\"int32\",\"global_dim\":[%llu,%llu],"
      "\"global_stride_bytes\":[%llu],\"box_dim\":[%u,%u],\"element_stride\":[1,1],\"swizzle\":\"none\"},"
      "\"correctness\":{\"passed\":%s,\"value_mismatches\":%d,\"version_mismatches\":%d},\"output\":",
      escape_json(prop.name).c_str(), prop.major, prop.minor, rows, cols, padded_cols, generations, seed,
      variant_name.c_str(), words * int(sizeof(int)), MAX_WAIT_POLLS,
      (unsigned long long)dim[0], (unsigned long long)dim[1], (unsigned long long)stride[0], box[0], box[1],
      value_errors == 0 && tag_errors == 0 ? "true" : "false", value_errors, tag_errors);
  array_json(output); std::printf(",\"observed_generations\":"); array_json(tags);
  std::printf(",\"reference\":"); array_json(reference);
  std::printf(",\"expected_generations\":"); array_json(expected_tags);
  std::printf(",\"events\":[");
  const char* roles[] = {"tma_issued", "wait_returned_true", "consumer_sample", "reuse_ready"};
  for (int i = 0; i < event_count; ++i) {
    const Event& e = events[i];
    if (e.role < 0 || e.role > 3) return 69;
    std::printf("%s{\"id\":\"event-%d\",\"event_layout_index\":%d,\"role\":\"%s\","
        "\"iteration\":%d,\"transfer\":%d,\"slot\":%d,\"expected_generation\":%d,"
        "\"observed_generation\":", i ? "," : "", i, i, roles[e.role], e.iteration, e.transfer,
        e.slot, e.expected_generation);
    if (e.observed_generation == ABSENT) std::printf("null"); else std::printf("%d", e.observed_generation);
    std::printf(",\"representative_value\":");
    if (e.representative_value == ABSENT) std::printf("null"); else std::printf("%d", e.representative_value);
    std::printf(",\"phase_parity\":%d,\"wait_success\":%s,\"wait_polls\":%u,"
        "\"barrier_shared_address\":\"0x%x\",\"buffer_shared_address\":\"0x%x\","
        "\"thread\":%d,\"warp_id\":%d,\"thread_program_ordinal\":%d,\"source_line\":%d}",
        e.phase, e.wait_success ? "true" : "false", e.polls, e.barrier_address, e.destination_address,
        e.thread, e.thread / 32, e.ordinal, e.source_line);
  }
  std::printf("]}\n");
  CUDA_OK(cudaFree(d_input)); CUDA_OK(cudaFree(d_output)); CUDA_OK(cudaFree(d_tags));
  CUDA_OK(cudaFree(d_events)); CUDA_OK(cudaFree(d_status));
  return value_errors || tag_errors ? 2 : 0;
}
