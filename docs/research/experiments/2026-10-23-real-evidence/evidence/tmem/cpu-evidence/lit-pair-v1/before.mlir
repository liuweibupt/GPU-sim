#blocked = #ttg.blocked<{sizePerThread = [1, 128], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1]}>
#blocked1 = #ttg.blocked<{sizePerThread = [1, 32], threadsPerWarp = [16, 2], warpsPerCTA = [4, 1], order = [0, 1]}>
#blocked2 = #ttg.blocked<{sizePerThread = [1, 64], threadsPerWarp = [16, 2], warpsPerCTA = [4, 1], order = [0, 1]}>
#linear = #ttg.linear<{register = [[0, 1], [0, 2], [32, 0]], lane = [[1, 0], [2, 0], [4, 0], [8, 0], [16, 0]], warp = [[0, 0], [0, 0]], block = []}>
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 1>
#tmem1 = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 2>
#tmem2 = #ttng.tensor_memory_encoding<blockM = 64, blockN = 64, colStride = 2>
#tmem3 = #ttng.tensor_memory_encoding<blockM = 64, blockN = 128, colStride = 2>
#tmem_scales = #ttng.tensor_memory_scales_encoding<>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 512 : i32, "ttg.threads-per-warp" = 32 : i32} {
  tt.func public @alloc_tensor_memory(%arg0: !tt.ptr<f16>, %arg1: !tt.ptr<f16>, %arg2: !tt.ptr<f16>) {
    %true = arith.constant true
    %cst = arith.constant dense<0.000000e+00> : tensor<128x128xf32, #blocked>
    %cst_0 = arith.constant dense<0.000000e+00> : tensor<128x128xf16, #blocked>
    %cst_1 = arith.constant dense<0.000000e+00> : tensor<64x64xf16, #blocked1>
    %cst_2 = arith.constant dense<0.000000e+00> : tensor<64x128xf16, #blocked2>
    %cst_3 = arith.constant dense<0> : tensor<64x4xi8, #linear>
    %cst_4 = arith.constant dense<0.000000e+00> : tensor<64x128xf16, #blocked2>
    %result = ttng.tmem_alloc %cst {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x128xf32, #blocked>) -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_5 = ttng.tmem_alloc %cst_0 {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x128xf16, #blocked>) -> !ttg.memdesc<128x128xf16, #tmem1, #ttng.tensor_memory, mutable>
    %result_6 = ttng.tmem_alloc %cst_1 {tensor_memory_col_offset = 256 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<64x64xf16, #blocked1>) -> !ttg.memdesc<64x64xf16, #tmem2, #ttng.tensor_memory, mutable>
    %result_7 = ttng.tmem_alloc %cst {tensor_memory_col_offset = 320 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x128xf32, #blocked>) -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %result, %true : tensor<128x128xf32, #blocked> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_0, %result_5, %true : tensor<128x128xf16, #blocked> -> !ttg.memdesc<128x128xf16, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_1, %result_6, %true : tensor<64x64xf16, #blocked1> -> !ttg.memdesc<64x64xf16, #tmem2, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %result_7, %true : tensor<128x128xf32, #blocked> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_8 = ttng.tmem_alloc %cst_4 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<64x128xf16, #blocked2>) -> !ttg.memdesc<64x128xf16, #tmem3, #ttng.tensor_memory, mutable>
    %result_9 = ttng.tmem_alloc %cst_4 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 16 : i32} : (tensor<64x128xf16, #blocked2>) -> !ttg.memdesc<64x128xf16, #tmem3, #ttng.tensor_memory, mutable>
    %result_10 = ttng.tmem_alloc %cst {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x128xf32, #blocked>) -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_8, %true : tensor<64x128xf16, #blocked2> -> !ttg.memdesc<64x128xf16, #tmem3, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_9, %true : tensor<64x128xf16, #blocked2> -> !ttg.memdesc<64x128xf16, #tmem3, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %result_10, %true : tensor<128x128xf32, #blocked> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_11 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x4xi8, #tmem_scales, #ttng.tensor_memory, mutable>
    %result_12 = ttng.tmem_alloc {tensor_memory_col_offset = 4 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x4xi8, #tmem_scales, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_3, %result_11, %true : tensor<64x4xi8, #linear> -> !ttg.memdesc<64x4xi8, #tmem_scales, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_3, %result_12, %true : tensor<64x4xi8, #linear> -> !ttg.memdesc<64x4xi8, #tmem_scales, #ttng.tensor_memory, mutable>
    tt.return
  }
}

// -----
#blocked = #ttg.blocked<{sizePerThread = [1, 128], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1]}>
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 4 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 512 : i32} {
  tt.func @tmem_subslice_extends_liveness() {
    %true = arith.constant true
    %cst = arith.constant dense<0.000000e+00> : tensor<128x128xf32, #blocked>
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = ttng.tmem_subslice %result {dim = 0 : i32, offset = 128 : i32} : !ttg.memdesc<256x128xf32, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable, 256x128>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 256 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %result_0, %true : tensor<128x128xf32, #blocked> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %0, %true : tensor<128x128xf32, #blocked> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable, 256x128>
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 1, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 4 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 32 : i32} {
  tt.func public @tmem_f16_one_column() {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x1xf16, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result) : (!ttg.memdesc<128x1xf16, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

// -----
#blocked = #ttg.blocked<{sizePerThread = [1, 128], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1]}>
#blocked1 = #ttg.blocked<{sizePerThread = [1, 64], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1]}>
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 1>
#tmem1 = #ttng.tensor_memory_encoding<blockM = 128, blockN = 64, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 512 : i32, "ttg.threads-per-warp" = 32 : i32} {
  tt.func public @alloc_tensor_memory_re_use(%arg0: !tt.ptr<f16>, %arg1: !tt.ptr<f16>, %arg2: !tt.ptr<f16>) {
    %true = arith.constant true
    %c1_i32 = arith.constant 1 : i32
    %c0_i32 = arith.constant 0 : i32
    %cst = arith.constant dense<0.000000e+00> : tensor<128x128xf32, #blocked>
    %cst_0 = arith.constant dense<0.000000e+00> : tensor<128x256xf32, #blocked>
    %cst_1 = arith.constant dense<0.000000e+00> : tensor<64x64xf16, #blocked>
    %cst_2 = arith.constant dense<0.000000e+00> : tensor<128x64xf32, #blocked1>
    %result = ttng.tmem_alloc %cst_0 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x256xf32, #blocked>) -> !ttg.memdesc<128x256xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_3 = ttng.tmem_alloc %cst {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x128xf32, #blocked>) -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_4 = ttng.tmem_alloc %cst_2 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked1>) -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    %result_5 = ttng.tmem_alloc %cst_2 {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked1>) -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_4, %true : tensor<128x64xf32, #blocked1> -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_5, %true : tensor<128x64xf32, #blocked1> -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    %result_6 = ttng.tmem_alloc %cst_0 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x256xf32, #blocked>) -> !ttg.memdesc<128x256xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_7 = ttng.tmem_alloc %cst_2 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked1>) -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    %result_8 = ttng.tmem_alloc %cst_2 {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked1>) -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_7, %true : tensor<128x64xf32, #blocked1> -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    %result_9 = ttng.tmem_alloc {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<2x128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = ttg.memdesc_index %result_9[%c1_i32] : !ttg.memdesc<2x128x128xf32, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_10 = ttng.tmem_alloc %cst_2 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked1>) -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    %result_11 = ttng.tmem_alloc %cst_2 {tensor_memory_col_offset = 384 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked1>) -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %0, %true : tensor<128x128xf32, #blocked> -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_10, %true : tensor<128x64xf32, #blocked1> -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_8, %true : tensor<128x64xf32, #blocked1> -> !ttg.memdesc<128x64xf32, #tmem1, #ttng.tensor_memory, mutable>
    tt.return
  }
}

// -----
#blocked = #ttg.blocked<{sizePerThread = [1, 32], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1]}>
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 64, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 128 : i32, "ttg.threads-per-warp" = 32 : i32} {
  tt.func public @alloc_tensor_memory_re_use_liverange_end_collision(%arg0: !tt.ptr<f16>, %arg1: !tt.ptr<f16>, %arg2: !tt.ptr<f16>, %arg3: index, %arg4: index, %arg5: index) {
    %true = arith.constant true
    %c1_i32 = arith.constant 1 : i32
    %c0_i32 = arith.constant 0 : i32
    %cst = arith.constant dense<0.000000e+00> : tensor<128x64xf32, #blocked>
    %cst_0 = arith.constant dense<0.000000e+00> : tensor<128x64xf32, #blocked>
    %cst_1 = arith.constant dense<0.000000e+00> : tensor<128x64xf32, #blocked>
    %cst_2 = arith.constant dense<0.000000e+00> : tensor<128x64xf32, #blocked>
    %result = ttng.tmem_alloc %cst_0 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked>) -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_3 = ttng.tmem_alloc %cst {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked>) -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    scf.for %arg6 = %arg3 to %arg4 step %arg5 {
      ttng.tmem_store %cst_2, %result, %true : tensor<128x64xf32, #blocked> -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
      ttng.tmem_store %cst_2, %result_3, %true : tensor<128x64xf32, #blocked> -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    }
    %result_4 = ttng.tmem_alloc %cst_0 {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked>) -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_5 = ttng.tmem_alloc %cst {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : (tensor<128x64xf32, #blocked>) -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_4, %true : tensor<128x64xf32, #blocked> -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_2, %result_5, %true : tensor<128x64xf32, #blocked> -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    tt.return
  }
}

// -----
#blocked = #ttg.blocked<{sizePerThread = [1, 32], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1], CGALayout = [[0, 1]]}>
#blocked1 = #ttg.blocked<{sizePerThread = [1, 64], threadsPerWarp = [32, 1], warpsPerCTA = [4, 1], order = [0, 1], CGALayout = [[1, 0]]}>
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 2, CGALayout = [[1, 0]]>
#tmem1 = #ttng.tensor_memory_encoding<blockM = 128, blockN = 64, colStride = 2, CGALayout = [[0, 1]]>
module attributes {"ttg.num-ctas" = 2 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 512 : i32, "ttg.threads-per-warp" = 32 : i32} {
  tt.func public @multi_ctas() {
    %true = arith.constant true
    %cst = arith.constant dense<0.000000e+00> : tensor<256x128xf16, #blocked>
    %cst_0 = arith.constant dense<0.000000e+00> : tensor<256x128xf16, #blocked1>
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x128xf16, #tmem, #ttng.tensor_memory, mutable>
    %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x128xf16, #tmem1, #ttng.tensor_memory, mutable>
    %result_2 = ttng.tmem_alloc {tensor_memory_col_offset = 256 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x128xf16, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_0, %result, %true : tensor<256x128xf16, #blocked1> -> !ttg.memdesc<256x128xf16, #tmem, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst, %result_1, %true : tensor<256x128xf16, #blocked> -> !ttg.memdesc<256x128xf16, #tmem1, #ttng.tensor_memory, mutable>
    ttng.tmem_store %cst_0, %result_2, %true : tensor<256x128xf16, #blocked1> -> !ttg.memdesc<256x128xf16, #tmem, #ttng.tensor_memory, mutable>
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 512 : i32} {
  tt.func @alloc_warp_specialize() {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttg.warp_specialize()
    default {
      %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
      %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
      ttg.warp_yield
    }
    partition0() num_warps(1) {
      %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 256 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
      %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 384 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
      "use"(%result_0) : (!ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
      ttg.warp_return
    } : () -> ()
    "use"(%result) : (!ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
  tt.func @alloc_warp_specialize_explicit_capture() {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttg.warp_specialize(%result)
    default {
      %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 128 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
      ttg.warp_yield
    }
    partition0(%arg0: !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>) num_warps(1) {
      %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 256 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>
      ttg.warp_return
    } : (!ttg.memdesc<128x128xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

// -----
#shared = #ttg.nvmma_shared<{swizzlingByteWidth = 64, transposed = true, elementBitWidth = 8}>
#shared1 = #ttg.swizzled_shared<{vec = 1, perPhase = 1, maxPhase = 1, order = [0]}>
#smem = #ttg.shared_memory
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 64, colStride = 1>
#tmem_scales = #ttng.tensor_memory_scales_encoding<>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.tensor_memory_size = 128 : i32} {
  tt.func @mma_lhs_tmem(%arg0: !ttg.memdesc<64x64xf16, #shared, #smem>, %arg1: i1, %arg2: i1, %arg3: !ttg.memdesc<1xi64, #shared1, #smem>, %arg4: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x64xf16, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 32 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tc_gen5_mma %result, %arg0, %result_0, %arg1, %arg2, %arg3[%arg4] {is_async} : !ttg.memdesc<128x64xf16, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<64x64xf16, #shared, #smem>, !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<1xi64, #shared1, #smem>
    tt.return
  }
  tt.func @mma_scaled_lhs_tmem(%arg0: !ttg.memdesc<64x64xf8E5M2, #shared, #smem>, %arg1: !ttg.memdesc<128x8xf8E4M3FN, #tmem_scales, #ttng.tensor_memory>, %arg2: !ttg.memdesc<256x8xf8E4M3FN, #tmem_scales, #ttng.tensor_memory>, %arg3: i1, %arg4: i1, %arg5: !ttg.memdesc<1xi64, #shared1, #smem>, %arg6: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x64xf8E5M2, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 16 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>
    ttng.tc_gen5_mma_scaled %result, %arg0, %result_0, %arg1, %arg2, %arg3, %arg4 lhs = e5m2 rhs = e5m2, %arg5[%arg6] {is_async} : !ttg.memdesc<128x64xf8E5M2, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<64x64xf8E5M2, #shared, #smem>, !ttg.memdesc<128x64xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<128x8xf8E4M3FN, #tmem_scales, #ttng.tensor_memory>, !ttg.memdesc<256x8xf8E4M3FN, #tmem_scales, #ttng.tensor_memory>, !ttg.memdesc<1xi64, #shared1, #smem>
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 128, colStride = 1, fp4Padded = true>
#tmem_scales = #ttng.tensor_memory_scales_encoding<>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 64 : i32} {
  tt.func @fp4_padded_tmem_alloc_columns() {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x64xi8, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 32 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x4xi8, #tmem_scales, #ttng.tensor_memory, mutable>
    "use"(%result, %result_0) : (!ttg.memdesc<128x64xi8, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<128x4xi8, #tmem_scales, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

// -----
#shared = #ttg.swizzled_shared<{vec = 1, perPhase = 1, maxPhase = 1, order = [0]}>
#shared1 = #ttg.nvmma_shared<{swizzlingByteWidth = 128, transposed = false, elementBitWidth = 16}>
#smem = #ttg.shared_memory
#tmem = #ttng.tensor_memory_encoding<blockM = 64, blockN = 128, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 256 : i32} {
  tt.func @alloc_warp_specialize_explicit_capture_subview() {
    %0 = ttg.local_alloc {allocation.offset = 196880 : i32} : () -> !ttg.memdesc<2x1xi64, #shared, #smem, mutable>
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<1x64x128xbf16, #tmem, #ttng.tensor_memory, mutable>
    %1 = ttg.local_alloc {allocation.offset = 0 : i32} : () -> !ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<1x64x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttg.warp_specialize(%1, %result, %result_0, %0)
    default {
      ttg.warp_yield
    }
    partition0(%arg0: !ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable>, %arg1: !ttg.memdesc<1x64x128xbf16, #tmem, #ttng.tensor_memory, mutable>, %arg2: !ttg.memdesc<1x64x128xf32, #tmem, #ttng.tensor_memory, mutable>, %arg3: !ttg.memdesc<2x1xi64, #shared, #smem, mutable>) num_warps(1) {
      %true = arith.constant true
      %c0_i32 = arith.constant 0 : i32
      %2 = ttg.memdesc_index %arg0[%c0_i32] : !ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable> -> !ttg.memdesc<128x128xbf16, #shared1, #smem>
      %3 = ttg.memdesc_index %arg1[%c0_i32] : !ttg.memdesc<1x64x128xbf16, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<64x128xbf16, #tmem, #ttng.tensor_memory, mutable>
      %4 = ttg.memdesc_index %arg2[%c0_i32] : !ttg.memdesc<1x64x128xf32, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<64x128xf32, #tmem, #ttng.tensor_memory, mutable>
      %5 = ttg.memdesc_index %arg3[%c0_i32] : !ttg.memdesc<2x1xi64, #shared, #smem, mutable> -> !ttg.memdesc<1xi64, #shared, #smem, mutable>
      ttng.tc_gen5_mma %3, %2, %4, %true, %true, %5[%true] {is_async} : !ttg.memdesc<64x128xbf16, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<128x128xbf16, #shared1, #smem>, !ttg.memdesc<64x128xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<1xi64, #shared, #smem, mutable>
      ttg.warp_return
    } : (!ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable>, !ttg.memdesc<1x64x128xbf16, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<1x64x128xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<2x1xi64, #shared, #smem, mutable>) -> ()
    tt.return
  }
  tt.func @alloc_warp_specialize_explicit_capture() {
    %0 = ttg.local_alloc {allocation.offset = 196880 : i32} : () -> !ttg.memdesc<2x1xi64, #shared, #smem, mutable>
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x128xbf16, #tmem, #ttng.tensor_memory, mutable>
    %1 = ttg.local_alloc {allocation.offset = 0 : i32} : () -> !ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x128xf32, #tmem, #ttng.tensor_memory, mutable>
    ttg.warp_specialize(%1, %result, %result_0, %0)
    default {
      ttg.warp_yield
    }
    partition0(%arg0: !ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable>, %arg1: !ttg.memdesc<64x128xbf16, #tmem, #ttng.tensor_memory, mutable>, %arg2: !ttg.memdesc<64x128xf32, #tmem, #ttng.tensor_memory, mutable>, %arg3: !ttg.memdesc<2x1xi64, #shared, #smem, mutable>) num_warps(1) {
      %true = arith.constant true
      %c0_i32 = arith.constant 0 : i32
      %2 = ttg.memdesc_index %arg0[%c0_i32] : !ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable> -> !ttg.memdesc<128x128xbf16, #shared1, #smem>
      %3 = ttg.memdesc_index %arg3[%c0_i32] : !ttg.memdesc<2x1xi64, #shared, #smem, mutable> -> !ttg.memdesc<1xi64, #shared, #smem, mutable>
      ttng.tc_gen5_mma %arg1, %2, %arg2, %true, %true, %3[%true] {is_async} : !ttg.memdesc<64x128xbf16, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<128x128xbf16, #shared1, #smem>, !ttg.memdesc<64x128xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<1xi64, #shared, #smem, mutable>
      ttg.warp_return
    } : (!ttg.memdesc<2x128x128xbf16, #shared1, #smem, mutable>, !ttg.memdesc<64x128xbf16, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<64x128xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<2x1xi64, #shared, #smem, mutable>) -> ()
    tt.return
  }
}

// -----
#shared = #ttg.nvmma_shared<{swizzlingByteWidth = 64, transposed = true, elementBitWidth = 8}>
#shared1 = #ttg.swizzled_shared<{vec = 1, perPhase = 1, maxPhase = 1, order = [0]}>
#smem = #ttg.shared_memory
#tmem = #ttng.tensor_memory_encoding<blockM = 64, blockN = 64, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 65536 : i32, ttg.tensor_memory_size = 256 : i32} {
  tt.func @mma_lhs_tmem(%arg0: !ttg.memdesc<64x64xf16, #shared, #smem>, %arg1: i1, %arg2: i1, %arg3: !ttg.memdesc<1xi64, #shared1, #smem>, %arg4: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 32 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>
    %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>
    %result_2 = ttng.tmem_alloc {tensor_memory_col_offset = 96 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<64x64xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = arith.select %arg4, %result, %result_0 : !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>
    cf.cond_br %arg4, ^bb1, ^bb2(%0 : !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>)
  ^bb1:  // pred: ^bb0
    cf.br ^bb2(%result_1 : !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>)
  ^bb2(%1: !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>):  // 2 preds: ^bb0, ^bb1
    ttng.tc_gen5_mma %1, %arg0, %result_2, %arg1, %arg2, %arg3[%arg4] {is_async} : !ttg.memdesc<64x64xf16, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<64x64xf16, #shared, #smem>, !ttg.memdesc<64x64xf32, #tmem, #ttng.tensor_memory, mutable>, !ttg.memdesc<1xi64, #shared1, #smem>
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 32, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 4 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 64 : i32} {
  tt.func @tmem_select_extends_liveness(%arg0: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 32 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = arith.select %arg0, %result, %result_0 : !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_1) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    "use"(%0) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    %result_2 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_2) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 32, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 4 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 128 : i32} {
  tt.func @tmem_view_select_extends_liveness(%arg0: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = ttng.tmem_subslice %result {dim = 0 : i32, offset = 128 : i32} : !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable, 256x32>
    %1 = ttng.tmem_subslice %result_0 {dim = 0 : i32, offset = 128 : i32} : !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable, 256x32>
    %2 = arith.select %arg0, %0, %1 : !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable, 256x32>
    %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_1) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    "use"(%2) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable, 256x32>) -> ()
    %result_2 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_2) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 32, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 4 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 128 : i32} {
  tt.func @tmem_select_view_extends_liveness(%arg0: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 64 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = arith.select %arg0, %result, %result_0 : !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %1 = ttng.tmem_subslice %0 {dim = 0 : i32, offset = 128 : i32} : !ttg.memdesc<256x32xf32, #tmem, #ttng.tensor_memory, mutable> -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable, 256x32>
    %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_1) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    "use"(%1) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable, 256x32>) -> ()
    %result_2 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_2) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

// -----
#tmem = #ttng.tensor_memory_encoding<blockM = 128, blockN = 32, colStride = 1>
module attributes {"ttg.num-ctas" = 1 : i32, "ttg.num-warps" = 4 : i32, ttg.shared = 4 : i32, ttg.target = "cuda:100", ttg.tensor_memory_size = 64 : i32} {
  tt.func @tmem_chain_extends_liveness(%arg0: i1, %arg1: i1) {
    %result = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_0 = ttng.tmem_alloc {tensor_memory_col_offset = 32 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %0 = arith.select %arg0, %result, %result_0 : !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %1 = arith.select %arg0, %result_0, %result : !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %2 = arith.select %arg1, %0, %1 : !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    %result_1 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_1) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    "use"(%2) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    %result_2 = ttng.tmem_alloc {tensor_memory_col_offset = 0 : i32, tensor_memory_row_offset = 0 : i32} : () -> !ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>
    "use"(%result_2) : (!ttg.memdesc<128x32xf32, #tmem, #ttng.tensor_memory, mutable>) -> ()
    tt.return
  }
}

