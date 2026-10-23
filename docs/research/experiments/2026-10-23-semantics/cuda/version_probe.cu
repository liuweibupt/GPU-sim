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

__device__ void emit(Event* events, int generations, int generation, int role,
                     int slot, int observed, int value, int valid, int line) {
  int position = (int(blockIdx.x) * generations + generation) * 5 + role;
  events[position] = {int(blockIdx.x), int(threadIdx.x), generation, role,
                      slot, observed, value, valid, line};
}

__global__ void version_probe(int count, int generations, uint32_t seed,
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
  if (thread == 0) tags[0] = tags[1] = -1;
  __syncthreads();  // CONTRACT_INITIALIZATION_BARRIER
  for (int generation = 0; generation < generations; ++generation) {
    const int write_slot = generation & 1;
    const int read_slot = wrong_slot ? 1 - write_slot : write_slot;
    if (thread < 32) values[write_slot][lane] = payload_value(seed, generation, index);
    if (thread == 0) {
      tags[write_slot] = generation;
      emit(events, generations, generation, 0, write_slot, tags[write_slot],
           values[write_slot][0], valid, __LINE__);
    }
    __syncthreads();  // CONTRACT_PRODUCER_VISIBILITY_BARRIER
    if (thread == 0) {
      emit(events, generations, generation, 1, write_slot, tags[write_slot],
           values[write_slot][0], valid, __LINE__);
    }
    int observed = -99;
    int value = 0;
    if (thread >= 32) {
      // The fault changes only the selected initialized slot. Addresses remain
      // legal and all threads execute both CTA barriers for every generation.
      observed = tags[read_slot];
      value = values[read_slot][lane];
      if (index < count) {
        output[generation * count + index] = value;
        observed_tags[generation * count + index] = observed;
      }
      if (thread == 32) {
        emit(events, generations, generation, 2, read_slot, observed, value, valid, __LINE__);
      }
    }
    __syncthreads();  // CONTRACT_READER_COMPLETION_REUSE_BARRIER
    if (thread == 32) {
      emit(events, generations, generation, 3, read_slot, observed, value, valid, __LINE__);
    }
    if (thread == 0) {
      emit(events, generations, generation, 4, write_slot, tags[write_slot],
           values[write_slot][0], valid, __LINE__);
    }
  }
}

template <typename T> static void print_array(const std::vector<T>& values) {
  std::cout << '[';
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << values[i];
  }
  std::cout << ']';
}

int main(int argc, char** argv) {
  try {
    if (argc != 5) throw std::runtime_error("usage: version_probe count generations seed correct|wrong-slot");
    int count = std::stoi(argv[1]);
    int generations = std::stoi(argv[2]);
    uint32_t seed = uint32_t(std::stoul(argv[3]));
    std::string variant = argv[4];
    if (count <= 0 || count > 4096 || generations <= 0 || generations > 64 ||
        (variant != "correct" && variant != "wrong-slot")) throw std::runtime_error("invalid probe arguments");
    bool wrong = variant == "wrong-slot";
    int blocks = (count + 31) / 32;
    size_t elements = size_t(count) * generations;
    size_t event_count = size_t(blocks) * generations * 5;
    int *device_output = nullptr, *device_tags = nullptr;
    Event* device_events = nullptr;
    check(cudaMalloc(&device_output, elements * sizeof(int)), "allocate output");
    check(cudaMalloc(&device_tags, elements * sizeof(int)), "allocate tags");
    check(cudaMalloc(&device_events, event_count * sizeof(Event)), "allocate events");
    check(cudaMemset(device_output, 0xcd, elements * sizeof(int)), "sentinel output");
    check(cudaMemset(device_tags, 0xcd, elements * sizeof(int)), "sentinel tags");
    check(cudaMemset(device_events, 0xcd, event_count * sizeof(Event)), "sentinel events");
    version_probe<<<blocks, 64>>>(count, generations, seed, wrong, device_output, device_tags, device_events);
    check(cudaGetLastError(), "launch");
    check(cudaDeviceSynchronize(), "synchronize");
    std::vector<int> output(elements), tags(elements), reference(elements), expected_tags(elements);
    std::vector<Event> events(event_count);
    check(cudaMemcpy(output.data(), device_output, elements * sizeof(int), cudaMemcpyDeviceToHost), "copy output");
    check(cudaMemcpy(tags.data(), device_tags, elements * sizeof(int), cudaMemcpyDeviceToHost), "copy tags");
    check(cudaMemcpy(events.data(), device_events, event_count * sizeof(Event), cudaMemcpyDeviceToHost), "copy events");
    check(cudaFree(device_events), "free events");
    check(cudaFree(device_tags), "free tags");
    check(cudaFree(device_output), "free output");
    int value_mismatches = 0, version_mismatches = 0;
    for (int generation = 0; generation < generations; ++generation) {
      for (int index = 0; index < count; ++index) {
        size_t position = size_t(generation) * count + index;
        // Independently written host oracle, repeated independently in Python.
        uint64_t left = uint64_t(generation + 1) * 2654435769ull;
        uint64_t right = uint64_t(index + 11) * 2246822507ull;
        reference[position] = int((uint64_t(seed) ^ left ^ right) & 8388607ull);
        expected_tags[position] = generation;
        value_mismatches += output[position] != reference[position];
        version_mismatches += tags[position] != generation;
      }
    }
    const char* roles[] = {"producer_write", "producer_complete", "consumer_read", "reader_done", "reuse_ready"};
    const char* phases[] = {"before_producer_barrier", "after_producer_barrier", "before_reuse_barrier",
                            "after_reuse_barrier", "after_reuse_barrier"};
    std::cout << "{\"format\":\"gpu-version-probe-v1\",\"shape\":[" << count
              << "],\"generations\":" << generations << ",\"seed\":" << seed
              << ",\"variant\":\"" << variant << "\",\"grid\":[" << blocks
              << ",1,1],\"block\":[64,1,1],\"correctness\":{\"value_mismatches\":" << value_mismatches
              << ",\"version_mismatches\":" << version_mismatches << ",\"elements\":" << elements
              << ",\"passed\":" << ((value_mismatches == 0 && version_mismatches == 0) ? "true" : "false")
              << "},\"output\":";
    print_array(output);
    std::cout << ",\"reference\":"; print_array(reference);
    std::cout << ",\"observed_generations\":"; print_array(tags);
    std::cout << ",\"expected_generations\":"; print_array(expected_tags);
    std::cout << ",\"events\":[";
    for (size_t i = 0; i < events.size(); ++i) {
      const Event& event = events[i];
      if (event.role < 0 || event.role > 4) throw std::runtime_error("unwritten or invalid event role");
      if (i) std::cout << ',';
      int thread_ordinal = event.thread == 0 ? event.generation * 3 + (event.role == 4 ? 2 : event.role)
                                            : event.generation * 2 + event.role - 2;
      std::cout << "{\"id\":\"b" << event.block << ":g" << event.generation << ":r" << event.role
                << "\",\"event_layout_index\":" << i << ",\"cta\":[" << event.block
                << ",0,0],\"thread\":" << event.thread << ",\"warp_id\":" << event.thread / 32
                << ",\"thread_program_ordinal\":" << thread_ordinal << ",\"iteration\":" << event.generation
                << ",\"role\":\"" << roles[event.role] << "\",\"phase\":\"" << phases[event.role]
                << "\",\"slot\":" << event.slot << ",\"expected_generation\":" << event.generation
                << ",\"observed_generation\":" << event.observed_generation
                << ",\"representative_value\":" << event.representative_value
                << ",\"valid_elements\":" << event.valid_elements << ",\"source_line\":" << event.source_line << '}';
    }
    std::cout << "]}\n";
    return value_mismatches || version_mismatches ? 2 : 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
