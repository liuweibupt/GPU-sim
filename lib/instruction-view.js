/** A point snapshot never extends an observation into an execution interval.
 * Fractional replay positions show the most recent recorded cycle explicitly.
 */
export function observationSnapshot(events, time, {limit = 200} = {}) {
  let cycle = null, observed = 0, total = 0, issue = 0, stall = 0;
  let points = [];
  for (const event of events) {
    if (event.start !== event.end) continue;
    total++;
    if (event.start > time) continue;
    observed++;
    if (event.args?.stage === 'ISSUE') issue++;
    if (event.args?.stage?.startsWith('STALL_')) stall++;
    if (cycle === null || event.start > cycle) {cycle = event.start; points = [];}
    if (event.start === cycle) points.push(event);
  }
  const visible = points.slice(0, budget(limit, 200));
  return {events: visible, cycle, atCursor: cycle !== null && cycle === time,
    observed, total, issue, stall, omitted: points.length - visible.length};
}

const budget = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const compareTime = (a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id);
const defaultLane = event => `W${event.args?.warpId ?? '?'}${event.args?.dynamicWarpId == null ? '' : ` D${event.args.dynamicWarpId}`} / ${event.args?.stage ?? event.category ?? 'instruction'}`;

/** Bound rendered marks around the cursor, including a selected late instruction.
 * Native scheduler IDs remain identities; they are never mapped to SM partitions.
 */
export function laneWindow(events, time, selectedEventId, options = {}) {
  const limit = budget(options.limit, 96), maxLanes = budget(options.maxLanes, 8);
  const perLane = budget(options.perLane, 16), laneKey = options.laneKey ?? defaultLane;
  const distance = event => time < event.start ? event.start - time : time > event.end ? time - event.end : 0;
  const compare = (a, b) => b.selected - a.selected || a.distance - b.distance || compareTime(a.event, b.event);
  // Retain only the nearest per-lane candidates while scanning. Sorting an entire
  // 250k-record trace for every playback refresh otherwise dominates rendering.
  const candidates = new Map();
  for (const event of events) {
    const key = laneKey(event), item = {event, distance: distance(event), selected: Number(event.id === selectedEventId)};
    if (!candidates.has(key)) candidates.set(key, []);
    const lane = candidates.get(key);
    if (lane.length >= perLane && compare(item, lane.at(-1)) >= 0) continue;
    let position = lane.length;
    while (position > 0 && compare(item, lane[position - 1]) < 0) position--;
    lane.splice(position, 0, item);
    if (lane.length > perLane) lane.pop();
  }
  const nearestLanes = [...candidates.values()].sort((a, b) => compare(a[0], b[0])).slice(0, maxLanes);
  const ranked = nearestLanes.flat().sort(compare).slice(0, limit);
  const lanes = new Map();
  for (const {event} of ranked) {
    const key = laneKey(event);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(event);
  }
  for (const lane of lanes.values()) lane.sort(compareTime);
  const visible = [...lanes.values()].flat().sort(compareTime);
  return {events: visible, lanes: [...lanes], total: events.length, totalLanes: candidates.size,
    start: visible.length ? Math.min(...visible.map(event => event.start)) : time,
    end: visible.length ? Math.max(...visible.map(event => event.end)) : time};
}

export function instructionSearchText(event) {
  const args = event.args ?? {};
  return [event.id, event.name, event.category, args.pc, args.opcode, args.instructionText,
    args.op, args.stage, args.scoreboardProducer, args.dynamicInstructionId,
    ...['smId', 'warpId', 'dynamicWarpId', 'schedulerId', 'threadBlockId'].map(key =>
      args[key] == null ? '' : `${key} ${args[key]}`),
    ...[['smId', 'SM'], ['warpId', 'warp'], ['dynamicWarpId', 'dynamic warp'],
      ['schedulerId', 'scheduler'], ['threadBlockId', 'CTA']].map(([key, label]) =>
      args[key] == null ? '' : `${label} ${args[key]}`)].filter(value => value != null).join(' ');
}
