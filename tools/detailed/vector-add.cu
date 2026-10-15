// Small deterministic workload for capturing real FlashGPU-Sim instructions.
#include <cuda_runtime.h>
#include <cstdio>
#include <cstdlib>

static void check(cudaError_t status, const char* operation) {
  if (status != cudaSuccess) {
    std::fprintf(stderr, "%s failed: %s\n", operation, cudaGetErrorString(status));
    std::exit(1);
  }
}

__global__ void vectorAdd(const float* a, const float* b, float* c, int count) {
  int index = blockIdx.x * blockDim.x + threadIdx.x;
  if (index < count) c[index] = a[index] + b[index];
}

int main() {
  constexpr int count = 256;
  constexpr int threads = 128;
  float a[count], b[count], c[count];
  for (int index = 0; index < count; ++index) {
    a[index] = static_cast<float>(index);
    b[index] = static_cast<float>(2 * index);
  }
  float *deviceA, *deviceB, *deviceC;
  check(cudaMalloc(&deviceA, sizeof(a)), "cudaMalloc A");
  check(cudaMalloc(&deviceB, sizeof(b)), "cudaMalloc B");
  check(cudaMalloc(&deviceC, sizeof(c)), "cudaMalloc C");
  check(cudaMemcpy(deviceA, a, sizeof(a), cudaMemcpyHostToDevice), "copy A");
  check(cudaMemcpy(deviceB, b, sizeof(b), cudaMemcpyHostToDevice), "copy B");
  std::printf("Vector addition: elements=%d blocks=%d threads_per_block=%d\n",
              count, (count + threads - 1) / threads, threads);
  vectorAdd<<<(count + threads - 1) / threads, threads>>>(deviceA, deviceB, deviceC, count);
  check(cudaGetLastError(), "vectorAdd launch");
  check(cudaMemcpy(c, deviceC, sizeof(c), cudaMemcpyDeviceToHost), "copy result");
  for (int index = 0; index < count; ++index) {
    if (c[index] != static_cast<float>(3 * index)) {
      std::fprintf(stderr, "Validation FAILED: index=%d actual=%f\n", index, c[index]);
      return 1;
    }
  }
  check(cudaFree(deviceA), "cudaFree A");
  check(cudaFree(deviceB), "cudaFree B");
  check(cudaFree(deviceC), "cudaFree C");
  std::puts("Vector addition validation PASSED (256/256 exact results)");
  return 0;
}
