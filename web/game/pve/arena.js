import {
  RACE_COMPANIES,
  RACE_UPGRADES,
  createRace,
  getRaceStats,
  tickRace,
  buyRaceUpgrade,
  buyRaceBusinessUpgrade,
  canBuyRaceUpgrade,
  getRaceUpgradeCost,
  manualRaceCompute,
  startRaceProject,
  restoreRace,
  serializeRace,
  chooseRaceNarrative,
} from "../../../lib/pve-race.js?v=narrative-branches-1";
import {
  getFinanceStats,
  quoteIPO,
  executeIPO,
  quoteBuyback,
  executeBuyback,
  updateValuation,
} from "../../../lib/pve-market.js?v=narrative-branches-1";
import {
  MODEL_INFO,
  getWorkloadPerformance,
} from "../../../lib/compute-model.js";

import {
  BUSINESS_UPGRADES,
  getBusinessUpgradeStatus,
} from "../../../lib/business-game.js?v=narrative-branches-1";

const SAVE_KEY = "huang-sir-pve-v1";
const $ = (id) => document.getElementById(id);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const number = (value, digits = 0) =>
  Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const cash = (value) => `$${number(value, Math.abs(value) < 1000 ? 2 : 0)}`;
const clock = (seconds) =>
  [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    Math.floor(seconds) % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
const shortClock = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;
const companyInfo = (id) => RACE_COMPANIES.find((company) => company.id === id);
const companyColors = { player: "#c8f58b", lisa: "#f0988e", grey: "#b8bfd1" };
const names = Object.fromEntries(
  RACE_UPGRADES.map((upgrade) => [upgrade.id, upgrade.name]),
);
const phases = {
  locked: "积累与研发",
  ready: "训练就绪",
  training: "模型训练中",
  commercial: "交付商业首单",
  complete: "首单已交付",
};
const technicalNames = {
  alu: "FP32 ARITHMETIC UNIT",
  clock: "CLOCK GENERATOR",
  l1: "LEVEL 1 CACHE",
  dram: "DEVICE MEMORY",
  l2: "SHARED LEVEL 2 CACHE",
  scheduler: "WARP SCHEDULER",
  tensor: "MATRIX ACCELERATOR",
  hbm: "HIGH BANDWIDTH MEMORY",
  tma: "TENSOR MEMORY ACCELERATOR",
  tmem: "TENSOR MEMORY",
};
const partGlyph = {
  alu: "⊞",
  clock: "↗",
  l1: "▤",
  dram: "▥",
  l2: "▦",
  scheduler: "⇄",
  tensor: "✳",
  hbm: "▰",
  tma: "⇢",
  tmem: "▧",
  pcie: "⇆",
  cuda: "⌘",
  libraries: "▤",
  nvlink: "⤨",
  ib_partner: "⇄",
  mellanox: "◇",
  rack: "▥",
  developers: "⌬",
};
const bottlenecks = {
  compute: "计算吞吐",
  bandwidth: "供数带宽",
  latency: "访存延迟",
};
let race;
let paused = false;
let selectedCompany = "player";
let savedStorage = true;
let offlineSeconds = 0;
let offlineBefore = [];
try {
  const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
  if (raw?.version === 1 && raw.race) {
    paused = raw.paused === true;
    const saved =
      typeof raw.race === "string" ? JSON.parse(raw.race) : raw.race;
    offlineBefore = (saved.companies || []).map((company) => ({
      id: company.id,
      totalEarned: company.game?.totalEarned || 0,
    }));
    offlineSeconds = paused
      ? 0
      : Math.max(
          0,
          Math.min(
            28800,
            (Date.now() - Number(saved.savedAt || Date.now())) / 1000,
          ),
        );
    race = restoreRace(saved, paused ? saved.savedAt : Date.now());
  }
} catch {
  savedStorage = false;
}
race ||= createRace();
let lastFrame = Date.now();
let lastSave = Date.now();
let lastChartSignature = "";
let lastNewsSignature = "";
let lastModelSignature = "";

function toast(message, type = "") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("toast-container").append(element);
  while ($("toast-container").children.length > 3)
    $("toast-container").firstElementChild.remove();
  setTimeout(() => element.remove(), type === "error" ? 6000 : 4300);
}
function rawCompany(id = "player") {
  return race.companies.find((company) => company.id === id);
}
function save() {
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({ version: 1, paused, race: serializeRace(race) }),
    );
    savedStorage = true;
    $("save-status").innerHTML =
      '<span class="status-dot"></span>创业赛进度已保存';
  } catch {
    savedStorage = false;
    $("save-status").textContent = "本机存档不可用";
  }
  lastSave = Date.now();
}
function addNews(type, message) {
  race.logs.push({ type, message, companyId: "player", elapsed: race.elapsed });
  race.logs = race.logs.slice(-48);
}
function handleEvents(events) {
  for (const event of events) {
    if (
      ["milestone", "race-end", "bankrupt", "project-ready"].includes(
        event.type,
      )
    )
      toast(
        event.message,
        event.type === "bankrupt"
          ? "error"
          : event.companyId === "player"
            ? "reward"
            : "",
      );
  }
  if (
    events.some((event) =>
      ["milestone", "race-end", "bankrupt"].includes(event.type),
    )
  )
    save();
}

function buildShop() {
  $("upgrade-grid").innerHTML = RACE_UPGRADES.map(
    (upgrade) =>
      `<article class="upgrade-card" id="upgrade-${upgrade.id}"><div class="upgrade-top"><div class="upgrade-icon part-glyph">${partGlyph[upgrade.id]}</div><span class="upgrade-level"></span></div><h3>${escapeHTML(upgrade.name)}<span>${technicalNames[upgrade.id]}</span></h3><p class="upgrade-description">${escapeHTML(upgrade.subtitle)}</p><p class="upgrade-benefit"></p><button class="upgrade-buy" data-buy="${upgrade.id}" aria-label="购买${escapeHTML(upgrade.name)}"><span></span><strong></strong></button></article>`,
  ).join("");
  $("company-races").innerHTML =
    RACE_COMPANIES.map(
      (company) =>
        `<div class="company-race-row"><span class="race-company-label"><i class="company-dot ${company.id}"></i>${escapeHTML(company.name)}</span><div class="race-track"><span class="race-fill ${company.id}" id="race-fill-${company.id}"></span></div><span class="race-company-state ${company.id}" id="race-stage-${company.id}"></span></div>`,
    ).join("") +
    '<div class="race-track-caption"><span>从车库起步</span><span>模型训练</span><span>商业首单 →</span></div>';
  const tabs = RACE_COMPANIES.map(
    (company) =>
      `<button type="button" class="${company.id}" data-stock="${company.id}"><i class="company-dot ${company.id}"></i>${escapeHTML(company.name)}</button>`,
  ).join("");
  $("market-company-tabs").innerHTML = tabs;
  $("large-market-tabs").innerHTML = tabs;
}

function buildBusinessShop() {
  $("business-grid").innerHTML = BUSINESS_UPGRADES.map((upgrade) =>
    `<article class="upgrade-card business-card" id="business-${upgrade.id}"><div class="upgrade-top"><div class="upgrade-icon part-glyph">${partGlyph[upgrade.id]}</div><span class="upgrade-level"></span></div><h3>${escapeHTML(upgrade.name)}<span>${escapeHTML(upgrade.subtitle)}</span></h3><p class="upgrade-description">${escapeHTML(upgrade.description)}</p><details class="business-budget"><summary>预算与验收条件</summary><p class="business-benefit">${escapeHTML(upgrade.benefit)}</p><p class="business-recurring">每级持续运营费用 +${cash(upgrade.recurringCost)}/s</p><p class="upgrade-benefit business-status"></p></details><button class="upgrade-buy" data-business-buy="${upgrade.id}" aria-label="研发${escapeHTML(upgrade.name)}"><span></span><strong></strong></button></article>`,
  ).join("");
}

function businessRoute(business) {
  return { none: "网络实验室筹备中", partner: "IB 服务已签约", acquire: "网络团队已入驻" }[business.networkRoute] || business.networkRoute;
}

function renderBusiness(stats) {
  const company = rawCompany();
  const business = stats.player.business;
  $("business-demand").textContent = `${business.demandBonus < 0 ? "−" : "+"}${cash(Math.abs(business.demandBonus))}/s`;
  $("business-premium").textContent = `×${number(business.revenueMultiplier, 2)}`;
  $("business-project").textContent = `×${number(business.projectMultiplier, 2)}`;
  $("business-racks").textContent = number(business.rackCount);
  $("business-upkeep").textContent = `${cash(business.operatingCost)}/s`;
  $("business-ledger-summary").textContent = business.summary;
  $("business-summary").textContent = business.rackCount
    ? "凌晨的机房里，交付组还在对最后一排指示灯。客户明早会来。"
    : business.softwareLevel
      ? "开发者群里又亮起几个头像。有人留下故障日志，也有人留下了改好的补丁。"
      : "实验室的白板还没擦。几位工程师把新的提案留在了你的桌上。";
  let invitations = 0;
  for (const upgrade of BUSINESS_UPGRADES) {
    const status = getBusinessUpgradeStatus(company.game, upgrade.id);
    const unavailable = paused || stats.player.finance.bankrupt;
    const reason = stats.player.finance.bankrupt ? "公司已停止经营" : paused ? "全场已暂停，继续后可投资" : status.reason;
    const card = $(`business-${upgrade.id}`);
    card.hidden = !status.level && status.missing.some((item) => !item.startsWith("资金 "));
    if (!card.hidden) invitations++;
    card.classList.toggle("locked", !status.ok && !status.maxed);
    card.classList.toggle("purchasable", status.ok && !unavailable);
    card.classList.toggle("installed", status.level > 0);
    card.querySelector(".upgrade-level").textContent = status.maxed
      ? "研发完成"
      : status.level ? `LV.${String(status.level).padStart(2, "0")}` : "待研发";
    card.querySelector(".business-status").textContent = status.maxed
      ? "已完成此项研发"
      : reason || "预算已备齐，验收条件已满足。";
    const button = card.querySelector("button");
    button.disabled = !status.ok || unavailable;
    button.title = reason || `投资 ${cash(status.cost)}，运营增加 ${cash(upgrade.recurringCost)}/s`;
    button.querySelector("span").textContent = status.maxed
      ? "已完成 ✓"
      : unavailable ? "暂不可签批" : status.ok ? status.level ? "追加研发 ↗" : "批准提案 +" : "预算待备齐";
    button.querySelector("strong").textContent = status.maxed ? "MAX" : cash(status.cost);
  }
  $("business-empty").hidden = invitations > 0;
}

let narrativeSignature = "";
function narrativeParagraphs(value) {
  return String(Array.isArray(value) ? value.join("\n") : value || "")
    .split(/\n+/).filter(Boolean).map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("");
}
function renderNarrative(player) {
  const view = player.narrative;
  const signature = JSON.stringify([view, paused]);
  if (signature === narrativeSignature) return;
  narrativeSignature = signature;
  $("narrative-state").textContent = view.pending ? "有一封信等你回" : view.ending ? "这一页已经写下" : "车间的灯还亮着";
  $("narrative-current").innerHTML = view.pending
    ? `<article class="narrative-letter"><div class="letter-sender"><span class="letter-mark" aria-hidden="true">✉</span><span>${escapeHTML(view.pending.speaker)}</span></div><h3 id="narrative-letter-title" tabindex="-1">${escapeHTML(view.pending.title)}</h3><div class="letter-body">${narrativeParagraphs(view.pending.body)}</div><div class="narrative-options" role="group" aria-labelledby="narrative-letter-title">${view.pending.options.map((option) => `<button type="button" class="narrative-choice" data-narrative-event="${escapeHTML(view.pending.id)}" data-narrative-option="${escapeHTML(option.id)}" ${paused || player.finance.bankrupt ? "disabled" : ""}><strong>${escapeHTML(option.label)}<span aria-hidden="true">↗</span></strong><span>${escapeHTML(option.detail)}</span></button>`).join("")}</div><p class="letter-footnote">${paused ? "赛场已暂停，继续全场后可以回信。" : "信可以稍后回。来往的订单与对手的消息仍在继续。"}</p></article>`
    : '<p class="narrative-quiet">桌上暂时没有未回的信。走廊那头传来风扇声，工程师还守在屏幕前。</p>';
  const recent = view.events.filter((event) => !event.id.startsWith("ending:")).slice(-4).reverse();
  const latest = recent[0];
  $("narrative-latest").hidden = !latest;
  $("narrative-latest").innerHTML = latest ? `<div class="narrative-event-meta"><span>${escapeHTML(latest.speaker)} · 最近的回音</span><time>${clock(latest.elapsed || 0)}</time></div><strong>${escapeHTML(latest.title)}</strong><div>${narrativeParagraphs(latest.body)}</div>` : "";
  $("narrative-history").hidden = recent.length < 2;
  $("narrative-events").innerHTML = recent.slice(1).map((event) => `<li><div class="narrative-event-meta"><span>${escapeHTML(event.speaker)}</span><time>${clock(event.elapsed || 0)}</time></div><strong>${escapeHTML(event.title)}</strong><div>${narrativeParagraphs(event.body)}</div></li>`).join("");
  $("narrative-ending").hidden = !view.ending;
  $("narrative-ending").innerHTML = view.ending
    ? `<span class="narrative-ending-label">多年后，人们这样记得这间公司</span><h3 tabindex="-1">${escapeHTML(view.ending.title)}</h3>${narrativeParagraphs(view.ending.body)}<div class="narrative-epilogue">${narrativeParagraphs(view.ending.epilogue)}</div><button type="button" class="outline-button" data-narrative-continue>合上信，回到赛场 <span aria-hidden="true">→</span></button><small>${player.finance.bankrupt ? "这一页已存档，对手的故事仍在继续。" : "这一页已存档，你仍可继续经营。"}</small>`
    : "";
}

function renderShop(stats) {
  const company = rawCompany();
  for (const upgrade of RACE_UPGRADES) {
    const card = $(`upgrade-${upgrade.id}`);
    const level = company.game.levels[upgrade.id] || 0;
    const missing = upgrade.requires.filter((id) => !company.game.levels[id]);
    const research = company.game.totalEarned < upgrade.unlockEarned;
    const locked =
      research || Boolean(missing.length) || stats.player.finance.bankrupt;
    const maxed = level >= upgrade.maxLevel;
    const canBuy = canBuyRaceUpgrade(race, upgrade.id);
    const cost = getRaceUpgradeCost(race, upgrade.id);
    card.classList.toggle("locked", locked);
    card.classList.toggle("purchasable", canBuy);
    card.querySelector(".upgrade-level").textContent = stats.player.finance
      .bankrupt
      ? "停止经营"
      : research
        ? "研发中"
        : missing.length
          ? "待前置"
          : level
            ? `LV.${String(level).padStart(2, "0")}`
            : "可安装";
    let benefit;
    if (research) benefit = `经营收入 ${cash(upgrade.unlockEarned)} 开放`;
    else if (missing.length)
      benefit = `前置：${missing.map((id) => names[id]).join(" + ")}`;
    else if (maxed) benefit = "已达组件最高等级";
    else {
      const kind = company.game.activeJob?.kind || "fp32";
      const before = getWorkloadPerformance(company.game.levels, kind);
      const after = getWorkloadPerformance(
        { ...company.game.levels, [upgrade.id]: level + 1 },
        kind,
      );
      const gain =
        before.throughput > 0
          ? (after.throughput / before.throughput - 1) * 100
          : 0;
      const nextFinance = getFinanceStats({
        ...company,
        game: {
          ...company.game,
          levels: { ...company.game.levels, [upgrade.id]: level + 1 },
        },
      });
      benefit = `当前负载 ${gain >= 0 ? "+" : ""}${number(gain, 1)}% · 成本 +${cash(Math.max(0, nextFinance.operatingCost - stats.player.finance.operatingCost))}/s`;
    }
    card.querySelector(".upgrade-benefit").textContent = benefit;
    const button = card.querySelector("button");
    button.disabled = !canBuy;
    button.querySelector("span").textContent = maxed
      ? "已达上限"
      : locked
        ? "尚未开放"
        : level
          ? "升级组件 ↗"
          : "安装组件 +";
    button.querySelector("strong").textContent = maxed ? "MAX" : cash(cost);
    button.title = locked
      ? benefit
      : !canBuy
        ? `还差 ${cash(Math.max(0, cost - company.game.money))}`
        : `${cash(cost)} · ${benefit}`;
  }
}

function progressFor(company) {
  if (company.project.phase === "complete") return 1;
  if (company.project.phase === "commercial")
    return 0.8 + company.commercialProgress * 0.2;
  if (company.project.phase === "training")
    return 0.45 + company.trainingProgress * 0.35;
  if (company.project.phase === "ready") return 0.45;
  const requirementProgress =
    company.requirements.reduce(
      (sum, requirement) =>
        sum + Math.min(1, requirement.current / requirement.required),
      0,
    ) / company.requirements.length;
  return Math.min(0.44, requirementProgress * 0.44);
}
function hardwareSummary(company) {
  return `${company.aluCount} ALU · ${company.levels.l1 ? "L1 " + company.levels.l1 : "无缓存"} · ${company.levels.hbm ? "HBM" : company.levels.dram ? "DRAM" : "无显存"}${company.levels.tensor ? " · Tensor" : ""}`;
}

function renderMilestones() {
  for (const [id, prefix] of [
    ["firstCapital", "gold"],
    ["gpt3", "gpt"],
    ["commercial", "deal"],
  ]) {
    const milestone = race.milestones[id];
    const won = milestone.winnerIds.length > 0;
    const card = $(`${prefix}-owner`).closest("article");
    card.classList.toggle("claimed", won);
    card.classList.toggle(
      "red-claimed",
      won && milestone.winnerIds.includes("lisa"),
    );
    $(`${prefix}-state`).textContent = won ? "已诞生" : "争夺中";
    $(`${prefix}-owner`).textContent = won
      ? `${milestone.winnerIds.map((id) => companyInfo(id).name).join(" / ")} · ${shortClock(milestone.elapsed)} 率先达成`
      : {
          firstCapital: "累计经营收入 $1,000，谁先做到？",
          gpt3: "备齐硬件，完成模型训练。",
          commercial: "从模型到产品，拿下先发优势。",
        }[id];
  }
  const bankrupt = rawCompany().finance.bankrupt;
  $("winner-banner").hidden = !race.winnerId && !bankrupt;
  if (bankrupt) {
    $("winner-banner").className = "winner-banner lisa";
    $("winner-banner").textContent =
      "银行收回了最后一笔授信。车间停止接单与研发，桌上的信与这一页故事留了下来。对手仍在发展。";
  } else if (race.winnerId) {
    const winner =
      race.winnerId === "tie"
        ? "多家公司并列"
        : companyInfo(race.winnerId).name;
    $("winner-banner").className = `winner-banner ${race.winnerId}`;
    $("winner-banner").textContent =
      `⚑ 今日头条：${winner}率先交付商业首单。这是赛场的第一个头条，你的公司会被怎样记住，还写在此后的每一天里。经营继续。`;
  }
}

function renderFinance(player) {
  const finance = player.finance;
  const company = rawCompany();
  $("cash-value").textContent = cash(player.money);
  $("net-value").textContent =
    `${finance.netFlow >= 0 ? "+" : "−"}${cash(Math.abs(finance.netFlow))}/s`;
  $("net-value").classList.toggle("negative", finance.netFlow < 0);
  $("net-note").textContent = finance.bankrupt
    ? "已停止经营 · 不再扣除运营费用"
    : `自动收入 ${cash(finance.incomeRate)} − 成本 ${cash(finance.operatingCost)}`;
  $("cost-value").textContent = finance.bankrupt
    ? "已停止"
    : `${cash(finance.operatingCost)}/s`;
  $("debt-value").textContent =
    `$${number(finance.debt)} / $${number(finance.creditLimit)}`;
  $("runway-note").textContent = finance.bankrupt
    ? "已触及破产线"
    : finance.runway !== null
      ? `按当前现金流约 ${shortClock(finance.runway)} 后触线`
      : "当前净现金流为正";
  $("debt-progress").style.width = `${finance.bankruptcyRatio * 100}%`;
  const highRisk =
    finance.bankrupt ||
    finance.bankruptcyRatio > 0.65 ||
    (finance.runway !== null && finance.runway < 60);
  const warning = !highRisk && (finance.netFlow < 0 || finance.debt > 1);
  $("risk-panel").className =
    `risk-panel ${highRisk ? "danger" : warning ? "warning" : ""}`;
  $("risk-title").textContent = finance.bankrupt
    ? "公司已破产。"
    : highRisk
      ? "财务室来了一通急电。"
      : warning
        ? "账本上出现了红字。"
        : "今天的账已经对齐。";
  $("risk-copy").textContent = finance.bankrupt
    ? "运营欠款达到信用额度，公司停止经营。往来的信件与经营记录仍然保留。"
    : finance.netFlow < 0
      ? `财务递来报表：当前预计每秒亏损 ${cash(-finance.netFlow)}，运营费用仍在扣除。`
      : finance.debt > 0
        ? "订单结算有间隔，收入到账会优先偿还欠款。现金为零并不立即破产。"
        : "硬件、团队与客户服务都在产生运营费用，训练时日常订单可用的算力会减少。";
  const ipo = quoteIPO(company);
  $("ipo-button").disabled = !ipo.ok;
  $("ipo-button").textContent = finance.listed
    ? "✓ 已完成 IPO"
    : finance.bankrupt
      ? "公司已破产"
      : "申请 IPO · 发行 250 股 ↗";
  $("ipo-copy").textContent = finance.listed
    ? "公司已上市，本场只开放一次首次融资。"
    : `累计经营收入 ${cash(player.totalEarned)} / $600`;
  $("ipo-quote").textContent = finance.listed
    ? `融资到账 ${cash(company.finance.ipoProceeds)} · 当前持股 ${number(finance.ownership * 100, 1)}%`
    : ipo.ok
      ? `预计融资 ${cash(ipo.proceeds)} · 发行价 ${cash(ipo.price)}`
      : ipo.reason;
  const shares = Number($("buyback-shares").value);
  const buyback = quoteBuyback(company, shares);
  $("buyback-button").disabled = !buyback.ok;
  $("buyback-button").textContent = buyback.ok
    ? `确认回购 · ${cash(buyback.cost)}`
    : "确认回购";
  $("buyback-quote").textContent = buyback.ok
    ? `${shares} 股 × ${cash(buyback.price)} = ${cash(buyback.cost)}`
    : buyback.reason;
  $("buyback-shares").max = String(Math.max(1, finance.publicShares));
}

function renderProject(player) {
  const phase = player.project.phase;
  $("project-phase").textContent = player.finance.bankrupt
    ? "已停止"
    : phases[phase];
  $("project-requirements").innerHTML = player.requirements
    .map(
      (requirement) =>
        `<span class="${requirement.met ? "met" : ""}">${escapeHTML(requirement.name)} ${requirement.id === "alu" ? `${requirement.current + 1}/${requirement.required + 1}` : `${requirement.current}/${requirement.required}`} ${requirement.met ? "✓" : ""}</span>`,
    )
    .join("");
  $("training-progress").style.width = `${player.trainingProgress * 100}%`;
  $("commercial-progress").style.width = `${player.commercialProgress * 100}%`;
  $("training-percent").textContent =
    `${number(player.trainingProgress * 100, 1)}%`;
  $("commercial-percent").textContent =
    `${number(player.commercialProgress * 100, 1)}%`;
  $("project-button").disabled = phase !== "ready" || player.finance.bankrupt;
  $("project-button").textContent = player.finance.bankrupt
    ? "已停止经营"
    : phase === "ready"
      ? "启动 GPT-3 训练 →"
      : phase === "training"
        ? "模型训练进行中…"
        : phase === "commercial"
          ? "商业首单交付中…"
          : phase === "complete"
            ? "✓ 已完成商业首单"
            : "准备好硬件再出发 →";
  $("project-story").textContent =
    phase === "training"
      ? `70% 算力正在训练模型，日常自动收入预计 ${cash(player.finance.incomeRate)}/s。完成训练后自动转入商业首单交付。`
      : phase === "commercial"
        ? "演示屏上终于出现了完整的句子。客户没有鼓掌，只问：明天能接进我们的系统吗？第一份商业订单正在交付。"
        : phase === "complete"
          ? "客户签下了验收单。走出会议室，你听见工程师已经在讨论下一次故障演练。"
          : "客户寄来半页未完的文字：如果这台机器能接着写下去呢？实验室里，新的计划有了名字。";
}

function chartSVG(stats, width, height) {
  const left = 42,
    right = 12,
    top = 14,
    bottom = 25;
  const now = race.elapsed;
  const start = Math.max(0, now - 600);
  const series = stats.companies.map((company) => {
    const history = rawCompany(company.id).finance.history || [];
    const points = history
      .filter((point) => point.elapsed >= start && point.elapsed <= now)
      .map((point) => ({ t: point.elapsed, p: point.price }));
    if (!points.length) points.push({ t: start, p: company.finance.price });
    if (points.at(-1).t < now || points.length === 1)
      points.push({ t: Math.max(now, start + 1), p: company.finance.price });
    return { id: company.id, points };
  });
  const maximum =
    Math.max(
      1.25,
      ...series.flatMap((series) => series.points.map((point) => point.p)),
    ) * 1.12;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const x = (t) => left + ((t - start) / Math.max(5, now - start)) * plotWidth;
  const y = (p) => top + plotHeight * (1 - Math.min(maximum, p) / maximum);
  let output = Array.from({ length: 4 }, (_, index) => {
    const value = (maximum * index) / 3;
    const yy = y(value);
    return `<path d="M${left} ${yy}H${width - right}" stroke="#34492a" stroke-width=".7" stroke-dasharray="3 5"/><text x="${left - 7}" y="${yy + 3}" text-anchor="end" class="stock-tooltip">${number(value, value < 10 ? 1 : 0)}</text>`;
  }).join("");
  for (const seriesItem of series) {
    const path = seriesItem.points
      .map(
        (point, index) =>
          `${index ? "L" : "M"}${x(point.t).toFixed(2)} ${y(point.p).toFixed(2)}`,
      )
      .join(" ");
    const last = seriesItem.points.at(-1);
    output += `<path d="${path}" class="stock-line ${seriesItem.id} ${seriesItem.id !== selectedCompany ? "faded" : ""}"/><circle cx="${x(last.t)}" cy="${y(last.p)}" r="${seriesItem.id === selectedCompany ? 3 : 2}" class="stock-end ${seriesItem.id}"/>`;
  }
  output += `<text x="${left}" y="${height - 5}" class="stock-tooltip">${shortClock(start)}</text><text x="${width - right}" y="${height - 5}" text-anchor="end" class="stock-tooltip">${shortClock(now)}</text>`;
  return output;
}

function renderStocks(stats) {
  const selected = stats.companies.find(
    (company) => company.id === selectedCompany,
  );
  const history = rawCompany(selectedCompany).finance.history || [];
  const firstPrice = history[0]?.price || 1;
  const change = (selected.finance.price / firstPrice - 1) * 100;
  $("market-symbol").textContent = {
    player: "HSIR",
    lisa: "LISA",
    grey: "GREY",
  }[selectedCompany];
  $("stock-price").textContent = cash(selected.finance.price);
  $("stock-change").textContent =
    `${change >= 0 ? "+" : ""}${number(change, 2)}% / 图中起点`;
  $("stock-change").classList.toggle("negative", change < 0);
  $("stock-cap").textContent = cash(selected.finance.marketCap);
  $("stock-ownership").textContent =
    `${number(selected.finance.ownership * 100, 1)}%`;
  $("stock-float").textContent = `${number(selected.finance.publicShares)} 股`;
  $("stock-listing").textContent = selected.finance.bankrupt
    ? "已破产"
    : selected.finance.listed
      ? "已 IPO · 模拟行情"
      : "未上市 · 估值参考";
  document.querySelectorAll("[data-stock]").forEach((button) => {
    button.classList.toggle("active", button.dataset.stock === selectedCompany);
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.stock === selectedCompany),
    );
  });
  const signature = JSON.stringify([
    race.elapsed,
    selectedCompany,
    stats.companies.map((company) => [
      company.finance.price,
      company.finance.publicShares,
    ]),
  ]);
  if (signature !== lastChartSignature) {
    lastChartSignature = signature;
    $("stock-chart").innerHTML = chartSVG(stats, 400, 170);
    $("large-stock-chart").innerHTML = chartSVG(stats, 800, 320);
  }
  $("large-stock-caption").textContent =
    `${selected.name} · 每股 ${cash(selected.finance.price)} · 公司估值 ${cash(selected.finance.marketCap)} · 创始人持股 ${number(selected.finance.ownership * 100, 1)}% · 图示最近 10 分钟`;
}

function renderLeaderboard(stats) {
  $("leaderboard").innerHTML = stats.rankings
    .map(
      (company, index) =>
        `<div class="leaderboard-row"><span class="leaderboard-rank">0${index + 1}</span><div class="leaderboard-company">${company.id === "grey" ? '<span class="leaderboard-avatar grey-avatar">▦</span>' : `<img class="leaderboard-avatar ${company.id}" src="${company.id === "player" ? "../assets/huang-sir-avatar.svg" : "./assets/lisa-avatar.svg"}" alt=""/>`}<div><strong>${escapeHTML(company.name)} ${company.finance.listed ? '<span class="listed-small">IPO</span>' : ""}</strong><small>${company.finance.bankrupt ? "已破产" : `${company.aluCount} ALU · ${company.cacheLabel} · ${phases[company.project.phase]}`}</small><small class="company-business-line">生态 LV.${number(company.business.softwareLevel)} · 机柜 ${number(company.business.rackCount)} · ${escapeHTML(businessRoute(company.business))}</small></div></div><div class="leaderboard-value">${cash(company.totalEarned)}<small>累计经营收入</small></div></div>`,
    )
    .join("");
  const signature = JSON.stringify(race.logs.slice(-12));
  if (signature !== lastNewsSignature) {
    lastNewsSignature = signature;
    $("race-news").innerHTML = race.logs
      .slice(-12)
      .reverse()
      .map(
        (entry) =>
          `<div class="news-entry ${entry.type === "milestone" ? "milestone" : ""}"><span class="news-time">${shortClock(entry.elapsed)}</span><i class="company-dot ${entry.companyId || "player"}"></i><span class="news-message">${escapeHTML(entry.message)}</span></div>`,
      )
      .join("");
  }
}

function renderModel() {
  const company = rawCompany();
  const kind =
    $("model-workload")?.value || company.game.activeJob?.kind || "fp32";
  const signature = JSON.stringify([company.game.levels, kind]);
  if (signature === lastModelSignature) return;
  lastModelSignature = signature;
  const model = getWorkloadPerformance(company.game.levels, kind);
  $("model-kind").textContent = kind.toUpperCase();
  $("model-throughput").textContent = `${number(model.throughput, 2)} 算力 / s`;
  $("model-bottleneck").textContent =
    bottlenecks[model.bottleneck] || model.bottleneck;
  $("model-cycles").textContent = `${number(model.cycles, 2)} 模型周期`;
  $("model-compute").textContent = number(model.computeCycles, 2);
  $("model-memory").textContent = number(model.memoryCycles, 2);
  $("model-latency").textContent = number(model.latencyCycles, 2);
  $("model-hit").textContent = `${number(model.hitRate * 100, 1)}%`;
  $("model-overlap").textContent = `${number(model.overlap * 100, 1)}%`;
  $("model-features").textContent = JSON.stringify(model.features, null, 2);
  $("model-description").textContent = MODEL_INFO.description;
}

function render() {
  const stats = getRaceStats(race);
  const player = stats.player;
  const lisa = stats.companies.find((company) => company.id === "lisa");
  $("world-time").textContent = clock(race.elapsed);
  $("world-status").textContent = paused ? "全场已暂停" : "所有公司同步经营";
  $("pause-button").textContent = paused ? "继续全场 ▶" : "暂停全场 Ⅱ";
  document.body.classList.toggle("race-paused", paused);
  $("player-lineup").textContent = hardwareSummary(player);
  $("lisa-lineup").textContent = hardwareSummary(lisa);
  $("leader-note").textContent = `${stats.rankings[0].name} 当前领先`;
  for (const company of stats.companies) {
    $("race-fill-" + company.id).style.width = `${progressFor(company) * 100}%`;
    $("race-stage-" + company.id).textContent = company.finance.bankrupt
      ? "已破产"
      : phases[company.project.phase];
  }
  $("compute-button").disabled = paused || player.finance.bankrupt;
  $("player-quote").innerHTML = player.finance.bankrupt
    ? "“那张最早的收据，<br />我还留着。”"
    : player.project.phase === "training"
      ? "“把这个模型跑通，<br />我们的窗口就来了。”"
      : "“灯还亮着，<br />你那边的电话<br />响了吗？”";
  $("lisa-quote").innerHTML =
    lisa.project.phase === "training"
      ? "“别只看发布会，<br />模型已经在跑了。”"
      : lisa.project.phase === "complete"
        ? "“第一单我收下了，<br />下一局，继续。”"
        : "“你在规划未来，<br />我已经开始交付。”";
  renderMilestones();
  renderFinance(player);
  renderProject(player);
  renderShop(stats);
  renderBusiness(stats);
  renderNarrative(player);
  renderStocks(stats);
  renderLeaderboard(stats);
  renderModel();
}

$("upgrade-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-buy]");
  if (!button) return;
  const result = buyRaceUpgrade(race, button.dataset.buy);
  if (result.ok) {
    toast(`${names[button.dataset.buy]} 已安装。留意新的运营成本。`, "reward");
    save();
    render();
  } else toast(result.reason, "error");
});
$("business-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-business-buy]");
  if (!button || paused) return;
  const id = button.dataset.businessBuy;
  const result = buyRaceBusinessUpgrade(race, id);
  if (!result.ok) return toast(result.reason, "error");
  const upgrade = BUSINESS_UPGRADES.find((item) => item.id === id);
  toast(`${upgrade.name} 研发完成 · 运营费用增加 ${cash(upgrade.recurringCost)}/s`, "reward");
  save();
  render();
});
$("narrative-current").addEventListener("click", (event) => {
  const button = event.target.closest("[data-narrative-option]");
  if (!button || paused) return;
  const result = chooseRaceNarrative(race, button.dataset.narrativeEvent, button.dataset.narrativeOption);
  if (!result.ok) return toast(result.reason, "error");
  save();
  render();
  $("narrative-title").focus({ preventScroll: true });
  toast("回信已寄出。", "reward");
});
$("narrative-ending").addEventListener("click", (event) => {
  if (!event.target.closest("[data-narrative-continue]")) return;
  $("arena-title").scrollIntoView({ behavior: "smooth", block: "center" });
  $("arena-title").focus({ preventScroll: true });
});
$("compute-button").addEventListener("click", () => {
  if (paused) return;
  handleEvents(manualRaceCompute(race));
  render();
});
document.addEventListener("keydown", (event) => {
  if (
    event.code === "Space" &&
    !event.repeat &&
    !paused &&
    !event.target.closest("button,input,a,select,textarea,dialog") &&
    !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    $("compute-button").click();
  }
});
$("project-button").addEventListener("click", () => {
  const result = startRaceProject(race);
  if (result.ok) {
    toast("GPT-3 计划启动。训练投入 70% 算力，现金流会发生变化。");
    save();
    render();
  } else toast(result.reason, "error");
});
$("ipo-button").addEventListener("click", () => {
  const result = executeIPO(rawCompany());
  if (result.ok) {
    addNews(
      "ipo",
      `黄Sir 完成 IPO，融资 ${cash(result.proceeds)}。发行 250 股，创始人持股降至 80%。`,
    );
    updateValuation(rawCompany(), race.elapsed);
    toast(`IPO 融资 ${cash(result.proceeds)} 已到账。`, "reward");
    save();
    render();
  } else toast(result.reason, "error");
});
$("buyback-shares").addEventListener("input", () =>
  renderFinance(getRaceStats(race).player),
);
$("buyback-button").addEventListener("click", () => {
  const shares = Number($("buyback-shares").value);
  const result = executeBuyback(rawCompany(), shares);
  if (result.ok) {
    addNews(
      "buyback",
      `黄Sir 回购 ${shares} 股，花费 ${cash(result.cost)}，现金与流通股同步减少。`,
    );
    updateValuation(rawCompany(), race.elapsed);
    toast(result.message);
    save();
    render();
  } else toast(result.reason, "error");
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-stock]");
  if (button) {
    selectedCompany = button.dataset.stock;
    renderStocks(getRaceStats(race));
  }
});
function showMarket() {
  $("stock-dialog").showModal();
  renderStocks(getRaceStats(race));
}
for (const id of ["rail-market", "market-open", "market-expand"])
  $(id).addEventListener("click", showMarket);
$("rules-button").addEventListener("click", () =>
  $("rules-dialog").showModal(),
);
$("pause-button").addEventListener("click", () => {
  paused = !paused;
  lastFrame = Date.now();
  save();
  render();
});
$("restart-button").addEventListener("click", () =>
  $("restart-dialog").showModal(),
);
$("restart-confirm").addEventListener("click", () => {
  race = createRace();
  paused = false;
  lastFrame = Date.now();
  lastChartSignature = "";
  lastNewsSignature = "";
  lastModelSignature = "";
  $("restart-dialog").close();
  save();
  render();
  toast("三家公司重新开张。同一起点，新一场选择。");
});
$("model-button").addEventListener("click", () => {
  $("model-dialog").showModal();
  renderModel();
});
$("model-workload").addEventListener("change", () => renderModel());
window.addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) save();
});
window.addEventListener("storage", (event) => {
  if (event.key !== SAVE_KEY || !event.newValue) return;
  try {
    const data = JSON.parse(event.newValue);
    const raw = JSON.parse(data.race);
    const restored = restoreRace(raw, data.paused ? raw.savedAt : Date.now());
    if (restored) {
      race = restored;
      paused = data.paused === true;
      lastFrame = Date.now();
      lastNewsSignature = "";
      lastChartSignature = "";
      render();
    }
  } catch {
    /* Ignore malformed updates from another tab. */
  }
});

buildShop();
buildBusinessShop();
render();
save();
if (!savedStorage) toast("浏览器未允许保存创业赛进度。", "error");
if (offlineSeconds >= 60 && offlineBefore.length) {
  const stats = getRaceStats(race);
  $("offline-copy").textContent =
    `离线 ${clock(offlineSeconds)}，所有公司按同一时钟接单、投资和研发，最多结算 8 小时。`;
  $("offline-summary").innerHTML = stats.companies
    .map(
      (company) =>
        `<div><span>${escapeHTML(company.name)}</span><strong>经营收入 +${cash(Math.max(0, company.totalEarned - (offlineBefore.find((before) => before.id === company.id)?.totalEarned || 0)))}</strong></div>`,
    )
    .join("");
  $("offline-dialog").showModal();
}
setInterval(() => {
  const now = Date.now();
  const delta = Math.max(0, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused) handleEvents(tickRace(race, delta));
  render();
  if (now - lastSave >= 5000) save();
}, 250);
