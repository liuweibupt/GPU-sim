import triton
import triton.language as tl

@triton.jit
def constant_kernel(Y,N:tl.constexpr,VALUE:tl.constexpr,DTYPE:tl.constexpr,NEGATIVE_ZERO:tl.constexpr):
    offs=tl.arange(0,N)
    if NEGATIVE_ZERO:
        y=tl.full((N,),-0.0,DTYPE)
    else:
        y=tl.full((N,),VALUE,DTYPE)
    tl.store(Y+offs,y)
