#include <cuda_runtime.h>
#include <cstdint>

namespace {
__global__ void rmsnorm_kernel(const float* __restrict__ x,
                               float* __restrict__ y,
                               int cols, int x_stride, int y_stride,
                               float epsilon) {
    constexpr int kThreads = 256;
    __shared__ float partial[kThreads];
    __shared__ float inverse_rms;

    const int row = static_cast<int>(blockIdx.x);
    const int tid = static_cast<int>(threadIdx.x);
    const float* input = x + row * x_stride;
    float* output = y + row * y_stride;

    float sum = 0.0f;
    for (int col = tid; col < cols; col += kThreads) {
        const float value = input[col];
        sum = fmaf(value, value, sum);
    }
    partial[tid] = sum;
    __syncthreads();

    for (int offset = kThreads / 2; offset > 0; offset >>= 1) {
        if (tid < offset) {
            partial[tid] += partial[tid + offset];
        }
        __syncthreads();
    }

    if (tid == 0) {
        inverse_rms = rsqrtf(partial[0] / static_cast<float>(cols) + epsilon);
    }
    __syncthreads();

    for (int col = tid; col < cols; col += kThreads) {
        output[col] = input[col] * inverse_rms;
    }
}
} // namespace

extern "C" cudaError_t launch_rmsnorm(const float* x, float* y,
                                      int rows, int cols,
                                      int x_stride, int y_stride,
                                      float epsilon, cudaStream_t stream) {
    if (rows == 0) {
        return cudaSuccess;
    }
    rmsnorm_kernel<<<rows, 256, 0, stream>>>(x, y, cols, x_stride, y_stride, epsilon);
    return cudaGetLastError();
}
