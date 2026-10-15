/** Observed instruction windows exclude unobserved kernel prologues/tails.
 * This changes only replay bounds, never timestamps or event duration. */
export function replayBounds(trace, start, end) {
  if (!trace?.meta?.capabilities?.includes('instruction_pipeline_stages')) return {start, end};
  let first = Infinity, last = -Infinity;
  for (const event of trace.events) if (event.end > event.start && event.args?.granularity === 'instruction') {
    first = Math.min(first, event.start); last = Math.max(last, event.end);
  }
  return first === Infinity ? {start, end} : {start: Math.max(start, first), end: Math.min(end, last)};
}

export function advanceReplay(time, delta, bounds, repeat = false) {
  const duration = bounds.end - bounds.start;
  if (!(duration > 0)) return {time: bounds.start, ended: true};
  const next = Math.max(bounds.start, time) + Math.max(0, delta);
  if (next < bounds.end) return {time: next, ended: false};
  return repeat ? {time: bounds.start + (next - bounds.start) % duration, ended: false}
    : {time: bounds.end, ended: true};
}
