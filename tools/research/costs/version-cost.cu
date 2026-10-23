// Cost harness for the source-derived frozen version probe. No production-kernel claim.
#include "version_cost_kernel.cuh"
#include <cuda_profiler_api.h>
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <random>
#include <sstream>

using Clock = std::chrono::steady_clock;
static double us(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::micro>(b-a).count();
}
template <class T> void array(std::ostream& s, const T* data, size_t count) {
  s << '['; for (size_t i=0;i<count;i++) {if(i)s<<',';s<<data[i];} s<<']';
}
struct Buffers {
  int n, g, blocks; size_t elements, events;
  int *out, *tags, *host_out, *host_tags; Event *log, *host_log;
  cudaEvent_t start, stop;
  cudaGraph_t graphs[2]; cudaGraphExec_t executions[2]; cudaGraphNode_t kernels[2];
  Buffers(int count, int generations):n(count),g(generations),blocks((n+31)/32),elements(size_t(n)*g),events(size_t(blocks)*g*5) {
    check(cudaMalloc(&out,elements*4),"output allocation");
    check(cudaMalloc(&tags,elements*4),"tag allocation");
    check(cudaMalloc(&log,events*sizeof(Event)),"event allocation");
    check(cudaMallocHost(&host_out,elements*4),"pinned output");
    check(cudaMallocHost(&host_tags,elements*4),"pinned tags");
    check(cudaMallocHost(&host_log,events*sizeof(Event)),"pinned events");
    check(cudaEventCreate(&start),"start event");check(cudaEventCreate(&stop),"stop event");
    for(int record=0;record<2;record++) {
      cudaGraphNode_t begin,end;check(cudaGraphCreate(&graphs[record],0),"graph create");
      check(cudaGraphAddEventRecordNode(&begin,graphs[record],nullptr,0,start),"graph start record");
      uint32_t seed=0;bool wrong=false;
      void* arguments[]={&n,&g,&seed,&wrong,&out,&tags,&log};
      cudaKernelNodeParams params{};params.func=record?(void*)cost_version_probe<true>:(void*)cost_version_probe<false>;
      params.gridDim=dim3(blocks);params.blockDim=dim3(64);params.kernelParams=arguments;
      check(cudaGraphAddKernelNode(&kernels[record],graphs[record],&begin,1,&params),"graph kernel");
      check(cudaGraphAddEventRecordNode(&end,graphs[record],&kernels[record],1,stop),"graph stop record");
      check(cudaGraphInstantiate(&executions[record],graphs[record],0),"graph instantiate");
    }
  }
  ~Buffers() {
    for(int record=0;record<2;record++){cudaGraphExecDestroy(executions[record]);cudaGraphDestroy(graphs[record]);}
    cudaEventDestroy(start);cudaEventDestroy(stop);cudaFree(out);cudaFree(tags);cudaFree(log);
    cudaFreeHost(host_out);cudaFreeHost(host_tags);cudaFreeHost(host_log);
  }
  double kernel_time(bool record,uint32_t seed) {
    bool wrong=false;void* arguments[]={&n,&g,&seed,&wrong,&out,&tags,&log};
    cudaKernelNodeParams params{};params.func=record?(void*)cost_version_probe<true>:(void*)cost_version_probe<false>;
    params.gridDim=dim3(blocks);params.blockDim=dim3(64);params.kernelParams=arguments;
    check(cudaGraphExecKernelNodeSetParams(executions[record],kernels[record],&params),"graph seed update");
    // A single submission contains start-event -> kernel -> stop-event, so host
    // scheduling between separate event/kernel API calls cannot inflate the span.
    check(cudaGraphLaunch(executions[record],0),"graph launch");
    check(cudaStreamSynchronize(0),"graph completion");float ms=0;
    check(cudaEventElapsedTime(&ms,start,stop),"graph elapsed");return double(ms)*1000;
  }
  template<class Fn> double event_time(Fn fn) {
    check(cudaEventRecord(start),"event start");fn();check(cudaEventRecord(stop),"event stop");
    check(cudaEventSynchronize(stop),"event sync");float ms=0;
    check(cudaEventElapsedTime(&ms,start,stop),"elapsed");return double(ms)*1000;
  }
  void validate(bool record, uint32_t seed) {
    for(int gen=0;gen<g;gen++)for(int i=0;i<n;i++) {
      const int expected=int((uint64_t(seed)^((uint64_t(gen)+1)*2654435769ull)^((uint64_t(i)+11)*2246822507ull))&8388607ull);
      if(host_out[size_t(gen)*n+i]!=expected)throw std::runtime_error("value oracle failed");
      if(record && host_tags[size_t(gen)*n+i]!=gen)throw std::runtime_error("tag oracle failed");
    }
    if(record)for(size_t i=0;i<events;i++) {
      const Event& e=host_log[i];int role=int(i%5),gen=int(i/5%g),block=int(i/5/g);
      int expected=int((uint64_t(seed)^((uint64_t(gen)+1)*2654435769ull)^((uint64_t(block*32)+11)*2246822507ull))&8388607ull);
      if(e.role!=role||e.generation!=gen||e.block!=block||e.observed_generation!=gen||e.slot!=(gen&1)||
         e.thread!=((role==2||role==3)?32:0)||e.representative_value!=expected||e.valid_elements!=std::min(32,n-block*32))
        throw std::runtime_error("event oracle failed");
    }
  }
  std::string serialize(bool record,uint32_t seed) {
    std::ostringstream s;
    s<<"{\"count\":"<<n<<",\"generations\":"<<g<<",\"seed\":"<<seed<<",\"instrumented\":"<<(record?"true":"false")<<",\"output\":";
    array(s,host_out,elements);
    if(record) {
      s<<",\"observed_generations\":";array(s,host_tags,elements);s<<",\"events\":[";
      for(size_t i=0;i<events;i++) {if(i)s<<',';const auto&e=host_log[i];
        s<<"{\"block\":"<<e.block<<",\"thread\":"<<e.thread<<",\"generation\":"<<e.generation<<",\"role\":"<<e.role
         <<",\"slot\":"<<e.slot<<",\"observed_generation\":"<<e.observed_generation<<",\"representative_value\":"<<e.representative_value
         <<",\"valid_elements\":"<<e.valid_elements<<",\"source_line\":"<<e.source_line<<'}';}
      s<<']';
    }
    s<<'}';return s.str();
  }
  void sample(bool record,int pair,int order,uint32_t seed,bool print,const std::string& validation_dir) {
    // Only the one kernel lies between the first event pair. Allocation, transfers,
    // validation, serialization and the event synchronizations themselves are outside it.
    double kernel=kernel_time(record,seed);
    auto a=Clock::now();
    double output_copy=event_time([&]{check(cudaMemcpyAsync(host_out,out,elements*4,cudaMemcpyDeviceToHost),"copy output");});
    auto b=Clock::now();
    double evidence_copy=0, evidence_wall=0;
    if(record) {auto c=Clock::now();evidence_copy=event_time([&]{
      check(cudaMemcpyAsync(host_tags,tags,elements*4,cudaMemcpyDeviceToHost),"copy tags");
      check(cudaMemcpyAsync(host_log,log,events*sizeof(Event),cudaMemcpyDeviceToHost),"copy events");
    });evidence_wall=us(c,Clock::now());}
    validate(record,seed); // Full payload and every instrumented event, outside timed stages.
    auto c=Clock::now();auto serialized=serialize(record,seed);auto d=Clock::now();
    if(!validation_dir.empty()) {
      std::ofstream f(validation_dir+"/n"+std::to_string(n)+"-g"+std::to_string(g)+(record?"-instrumented.json":"-baseline.json"));
      f<<serialized<<'\n';if(!f)throw std::runtime_error("validation write failed");
    }
    if(print)std::cout<<std::setprecision(10)<<"{\"kind\":\"sample\",\"count\":"<<n<<",\"generations\":"<<g
      <<",\"pair\":"<<pair<<",\"order\":"<<order<<",\"instrumented\":"<<(record?"true":"false")
      <<",\"seed\":"<<seed<<",\"kernel_us\":"<<kernel<<",\"output_d2h_device_us\":"<<output_copy
      <<",\"output_d2h_host_us\":"<<us(a,b)<<",\"evidence_d2h_device_us\":"<<evidence_copy<<",\"evidence_d2h_host_us\":"<<evidence_wall
      <<",\"serialize_us\":"<<us(c,d)<<",\"output_bytes\":"<<elements*4<<",\"evidence_bytes\":"<<(record?elements*4+events*sizeof(Event):0)
      <<",\"serialized_bytes\":"<<serialized.size()<<",\"events\":"<<(record?events:0)<<",\"correct\":true}"<<'\n';
  }
};

int main(int argc,char**argv) {
  try {
    if(argc!=6)throw std::runtime_error("usage: version-cost session pairs warmups validation_dir profile(0|1)");
    int session=std::stoi(argv[1]),pairs=std::stoi(argv[2]),warmups=std::stoi(argv[3]);bool profile=std::stoi(argv[5]);
    if(pairs<1||warmups<0)throw std::runtime_error("invalid sampling counts");
    int driver=0,runtime=0;cudaDriverGetVersion(&driver);cudaRuntimeGetVersion(&runtime);cudaDeviceProp prop;
    check(cudaGetDeviceProperties(&prop,0),"device identity");
    cudaFuncAttributes base{},inst{};
    check(cudaFuncGetAttributes(&base,cost_version_probe<false>),"baseline attributes");
    check(cudaFuncGetAttributes(&inst,cost_version_probe<true>),"instrumented attributes");
    std::cout<<"{\"kind\":\"environment\",\"device\":\""<<prop.name<<"\",\"compute\":["<<prop.major<<','<<prop.minor
      <<"],\"driver\":"<<driver<<",\"runtime\":"<<runtime<<",\"sms\":"<<prop.multiProcessorCount<<",\"l2_bytes\":"<<prop.l2CacheSize
      <<",\"baseline_registers\":"<<base.numRegs<<",\"instrumented_registers\":"<<inst.numRegs
      <<",\"baseline_shared\":"<<base.sharedSizeBytes<<",\"instrumented_shared\":"<<inst.sharedSizeBytes<<"}\n";
    std::mt19937 random(20261023u+uint32_t(session));
    std::vector<std::pair<int,int>> configurations{{32,1},{257,5},{4096,8},{4096,64}};
    std::shuffle(configurations.begin(),configurations.end(),random);
    for(auto config:configurations) {
      Buffers buffers(config.first,config.second);
      for(bool record:{false,true}) buffers.sample(record,-1,0,7,false,argv[4]);
      for(int i=0;i<warmups;i++)for(bool record:{false,true})buffers.sample(record,-1,0,7,false,"");
      if(profile)check(cudaProfilerStart(),"profile start");
      for(int pair=0;pair<pairs;pair++) {bool first=bool(random()&1);uint32_t seed=random();
        buffers.sample(first,pair,0,seed,true,"");buffers.sample(!first,pair,1,seed,true,"");}
      if(profile)check(cudaProfilerStop(),"profile stop");
    }
    return 0;
  }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}
