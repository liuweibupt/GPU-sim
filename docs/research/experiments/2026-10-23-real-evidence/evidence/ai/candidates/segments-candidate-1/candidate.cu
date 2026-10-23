#include <cuda_runtime.h>
#include <cstdint>

namespace {
constexpr int kThreads = 256;

__global__ void sum_segments(const int32_t* __restrict__ x,
                             const int32_t* __restrict__ offsets,
                             int64_t* __restrict__ y) {
    const int s = static_cast<int>(blockIdx.x);
    const int tid = static_cast<int>(threadIdx.x);
    const int begin = offsets[s];
    const int end = offsets[s + 1];

    int64_t sum = 0;
    for (int i = begin + tid; i < end; i += kThreads) {
        sum += static_cast<int64_t>(x[i]);
    }

    __shared__ int64_t partial[kThreads];
    partial[tid] = sum;
    __syncthreads();

    for (int stride = kThreads / 2; stride > 0; stride /= 2) {
        if (tid < stride) {
            partial[tid] += partial[tid + stride];
        }
        __syncthreads();
    }

    if (tid == 0) {
        y[s] = partial[0];
    }
}
}  // namespace

extern "C" cudaError_t launch_segments(const int32_t* x,
                                        const int32_t* offsets,
                                        int64_t* y,
                                        int n,
                                        int segments,
                                        cudaStream_t stream) {
    (void)n;
    if (segments == 0) {
        return cudaSuccess;
    }
    sum_segments<<<segments, kThreads, 0, stream>>>(x, offsets, y);
    return cudaGetLastError();
}
