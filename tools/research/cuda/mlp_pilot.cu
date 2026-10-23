#define GPU_PILOT_LIBRARY_ONLY
#include "gemm_pilot.cu"

// Unfused, bias-free two-layer MLP: ReLU(X W1) W2.
// B=16/64/128, I=128, H=256, O=128 in the recorded study.
constexpr double MLP_ATOL=3e-4,MLP_RTOL=3e-4;

__global__ void mlp_relu(float* values,int count) {
  const int i=blockIdx.x*blockDim.x+threadIdx.x;
  if(i<count) values[i]=fmaxf(values[i],0.0f);
}

struct MLPProblem {
  int batch,input,hidden,output;
  std::vector<float> x,w1,w2,host_output,rounded_hidden;
  std::vector<double> reference;
  float *dx=nullptr,*dw1=nullptr,*dw2=nullptr,*dh=nullptr,*dy=nullptr;
  uint64_t input_hash=1469598103934665603ULL;
  MLPProblem(int b,int i,int h,int o,uint32_t seed):batch(b),input(i),hidden(h),output(o),
    x(size_t(b)*i),w1(size_t(i)*h),w2(size_t(h)*o),host_output(size_t(b)*o),
    rounded_hidden(size_t(b)*h),reference(size_t(b)*o) {
    uint32_t state=seed?seed:1;
    for(auto* v:{&x,&w1,&w2}) for(float& value:*v) {
      state^=state<<13;state^=state>>17;state^=state<<5;
      const uint32_t word=state&65535U;
      value=float(word)/32768.0f-1.0f;
      input_hash=(input_hash^word)*1099511628211ULL;
    }
    for(int r=0;r<b;++r) for(int col=0;col<h;++col) {
      double total=0;
      for(int p=0;p<i;++p) total+=double(x[r*i+p])*double(w1[p*h+col]);
      // Explicit FP32 intermediate rounding before applying ReLU.
      rounded_hidden[r*h+col]=std::max(float(total),0.0f);
    }
    for(int r=0;r<b;++r) for(int col=0;col<o;++col) {
      double total=0;
      for(int p=0;p<h;++p) total+=double(rounded_hidden[r*h+p])*double(w2[p*o+col]);
      reference[r*o+col]=total;
    }
    CUDA(cudaMalloc(&dx,x.size()*sizeof(float)));CUDA(cudaMalloc(&dw1,w1.size()*sizeof(float)));
    CUDA(cudaMalloc(&dw2,w2.size()*sizeof(float)));CUDA(cudaMalloc(&dh,rounded_hidden.size()*sizeof(float)));
    CUDA(cudaMalloc(&dy,host_output.size()*sizeof(float)));
    CUDA(cudaMemcpy(dx,x.data(),x.size()*sizeof(float),cudaMemcpyHostToDevice));
    CUDA(cudaMemcpy(dw1,w1.data(),w1.size()*sizeof(float),cudaMemcpyHostToDevice));
    CUDA(cudaMemcpy(dw2,w2.data(),w2.size()*sizeof(float),cudaMemcpyHostToDevice));
  }
  ~MLPProblem(){ for(auto p:{dx,dw1,dw2,dh,dy}) if(p) cudaFree(p); }
};

void mlp_launch(MLPProblem& p,const std::string& candidate) {
  launch(candidate,p.dx,p.dw1,p.dh,p.batch,p.hidden,p.input);
  mlp_relu<<<(p.batch*p.hidden+255)/256,256>>>(p.dh,p.batch*p.hidden);
  CUDA(cudaGetLastError());
  launch(candidate,p.dh,p.dw2,p.dy,p.batch,p.output,p.hidden);
}

Verdict mlp_verify(MLPProblem& p,const std::string& candidate) {
  CUDA(cudaMemset(p.dh,0xff,p.rounded_hidden.size()*sizeof(float)));
  CUDA(cudaMemset(p.dy,0xff,p.host_output.size()*sizeof(float)));
  mlp_launch(p,candidate);CUDA(cudaDeviceSynchronize());
  CUDA(cudaMemcpy(p.host_output.data(),p.dy,p.host_output.size()*sizeof(float),cudaMemcpyDeviceToHost));
  Verdict v;double error2=0,ref2=0;
  for(size_t i=0;i<p.reference.size();++i) {
    const double ref=p.reference[i];ref2+=ref*ref;
    if(!std::isfinite(p.host_output[i])) { ++v.nonfinite;++v.violations;continue; }
    const double error=std::abs(double(p.host_output[i])-ref);
    v.max_abs=std::max(v.max_abs,error);error2+=error*error;
    if(error>MLP_ATOL+MLP_RTOL*std::abs(ref)) ++v.violations;
  }
  v.relative_l2=std::sqrt(error2/std::max(ref2,1e-300));
  return v;
}

float mlp_measure(MLPProblem& p,const std::string& candidate,int launches,cudaEvent_t start,cudaEvent_t stop) {
  CUDA(cudaEventRecord(start));
  for(int i=0;i<launches;++i) mlp_launch(p,candidate);
  CUDA(cudaEventRecord(stop));CUDA(cudaEventSynchronize(stop));
  float ms=0;CUDA(cudaEventElapsedTime(&ms,start,stop));return ms/launches;
}

int main(int argc,char**argv) {
  try {
    std::string mode="verify",candidate="baseline",comparison="baseline-tiled";
    int batch=16,input=128,hidden=256,output=128,warmup=30,pairs=30,launches=30;
    uint32_t seed=20261023;
    for(int i=1;i<argc;++i) {
      std::string arg=argv[i];
      auto value=[&](){ if(++i>=argc)throw std::runtime_error("Missing argument");return std::string(argv[i]); };
      if(arg=="--mode")mode=value();else if(arg=="--candidate")candidate=value();
      else if(arg=="--comparison")comparison=value();else if(arg=="--batch")batch=std::stoi(value());
      else if(arg=="--seed")seed=std::stoul(value());else throw std::runtime_error("Unknown argument");
    }
    if(batch!=16 && batch!=64 && batch!=128)throw std::runtime_error("Unsupported pilot batch");
    MLPProblem p(batch,input,hidden,output,seed);
    std::cout<<std::setprecision(10)<<"{\"mode\":\""<<mode<<"\",\"shape_biho\":["<<batch<<","<<input<<","<<hidden<<","<<output
      <<"],\"seed\":"<<seed<<",\"input_hash\":\""<<std::hex<<p.input_hash<<std::dec
      <<"\",\"atol\":"<<MLP_ATOL<<",\"rtol\":"<<MLP_RTOL;
    if(mode=="verify") {
      const auto v=mlp_verify(p,candidate);
      std::cout<<",\"candidate\":\""<<candidate<<"\",\"verdict\":{\"pass\":"<<(v.pass()?"true":"false")
        <<",\"violations\":"<<v.violations<<",\"elements\":"<<p.reference.size()<<",\"nonfinite\":"<<v.nonfinite
        <<",\"max_abs_finite\":"<<v.max_abs<<",\"relative_l2\":";
      if(v.nonfinite)std::cout<<"null";else std::cout<<v.relative_l2;
      std::cout<<"}}\n";return v.pass()?0:2;
    }
    if(mode!="benchmark" || (comparison!="baseline-tiled" && comparison!="tiled-cublas"))throw std::runtime_error("Unsupported mode/comparison");
    const std::string a=comparison=="baseline-tiled"?"baseline":"tiled",b=comparison=="baseline-tiled"?"tiled":"cublas";
    if(!mlp_verify(p,a).pass() || !mlp_verify(p,b).pass())throw std::runtime_error("Numerical gate failed; no timing emitted");
    for(int i=0;i<warmup;++i){mlp_launch(p,a);mlp_launch(p,b);}CUDA(cudaDeviceSynchronize());
    cudaEvent_t start,stop;CUDA(cudaEventCreate(&start));CUDA(cudaEventCreate(&stop));
    std::vector<int> orders(pairs);for(int i=0;i<pairs;++i)orders[i]=i%2;
    std::mt19937 rng(seed^0x5a17b38U);std::shuffle(orders.begin(),orders.end(),rng);
    std::cout<<",\"comparison\":\""<<comparison<<"\",\"candidate_a\":\""<<a<<"\",\"candidate_b\":\""<<b
      <<"\",\"correctness_gates\":{\""<<a<<"\":true,\""<<b<<"\":true},\"warmup_per_candidate\":"<<warmup
      <<",\"launches_per_sample\":"<<launches<<",\"scope\":\"CUDA-event interval for GEMM-ReLU-GEMM, resident inputs, separate kernels\",\"samples\":[";
    for(int i=0;i<pairs;++i) {
      float ta,tb;
      if(orders[i]==0){ta=mlp_measure(p,a,launches,start,stop);tb=mlp_measure(p,b,launches,start,stop);}
      else{tb=mlp_measure(p,b,launches,start,stop);ta=mlp_measure(p,a,launches,start,stop);}
      if(i)std::cout<<",";
      std::cout<<"{\"pair\":"<<i<<",\"order\":\""<<(orders[i]==0?"AB":"BA")<<"\",\""<<a<<"_ms\":"<<ta<<",\""<<b<<"_ms\":"<<tb<<"}";
    }
    CUDA(cudaEventDestroy(start));CUDA(cudaEventDestroy(stop));std::cout<<"]}\n";return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
