/**
 * Fictional, browser-free letters from a growing GPU workshop. Only purchased
 * capabilities open encounters. Choices make modest, mixed economic changes;
 * canonical letters and awarded endings survive reloads without trusting text.
 */
const VERSION = 1;
const LOG_LIMIT = 24;
const FOLLOWUP_DELAY = 60;
const EPSILON = 1e-8;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clock = (game, context = {}) => Math.max(0, finite(context.elapsed) && context.mode === 'pve' ? context.elapsed : finite(game?.elapsed) ? game.elapsed : 0);
const modeOf = context => context?.mode === 'pve' ? 'pve' : 'workshop';
const businessLevel = (game, id) => Math.max(0, finite(game?.business?.levels?.[id]) ? game.business.levels[id] : 0);
const networkOf = game => businessLevel(game, 'mellanox') >= 1 ? 'acquire' : businessLevel(game, 'ib_partner') >= 1 ? 'partner' : 'none';

const SCENES = [
  {
    id: 'software-letter', title: '凌晨两点的来信', speaker: '小林 · 第一批开发者',
    body: 'CUDA 的第一份文档刚挂出去，小林就发来了报错截图。另一封邮件来自大客户：他们愿意支付更高的服务费，条件是接下来的接口先围着他们做。工程师把两封邮件打印出来，放在同一张桌上。',
    options: [
      {id: 'commons', label: '「把接口说明也寄给小林。」', detail: '继续接待不同团队，服务报价留些余地；公开答疑与兼容维护会成为长期工作。', effects: {revenueMultiplier: .98, demandBonus: 2, operatingCost: .08},
        reply: ['文档组', '寄出的不只是文档', '工程师给小林补了一份能跑通的例子，也在工单上写下：以后更新，要给旧程序留一扇门。大客户没有签独家，仍留了一张普通订单。'],
        later: ['小林', '来自别处的补丁', '小林寄回一份修复，署名里多了两家你没见过的工作室。晚上答疑的人越来越多，报价单上那些小额折扣也一直没能划掉。']},
      {id: 'anchor', label: '「明早去谈那份专用接口合同。」', detail: '围绕一位客户交付，能谈到更高报价；部分新客户暂时接不进来，专门支持也需要持续预算。', effects: {revenueMultiplier: 1.12, demandBonus: -1, operatingCost: .18},
        reply: ['客户经理', '一张留了签名的位置', '客户把合同的最后一页推了过来，验收会议和专用接口都写进了附件。工程师收起通用示例，先给这位客户开了一条维护分支。'],
        later: ['驻场工程师', '周三的固定电话', '客户如约续了订单，还介绍了自己的业务部门。另一家工作室因接口排期转身离开；每周三的驻场电话，则准时响起来。']},
    ],
  },
  {
    id: 'network-night', title: '机房门口的雨', speaker: '阿岚 · 系统工程师',
    body: game => networkOf(game) === 'acquire' ? '并进来的网络团队第一次和芯片组一起值夜班。客户的 IB 链路刚刚恢复，两个组却还在争论谁能改验收排期。一位负责人提出：按共同协议排队；另一位想直接成立专组，把整个项目接到底。' : 'IB 供应商的人冒雨赶来，客户的链路刚恢复，下一批交货时间仍然悬着。供应商希望保留自己的排期，客户却只肯认你这一个联系人。阿岚问：今晚，给谁一份怎样的承诺？',
    options: [
      {id: 'shared', label: '「把各家的排期放到一张表上。」', detail: '保留更多合作客户与共同接口；跨团队协调会花时间，也需要持续有人对接。', effects: {projectMultiplier: .97, demandBonus: 1, operatingCost: .08},
        reply: ['阿岚', '抄送给所有人的排期', '你把故障记录、边界和排期同时发给几家团队。没人能独自改动交付日，第一次协调会也比预想中开得更久。'],
        later: ['合作方工程师', '不是你们的一张工单', '合作方把下一次巡检也排进了自己的值班表，一位新客户愿意共用接口。跨公司的签字仍会拖慢验收，但深夜电话终于有人一起接了。']},
      {id: 'dedicated', label: '「这批交付，由我们一个窗口接到底。」', detail: '集中资源能缩短项目交付；一些并行订单要让位，专门值班与兜底支持也会留下持续支出。', effects: {projectMultiplier: 1.08, demandBonus: -.5, operatingCost: .16},
        reply: ['阿岚', '门口留下了一把伞', '客户拿走了你的直拨电话。专组把交换机、驱动和验收清单摆在同一间屋里，其他客户的排期暂时向后挪了一格。'],
        later: ['客户运维', '只拨这一个号码', '这次验收少了一轮转交，客户愿意把下一批也托给你。凌晨又有一通电话打进专组：无论故障在哪一段，他们都习惯先找你。']},
    ],
  },
  {
    id: 'deployment-window', title: '年末之前', speaker: '阿岚 · 系统工程师',
    body: game => businessLevel(game, 'rack') >= 1 ? '第一座机柜的风扇已经转起来。新客户想在年末前再开一批，老客户却等着维护窗口。白板上的交付表写满了，阿岚擦掉一个日期，又把笔递给你。' : '订单已经把车库挤得很满。一位客户想把下一批部署提前到年末，工程师却还欠老客户几项维护。没有更多机柜可以遮住这张排期表；今晚得先决定，人手放在哪里。',
    options: [
      {id: 'careful', label: '「先把已经答应的几家照顾好。」', detail: '为老客户的续单和维护留出人手，减少持续开销；新项目交付会放慢，有人可能另找档期。', effects: {revenueMultiplier: 1.03, projectMultiplier: .95, operatingCost: -.15},
        reply: ['客户经理', '划掉的那个日期', '你把做不到的交期划掉，给新客户回了电话。老客户的维护窗口留住了，几张新增部署单则被放回抽屉。'],
        later: ['老客户', '一封没有催促的邮件', '老客户发来了一张团队合照：那次维护没有打断他们的工作。新客户的宣传照里出现了另一家厂商；阿岚终于按时回了一趟家。']},
      {id: 'expand', label: '「把新一批部署排进来。」', detail: '增加项目交付能力，接住眼前的部署窗口；持续开销会上升，团队也要承担更密的值班。', effects: {projectMultiplier: 1.1, operatingCost: .4},
        reply: ['阿岚', '白板又接长了一截', '隔壁空房挂上了新的排期表，新客户确认了档期。工程师把两张值班表拼在一起，问行政能不能多配一把门钥匙。'],
        later: ['夜班工程师', '最后一班地铁', '这一批部署比原来的排期更快，客户带来了下一轮询价。夜班群里的消息也密了起来；你留下的机房钥匙，又多配了两把。']},
    ],
  },
];
const SCENE_MAP = new Map(SCENES.map(scene => [scene.id, scene]));
const ENDING_IDS = new Set(['closure', 'common-language', 'single-factory', 'partner-lights', 'quiet-workshop', 'signed-horizon', 'independent-lights']);

export function createNarrative() { return {version: VERSION, decisions: [], events: [], ending: null}; }

function openingEvent() {
  return {id: 'garage-door', title: '卷帘门第一次升起', speaker: '工坊记事', elapsed: 0,
    body: '阿岚把一张空排期表贴在车库墙上，小林抱着自己的程序站在门口。机器的风扇刚刚转起来，桌上的电话还没有响。没人知道，这个门牌以后会被谁记住。'};
}

function sceneEligible(index, game, decisions) {
  if (index && !decisions.some(decision => decision.eventId === SCENES[index - 1].id)) return false;
  if (index === 0) return businessLevel(game, 'cuda') >= 1;
  if (index === 1) return networkOf(game) !== 'none';
  return businessLevel(game, 'rack') >= 1 || (finite(game?.totalEarned) && game.totalEarned >= 12000);
}

function selected(decisions, eventId) { return decisions.find(decision => decision.eventId === eventId)?.optionId; }
function choiceOption(decision) { return SCENE_MAP.get(decision.eventId)?.options.find(option => option.id === decision.optionId); }
function decisionEvent(decision, later = false) {
  const option = choiceOption(decision);
  const [speaker, title, base] = option[later ? 'later' : 'reply'];
  const body = later && decision.mode === 'pve' ? `${base}${decision.eventId === 'software-letter' ? ' Lisa 的销售也来打听这套接口，不过客户还在等自己的交付。' : decision.eventId === 'network-night' ? ' 灰盒实验室寄来了新的报价，客户把它压在了你们的排期表下面。' : ' 窗外的同行招牌还亮着；这场竞赛没有替你决定明天的订单。'}` : base;
  return {id: `${decision.eventId}:${decision.optionId}:${later ? 'later' : 'reply'}`, title, speaker, body, elapsed: decision.elapsed + (later ? FOLLOWUP_DELAY : 0)};
}

function resultOf(context) { return context.winnerId === 'player' ? 'won' : context.winnerId === 'tie' ? 'tie' : 'late'; }
function triggerEligible(trigger, game, context, decisions) {
  if (trigger === 'bankrupt') return modeOf(context) === 'pve' && context.bankrupt === true;
  if (trigger === 'project') return modeOf(context) === 'pve' && context.projectComplete === true;
  if (modeOf(context) !== 'workshop') return false;
  if (trigger === 'factory') return Array.isArray(game?.won) && game.won.includes('factory');
  return trigger === 'business' && finite(game?.totalEarned) && game.totalEarned >= 30000 && decisions.length === SCENES.length;
}

function endingId(decisions, evidence) {
  if (evidence.trigger === 'bankrupt') return 'closure';
  const software = selected(decisions, 'software-letter');
  const network = selected(decisions, 'network-night');
  const scale = selected(decisions, 'deployment-window');
  if (network === 'dedicated' && evidence.network === 'acquire' && evidence.rack) return 'single-factory';
  if (software === 'commons' && scale === 'careful') return 'common-language';
  if (network === 'shared' && evidence.network === 'partner') return 'partner-lights';
  if (scale === 'careful') return 'quiet-workshop';
  if (software === 'anchor' && scale === 'expand') return 'signed-horizon';
  return 'independent-lights';
}

function canonicalEnding(id, elapsed, evidence) {
  const texts = {
    closure: ['停在清晨的风扇', '最后一次结算后，账上的钱没能撑住持续支出。阿岚逐台关掉机器，客户把尚未完成的工作迁了出去。留在桌上的接口文档和排期表，记录着这家公司曾经答应过什么。', '有人去了客户那里，有人带着旧代码重新找工作。车库的门关上了，这一段经营留下的承诺并没有跟着消失。'],
    'common-language': ['人们开始说同一种语言', '验收邮件到来时，署名里已经有了陌生的团队。小林沿用旧接口，新来的人接着写工具；你少接过几张急单，也一直替那些老程序留着门。', '后来有人问这套平台属于谁。阿岚把一封来自外地的补丁转给你：那里的工程师，从来没来过这间车库。'],
    'single-factory': ['一张桌上的整座工厂', '芯片、网络和交付团队终于用上同一张排期表。客户只拨一个号码，你也很难再把任何一段故障推给别人。第一次整柜验收的合照里，站着原本来自不同公司的工程师。', '机房外换了更大的招牌。每当电话响起，总有人抬头看看你；那份把事情接到底的承诺，已经成了公司的名字。'],
    'partner-lights': ['远处也亮着灯', '这次交付的签字页上留着几家公司的名字。各自的排期曾经吵得很凶，下一次故障却不必由一个团队熬完整夜。客户终于知道，合同背后不止一扇会打开的门。', '一封转来的邮件里，新的伙伴正在邀请更多团队共用接口。你们的招牌没有连成一块，值班室的灯却能隔着很远彼此照应。'],
    'quiet-workshop': ['旧客户还记得门牌号', '你没有接下每一个催促的日期。几张新单去了别处，留下的客户却知道维护窗口会照常到来。验收结束那晚，阿岚把白板擦干净，给大家留了一次完整的下班。', '工坊没有占满整条街。后来搬远的客户仍会来信，问下一批老程序，能不能继续在你们这里跑。'],
    'signed-horizon': ['合同尽头的地平线', '专用接口和更紧的交付表撑起了新的部署。那位大客户的名字出现在越来越多合同上，夜班电话也跟着变多。你们交出了这一批，下一批需求已经写在了附件里。', '窗外出现了更大的机房。客户愿意继续同行，但每一次需求变化，都会把整家公司叫回那张最初的谈判桌。'],
    'independent-lights': ['车库之外', '客户签下了这一阶段的验收单。还有接口要补，还有人等着下一批机器；这家公司已经走出了最初的车库，却仍要亲自回答每一份新的邀请。', '阿岚把旧门牌挂在新办公室里。某天深夜，小林又发来一张报错截图，末尾写着：明天见。'],
  };
  const [title, base, epilogue] = texts[id];
  let body = base;
  if (evidence.trigger === 'project') body = `${evidence.result === 'won' ? '首单商业化的消息先从你的机房传了出去。' : evidence.result === 'tie' ? '两份验收消息在同一天传开，这次没有谁独占头条。' : '同行的庆功新闻已经过去，你的客户今天才签下验收；他们在意的是，自己的项目终于跑起来了。'}${base}`;
  return {id, title, body, epilogue, elapsed, evidence: {...evidence}};
}

function restoreEnding(raw, game, context, decisions) {
  if (!raw || !ENDING_IDS.has(raw.id) || !finite(raw.elapsed) || raw.elapsed < 0 || raw.elapsed > clock(game, context)) return null;
  const proof = raw.evidence;
  if (!proof || proof.mode !== modeOf(context) || !Number.isInteger(proof.decisionCount) || proof.decisionCount < 0 || proof.decisionCount > decisions.length ||
      !['none', 'partner', 'acquire'].includes(proof.network) || typeof proof.rack !== 'boolean') return null;
  const historicDecisions = decisions.slice(0, proof.decisionCount);
  if (historicDecisions.some(decision => decision.elapsed > raw.elapsed) ||
      (proof.network !== 'none' && proof.network !== networkOf(game)) || (proof.rack && businessLevel(game, 'rack') < 1) ||
      !triggerEligible(proof.trigger, game, context, historicDecisions)) return null;
  if (historicDecisions.some(decision => decision.eventId === 'network-night') && proof.network === 'none') return null;
  const result = proof.trigger === 'project' ? resultOf(context) : proof.trigger === 'bankrupt' ? 'closed' : 'workshop';
  if (proof.result !== result) return null;
  const evidence = {mode: proof.mode, trigger: proof.trigger, result, network: proof.network, rack: proof.rack, decisionCount: proof.decisionCount};
  if (endingId(historicDecisions, evidence) !== raw.id) return null;
  return canonicalEnding(raw.id, raw.elapsed, evidence);
}

function restoreDecisions(raw, game, context = {}) {
  const decisions = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.version !== undefined && raw.version !== VERSION)) return decisions;
  const now = clock(game, context);
  const candidates = Array.isArray(raw.decisions) ? raw.decisions.slice(0, 16) : [];
  for (const candidate of candidates) {
    const index = SCENES.findIndex(scene => scene.id === candidate?.eventId);
    if (index !== decisions.length || !sceneEligible(index, game, decisions) ||
        !SCENES[index].options.some(option => option.id === candidate.optionId) ||
        !finite(candidate.elapsed) || candidate.elapsed < 0 || candidate.elapsed > now + EPSILON ||
        candidate.elapsed < (decisions.at(-1)?.elapsed ?? 0)) continue;
    decisions.push({eventId: candidate.eventId, optionId: candidate.optionId, elapsed: candidate.elapsed, mode: candidate.mode === 'pve' ? 'pve' : candidate.mode === 'workshop' ? 'workshop' : modeOf(context)});
  }
  return decisions;
}

/** Strip injected text and impossible choices, then rebuild known log records. */
export function restoreNarrative(raw, game, context = {}) {
  const state = createNarrative();
  // Completed saves from before letters existed get a retrospective second act.
  // Fresh games already have createNarrative(), so their normal finish is intact.
  const alreadyFinished = modeOf(context) === 'pve' ? context.projectComplete === true : Array.isArray(game?.won) && game.won.includes('factory');
  if (raw == null && alreadyFinished && !context.bankrupt) state.retrospective = true;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.version !== undefined && raw.version !== VERSION)) return state;
  const now = clock(game, context);
  state.decisions = restoreDecisions(raw, game, context);
  if (raw.retrospective === true && alreadyFinished && !raw.ending) state.retrospective = true;
  const canonical = new Map([['garage-door', openingEvent()]]);
  for (const decision of state.decisions) {
    for (const later of [false, true]) {
      const event = decisionEvent(decision, later);
      if (event.elapsed <= now + EPSILON) canonical.set(event.id, event);
    }
  }
  state.ending = restoreEnding(raw.ending, game, context, state.decisions);
  if (state.ending) {
    for (const [id, event] of canonical) if (event.elapsed > state.ending.elapsed) canonical.delete(id);
    canonical.set(`ending:${state.ending.id}`, endingEvent(state.ending));
  }
  const seen = new Set();
  for (const item of Array.isArray(raw.events) ? raw.events : []) {
    if (canonical.has(item?.id) && !seen.has(item.id)) { state.events.push(canonical.get(item.id)); seen.add(item.id); }
  }
  state.events.sort((a, b) => a.elapsed - b.elapsed);
  state.events = state.events.slice(-LOG_LIMIT);
  return state;
}

function pendingScene(game, state) {
  if (state.ending) return null;
  const index = state.decisions.length;
  const scene = SCENES[index];
  if (!scene || !sceneEligible(index, game, state.decisions)) return null;
  return {id: scene.id, title: scene.title, speaker: scene.speaker, body: typeof scene.body === 'function' ? scene.body(game) : scene.body,
    options: scene.options.map(({id, label, detail}) => ({id, label, detail}))};
}
function endingEvent(ending) { return {id: `ending:${ending.id}`, title: ending.title, speaker: '工坊档案 · 这一段的尾声', body: ending.body, elapsed: ending.elapsed}; }

export function getNarrativeView(game, context = {}) {
  const state = restoreNarrative(game?.narrative, game, context);
  return {pending: pendingScene(game, state), events: state.events.map(event => ({...event})), ending: state.ending ? {...state.ending, evidence: {...state.ending.evidence}} : null};
}

/** Synchronize after real game actions. Delayed letters retain their due time. */
export function updateNarrative(game, context = {}) {
  const state = restoreNarrative(game?.narrative, game, context);
  const now = clock(game, context);
  const added = [];
  const append = event => {
    if (state.events.some(item => item.id === event.id)) return;
    state.events.push(event); added.push(event);
  };
  append(openingEvent());
  for (const decision of state.decisions) {
    if (!state.ending || decision.elapsed <= state.ending.elapsed) append(decisionEvent(decision));
    if (now >= decision.elapsed + FOLLOWUP_DELAY && (!state.ending || decision.elapsed + FOLLOWUP_DELAY <= state.ending.elapsed)) append(decisionEvent(decision, true));
  }
  if (!state.ending) {
    const trigger = context.bankrupt && modeOf(context) === 'pve' ? 'bankrupt' : modeOf(context) === 'pve' ? 'project' : Array.isArray(game?.won) && game.won.includes('factory') ? 'factory' : 'business';
    if ((!state.retrospective || state.decisions.length === SCENES.length || trigger === 'bankrupt') && triggerEligible(trigger, game, context, state.decisions)) {
      const evidence = {mode: modeOf(context), trigger, result: trigger === 'project' ? resultOf(context) : trigger === 'bankrupt' ? 'closed' : 'workshop', network: networkOf(game), rack: businessLevel(game, 'rack') >= 1, decisionCount: state.decisions.length};
      state.ending = canonicalEnding(endingId(state.decisions, evidence), now, evidence);
      delete state.retrospective;
      append(endingEvent(state.ending));
    }
  }
  state.events.sort((a, b) => a.elapsed - b.elapsed);
  state.events = state.events.slice(-LOG_LIMIT);
  game.narrative = state;
  return added.sort((a, b) => a.elapsed - b.elapsed).map(event => ({...event}));
}

export function chooseNarrativeOption(game, eventId, optionId, context = {}) {
  const state = restoreNarrative(game?.narrative, game, context);
  const pending = pendingScene(game, state);
  if (!pending || pending.id !== eventId) return {ok: false, reason: '这封信已经处理，或还没有送到。', events: []};
  if (!pending.options.some(option => option.id === optionId)) return {ok: false, reason: '信上没有这一项答复。', events: []};
  state.decisions.push({eventId, optionId, elapsed: clock(game, context), mode: modeOf(context)});
  game.narrative = state;
  return {ok: true, reason: '答复已寄出。', events: updateNarrative(game, context)};
}

/** Canonical decisions only; queries never alter game, cash or stored letters. */
export function getNarrativeEffects(game) {
  const decisions = restoreDecisions(game?.narrative, game);
  const result = {revenueMultiplier: 1, demandBonus: 0, projectMultiplier: 1, operatingCost: 0};
  for (const decision of decisions) {
    const effect = choiceOption(decision).effects;
    result.revenueMultiplier *= effect.revenueMultiplier ?? 1;
    result.projectMultiplier *= effect.projectMultiplier ?? 1;
    result.demandBonus += effect.demandBonus ?? 0;
    result.operatingCost += effect.operatingCost ?? 0;
  }
  for (const key of Object.keys(result)) result[key] = Math.round(result[key] * 1e6) / 1e6;
  return result;
}
