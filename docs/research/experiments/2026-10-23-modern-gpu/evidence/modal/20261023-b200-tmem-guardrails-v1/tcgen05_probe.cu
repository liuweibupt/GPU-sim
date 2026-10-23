// SM100a experiment-authored probe, not an optimized GEMM or a natural AI bug.
// Build: nvcc -std=c++17 -O3 -lineinfo -arch=sm_100a tcgen05_probe.cu -o tcgen05_probe
// Run: timeout 120s ./tcgen05_probe ITERATIONS SEED correct|wrong-version|fixed [GENERATION_BASE]
// Exit 0: expected values match; 2: controlled version/value mismatch; 1: operational failure.
//
// ISA/layout references (no external CUTLASS build dependency):
// https://docs.nvidia.com/cuda/parallel-thread-execution/#tcgen05-instructions
// NVIDIA CUTLASS commit 91843b71d90737e0a9b86f7d9df213cff5a3526f:
// examples/cute/tutorial/blackwell/01_mma_sm100.cu (lifecycle/reference algorithm)
// include/cute/arch/mma_sm100_desc.hpp (canonical K-major layout/descriptor)
// The instructions below use NVIDIA's CUDA Toolkit <cuda/ptx> wrappers.
#include <cuda_runtime.h>
#include <cuda_fp16.h>
#include <cuda/ptx>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace ptx = cuda::ptx;
constexpr int kM = 128, kN = 32, kK = 16, kColumns = 32, kEvents = 11;
constexpr uint32_t kInstructionDescriptor = (1u << 4) | ((kN / 8) << 17) | ((kM / 16) << 24);

static void check(cudaError_t status, const char* operation) {
  if (status != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}

struct Event {
  uint64_t expected_generation, observed_generation, clock, descriptor_a, descriptor_b;
  uint32_t iteration, role, thread, selected_input, candidate_input, repaired;
  uint32_t tmem_base, tmem_columns, barrier_address, barrier_phase, wait_success, wait_polls;
  uint32_t source_line;
  float representative_value;
};

struct Lifecycle {
  uint32_t allocated, deallocated, tmem_base, columns, barrier_address;
};

// FP16 K-major, no swizzle: ((8,rows/8),(8,2)):((8,128),(1,64)).
// Units are half elements. LBO=128 bytes, SBO=256 bytes; both are 16B aligned.
__host__ __device__ constexpr int smem_offset(int row, int k) {
  return (row % 8) * 8 + (row / 8) * 128 + (k % 8) + (k / 8) * 64;
}

__device__ uint64_t smem_descriptor(const __half* ptr) {
  uint32_t address = static_cast<uint32_t>(__cvta_generic_to_shared(ptr));
  return (uint64_t(address & 0x3ffffu) >> 4) | (uint64_t(128 / 16) << 16)
         | (uint64_t(256 / 16) << 32) | (uint64_t(1) << 46);
}

__device__ void emit(Event* events, int iteration, int offset, int role,
                     uint64_t expected, uint64_t observed, uint32_t selected,
                     uint32_t candidate, uint32_t repaired, uint32_t tmem,
                     uint32_t barrier, uint64_t desc_a, uint64_t desc_b,
                     uint32_t wait_success, uint32_t polls, float value, int line) {
  events[iteration * kEvents + offset] = {
    expected, observed, uint64_t(clock64()), desc_a, desc_b,
    uint32_t(iteration), uint32_t(role), uint32_t(threadIdx.x), selected, candidate, repaired,
    tmem, kColumns, barrier, uint32_t(iteration & 1), wait_success, polls, uint32_t(line), value
  };
}

__global__ __launch_bounds__(128)
void tcgen05_probe(const __half* input_a, const __half* input_b, const uint64_t* input_tags,
                  int iterations, int variant, uint64_t generation_base, uint64_t timeout_ticks,
                  float* output, Event* events, Lifecycle* lifecycle) {
  __shared__ __align__(128) __half a[kM * kK];
  __shared__ __align__(128) __half b[kN * kK];
  __shared__ __align__(8) uint64_t mma_barrier;
  __shared__ __align__(4) uint32_t tmem_base;
  __shared__ uint32_t selected_input, candidate_input, repaired;
  __shared__ uint64_t selected_generation;

  const int thread = int(threadIdx.x), warp = thread / 32;
  if (thread == 0) {
    ptx::mbarrier_init(&mma_barrier, 1u);
    ptx::fence_mbarrier_init(ptx::sem_release, ptx::scope_cluster);
  }
  if (warp == 0) ptx::tcgen05_alloc(ptx::cta_group_1, &tmem_base, uint32_t(kColumns));
  __syncthreads();  // CONTRACT_ALLOCATION_AND_BARRIER_PUBLICATION
  const uint32_t base = tmem_base;
  const uint32_t barrier = uint32_t(__cvta_generic_to_shared(&mma_barrier));
  const uint64_t desc_a = smem_descriptor(a), desc_b = smem_descriptor(b);
  if (thread == 0) *lifecycle = {1u, 0u, base, kColumns, barrier};

  for (int iteration = 0; iteration < iterations; ++iteration) {
    const int expected_input = iteration + 2;
    const uint64_t expected_generation = generation_base + uint64_t(expected_input);
    if (thread == 0) {
      // A controlled selector defect: the old input is TWO generations older,
      // so its parity equals the requested generation's parity. All accesses
      // and synchronization remain legal. A tag is read from device memory.
      candidate_input = variant == 0 ? expected_input : expected_input - 2;
      selected_input = candidate_input;
      repaired = 0;
      if (variant == 2 && input_tags[candidate_input] != expected_generation) {
        selected_input = expected_input;
        repaired = 1;
      }
      selected_generation = input_tags[selected_input];
    }
    __syncthreads();  // CONTRACT_SELECTED_SOURCE_PUBLICATION
    const uint64_t actual_generation = selected_generation;
    for (int i = thread; i < kM * kK; i += 128) {
      a[smem_offset(i / kK, i % kK)] = input_a[selected_input * kM * kK + i];
    }
    for (int i = thread; i < kN * kK; i += 128) {
      b[smem_offset(i / kK, i % kK)] = input_b[i];
    }
    asm volatile("fence.proxy.async.shared::cta;" : : : "memory");
    __syncthreads();  // CONTRACT_OPERAND_PUBLICATION
    ptx::tcgen05_fence_after_thread_sync();
    if (thread == 0) {
      emit(events, iteration, 0, 0, expected_generation, actual_generation, selected_input,
           candidate_input, repaired, base, barrier, desc_a, desc_b, 0, 0, 0, __LINE__);
      const uint32_t disable_lanes[4] = {0, 0, 0, 0};
      ptx::tcgen05_mma(ptx::kind_f16, ptx::cta_group_1, base, desc_a, desc_b,
                      kInstructionDescriptor, disable_lanes, false);
      // Full MMA completion, deliberately NOT sync_restrict::shared::read::mma::a.
      ptx::tcgen05_commit(ptx::cta_group_1, &mma_barrier);
      emit(events, iteration, 1, 1, expected_generation, actual_generation, selected_input,
           candidate_input, repaired, base, barrier, desc_a, desc_b, 0, 0, 0, __LINE__);
    }

    uint32_t polls = 0;
    const uint64_t wait_start = clock64();
    while (!ptx::mbarrier_try_wait_parity(ptx::sem_acquire, ptx::scope_cta,
                                        &mma_barrier, uint32_t(iteration & 1))) {
      ++polls;
      if (clock64() - wait_start > timeout_ticks) asm volatile("trap;");
    }
    ptx::tcgen05_fence_after_thread_sync();
    if ((thread & 31) == 0) {
      // Written only AFTER the actual wait returns true, not at wait issuance.
      emit(events, iteration, 2 + warp, 2, expected_generation, actual_generation, selected_input,
           candidate_input, repaired, base, barrier, desc_a, desc_b, 1, polls, 0, __LINE__);
    }

    float first_value = 0;
    for (int column = 0; column < kN; ++column) {
      uint32_t bits[1];
      // Every thread of a warp supplies the same address; one row per lane.
      const uint32_t address = base + (uint32_t(warp * 32) << 16) + uint32_t(column);
      ptx::tcgen05_ld_32x32b(bits, address);
      ptx::tcgen05_wait_ld();
      const float value = __uint_as_float(bits[0]);
      output[(iteration * kM + thread) * kN + column] = value;
      if (column == 0) first_value = value;
    }
    // This facet is TMEM reader completion, separate from MMA result readiness.
    ptx::tcgen05_fence_before_thread_sync();
    if ((thread & 31) == 0) {
      emit(events, iteration, 6 + warp, 3, expected_generation, actual_generation, selected_input,
           candidate_input, repaired, base, barrier, desc_a, desc_b, 1, polls, first_value, __LINE__);
    }
    __syncthreads();  // CONTRACT_ALL_READERS_DONE_BEFORE_TMEM_REUSE
    ptx::tcgen05_fence_after_thread_sync();
    if (thread == 0) {
      emit(events, iteration, 10, 4, expected_generation, actual_generation, selected_input,
           candidate_input, repaired, base, barrier, desc_a, desc_b, 1, polls, first_value, __LINE__);
    }
    // The next iteration's operand-publication CTA barrier also ensures all
    // threads have reached this iteration before any later MMA is issued.
  }
  __syncthreads();
  if (warp == 0) {
    ptx::tcgen05_relinquish_alloc_permit(ptx::cta_group_1);
    ptx::tcgen05_dealloc(ptx::cta_group_1, base, uint32_t(kColumns));
  }
  __syncthreads();  // CONTRACT_DEALLOCATION_RETURNED
  if (thread == 0) lifecycle->deallocated = 1;
}

template <typename T> static void print_array(const std::vector<T>& values) {
  std::cout << '[';
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << values[i];
  }
  std::cout << ']';
}

static int a_value(uint32_t seed, int input, int row, int k) {
  return 2 * (input + 1) + int((seed + row * 3u + k * 5u) % 7u) - 3;
}
static int b_value(uint32_t seed, int column, int k) {
  return 1 + int((seed + column + k * 3u) % 5u);
}
static float reference_value(uint32_t seed, int input, int row, int column) {
  int sum = 0;
  for (int k = 0; k < kK; ++k) sum += a_value(seed, input, row, k) * b_value(seed, column, k);
  return float(sum);
}

int main(int argc, char** argv) {
  try {
    if (argc != 4 && argc != 5) throw std::runtime_error(
        "usage: tcgen05_probe ITERATIONS SEED correct|wrong-version|fixed [GENERATION_BASE]");
    const int iterations = std::stoi(argv[1]);
    const unsigned long seed_arg = std::stoul(argv[2]);
    const std::string variant_name = argv[3];
    const int variant = variant_name == "correct" ? 0 : variant_name == "wrong-version" ? 1 : variant_name == "fixed" ? 2 : -1;
    const uint64_t generation_base = argc == 5 ? std::stoull(argv[4]) : 9007199254740992ull;
    if (iterations < 1 || iterations > 64 || seed_arg > 65535 || variant < 0 ||
        generation_base > std::numeric_limits<uint64_t>::max() - uint64_t(iterations + 2))
      throw std::runtime_error("invalid arguments");
    const uint32_t seed = uint32_t(seed_arg);
    cudaDeviceProp device{};
    check(cudaGetDeviceProperties(&device, 0), "device properties");
    if (device.major != 10 || device.minor != 0) throw std::runtime_error("this probe requires an SM100 device and an sm_100a build");
    int runtime_version = 0, driver_version = 0;
    check(cudaRuntimeGetVersion(&runtime_version), "runtime version");
    check(cudaDriverGetVersion(&driver_version), "driver version");
    const int inputs = iterations + 2;
    const size_t elements = size_t(iterations) * kM * kN;
    std::vector<__half> a(size_t(inputs) * kM * kK), b(kN * kK);
    std::vector<uint64_t> tags(inputs);
    for (int input = 0; input < inputs; ++input) {
      tags[input] = generation_base + uint64_t(input);
      for (int row = 0; row < kM; ++row) for (int k = 0; k < kK; ++k)
        a[(input * kM + row) * kK + k] = __float2half(float(a_value(seed, input, row, k)));
    }
    for (int column = 0; column < kN; ++column) for (int k = 0; k < kK; ++k)
      b[column * kK + k] = __float2half(float(b_value(seed, column, k)));
    __half *da = nullptr, *db = nullptr;
    uint64_t* dtags = nullptr;
    float* dout = nullptr;
    Event* devents = nullptr;
    Lifecycle* dlife = nullptr;
    check(cudaMalloc(&da, a.size() * sizeof(__half)), "allocate A");
    check(cudaMalloc(&db, b.size() * sizeof(__half)), "allocate B");
    check(cudaMalloc(&dtags, tags.size() * sizeof(uint64_t)), "allocate tags");
    check(cudaMalloc(&dout, elements * sizeof(float)), "allocate output");
    check(cudaMalloc(&devents, iterations * kEvents * sizeof(Event)), "allocate events");
    check(cudaMalloc(&dlife, sizeof(Lifecycle)), "allocate lifecycle");
    check(cudaMemcpy(da, a.data(), a.size() * sizeof(__half), cudaMemcpyHostToDevice), "copy A");
    check(cudaMemcpy(db, b.data(), b.size() * sizeof(__half), cudaMemcpyHostToDevice), "copy B");
    check(cudaMemcpy(dtags, tags.data(), tags.size() * sizeof(uint64_t), cudaMemcpyHostToDevice), "copy tags");
    check(cudaMemset(dout, 0xff, elements * sizeof(float)), "sentinel output");
    check(cudaMemset(devents, 0xff, iterations * kEvents * sizeof(Event)), "sentinel events");
    check(cudaMemset(dlife, 0, sizeof(Lifecycle)), "zero lifecycle");
    // A 2-billion-cycle device watchdog supplements the 120s process timeout.
    tcgen05_probe<<<1, 128>>>(da, db, dtags, iterations, variant, generation_base,
                             2000000000ull, dout, devents, dlife);
    check(cudaGetLastError(), "launch");
    check(cudaDeviceSynchronize(), "synchronize");
    std::vector<float> output(elements), reference(elements);
    std::vector<Event> events(iterations * kEvents);
    Lifecycle life{};
    check(cudaMemcpy(output.data(), dout, elements * sizeof(float), cudaMemcpyDeviceToHost), "read output");
    check(cudaMemcpy(events.data(), devents, events.size() * sizeof(Event), cudaMemcpyDeviceToHost), "read events");
    check(cudaMemcpy(&life, dlife, sizeof(Lifecycle), cudaMemcpyDeviceToHost), "read lifecycle");
    check(cudaFree(dlife), "free lifecycle"); check(cudaFree(devents), "free events");
    check(cudaFree(dout), "free output"); check(cudaFree(dtags), "free tags");
    check(cudaFree(db), "free B"); check(cudaFree(da), "free A");
    if (life.allocated != 1 || life.deallocated != 1 || life.columns != kColumns)
      throw std::runtime_error("incomplete TMEM lifecycle");
    size_t mismatches = 0, selected_mismatches = 0, version_mismatches = 0;
    float max_abs_error = 0;
    for (int iteration = 0; iteration < iterations; ++iteration) {
      const Event& selected = events[iteration * kEvents];
      if (selected.selected_input >= uint32_t(inputs)) throw std::runtime_error("invalid selected input event");
      version_mismatches += selected.observed_generation != generation_base + uint64_t(iteration + 2);
      for (int row = 0; row < kM; ++row) for (int column = 0; column < kN; ++column) {
        const size_t i = (iteration * kM + row) * kN + column;
        if (!std::isfinite(output[i])) throw std::runtime_error("nonfinite or unwritten output");
        reference[i] = reference_value(seed, iteration + 2, row, column);
        const float selected_reference = reference_value(seed, int(selected.selected_input), row, column);
        mismatches += output[i] != reference[i];
        selected_mismatches += output[i] != selected_reference;
        max_abs_error = std::max(max_abs_error, std::abs(output[i] - reference[i]));
      }
    }
    for (size_t i = 0; i < events.size(); ++i) {
      const Event& e = events[i];
      if (e.role > 4 || e.iteration != i / kEvents || e.thread >= 128 ||
          e.tmem_base != life.tmem_base || e.tmem_columns != kColumns ||
          e.barrier_address != life.barrier_address || e.barrier_phase != (e.iteration & 1))
        throw std::runtime_error("unwritten or inconsistent observation");
    }
    const char* roles[] = {"input_selected", "mma_committed", "mma_wait_success", "tmem_reader_done", "reuse_ready"};
    const char* domains[] = {"value", "commit_issued", "producer_result_ready", "reader_done", "reuse_ready"};
    std::cout << std::setprecision(9)
      << "{\"format\":\"tcgen05-probe-v1\",\"source_contract\":\"tcgen05-probe-v1\",\"variant\":\"" << variant_name
      << "\",\"shape\":[128,32,16],\"dtype\":\"f16xf16-f32\",\"grid\":[1,1,1],\"block\":[128,1,1]"
      << ",\"iterations\":" << iterations << ",\"seed\":" << seed << ",\"generation_base\":\"" << generation_base
      << "\",\"gpu\":{\"name\":\"" << device.name << "\",\"major\":" << device.major << ",\"minor\":" << device.minor
      << ",\"runtime_version\":" << runtime_version << ",\"driver_version\":" << driver_version << "}"
      << ",\"instruction_descriptor\":" << kInstructionDescriptor
      << ",\"lifecycle\":{\"allocated\":true,\"deallocated\":true,\"tmem_base\":" << life.tmem_base
      << ",\"tmem_columns\":" << life.columns << ",\"barrier_address\":" << life.barrier_address << "}"
      << ",\"correctness\":{\"elements\":" << elements << ",\"expected_value_mismatches\":" << mismatches
      << ",\"selected_source_mismatches\":" << selected_mismatches << ",\"version_mismatches\":" << version_mismatches
      << ",\"max_abs_error\":" << max_abs_error << ",\"passed\":" << (!mismatches && !version_mismatches ? "true" : "false")
      << ",\"exact_integer_reference\":true},\"output\":";
    print_array(output);
    std::cout << ",\"reference\":"; print_array(reference);
    std::cout << ",\"events\":[";
    for (size_t i = 0; i < events.size(); ++i) {
      const Event& e = events[i];
      if (i) std::cout << ',';
      std::cout << "{\"id\":\"i" << e.iteration << ":e" << i % kEvents << "\",\"event_layout_index\":" << i
        << ",\"iteration\":" << e.iteration << ",\"role\":\"" << roles[e.role] << "\",\"domain\":\"" << domains[e.role]
        << "\",\"thread\":" << e.thread << ",\"warp_id\":" << e.thread / 32
        << ",\"expected_generation\":\"" << e.expected_generation << "\",\"observed_generation\":\"" << e.observed_generation
        << "\",\"barrier_generation\":\"" << e.iteration << "\",\"barrier_phase\":" << e.barrier_phase
        << ",\"selected_input\":" << e.selected_input << ",\"candidate_input\":" << e.candidate_input << ",\"repaired\":" << (e.repaired ? "true" : "false")
        << ",\"tmem_base\":" << e.tmem_base << ",\"tmem_columns\":" << e.tmem_columns << ",\"barrier_address\":" << e.barrier_address
        << ",\"descriptor_a\":\"" << e.descriptor_a << "\",\"descriptor_b\":\"" << e.descriptor_b
        << "\",\"wait_success\":" << (e.wait_success ? "true" : "false") << ",\"failed_wait_polls\":" << e.wait_polls
        << ",\"representative_value\":" << e.representative_value << ",\"clock64\":\"" << e.clock << "\",\"source_line\":" << e.source_line << '}';
    }
    std::cout << "]}\n";
    if (selected_mismatches) return 1;
    return mismatches || version_mismatches ? 2 : 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
