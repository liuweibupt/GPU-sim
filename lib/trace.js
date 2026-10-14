/** Authoritative timestamps remain unchanged. Presentation never writes into events. */
export class TraceError extends Error {
  constructor(message) { super(message); this.name = 'TraceError'; }
}

function requireValue(condition, message) {
  if (!condition) throw new TraceError(message);
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function identifier(value) { return typeof value === 'string' && value.length > 0; }

export function validateTrace(trace) {
  requireValue(record(trace) && trace.schemaVersion === 1, '需要 schemaVersion: 1 的 trace，或 Chrome trace JSON。');
  requireValue(record(trace.meta), 'trace 缺少 meta 来源信息。');
  requireValue(identifier(trace.meta.producer), 'meta.producer 不能为空。');
  requireValue(['simulation', 'measurement', 'illustration'].includes(trace.meta.evidenceKind), '未知 evidenceKind。');
  requireValue(['cycle', 'us', 'ns'].includes(trace.meta.timeUnit), 'timeUnit 必须是 cycle、us 或 ns；不同时间域不能直接合并。');
  requireValue(Array.isArray(trace.components) && Array.isArray(trace.events), 'components 和 events 必须是数组。');
  requireValue(trace.components.length <= 2000, '原型最多展示 2,000 个组件/轨道；请先截取组件范围。');
  requireValue(trace.events.length <= 250000, '原型最多导入 250,000 个区间；请先截取事件窗口。');
  const components = new Map();
  for (const c of trace.components) {
    requireValue(record(c) && identifier(c.id) && identifier(c.label), '组件需要非空 id 和 label。');
    requireValue(!components.has(c.id), `组件 id 重复：${c.id}`);
    components.set(c.id, c);
  }
  for (const c of components.values()) {
    if (c.parentId != null) requireValue(components.has(c.parentId), `组件 ${c.id} 的 parentId 不存在。`);
  }
  // Iterative traversal handles deep imported hierarchies without a recursive stack.
  const settled = new Set();
  for (const c of components.values()) {
    const path = new Set();
    let current = c;
    while (current && !settled.has(current.id)) {
      requireValue(!path.has(current.id), `组件层级存在环：${current.id}`);
      path.add(current.id);
      current = components.get(current.parentId);
    }
    for (const id of path) settled.add(id);
  }
  const events = new Map();
  for (const e of trace.events) {
    requireValue(record(e) && identifier(e.id) && identifier(e.name), '事件需要非空 id 和 name。');
    requireValue(!events.has(e.id), `事件 id 重复：${e.id}`);
    requireValue(components.has(e.componentId), `事件 ${e.id} 引用了不存在的组件。`);
    requireValue(finite(e.start) && finite(e.end) && e.end >= e.start, `事件 ${e.id} 的起止时间无效。`);
    requireValue(Array.isArray(e.dependencies), `事件 ${e.id} 缺少 dependencies 数组。`);
    requireValue(e.args == null || record(e.args), `事件 ${e.id} 的 args 必须是对象。`);
    requireValue(e.args?.issueDependencies == null || Array.isArray(e.args.issueDependencies), `事件 ${e.id} 的 issueDependencies 必须是数组。`);
    events.set(e.id, e);
  }
  const omitted = trace.metrics?.omittedNodes ?? [];
  requireValue(Array.isArray(omitted), 'omittedNodes 必须是数组。');
  const nodes = new Map(events);
  for (const node of omitted) {
    requireValue(record(node) && identifier(node.id) && !nodes.has(node.id), '未完成节点 id 无效或重复。');
    requireValue(['unissued','started-incomplete'].includes(node.status) && node.end === null, `未完成节点 ${node.id} 状态或 end 无效。`);
    requireValue(node.status === 'unissued' ? node.start === null : finite(node.start), `未完成节点 ${node.id} 的 start 无效。`);
    requireValue(Array.isArray(node.dependencies) && Array.isArray(node.issueDependencies), `未完成节点 ${node.id} 缺少依赖数组。`);
    nodes.set(node.id, node);
  }
  const successors = new Map();
  const indegree = new Map();
  for (const e of nodes.values()) {
    const complete = new Set(e.dependencies);
    const issue = new Set(e.args?.issueDependencies ?? e.issueDependencies ?? []);
    const all = new Set([...complete, ...issue]);
    requireValue(!all.has(e.id), `事件 ${e.id} 不能依赖自身。`);
    for (const id of all) {
      requireValue(nodes.has(id), `事件 ${e.id} 的依赖 ${id} 不存在。`);
      const producer = nodes.get(id);
      if (complete.has(id) && finite(e.start)) requireValue(events.has(id) && producer.end <= e.start, `完成依赖违反时序：${id} → ${e.id}`);
      if (issue.has(id) && finite(e.start)) {
        const release = producer.args?.issueReleaseCycle;
        requireValue(release == null || finite(release), `事件 ${id} 的 issueReleaseCycle 无效。`);
        requireValue(release == null || (release >= producer.start && release <= producer.end), `事件 ${id} 的发射释放时间超出其区间。`);
        requireValue(finite(producer.start) && (release ?? producer.start) <= e.start, `发射依赖违反时序：${id} → ${e.id}`);
      }
      if (!successors.has(id)) successors.set(id, []);
      successors.get(id).push(e.id);
    }
    indegree.set(e.id, all.size);
  }
  const queue = [...nodes.keys()].filter(id => indegree.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    for (const id of successors.get(queue[i]) ?? []) {
      indegree.set(id, indegree.get(id) - 1);
      if (indegree.get(id) === 0) queue.push(id);
    }
  }
  requireValue(queue.length === nodes.size, '任务依赖图存在环。');
  return trace;
}

function chromeCategory(category) {
  const cat = String(category ?? '').toLowerCase();
  if (cat.includes('gpu_memcpy') || cat.includes('gpu_memset')) return 'memory';
  if (cat.split(',').some(c => c.trim() === 'kernel')) return 'compute';
  if (cat.includes('cuda_runtime') || cat.includes('cuda_driver')) return 'api';
  return 'activity';
}

/** Chrome/PyTorch spans describe tracks, never invented SMs or memory transactions. */
export function normalizeTrace(input) {
  // Kineto also writes schemaVersion: 1. Its traceEvents envelope takes priority.
  if (record(input) && !Array.isArray(input.traceEvents) && input.schemaVersion != null) return validateTrace(input);
  const rawEvents = Array.isArray(input) ? input : input?.traceEvents;
  requireValue(Array.isArray(rawEvents), '文件既不是统一 trace，也没有 Chrome traceEvents 数组。');
  requireValue(rawEvents.length <= 500000, '原型最多读取 500,000 条原始记录；请先截取 trace。');
  const names = new Map();
  for (const e of rawEvents) {
    if (e?.ph !== 'M') continue;
    if (e.name === 'process_name') names.set(`p:${e.pid ?? 'unknown'}`, String(e.args?.name ?? e.pid));
    if (e.name === 'thread_name') names.set(`p:${e.pid ?? 'unknown'}/t:${e.tid ?? 'unknown'}`, String(e.args?.name ?? e.tid));
  }
  const components = new Map();
  const events = [];
  const stacks = new Map();
  const ignored = {};
  let unmatchedEnds = 0;
  let missingTrackIds = 0;
  function track(e) {
    if (e.pid == null || e.tid == null) missingTrackIds++;
    const pid = e.pid ?? 'unknown';
    const tid = e.tid ?? 'unknown';
    const processId = `p:${pid}`;
    const trackId = `${processId}/t:${tid}`;
    if (!components.has(processId)) components.set(processId, {id: processId, label: names.get(processId) ?? `进程 ${pid}`, kind: 'process'});
    if (!components.has(trackId)) components.set(trackId, {id: trackId, label: names.get(trackId) ?? `轨道 ${tid}`, kind: 'track', parentId: processId});
    return trackId;
  }
  function span(e, index, end, endingArgs) {
    requireValue(finite(e.ts) && finite(end) && end >= e.ts, `Chrome 记录 ${index} 的 ts/dur 无效。`);
    events.push({
      id: `chrome:${index}`, name: String(e.name ?? '(unnamed)'),
      category: chromeCategory(e.cat), componentId: track(e), start: e.ts, end,
      dependencies: [], args: {...(record(e.args) ? e.args : {}), sourceCategory: e.cat ?? '', ...(endingArgs ? {endArgs: endingArgs} : {})}
    });
  }
  rawEvents.forEach((e, i) => {
    requireValue(record(e), `Chrome 记录 ${i} 必须是对象。`);
    if (e.ph === 'X') {
      requireValue(finite(e.dur) && e.dur >= 0, `Chrome 记录 ${i} 的 dur 无效。`);
      span(e, i, e.ts + e.dur);
    } else if (e.ph === 'B') {
      requireValue(finite(e.ts), `Chrome 记录 ${i} 的 ts 无效。`);
      const key = `${e.pid ?? 'unknown'}/${e.tid ?? 'unknown'}`;
      if (!stacks.has(key)) stacks.set(key, []);
      stacks.get(key).push({event: e, index: i});
    } else if (e.ph === 'E') {
      requireValue(finite(e.ts), `Chrome 记录 ${i} 的 ts 无效。`);
      const key = `${e.pid ?? 'unknown'}/${e.tid ?? 'unknown'}`;
      const opening = stacks.get(key)?.pop();
      if (opening) span(opening.event, opening.index, e.ts, e.args);
      else unmatchedEnds++;
    } else {
      const phase = String(e.ph ?? 'missing');
      ignored[phase] = (ignored[phase] ?? 0) + 1;
    }
  });
  const unmatchedBegins = [...stacks.values()].reduce((n, stack) => n + stack.length, 0);
  requireValue(events.length > 0, '没有可回放的完整区间。当前支持 X 和配对 B/E；不把采样点伪装成执行区间。');
  events.sort((a, b) => a.start - b.start || a.end - b.end);
  const warnings = [];
  if (unmatchedBegins || unmatchedEnds) warnings.push(`未配对 B/E：${unmatchedBegins} / ${unmatchedEnds}，未合成起止时间。`);
  if (missingTrackIds) warnings.push(`${missingTrackIds} 个区间缺少 pid/tid，放入 unknown 轨道。`);
  if (Object.keys(ignored).some(k => k !== 'M')) warnings.push('当前仅显示 duration 区间；counter、flow、instant、async 等记录保留在原始来源中。');
  return validateTrace({
    schemaVersion: 1,
    meta: {
      title: '导入的 Chrome / PyTorch profile', producer: 'Chrome trace importer',
      evidenceKind: 'measurement', timeUnit: 'us',
      description: '用户导入的 profile，采集来源未经核验。轨道不是 SM；区间不是逐条指令或缓存事务。',
      capabilities: ['activity_spans'],
      importSummary: {inputRecords: rawEvents.length, importedSpans: events.length, ignoredPhases: ignored, unmatchedBegins, unmatchedEnds, warnings}
    },
    components: [...components.values()], events, metrics: {},
    source: {format: 'chrome', raw: input}
  });
}

export function buildIndex(trace) {
  return {
    events: new Map(trace.events.map(e => [e.id, e])),
    components: new Map(trace.components.map(c => [c.id, c]))
  };
}

export function traceBounds(trace) {
  if (!trace.events.length) return {start: 0, end: 0};
  let start = Infinity, end = -Infinity;
  for (const e of trace.events) { start = Math.min(start, e.start); end = Math.max(end, e.end); }
  return {start, end};
}

/** [start,end) intervals; a zero-length event completes at its timestamp. */
export function stateAt(trace, time) {
  requireValue(finite(time), '回放时间必须是有限数字。');
  const active = [], completed = [], pending = [];
  for (const e of trace.events) {
    if (e.end <= time) completed.push(e);
    else if (e.start <= time) active.push(e);
    else pending.push(e);
  }
  return {active, completed, pending};
}
