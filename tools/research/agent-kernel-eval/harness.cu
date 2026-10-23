// Evaluator-authored host-only I/O harness. Candidate translation unit is linked unchanged.
#include <cuda_runtime.h>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <vector>
#include <filesystem>
#include <stdexcept>
extern "C" cudaError_t launch_rmsnorm(const float*,float*,int,int,int,int,float,cudaStream_t);
extern "C" cudaError_t launch_transpose(const float*,float*,int,int,int,int,cudaStream_t);
extern "C" cudaError_t launch_segments(const int32_t*,const int32_t*,int64_t*,int,int,cudaStream_t);
struct Header {uint32_t magic,task;int32_t rows,cols,xs,ys,n,segments;float epsilon;uint32_t inputs,outputs,offsets;};
static_assert(sizeof(Header)==48,"binary header layout");
constexpr size_t GUARD=64;
void check(cudaError_t e,const char* stage){if(e!=cudaSuccess)throw std::runtime_error(std::string(stage)+": "+cudaGetErrorString(e));}
std::vector<unsigned char> guarded(size_t count,size_t item,const void* pattern){std::vector<unsigned char> b((count+2*GUARD)*item);for(size_t i=0;i<count+2*GUARD;i++)std::memcpy(b.data()+i*item,pattern,item);return b;}
void run(const std::filesystem::path& input,const std::filesystem::path& output,cudaStream_t stream){
 std::ifstream in(input,std::ios::binary);Header h{};in.read(reinterpret_cast<char*>(&h),sizeof(h));
 if(!in||h.magic!=0x314b4741||h.task!=TASK_ID)throw std::runtime_error("bad test header");
 const int32_t sentinel=0x13579bdf;const float float_sentinel=987654.25f;const int64_t integer_sentinel=0x13579BDF2468ACEll;const size_t item=TASK_ID==3?8:4;
 auto x=guarded(h.inputs,4,&sentinel),offsets=guarded(h.offsets,4,&sentinel),y=guarded(h.outputs,item,TASK_ID==3?static_cast<const void*>(&integer_sentinel):static_cast<const void*>(&float_sentinel));
 in.read(reinterpret_cast<char*>(x.data()+GUARD*4),h.inputs*4);in.read(reinterpret_cast<char*>(offsets.data()+GUARD*4),h.offsets*4);if(!in)throw std::runtime_error("short case input");
 unsigned char *dx=nullptr,*dy=nullptr,*doff=nullptr;
 check(cudaMalloc(&dx,x.size()),"allocate input");check(cudaMalloc(&dy,y.size()),"allocate output");check(cudaMalloc(&doff,offsets.size()),"allocate offsets");
 check(cudaMemcpyAsync(dx,x.data(),x.size(),cudaMemcpyHostToDevice,stream),"copy input");check(cudaMemcpyAsync(dy,y.data(),y.size(),cudaMemcpyHostToDevice,stream),"copy output sentinel");check(cudaMemcpyAsync(doff,offsets.data(),offsets.size(),cudaMemcpyHostToDevice,stream),"copy offsets");
#if TASK_ID == 1
 check(launch_rmsnorm(reinterpret_cast<const float*>(dx+GUARD*4),reinterpret_cast<float*>(dy+GUARD*item),h.rows,h.cols,h.xs,h.ys,h.epsilon,stream),"candidate launch");
#elif TASK_ID == 2
 check(launch_transpose(reinterpret_cast<const float*>(dx+GUARD*4),reinterpret_cast<float*>(dy+GUARD*item),h.rows,h.cols,h.xs,h.ys,stream),"candidate launch");
#elif TASK_ID == 3
 check(launch_segments(reinterpret_cast<const int32_t*>(dx+GUARD*4),reinterpret_cast<const int32_t*>(doff+GUARD*4),reinterpret_cast<int64_t*>(dy+GUARD*item),h.n,h.segments,stream),"candidate launch");
#endif
 check(cudaStreamSynchronize(stream),"candidate synchronize");
 check(cudaMemcpy(y.data(),dy,y.size(),cudaMemcpyDeviceToHost),"read output");check(cudaMemcpy(x.data(),dx,x.size(),cudaMemcpyDeviceToHost),"read input guards");check(cudaMemcpy(offsets.data(),doff,offsets.size(),cudaMemcpyDeviceToHost),"read offset guards");
 std::ofstream result(output,std::ios::binary);result.write(reinterpret_cast<const char*>(y.data()),y.size());result.write(reinterpret_cast<const char*>(x.data()),x.size());result.write(reinterpret_cast<const char*>(offsets.data()),offsets.size());if(!result)throw std::runtime_error("cannot write actual output");
 check(cudaFree(dx),"free input");check(cudaFree(dy),"free output");check(cudaFree(doff),"free offsets");
}
int main(int argc,char**argv){if(argc<3){std::cerr<<"Usage: harness OUTPUT_DIR INPUT_CASE...\n";return 2;}std::string current="initialization";try{
 cudaDeviceProp prop{};check(cudaGetDeviceProperties(&prop,0),"device properties");std::cout<<"device="<<prop.name<<" compute="<<prop.major<<'.'<<prop.minor<<'\n';cudaStream_t stream;check(cudaStreamCreate(&stream),"create stream");std::filesystem::create_directories(argv[1]);
 for(int i=2;i<argc;i++){current=std::filesystem::path(argv[i]).stem().string();run(argv[i],std::filesystem::path(argv[1])/(current+".actual.bin"),stream);std::cout<<"completed="<<current<<std::endl;}check(cudaStreamDestroy(stream),"destroy stream");return 0;
 }catch(const std::exception&e){std::cerr<<"case="<<current<<" error="<<e.what()<<'\n';return 3;}}
