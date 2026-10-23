// Generated only by prepare-version-kernel.py. Source SHA256: 99f8a78d3f9fdc932fdbc83acc85b6d5ea847c3d59cf7f0be00bc8f114395f29
// Controlled SM89 version-tag probe. This is an experiment-authored fault,
// not a naturally occurring AI-generated defect or an SM100 protocol test.
#include <cuda_runtime.h>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

static void check(cudaError_t status, const char* operation) {
  if (status != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
}

struct Event {
  int block;
  int thread;
  int generation;
  int role;
  int slot;
  int observed_generation;
  int representative_value;
  int valid_elements;
  int source_line;
};

__device__ int payload_value(uint32_t seed, int generation, int index) {
  uint32_t value = seed ^ (uint32_t(generation + 1) * 0x9e3779b9u)
                        ^ (uint32_t(index + 11) * 0x85ebca6bu);
  return int(value & 0x7fffffu);
}

__device__ void cost_emit(Event* events, int generations, int generation, int role,
                     int slot, int observed, int value, int valid, int line) {
  int position = (int(blockIdx.x) * generations + generation) * 5 + role;
  events[position] = {int(blockIdx.x), int(threadIdx.x), generation, role,
                      slot, observed, value, valid, line};
}

template <bool Record>
__global__ void cost_version_probe(int count, int generations, uint32_t seed,
                              bool wrong_slot, int* output, int* observed_tags,
                              Event* events) {
  __shared__ int values[2][32];
  __shared__ int tags[2];
  const int thread = int(threadIdx.x);
  const int lane = thread & 31;
  const int index = int(blockIdx.x) * 32 + lane;
  const int valid = min(32, count - int(blockIdx.x) * 32);
  if (thread < 32) {
    // Both slots have an initialized, explicitly tagged prehistory.
    values[0][lane] = -(1000000 + index);
    values[1][lane] = -(1000000 + index);
  }
  if constexpr (Record) if (thread == 0) tags[0] = tags[1] = -1;
  __syncthreads();  // CONTRACT_INITIALIZATION_BARRIER
  for (int generation = 0; generation < generations; ++generation) {
    const int write_slot = generation & 1;
    const int read_slot = wrong_slot ? 1 - write_slot : write_slot;
    if (thread < 32) values[write_slot][lane] = payload_value(seed, generation, index);
    if (thread == 0) {
      if constexpr (Record) tags[write_slot] = generation;
      if constexpr (Record) cost_emit(events, generations, generation, 0, write_slot, tags[write_slot],
           values[write_slot][0], valid, __LINE__);
    }
    __syncthreads();  // CONTRACT_PRODUCER_VISIBILITY_BARRIER
    if (thread == 0) {
      if constexpr (Record) cost_emit(events, generations, generation, 1, write_slot, tags[write_slot],
           values[write_slot][0], valid, __LINE__);
    }
    int observed = -99;
    int value = 0;
    if (thread >= 32) {
      // The fault changes only the selected initialized slot. Addresses remain
      // legal and all threads execute both CTA barriers for every generation.
      if constexpr (Record) observed = tags[read_slot];
      value = values[read_slot][lane];
      if (index < count) {
        output[generation * count + index] = value;
        if constexpr (Record) observed_tags[generation * count + index] = observed;
      }
      if (thread == 32) {
        if constexpr (Record) cost_emit(events, generations, generation, 2, read_slot, observed, value, valid, __LINE__);
      }
    }
    __syncthreads();  // CONTRACT_READER_COMPLETION_REUSE_BARRIER
    if (thread == 32) {
      if constexpr (Record) cost_emit(events, generations, generation, 3, read_slot, observed, value, valid, __LINE__);
    }
    if (thread == 0) {
      if constexpr (Record) cost_emit(events, generations, generation, 4, write_slot, tags[write_slot],
           values[write_slot][0], valid, __LINE__);
    }
  }
}

