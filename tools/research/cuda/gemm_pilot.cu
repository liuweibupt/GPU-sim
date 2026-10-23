#include <cuda_runtime.h>
#include <cuda_profiler_api.h>
#include <cublas_v2.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

// Contract: contiguous row-major FP32 A[M,K] * B[K,N] -> C[M,N].
// All shapes are positive. No transpose, batching, Tensor Cores, or async ISA.
// The tail bug is deliberately authored for this experiment, not discovered.
constexpr int TILE = 16;
constexpr double ATOL = 2e-5, RTOL = 2e-4;

void check(cudaError_t e, const char* operation) {
  if (e != cudaSuccess)
    throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(e));
}
#define CUDA(call) check((call), #call)

void check_blas(cublasStatus_t status, const char* operation) {
  if(status!=CUBLAS_STATUS_SUCCESS)
    throw std::runtime_error(std::string(operation)+": cuBLAS status "+std::to_string(int(status)));
}
#define BLAS(call) check_blas((call), #call)
struct LibraryHandle {
  cublasHandle_t value;
  LibraryHandle() {
    BLAS(cublasCreate(&value));
    BLAS(cublasSetMathMode(value,CUBLAS_PEDANTIC_MATH));
    BLAS(cublasSetAtomicsMode(value,CUBLAS_ATOMICS_NOT_ALLOWED));
  }
  ~LibraryHandle() { cublasDestroy(value); }
};
cublasHandle_t library_handle() { static LibraryHandle handle; return handle.value; }

__global__ void gemm_baseline(const float* a, const float* b, float* c,
                            int m, int n, int k) {
  const int row = blockIdx.y * blockDim.y + threadIdx.y;
  const int col = blockIdx.x * blockDim.x + threadIdx.x;
  if (row < m && col < n) {
    float sum = 0;
    for (int p = 0; p < k; ++p) sum = fmaf(a[row*k+p], b[p*n+col], sum);
    c[row*n+col] = sum;
  }
}

__global__ void gemm_tail_bug(const float* a, const float* b, float* c,
                            int m, int n, int k) {
  const int row = blockIdx.y * blockDim.y + threadIdx.y;
  const int col = blockIdx.x * blockDim.x + threadIdx.x;
  // Deliberate error: discard incomplete output tiles. Accesses remain in bounds.
  if (row < (m/TILE)*TILE && col < (n/TILE)*TILE) {
    float sum = 0;
    for (int p = 0; p < k; ++p) sum = fmaf(a[row*k+p], b[p*n+col], sum);
    c[row*n+col] = sum;
  }
}

__global__ void gemm_tiled(const float* a, const float* b, float* c,
                         int m, int n, int k) {
  // Targeted after the baseline profile: reduce repeated global load requests.
  // This is conventional synchronous SMEM tiling, not TMA or Tensor Core code.
  __shared__ float at[TILE][TILE],bt[TILE][TILE];
  const int row=blockIdx.y*TILE+threadIdx.y;
  const int col=blockIdx.x*TILE+threadIdx.x;
  float sum=0;
  for(int base=0;base<k;base+=TILE) {
    const int ak=base+threadIdx.x,bk=base+threadIdx.y;
    at[threadIdx.y][threadIdx.x]=(row<m && ak<k)?a[row*k+ak]:0;
    bt[threadIdx.y][threadIdx.x]=(bk<k && col<n)?b[bk*n+col]:0;
    __syncthreads();
    #pragma unroll
    for(int p=0;p<TILE;++p) sum=fmaf(at[threadIdx.y][p],bt[p][threadIdx.x],sum);
    __syncthreads();
  }
  if(row<m && col<n) c[row*n+col]=sum;
}

void launch(const std::string& candidate, const float* a, const float* b, float* c,
            int m, int n, int k) {
  if(candidate=="cublas") {
    const float alpha=1,beta=0;
    // Row-major C=A*B is column-major C^T=B^T*A^T, with no data conversion.
    BLAS(cublasSgemm(library_handle(),CUBLAS_OP_N,CUBLAS_OP_N,n,m,k,
                    &alpha,b,n,a,k,&beta,c,n));
    CUDA(cudaGetLastError());
    return;
  }
  const dim3 block(TILE,TILE), grid((n+TILE-1)/TILE,(m+TILE-1)/TILE);
  if (candidate == "baseline") gemm_baseline<<<grid,block>>>(a,b,c,m,n,k);
  else if (candidate == "tail_bug") gemm_tail_bug<<<grid,block>>>(a,b,c,m,n,k);
  else if (candidate == "tiled") gemm_tiled<<<grid,block>>>(a,b,c,m,n,k);
  else throw std::runtime_error("Unsupported candidate: " + candidate);
  CUDA(cudaGetLastError());
}

struct Problem {
  int m,n,k;
  std::vector<float> a,b,c;
  std::vector<double> reference;
  float *da=nullptr,*db=nullptr,*dc=nullptr;
  uint64_t input_hash=1469598103934665603ULL;
  Problem(int m_, int n_, int k_, uint32_t seed):m(m_),n(n_),k(k_),
    a(size_t(m)*k),b(size_t(k)*n),c(size_t(m)*n),reference(size_t(m)*n) {
    uint32_t state=seed ? seed : 1;
    for (auto* v : {&a,&b}) for (float& x : *v) {
      state ^= state << 13; state ^= state >> 17; state ^= state << 5;
      const uint32_t word=state & 65535U;
      x=float(word)/32768.0f-1.0f;
      input_hash=(input_hash ^ word)*1099511628211ULL;
    }
    // Independent CPU oracle: double arithmetic, no GPU output/code reuse.
    for (int i=0;i<m;++i) for (int j=0;j<n;++j) {
      double total=0;
      for (int p=0;p<k;++p) total+=double(a[size_t(i)*k+p])*double(b[size_t(p)*n+j]);
      reference[size_t(i)*n+j]=total;
    }
    CUDA(cudaMalloc(&da,a.size()*sizeof(float)));
    CUDA(cudaMalloc(&db,b.size()*sizeof(float)));
    CUDA(cudaMalloc(&dc,c.size()*sizeof(float)));
    CUDA(cudaMemcpy(da,a.data(),a.size()*sizeof(float),cudaMemcpyHostToDevice));
    CUDA(cudaMemcpy(db,b.data(),b.size()*sizeof(float),cudaMemcpyHostToDevice));
  }
  ~Problem() { if(da) cudaFree(da); if(db) cudaFree(db); if(dc) cudaFree(dc); }
};

struct Verdict {
  size_t violations=0,nonfinite=0;
  double max_abs=0,relative_l2=0;
  bool pass() const { return violations==0; }
};
Verdict verify(Problem& p, const std::string& candidate) {
  // Explicitly initialized poison exposes missing writes without uninitialized memory.
  CUDA(cudaMemset(p.dc,0xff,p.c.size()*sizeof(float)));
  launch(candidate,p.da,p.db,p.dc,p.m,p.n,p.k);
  CUDA(cudaDeviceSynchronize());
  CUDA(cudaMemcpy(p.c.data(),p.dc,p.c.size()*sizeof(float),cudaMemcpyDeviceToHost));
  Verdict v;
  double error2=0,reference2=0;
  for(size_t i=0;i<p.c.size();++i) {
    const double ref=p.reference[i];
    reference2+=ref*ref;
    if(!std::isfinite(p.c[i])) { ++v.nonfinite; ++v.violations; continue; }
    const double error=std::abs(double(p.c[i])-ref);
    v.max_abs=std::max(v.max_abs,error);
    error2+=error*error;
    if(error>ATOL+RTOL*std::abs(ref)) ++v.violations;
  }
  v.relative_l2=std::sqrt(error2/std::max(reference2,1e-300));
  return v;
}
void emit_verdict(const Verdict& v, const Problem& p) {
  std::cout << "{\"pass\":" << (v.pass()?"true":"false")
    << ",\"violations\":" << v.violations << ",\"elements\":" << p.c.size()
    << ",\"nonfinite\":" << v.nonfinite << ",\"max_abs_finite\":" << v.max_abs
    << ",\"relative_l2\":";
  if(v.nonfinite) std::cout << "null"; else std::cout << v.relative_l2;
  std::cout << ",\"error_samples\":[";
  int count=0;
  for(size_t i=0;i<p.c.size() && count<12;++i) {
    const bool finite=std::isfinite(p.c[i]);
    const double error=finite?std::abs(double(p.c[i])-p.reference[i]):0;
    if(finite && error<=ATOL+RTOL*std::abs(p.reference[i])) continue;
    if(count++) std::cout << ",";
    std::cout << "{\"row\":" << i/p.n << ",\"col\":" << i%p.n
      << ",\"reference\":" << p.reference[i] << ",\"actual\":";
    if(finite) std::cout << p.c[i]; else std::cout << "null";
    std::cout << ",\"abs_error\":";
    if(finite) std::cout << error; else std::cout << "null";
    std::cout << ",\"nonfinite\":" << (finite?"false":"true") << "}";
  }
  std::cout << "]";
  if(p.c.size()<=400) {
    for(const std::string field:{"reference_matrix","actual_matrix","abs_error_matrix","violation_matrix"}) {
      std::cout << ",\"" << field << "\":[";
      for(int row=0;row<p.m;++row) {
        if(row) std::cout << ",";
        std::cout << "[";
        for(int col=0;col<p.n;++col) {
          if(col) std::cout << ",";
          const size_t i=size_t(row)*p.n+col;
          const bool finite=std::isfinite(p.c[i]);
          const double error=finite?std::abs(double(p.c[i])-p.reference[i]):0;
          if(field=="reference_matrix") std::cout << p.reference[i];
          else if(field=="violation_matrix") std::cout << ((!finite || error>ATOL+RTOL*std::abs(p.reference[i]))?"true":"false");
          else if(!finite) std::cout << "null";
          else std::cout << (field=="actual_matrix"?double(p.c[i]):error);
        }
        std::cout << "]";
      }
      std::cout << "]";
    }
  }
  std::cout << "}";
}

float measure(Problem& p, const std::string& candidate, int launches,
              cudaEvent_t start, cudaEvent_t stop) {
  CUDA(cudaEventRecord(start));
  for(int i=0;i<launches;++i) launch(candidate,p.da,p.db,p.dc,p.m,p.n,p.k);
  CUDA(cudaEventRecord(stop));
  CUDA(cudaEventSynchronize(stop));
  float ms=0; CUDA(cudaEventElapsedTime(&ms,start,stop));
  return ms/launches;
}

#ifndef GPU_PILOT_LIBRARY_ONLY
int main(int argc,char**argv) {
  try {
    std::string mode="verify",candidate="baseline",comparison="baseline-tiled";
    int m=128,n=128,k=128,warmup=20,pairs=30,launches=30;
    uint32_t seed=20261023;
    for(int i=1;i<argc;++i) {
      std::string arg=argv[i];
      auto value=[&](){ if(++i>=argc) throw std::runtime_error("Missing value"); return std::string(argv[i]); };
      if(arg=="--mode") mode=value();
      else if(arg=="--candidate") candidate=value();
      else if(arg=="--comparison") comparison=value();
      else if(arg=="--m") m=std::stoi(value());
      else if(arg=="--n") n=std::stoi(value());
      else if(arg=="--k") k=std::stoi(value());
      else if(arg=="--seed") seed=std::stoul(value());
      else if(arg=="--warmup") warmup=std::stoi(value());
      else if(arg=="--pairs") pairs=std::stoi(value());
      else if(arg=="--launches") launches=std::stoi(value());
      else throw std::runtime_error("Unknown argument: "+arg);
    }
    if(std::min({m,n,k,launches,pairs})<=0 || warmup<0) throw std::runtime_error("Invalid dimensions/budget");
    std::cout << std::setprecision(10);
    if(mode=="identify") {
      cudaDeviceProp p{}; CUDA(cudaGetDeviceProperties(&p,0));
      int runtime=0,driver=0,blas=0; CUDA(cudaRuntimeGetVersion(&runtime)); CUDA(cudaDriverGetVersion(&driver));
      BLAS(cublasGetVersion(library_handle(),&blas));
      std::cout << "{\"gpu\":\"" << p.name << "\",\"sm\":" << p.major*10+p.minor
        << ",\"sm_count\":" << p.multiProcessorCount << ",\"l2_bytes\":" << p.l2CacheSize
        << ",\"global_bytes\":" << p.totalGlobalMem << ",\"runtime\":" << runtime
        << ",\"driver_api\":" << driver << ",\"cublas\":" << blas
        << ",\"cublas_math\":\"CUBLAS_PEDANTIC_MATH\",\"cublas_atomics\":\"CUBLAS_ATOMICS_NOT_ALLOWED\"}\n";
      return 0;
    }
    Problem p(m,n,k,seed);
    std::cout << "{\"mode\":\"" << mode << "\",\"shape_mnk\":[" << m << "," << n << "," << k
      << "],\"seed\":" << seed << ",\"input_hash\":\"" << std::hex << p.input_hash << std::dec
      << "\",\"atol\":" << ATOL << ",\"rtol\":" << RTOL;
    if(mode=="verify") {
      const Verdict v=verify(p,candidate);
      std::cout << ",\"candidate\":\"" << candidate << "\",\"verdict\":";
      emit_verdict(v,p); std::cout << "}\n";
      return v.pass()?0:2;
    }
    if(mode=="profile") {
      const Verdict v=verify(p,candidate);
      if(!v.pass()) throw std::runtime_error("Profile refused: numerical verification failed");
      for(int i=0;i<warmup;++i) launch(candidate,p.da,p.db,p.dc,m,n,k);
      CUDA(cudaDeviceSynchronize());
      CUDA(cudaProfilerStart());
      for(int i=0;i<launches;++i) launch(candidate,p.da,p.db,p.dc,m,n,k);
      CUDA(cudaDeviceSynchronize());
      CUDA(cudaProfilerStop());
      std::cout << ",\"candidate\":\"" << candidate << "\",\"launches\":" << launches << "}\n";
      return 0;
    }
    if(mode!="benchmark") throw std::runtime_error("Unknown mode");
    if(comparison!="baseline-tiled" && comparison!="tiled-cublas") throw std::runtime_error("Unknown comparison");
    const std::string candidate_a=comparison=="baseline-tiled"?"baseline":"tiled";
    const std::string candidate_b=comparison=="baseline-tiled"?"tiled":"cublas";
    const Verdict a=verify(p,candidate_a),b=verify(p,candidate_b);
    if(!a.pass() || !b.pass()) throw std::runtime_error("Benchmark refused: numerical verification failed");
    for(int i=0;i<warmup;++i) for(const auto& c:{candidate_a,candidate_b}) launch(c,p.da,p.db,p.dc,m,n,k);
    CUDA(cudaDeviceSynchronize());
    cudaEvent_t start,stop; CUDA(cudaEventCreate(&start)); CUDA(cudaEventCreate(&stop));
    std::mt19937 order_rng(seed^0x5a17b38U);
    std::vector<int> orders(pairs);
    for(int i=0;i<pairs;++i) orders[i]=i%2;
    std::shuffle(orders.begin(),orders.end(),order_rng);
    std::cout << ",\"comparison\":\"" << comparison << "\",\"candidate_a\":\"" << candidate_a
      << "\",\"candidate_b\":\"" << candidate_b << "\",\"correctness_gates\":{\"" << candidate_a
      << "\":true,\"" << candidate_b << "\":true},\"warmup_per_candidate\":" << warmup << ",\"launches_per_sample\":" << launches
      << ",\"scope\":\"CUDA-event interval per launch, resident repeated inputs, no copies\",\"samples\":[";
    for(int i=0;i<pairs;++i) {
      float ta,tb;
      if(orders[i]==0) { ta=measure(p,candidate_a,launches,start,stop); tb=measure(p,candidate_b,launches,start,stop); }
      else { tb=measure(p,candidate_b,launches,start,stop); ta=measure(p,candidate_a,launches,start,stop); }
      if(i) std::cout << ",";
      std::cout << "{\"pair\":" << i << ",\"order\":\"" << (orders[i]==0?"AB":"BA")
        << "\",\"" << candidate_a << "_ms\":" << ta << ",\"" << candidate_b << "_ms\":" << tb << "}";
    }
    CUDA(cudaEventDestroy(start)); CUDA(cudaEventDestroy(stop));
    std::cout << "]}\n";
    return 0;
  } catch(const std::exception& e) { std::cerr << e.what() << "\n"; return 1; }
}
#endif
