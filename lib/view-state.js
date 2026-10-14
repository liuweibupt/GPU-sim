/** Camera/window changes are independent from authoritative simulation timestamps. */
export function timeWindow(bounds, zoom = 1, center = null) {
  const duration = Math.max(0, bounds.end - bounds.start);
  const scale = Number.isFinite(zoom) ? Math.max(1, Math.min(16, zoom)) : 1;
  if (!duration) return {...bounds};
  const width = duration / scale;
  const anchor = Number.isFinite(center) ? center : (bounds.start + bounds.end) / 2;
  const start = Math.max(bounds.start, Math.min(bounds.end - width, anchor - width / 2));
  return {start, end: start + width};
}

export function eventInScope(event, scope) {
  if (!scope) return true;
  return ['smId','threadBlockId','warpId'].every(key => scope[key] == null ||
    (event.args?.[key] != null && String(event.args[key]) === String(scope[key])));
}

export function intersectsWindow(event, window) {
  if (event.start === event.end) return event.start >= window.start && event.start <= window.end;
  return event.end > window.start && event.start < window.end;
}
