import triton
import triton.language as tl

@triton.jit
def filter_kernel(Y,VALUES:tl.constexpr,CUTOFF:tl.constexpr,EVEN:tl.constexpr):
    if EVEN:
        vals:tl.constexpr=[x for x in VALUES if x>=CUTOFF if x%2==0]
    else:
        vals:tl.constexpr=[x for x in VALUES if x>=CUTOFF]
    tl.store(Y,len(vals))
    for i in tl.static_range(len(vals)):
        tl.store(Y+1+i,vals[i])
