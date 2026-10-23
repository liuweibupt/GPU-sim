#include <cuda_runtime.h>
#include <cstdint>

namespace {
__global__ void sum_segments_kernel(const int32_t* x,
                                    const int32_t* offsets,
                                    int64_t* y) {
    const int s = static_cast<int>(blockIdx.x);
    const int tid = static_cast<int>(threadIdx.x);
    const int begin = offsets[s];
    const int end = offsets[s + 1];
    int64_t sum = 0;
    for (int i = begin + tid; i < end; i += 256) {
        sum += static_cast<int64_t>(x[i]);
    }

    __shared__ int64_t partial[256];
    partial[tid] = sum;
    __syncthreads();
    for (int stride = 128; stride > 0; stride >>= 1) {
        if (tid < stride) {
            partial[tid] += partial[tid + stride];
        }
        __syncthreads();
    }
    if (tid == 0) {
        y[s] = partial[0];
    }
}
}

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
    sum_segments_kernel<<<segments, 256, 0, stream>>>(x, offsets, y);
    return cudaGetLastError();
}
