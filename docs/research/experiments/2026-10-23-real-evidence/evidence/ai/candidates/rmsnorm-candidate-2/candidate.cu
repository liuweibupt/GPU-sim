#include <cuda_runtime.h>
#include <cstdint>

namespace {
__global__ void rmsnorm_kernel(const float* __restrict__ x,
                               float* __restrict__ y,
                               int cols, int x_stride, int y_stride,
                               float epsilon) {
    const int row = static_cast<int>(blockIdx.x);
    const int tid = static_cast<int>(threadIdx.x);
    const int lane = tid & 31;
    const int warp = tid >> 5;
    const float* input = x + row * x_stride;
    float* output = y + row * y_stride;
    __shared__ float warp_sums[8];
    __shared__ float inverse_rms;

    float sum = 0.0f;
    for (int c = tid; c < cols; c += 256) {
        const float value = input[c];
        sum = fmaf(value, value, sum);
    }
    for (int offset = 16; offset > 0; offset >>= 1) {
        sum += __shfl_down_sync(0xffffffffu, sum, offset);
    }
    if (lane == 0) {
        warp_sums[warp] = sum;
    }
    __syncthreads();

    if (warp == 0) {
        float total = lane < 8 ? warp_sums[lane] : 0.0f;
        for (int offset = 16; offset > 0; offset >>= 1) {
            total += __shfl_down_sync(0xffffffffu, total, offset);
        }
        if (lane == 0) {
            inverse_rms = rsqrtf(total / static_cast<float>(cols) + epsilon);
        }
    }
    __syncthreads();

    for (int c = tid; c < cols; c += 256) {
        output[c] = input[c] * inverse_rms;
    }
}
}  // namespace

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
