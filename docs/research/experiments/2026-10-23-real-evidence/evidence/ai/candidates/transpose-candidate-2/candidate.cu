#include <cuda_runtime.h>
#include <cstdint>

namespace {
__global__ void transpose_kernel(const float* __restrict__ x,
                                 float* __restrict__ y,
                                 int rows, int cols,
                                 int x_stride, int y_stride) {
    __shared__ float tile[32][33];

    const int tx = static_cast<int>(threadIdx.x);
    const int ty = static_cast<int>(threadIdx.y);
    const int input_col = static_cast<int>(blockIdx.x) * 32 + tx;
    const int input_row = static_cast<int>(blockIdx.y) * 32 + ty;

    #pragma unroll
    for (int j = 0; j < 32; j += 8) {
        if (input_row + j < rows && input_col < cols) {
            tile[ty + j][tx] = x[(input_row + j) * x_stride + input_col];
        }
    }

    __syncthreads();

    const int output_col = static_cast<int>(blockIdx.y) * 32 + tx;
    const int output_row = static_cast<int>(blockIdx.x) * 32 + ty;

    #pragma unroll
    for (int j = 0; j < 32; j += 8) {
        if (output_row + j < cols && output_col < rows) {
            y[(output_row + j) * y_stride + output_col] = tile[tx][ty + j];
        }
    }
}
} // namespace

extern "C" cudaError_t launch_transpose(const float* x, float* y,
                                        int rows, int cols,
                                        int x_stride, int y_stride,
                                        cudaStream_t stream) {
    if (rows == 0 || cols == 0) {
        return cudaSuccess;
    }

    const dim3 block(32, 8);
    const dim3 grid((cols + 31) / 32, (rows + 31) / 32);
    transpose_kernel<<<grid, block, 0, stream>>>(
        x, y, rows, cols, x_stride, y_stride);
    return cudaGetLastError();
}
