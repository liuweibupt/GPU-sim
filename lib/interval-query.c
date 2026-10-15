// Freestanding WASM query over a balanced maximum-end interval tree.
// Input/output buffers are allocated once by interval-index.js. No libc/heap.
typedef unsigned int u32;

static u32 visit(const double *tree, u32 node, u32 left, u32 right,
                 u32 through, double time, u32 *output, u32 count) {
  if (left >= through || tree[node] <= time) return count;
  if (right - left == 1) { output[count] = left; return count + 1; }
  const u32 middle = (left + right) >> 1;
  count = visit(tree, node * 2, left, middle, through, time, output, count);
  return visit(tree, node * 2 + 1, middle, right, through, time, output, count);
}

u32 query_intervals(const double *starts, u32 size, const double *tree,
                    u32 leaves, double time, u32 *output) {
  u32 low = 0, high = size;
  while (low < high) {
    const u32 middle = (low + high) >> 1;
    if (starts[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return visit(tree, 1, 0, leaves, low, time, output, 0);
}
