import triton
import triton.language as tl

@triton.jit
def softmax_kernel(X,Y,N:tl.constexpr,SHAPE:tl.constexpr,DIM:tl.constexpr):
    offs=tl.arange(0,N).reshape(SHAPE)
    x=tl.load(X+offs)
    y=tl.softmax(x,dim=DIM)
    tl.store(Y+offs,y)
