import {
  UPGRADES,
  CHAPTERS,
  createGame,
  getStats,
  getUpgradeCost,
  getUpgradePreview,
  canBuyUpgrade,
  buyUpgrade,
  tickGame,
  manualCompute,
  startChallenge,
  restoreGame,
  serializeGame,
  chooseGameNarrative,
  buyGameBusinessUpgrade,
} from "../../lib/idle-game.js?v=narrative-branches-1";

import {
  BUSINESS_UPGRADES,
  getBusinessStats,
  getBusinessUpgradeStatus,
} from "../../lib/business-game.js?v=narrative-branches-1";
import { getNarrativeView } from "../../lib/game-narrative.js?v=narrative-branches-1";

const SAVE_KEY = "huang-sir-workshop-v1";
const PREF_KEY = "huang-sir-workshop-preferences";
const $ = (id) => document.getElementById(id);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const format = (value, decimals = 0) =>
  Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
const cash = (value) => `$${format(value, value < 1000 ? 2 : 0)}`;
const compact = (value) =>
  value >= 1e9
    ? `${format(value / 1e9, 1)}B`
    : value >= 1e6
      ? `${format(value / 1e6, 1)}M`
      : value >= 1e4
        ? `${format(value / 1e3, 1)}K`
        : format(value, value < 100 ? 1 : 0);
const time = (seconds) =>
  [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    Math.floor(seconds) % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
const names = Object.fromEntries(
  UPGRADES.map((upgrade) => [upgrade.id, upgrade.name]),
);
const categories = {
  alu: "compute",
  clock: "compute",
  scheduler: "compute",
  tensor: "compute",
  l1: "memory",
  l2: "memory",
  dram: "memory",
  hbm: "memory",
  tmem: "memory",
  tma: "transfer",
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
const iconPaths = {
  alu: "M5 5h14v14H5zM9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3",
  clock: "M12 5v7l4 2M3 12a9 9 0 1 0 3-7M3 4v5h5",
  l1: "M4 5h16v5H4zM4 14h16v5H4zM7 7.5h1m-1 9h1",
  dram: "M3 6h18v12H3zM6 9h3v6H6zm9 0h3v6h-3zM6 18v3m4-3v3m4-3v3m4-3v3",
  l2: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6zM10 7h4m-7 3v4m10-4v4m-7 3h4",
  scheduler: "M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4",
  tensor: "M4 4h16v16H4zM9 4v16m6-16v16M4 9h16M4 15h16",
  hbm: "m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4",
  tma: "M3 7h14m-4-4 4 4-4 4M7 17h14m-4-4 4 4-4 4M3 17h1m16-10h1",
  tmem: "M4 4h16v16H4zM8 8h8v8H8zM12 4v4m0 8v4M4 12h4m8 0h4",
  pcie: "M3 8h18v8H3zM7 16v4m5-4v4m5-4v4M7 5v3m5-3v3m5-3v3",
  cuda: "m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18",
  libraries: "M4 4h5v16H4zm7 0h4v16h-4zm6 1 4-1 3 15-4 1z",
  nvlink: "M2 4h7v7H2zm13 9h7v7h-7zM9 7h9v6M6 11v6h9",
  ib_partner: "M3 5h7v5H3zm11 9h7v5h-7zM10 7h8v7M6 10v6h8",
  mellanox: "M3 20V9l9-6 9 6v11H3zM9 20v-7h6v7M7 9h1m8 0h1",
  rack: "M5 2h14v20H5zM5 8h14M5 15h14M8 5h1m-1 7h1m-1 7h1",
  developers: "M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-3a6 6 0 0 1 12 0v3M16 4a4 4 0 0 1 0 8m2 3a5 5 0 0 1 4 5v1",
};
const icon = (id) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[id] || iconPaths.alu}"/></svg>`;
const kindLabel = {
  fp32: "FP32 · 浮点计算",
  stream: "STREAM · 数据归约",
  conv: "CONV · 图像卷积",
  gemm: "GEMM · 矩阵乘法",
  async: "ASYNC · Tile 流水线",
  attention: "ATTN · 长序列注意力",
};
const chapterUnlocks = {
  scalar: ["第一份创业记录", "特殊订单奖金"],
  vector: ["向量计算委托", "多工位的第一步"],
  graphics: ["像素工作室的认可", "重复数据的生意"],
  physics: ["并行物理沙盒", "更大的应用订单"],
  alexnet: ["视觉计算里程碑", "深度学习委托"],
  transformer: ["注意力时代记录", "矩阵计算挑战"],
  hopper: ["训练流水线交付", "数据搬运挑战"],
  training: ["训练流水线交付", "数据搬运挑战"],
  blackwell: ["长序列时代记录", "大规模推理挑战"],
  attention: ["长序列时代记录", "大规模推理挑战"],
  factory: ["车库创业终章", "自由经营模式"],
};
let state;
let offline = { seconds: 0, earned: 0, completed: 0 };
let storageAvailable = true;
let migratedTileModel = false;
let preferences = { sound: false, reduceMotion: false };
try {
  const stored = localStorage.getItem(SAVE_KEY);
  if (stored) {
    ({ state, offline } = restoreGame(stored));
    try {
      migratedTileModel = JSON.parse(stored)?.performanceModel === "workshop";
    } catch {}
  }
} catch {
  storageAvailable = false;
}
try {
  const savedPreferences = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
  if (
    savedPreferences &&
    typeof savedPreferences === "object" &&
    !Array.isArray(savedPreferences)
  ) {
    preferences = {
      sound: savedPreferences.sound === true,
      reduceMotion: savedPreferences.reduceMotion === true,
    };
  }
} catch {
  /* Damaged preferences do not affect the game save. */
}
state ||= createGame();
let currentView = "workshop";
let currentFilter = "all";
let hardwareSignature = "";
let storySignature = "";
let chapterSignature = "";
let deliveryLog = [];
let audioContext;
let lastFrame = Date.now();
let lastSave = Date.now();
let lastDeliveryToast = 0;

function toast(message, type = "") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("toast-container").append(element);
  while ($("toast-container").childElementCount > 3)
    $("toast-container").firstElementChild.remove();
  setTimeout(() => element.remove(), type === "error" ? 5500 : 3800);
}

function playSound(type) {
  if (!preferences.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended")
      audioContext.resume().catch(() => {});
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(
      type === "win" ? 523.25 : 440,
      audioContext.currentTime,
    );
    oscillator.frequency.exponentialRampToValueAtTime(
      type === "win" ? 1046.5 : 660,
      audioContext.currentTime + 0.12,
    );
    gain.gain.setValueAtTime(0.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      audioContext.currentTime + 0.2,
    );
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.22);
  } catch {
    /* Audio is optional, gameplay continues when unavailable. */
  }
}

function save(showFeedback = false) {
  try {
    localStorage.setItem(SAVE_KEY, serializeGame(state));
    storageAvailable = true;
    $("save-status").innerHTML =
      '<span class="status-dot"></span>进度已保存在本机';
    if (showFeedback) toast("工坊进度已保存。放心，下班也有收入。");
  } catch {
    storageAvailable = false;
    $("save-status").textContent = "无法自动存档 · 请导出备份";
    if (showFeedback)
      toast("浏览器未允许保存，请在经营日志中导出存档。", "error");
  }
  lastSave = Date.now();
}

function processEvents(events) {
  for (const event of events) {
    if (event.type === "challenge-complete") {
      toast(event.message, "reward");
      playSound("win");
      chapterSignature = "";
      save();
    } else if (event.type === "job-complete") {
      deliveryLog.unshift({
        elapsed: state.elapsed,
        message: event.message,
        type: "delivery",
      });
      deliveryLog = deliveryLog.slice(0, 30);
      if (state.completed <= 3 && Date.now() - lastDeliveryToast > 2500) {
        toast(`第一桶金 +${cash(event.reward)} · 订单自动结算`, "reward");
        lastDeliveryToast = Date.now();
      }
    } else if (event.message) toast(event.message);
  }
}

function createShop() {
  $("upgrade-grid").innerHTML = UPGRADES.map(
    (upgrade) =>
      `<article class="upgrade-card" id="upgrade-${upgrade.id}" data-category="${categories[upgrade.id]}"><div class="upgrade-top"><div class="upgrade-icon">${icon(upgrade.id)}</div><span class="upgrade-level"></span></div><h3>${escapeHTML(upgrade.name)}<span>${technicalNames[upgrade.id]}</span></h3><p class="upgrade-description">${escapeHTML(upgrade.description)}</p><p class="upgrade-benefit"></p><button class="upgrade-buy" data-buy="${upgrade.id}" aria-label="购买${escapeHTML(upgrade.name)}"><span></span><strong></strong></button></article>`,
  ).join("");
}

function createBusinessShop() {
  $("business-grid").innerHTML = BUSINESS_UPGRADES.map((upgrade) =>
    `<article class="upgrade-card business-card" id="business-${upgrade.id}"><div class="upgrade-top"><div class="upgrade-icon">${icon(upgrade.id)}</div><span class="upgrade-level"></span></div><h3>${escapeHTML(upgrade.name)}<span>${escapeHTML(upgrade.subtitle)}</span></h3><p class="upgrade-description">${escapeHTML(upgrade.description)}</p><details class="business-budget"><summary>预算与验收条件</summary><p class="business-benefit">${escapeHTML(upgrade.benefit)}</p><p class="business-recurring">工坊研发一次付费，无持续运营费用。</p><p class="upgrade-benefit business-status"></p></details><button class="upgrade-buy" data-business-buy="${upgrade.id}" aria-label="研发${escapeHTML(upgrade.name)}"><span></span><strong></strong></button></article>`,
  ).join("");
}

function renderBusiness(stats) {
  const business = stats.business;
  $("business-investment").textContent = cash(business.investmentValue);
  $("business-premium").textContent = `×${format(business.revenueMultiplier, 2)}`;
  $("business-project").textContent = `×${format(business.projectMultiplier, 2)}`;
  $("business-racks").textContent = format(business.rackCount);
  $("business-ledger-summary").textContent = `${business.summary} · 工坊研发一次付费`;
  $("business-summary").textContent = business.rackCount
    ? "机房的风扇彻夜不停。交付组又把一张客户留言压在了工单下面。"
    : business.softwareLevel
      ? "群聊里开始有人替陌生人解答问题。那几页文档，正在离开这间车库。"
      : "焊台旁放着几份手写提案。工程师们还没回家，等你来聊聊。";
  let invitations = 0;
  for (const upgrade of BUSINESS_UPGRADES) {
    const status = getBusinessUpgradeStatus(state, upgrade.id);
    const card = $(`business-${upgrade.id}`);
    card.hidden = !status.level && status.missing.some((item) => !item.startsWith("资金 "));
    if (!card.hidden) invitations++;
    card.classList.toggle("locked", !status.ok && !status.maxed);
    card.classList.toggle("purchasable", status.ok);
    card.classList.toggle("installed", status.level > 0);
    card.querySelector(".upgrade-level").textContent = status.maxed
      ? "研发完成"
      : status.level ? `LV.${String(status.level).padStart(2, "0")}` : "待研发";
    card.querySelector(".business-status").textContent = status.maxed
      ? "已完成此项研发"
      : status.ok ? "预算已备齐，验收条件已满足。" : status.reason;
    const button = card.querySelector("button");
    button.disabled = !status.ok;
    button.title = status.reason || `研发预算 ${cash(status.cost)}`;
    button.querySelector("span").textContent = status.maxed
      ? "已完成 ✓"
      : status.ok ? status.level ? "追加研发 ↗" : "批准提案 +" : "预算待备齐";
    button.querySelector("strong").textContent = status.maxed ? "MAX" : cash(status.cost);
  }
  $("business-empty").hidden = invitations > 0;
}

let narrativeSignature = "";
function narrativeParagraphs(value) {
  return String(Array.isArray(value) ? value.join("\n") : value || "")
    .split(/\n+/).filter(Boolean).map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("");
}
function renderNarrative() {
  const view = getNarrativeView(state, { mode: "workshop" });
  const signature = JSON.stringify(view);
  if (signature === narrativeSignature) return;
  narrativeSignature = signature;
  $("narrative-state").textContent = view.pending ? "有一封信等你回" : view.ending ? "这一页已经写下" : "车库仍在营业";
  $("narrative-current").innerHTML = view.pending
    ? `<article class="narrative-letter"><div class="letter-sender"><span class="letter-mark" aria-hidden="true">✉</span><span>${escapeHTML(view.pending.speaker)}</span></div><h3 id="narrative-letter-title" tabindex="-1">${escapeHTML(view.pending.title)}</h3><div class="letter-body">${narrativeParagraphs(view.pending.body)}</div><div class="narrative-options" role="group" aria-labelledby="narrative-letter-title">${view.pending.options.map((option) => `<button type="button" class="narrative-choice" data-narrative-event="${escapeHTML(view.pending.id)}" data-narrative-option="${escapeHTML(option.id)}"><strong>${escapeHTML(option.label)}<span aria-hidden="true">↗</span></strong><span>${escapeHTML(option.detail)}</span></button>`).join("")}</div><p class="letter-footnote">信可以稍后回。工坊的订单照常流转。</p></article>`
    : '<p class="narrative-quiet">桌上暂时没有未回的信。窗外天色渐暗，车间里的键盘声还在继续。</p>';
  const recent = view.events.filter((event) => !event.id.startsWith("ending:")).slice(-4).reverse();
  const latest = recent[0];
  $("narrative-latest").hidden = !latest;
  $("narrative-latest").innerHTML = latest ? `<div class="narrative-event-meta"><span>${escapeHTML(latest.speaker)} · 最近的回音</span><time>${time(latest.elapsed || 0)}</time></div><strong>${escapeHTML(latest.title)}</strong><div>${narrativeParagraphs(latest.body)}</div>` : "";
  $("narrative-history").hidden = recent.length < 2;
  $("narrative-events").innerHTML = recent.slice(1).map((event) => `<li><div class="narrative-event-meta"><span>${escapeHTML(event.speaker)}</span><time>${time(event.elapsed || 0)}</time></div><strong>${escapeHTML(event.title)}</strong><div>${narrativeParagraphs(event.body)}</div></li>`).join("");
  $("narrative-ending").hidden = !view.ending;
  $("narrative-ending").innerHTML = view.ending
    ? `<span class="narrative-ending-label">多年后，人们这样记得这间工坊</span><h3 tabindex="-1">${escapeHTML(view.ending.title)}</h3>${narrativeParagraphs(view.ending.body)}<div class="narrative-epilogue">${narrativeParagraphs(view.ending.epilogue)}</div><button type="button" class="outline-button" data-narrative-continue>回到仍亮着灯的工坊 <span aria-hidden="true">→</span></button><small>这一页已存档，经营仍会继续。</small>`
    : "";
}

function renderShop() {
  for (const upgrade of UPGRADES) {
    const card = $(`upgrade-${upgrade.id}`);
    const level = state.levels[upgrade.id] || 0;
    const missing = upgrade.requires.filter((id) => !state.levels[id]);
    const research = state.totalEarned < (upgrade.unlockEarned || 0);
    const locked = Boolean(missing.length || research);
    const purchasable = canBuyUpgrade(state, upgrade.id);
    const maxed = level >= upgrade.maxLevel;
    const price = getUpgradeCost(state, upgrade.id);
    card.hidden =
      currentFilter !== "all" && categories[upgrade.id] !== currentFilter;
    card.classList.toggle("locked", locked);
    card.classList.toggle("purchasable", purchasable);
    card.querySelector(".upgrade-level").textContent = research
      ? "研发中"
      : missing.length
        ? "待前置组件"
        : level
          ? `LV.${String(level).padStart(2, "0")}`
          : "可研发";
    card.querySelector(".upgrade-benefit").textContent = research
      ? `经营累计 ${cash(upgrade.unlockEarned)} 后开放`
      : missing.length
        ? `前置：${missing.map((id) => names[id]).join(" + ")}`
        : maxed
          ? "已达最高等级"
          : `${upgrade.benefit} · 当前订单预计 ${((getUpgradePreview(state, upgrade.id)?.gain ?? 0) * 100).toFixed(1)}% 速度变化`;
    const button = card.querySelector("button");
    button.disabled = !purchasable;
    button.querySelector("span").textContent = maxed
      ? "已达最高等级"
      : locked
        ? "尚未开放"
        : level
          ? "升级组件 ↗"
          : "安装组件 +";
    button.querySelector("strong").textContent = maxed ? "MAX" : cash(price);
    button.title = maxed
      ? "组件已达最高等级"
      : research
        ? `累计收入还差 ${cash(upgrade.unlockEarned - state.totalEarned)}`
        : missing.length
          ? `先安装 ${missing.map((id) => names[id]).join("、")}`
          : !purchasable
            ? `再赚 ${cash(price - state.money)} 即可购买`
            : `花费 ${cash(price)}，${upgrade.benefit}`;
  }
}

function renderHardware(stats) {
  const signature = JSON.stringify(state.levels);
  if (hardwareSignature === signature) return;
  hardwareSignature = signature;
  const lv = (id) => state.levels[id] || 0;
  const installed = UPGRADES.filter((upgrade) => lv(upgrade.id) > 0).length;
  const generations = lv("tmem")
    ? ["张量工厂", "GEN 4"]
    : lv("tma")
      ? ["异步引擎", "GEN 3"]
      : lv("tensor")
        ? ["矩阵机器", "GEN 2"]
        : lv("dram")
          ? ["并行工坊", "GEN 1"]
          : ["车库原型", "GEN 0"];
  $("generation-tag").textContent = `${generations[0]} · ${generations[1]}`;
  $("chip-revision").textContent =
    `REV ${installed}.${Object.values(state.levels).reduce((a, b) => a + b, 0)} · ${stats.power} W`;
  const module = (id, label, x, y, width, height, sublabel) => {
    const active = lv(id) > 0;
    return `<g class="chip-module" data-module="${id}" tabindex="0" role="button" aria-label="${escapeHTML(names[id])}，${active ? `等级 ${lv(id)}` : "尚未安装"}"><title>${escapeHTML(names[id])} · ${active ? `Lv.${lv(id)}` : "未安装，点击查看研发"}</title><rect class="module-base" x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="${active ? "#23301b" : "#111a11"}" stroke="${active ? "#718b4b" : "#34432c"}" stroke-dasharray="${active ? "0" : "3 4"}"/><path d="M${x + 7} ${y + height - 6}h${width - 14}" stroke="${active ? "#4e6a34" : "#202d1d"}"/><text x="${x + width / 2}" y="${y + height / 2 - 2}" text-anchor="middle" fill="${active ? "#c5e5a0" : "#596b4e"}" font-size="12" font-family="Consolas,monospace">${label}</text><text x="${x + width / 2}" y="${y + height / 2 + 13}" text-anchor="middle" fill="${active ? "#809b65" : "#44553c"}" font-size="8" font-family="sans-serif">${active ? escapeHTML(sublabel || `LV.${lv(id)} · ONLINE`) : "＋ 待安装"}</text>${active ? `<circle cx="${x + width - 10}" cy="${y + 9}" r="2" fill="#c8f58b"/>` : ""}</g>`;
  };
  const pinLines =
    Array.from(
      { length: 12 },
      (_, i) => `<path d="M${318 + i * 14} 117v-8m0 142v-8"/>`,
    ).join("") +
    Array.from(
      { length: 7 },
      (_, i) => `<path d="M292 ${135 + i * 15}h-9m225 0h9"/>`,
    ).join("");
  const lanes = [
    { path: "M70 177H280", active: true },
    { path: "M280 180H200", active: lv("tensor") },
    { path: "M280 125H250V89", active: lv("l1") },
    { path: "M460 125V89H505", active: lv("l2") },
    { path: "M320 244V265H255V279", active: lv("dram") },
    { path: "M450 244V277", active: lv("hbm") },
    { path: "M510 156H609", active: lv("tma") },
    { path: "M510 207H570V233H609", active: lv("tmem") },
    { path: "M270 144H220V75H199", active: lv("scheduler") },
  ];
  const traces = lanes
    .map(
      ({ path, active }, i) =>
        `<path d="${path}" fill="none" stroke="${active ? "#70864c" : "#2d4028"}" stroke-width="${active ? 1.5 : 1}"/>${active ? `<circle r="2.5" fill="#c8f58b" class="packet" style="offset-path:path('${path}');animation-delay:-${i * 0.6}s"/>` : ""}`,
    )
    .join("");
  $("hardware-svg").innerHTML =
    `<defs><linearGradient id="chip-fill" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#344b24"/><stop offset="1" stop-color="#1c2b17"/></linearGradient><filter id="chip-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="14"/></filter><pattern id="core-grid" width="11" height="11" patternUnits="userSpaceOnUse"><path d="M11 0H0V11" fill="none" stroke="#a9d079" stroke-width=".5" opacity=".2"/></pattern></defs><rect x="22" y="15" width="756" height="316" rx="14" fill="#10190e22" stroke="#34472a"/><path d="M22 42V29q0-14 14-14h15M748 15h16q14 0 14 14v13M22 303v14q0 14 14 14h15m697 0h16q14 0 14-14v-14" fill="none" stroke="#5b7642" stroke-width="2"/>${[
      [38, 31],
      [762, 31],
      [38, 315],
      [762, 315],
    ]
      .map(
        ([x, y]) =>
          `<circle cx="${x}" cy="${y}" r="3.5" fill="#0c140a" stroke="#4b603b"/><path d="M${x - 2} ${y}h4" stroke="#4b603b"/>`,
      )
      .join(
        "",
      )}<g stroke="#253820" stroke-width=".7" fill="none"><path d="M42 120h73l20-20h130l20 20M40 251h130l30-25h72M545 50h65l25 25h120M548 293h65l20-20h123M42 128h71l20-20h110M550 303h64l22-22h119M550 43h70l25 25h110"/></g>${traces}<rect x="295" y="115" width="210" height="134" rx="16" fill="#a6e374" opacity=".12" filter="url(#chip-glow)" class="chip-core-glow"/><g stroke="#779751" stroke-width="4">${pinLines}</g><g class="chip-module" data-module="alu" tabindex="0" role="button" aria-label="浮点 ALU，当前 ${stats.aluCount} 颗"><rect class="module-base" x="293" y="118" width="214" height="128" rx="9" fill="#22301b" stroke="#6f914a"/><rect x="306" y="131" width="188" height="102" rx="4" fill="url(#chip-fill)" stroke="#536e38"/><rect x="312" y="137" width="176" height="90" fill="url(#core-grid)"/><text x="400" y="159" text-anchor="middle" font-family="Consolas,monospace" font-size="8" letter-spacing="2" fill="#8faa70">COMPUTE ENGINE</text><text x="400" y="192" text-anchor="middle" font-family="Consolas,monospace" font-size="27" letter-spacing="1" fill="#d1f6a9">${stats.aluCount} × ALU</text><text x="400" y="214" text-anchor="middle" font-family="Consolas,monospace" font-size="9" fill="#92b372">FP32 · ${lv("clock") ? `${format(1 + lv("clock") * 0.35, 2)}× CLOCK` : "1.00× CLOCK"}</text><circle cx="484" cy="141" r="2.5" fill="#c8f58b"/></g>${module("scheduler", "SCHEDULER", 67, 52, 130, 47)}${module("tensor", "TENSOR CORE", 67, 147, 130, 65)}${module("l1", "L1 CACHE", 216, 40, 147, 49, `${lv("l1") * 32} KB · LOCAL`)}${module("l2", "L2 CACHE", 425, 40, 147, 49, `${lv("l2") * 256} KB · SHARED`)}${module("dram", "DRAM", 187, 279, 147, 40, `${lv("dram") * 256} MB`)}${module("hbm", "HBM", 365, 279, 147, 40, `${lv("hbm") * 8} GB`)}${module("tma", "TMA", 610, 123, 126, 56)}${module("tmem", "TMEM", 610, 205, 126, 56)}<text x="593" y="303" fill="#4d6440" font-family="Consolas,monospace" font-size="8" letter-spacing="1.5">BUILT ONE UPGRADE AT A TIME</text>`;
  if (window.innerWidth <= 720) {
    const canvas = $("hardware-svg").parentElement;
    requestAnimationFrame(() => {
      canvas.scrollLeft = (canvas.scrollWidth - canvas.clientWidth) / 2;
    });
  }
}

function nextChapter() {
  return CHAPTERS.find((chapter) => !state.won.includes(chapter.id));
}
function requirementText(id, minimum) {
  return id === "alu"
    ? `${minimum + 1} ALU`
    : minimum > 1
      ? `${names[id]} LV.${minimum}`
      : names[id];
}

function renderMentor(stats) {
  const lv = state.levels;
  let quote =
    "钥匙只有两把。<br />一把在你手里，<br />一把今晚留在车库。";
  let target = state.activeJob ? `${state.activeJob.client}的订单正在处理` : "门口的营业灯还亮着";
  let progress = state.activeJob ? Math.min(1, state.activeJob.progress / state.activeJob.work) : 0;
  let chapter = "序章 / 车库创业";
  if (lv.l1) {
    quote = "常用的数据放手边，<br />省下来的每一次等待，<br />都是利润。";
    chapter = "研发 / 存储起步";
  }
  if (lv.dram) {
    quote = "刚接到客户的电话。<br />他问，明天还能不能<br />找到今天接电话的人。";
    chapter = "经营 / 并行工坊";
  }
  if (stats.aluCount >= 8 && lv.l2) {
    quote =
      "有人送来一堆猫的照片。<br />这次不只算小数，<br />我们要让机器看懂世界。";
    chapter = "委托 / 视觉时代";
  }
  if (lv.tensor) {
    quote = "矩阵乘法来了，<br />咱们给它安排一个<br />真正的专业工位。";
    chapter = "研发 / 张量时代";
  }
  if (lv.tma) {
    quote =
      "计算的同时，<br />下一批数据已经在路上。<br />等箱子的日子，过去了。";
    chapter = "研发 / 异步时代";
  }
  if (lv.tmem) {
    quote = "当年那颗 ALU，<br />大概也没想到，<br />今天会这么热闹。";
    chapter = "经营 / AI 工厂";
  }
  if (state.won.length === CHAPTERS.length) {
    quote = "最早那张收据，<br />我还留着。<br />上面的字都快褪色了。";
    chapter = "经营 / 灯火未熄";
  }
  $("mentor-quote").innerHTML = quote;
  $("mission-text").textContent = target;
  $("mission-progress").style.width = `${progress * 100}%`;
  $("mission-count").textContent = `${Math.round(progress * 100)}%`;
  $("mentor-chapter").textContent = chapter;
  const perf = stats.performance;
  const labels = {
    compute: "计算吞吐",
    bandwidth: "供数带宽",
    latency: "访存延迟",
  };
  $("bottleneck").textContent =
    `${stats.workloadName}：${labels[perf.bottleneck]}受限（解析估算）。`;
  $("resource-evidence").textContent =
    `计算 ${perf.computeCycles.toFixed(1)} · 搬运 ${perf.memoryCycles.toFixed(1)} · 延迟 ${perf.latencyCycles.toFixed(1)} · 重叠抵扣 ${perf.overlapCycles.toFixed(1)} · 总计 ${perf.cycles.toFixed(1)} 逻辑周期。`;
}

function renderOrders() {
  const premium = getBusinessStats(state).revenueMultiplier;
  const jobs = [state.activeJob, ...state.queue].filter(Boolean).slice(0, 4);
  $("queue-count").textContent = `${state.queue.length} 笔排队`;
  const activeJob = state.activeJob;
  $("live-order-client").textContent = activeJob
    ? `${activeJob.client} · ${activeJob.name}`
    : "等待下一位客户";
  $("live-order-expression").textContent = activeJob
    ? activeJob.expression
    : "订单将自动接入";
  $("live-order-percent").textContent = activeJob
    ? `${Math.floor((activeJob.progress / activeJob.work) * 100)}%`
    : "—";
  $("live-order-progress").style.width =
    `${activeJob ? Math.min(100, (activeJob.progress / activeJob.work) * 100) : 0}%`;
  $("live-order-queue").textContent = `${state.queue.length} 单等候`;
  $("orders-list").innerHTML = jobs.length
    ? jobs
        .map((job, index) => {
          const active = job === state.activeJob;
          const percent = Math.min(100, (job.progress / job.work) * 100);
          return `<div class="order-row"><div class="order-client"><span class="client-icon">${["π", "∑", "⌘", "λ"][job.id % 4]}</span><div class="client-details"><strong>${escapeHTML(job.client)}</strong><small>#${String(job.id).padStart(5, "0")} · ${escapeHTML(kindLabel[job.kind] || job.name)}</small></div></div><span class="order-expression">${escapeHTML(job.expression)}</span>${active ? `<div class="order-progress"><div class="progress-track"><span style="width:${percent}%"></span></div><span>${Math.floor(percent)}%</span></div>` : `<div class="order-progress waiting">排队中 · 第 ${index} 位</div>`}<span class="order-reward">${cash(Math.round(job.reward * premium * 100) / 100)}</span></div>`;
        })
        .join("")
    : '<div class="journal-empty">已清空订单队列，下一位客户正在路上…</div>';
}

function renderChapters() {
  const next = nextChapter();
  const active =
    state.challenge &&
    CHAPTERS.find((chapter) => chapter.id === state.challenge.id);
  $("history-won").textContent = String(state.won.length).padStart(2, "0");
  $("history-total").textContent = String(CHAPTERS.length).padStart(2, "0");
  $("history-indicator").hidden =
    !next ||
    Boolean(next.previous && !state.won.includes(next.previous)) ||
    !Object.entries(next.requires).every(
      ([id, minimum]) => state.levels[id] >= minimum,
    );
  $("next-chapter-title").textContent = active
    ? `正在交付 · ${active.title}`
    : next
      ? `${next.year} · ${next.title}`
      : "所有应用委托已交付";
  $("next-chapter-copy").textContent = active
    ? `70% 算力服务应用任务，日常订单照常经营。进度 ${Math.floor((state.challenge.progress / state.challenge.work) * 100)}%`
    : next
      ? next.subtitle
      : "车库的故事还在继续，新的订单永远在路上。";
  $("chapter-requirements").textContent = next
    ? Object.entries(next.requires)
        .map(([id, minimum]) => requirementText(id, minimum))
        .join(" + ") || "一颗 ALU 就能开始"
    : "自由经营 · 无限可能";
  $("chapter-button").innerHTML = active
    ? "查看进度 <span>↗</span>"
    : "查看委托 <span>↗</span>";
  const signature = JSON.stringify([
    state.won,
    state.levels,
    state.challenge?.id,
  ]);
  if (chapterSignature !== signature) {
    chapterSignature = signature;
    $("chapter-list").innerHTML = CHAPTERS.map((chapter, index) => {
      const won = state.won.includes(chapter.id);
      const available =
        !won &&
        (!chapter.previous || state.won.includes(chapter.previous)) &&
        Object.entries(chapter.requires).every(
          ([id, min]) => state.levels[id] >= min,
        );
      const running = state.challenge?.id === chapter.id;
      return `<article class="history-card ${won ? "won" : available ? "available" : ""}" id="chapter-${chapter.id}"><div class="history-year">${escapeHTML(chapter.year.split(" · ")[0])}${chapter.year.includes("架空") ? '<small class="fiction-label">架空</small>' : ""}<p class="history-index">CONTRACT ${String(index + 1).padStart(2, "0")}</p></div><div class="history-body"><span class="history-subtitle">${escapeHTML(chapter.subtitle)}</span><h3>${escapeHTML(chapter.title)}</h3><p>${escapeHTML(chapter.description)}</p><div class="history-unlocks">${(chapterUnlocks[chapter.id] || ["特殊应用委托", "交付奖金"]).map((label) => `<span>${escapeHTML(label)}</span>`).join("")}</div></div><div class="history-action"><div class="requirements">${
        Object.entries(chapter.requires)
          .map(
            ([id, min]) =>
              `<span class="requirement ${state.levels[id] >= min ? "met" : ""}">${escapeHTML(requirementText(id, min))} ${state.levels[id] >= min ? "✓" : ""}</span>`,
          )
          .join("") || '<span class="requirement met">初始 ALU ✓</span>'
      }</div><div class="history-reward">交付奖金 ${cash(chapter.reward)}</div>${running ? '<div class="challenge-progress-label"><span>应用任务进行中</span><span class="challenge-percent"></span></div><div class="challenge-bar"><span></span></div>' : `<button class="primary-button" data-challenge="${chapter.id}" ${!available || state.challenge ? "disabled" : ""}>${won ? "✓ 已交付，史官已记录" : available && !state.challenge ? "接下这份委托 →" : chapter.previous && !state.won.includes(chapter.previous) ? "先完成上一份应用委托" : state.challenge ? "等待当前任务交付" : "准备好硬件再来"}</button>`}<p class="history-lock-reason">${won ? "研发与日常经营持续进行。" : "接单不消耗资金 · 挑战期间仍有日常收入"}</p></div></article>`;
    }).join("");
  }
  if (active) {
    const card = $(`chapter-${active.id}`);
    const percent = Math.min(
      100,
      (state.challenge.progress / state.challenge.work) * 100,
    );
    card.querySelector(".challenge-percent").textContent =
      `${format(percent, 1)}%`;
    card.querySelector(".challenge-bar>span").style.width = `${percent}%`;
  }
}

function renderJournal() {
  if (currentView !== "journal") return;
  const entries = [...state.story, ...deliveryLog]
    .sort((a, b) => b.elapsed - a.elapsed)
    .slice(0, 60);
  const signature = JSON.stringify(entries);
  if (storySignature === signature) return;
  storySignature = signature;
  $("journal-list").innerHTML = entries.length
    ? entries
        .map(
          (item) =>
            `<div class="journal-entry"><span class="journal-time">${time(item.elapsed)}</span><span class="journal-symbol">${item.type === "challenge-complete" ? "✦" : item.type === "upgrade" ? "⊞" : item.type === "delivery" ? "↗" : "◇"}</span><span class="journal-message">${escapeHTML(item.message)}</span></div>`,
        )
        .join("")
    : '<p class="journal-empty">第一段工坊故事，等你来写。</p>';
}

function render() {
  const stats = getStats(state);
  $("money").textContent = format(state.money, state.money < 10000 ? 2 : 0);
  $("income").textContent = `+${cash(stats.incomeRate)} / s 预计`;
  $("throughput").textContent = compact(
    stats.throughput * (stats.boosted ? 1.55 : 1),
  );
  $("completed").textContent = format(state.completed);
  $("total-earned").textContent = cash(state.totalEarned);
  $("hit-rate").textContent = Math.round(stats.hitRate * 100);
  $("hardware-summary").textContent =
    `${stats.aluCount} ALU${state.levels.tensor ? ` · ${state.levels.tensor} TENSOR` : " · FP32"}`;
  $("boost-tag").hidden = !stats.boosted;
  $("cache-summary").textContent = stats.cacheLabel;
  $("cache-tip").textContent = stats.hitRate
    ? "常用数据，近在手边"
    : "每份数据，现用现取";
  $("play-time").textContent = time(state.elapsed);
  $("job-stream").textContent =
    `${stats.unlockedKinds.length} 种工作负载 · 持续接单 ↗`;
  const nextResearch = UPGRADES.filter(
    (upgrade) => (upgrade.unlockEarned || 0) > state.totalEarned,
  ).sort((a, b) => a.unlockEarned - b.unlockEarned)[0];
  $("research-next").textContent = nextResearch
    ? `累计 ${cash(state.totalEarned)} / ${cash(nextResearch.unlockEarned)} · 下一项 ${nextResearch.name}`
    : "研发里程碑全部达成 · 补齐前置即可安装";
  $("research-progress").style.width =
    `${nextResearch ? Math.min(100, (state.totalEarned / nextResearch.unlockEarned) * 100) : 100}%`;
  renderShop();
  renderBusiness(stats);
  renderHardware(stats);
  renderMentor(stats);
  renderNarrative();
  const service = stats.performance;
  $("service-model-summary").textContent =
    `${service.kind.toUpperCase()} · 工作集 ${format(service.features.workingSetBytes / 1024, 1)} KiB · ${format(service.cycles, 1)} 逻辑周期 · 估算缓存命中 ${format(service.hitRate * 100, 1)}%`;

  renderOrders();
  renderChapters();
  renderJournal();
}

function setView(view) {
  currentView = view;
  for (const name of ["workshop", "history", "journal"])
    $(`${name}-view`).hidden = name !== view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("page-title").innerHTML =
    `${view === "history" ? "应用任务" : view === "journal" ? "经营日志" : "算力工坊"}<span class="heading-dot">.</span>`;
  $("page-subtitle").textContent =
    view === "history"
      ? "客户带来新需求，有的写在合同里，有的藏在交付后的电话里。"
      : view === "journal"
        ? "从第一笔收入，到第一座 AI 工厂，记住每个小小的进步。"
        : "一颗 ALU，一个车库。下一个计算时代，由你建造。";
  renderJournal();
}

function compute() {
  processEvents(manualCompute(state));
  $("compute-button").classList.remove("compute-pulse");
  void $("compute-button").offsetWidth;
  $("compute-button").classList.add("compute-pulse");
  render();
}

function applyPreferences() {
  document.documentElement.classList.toggle(
    "reduce-motion",
    Boolean(preferences.reduceMotion),
  );
  $("reduce-motion").checked = Boolean(preferences.reduceMotion);
  $("sound-button").setAttribute(
    "aria-pressed",
    String(Boolean(preferences.sound)),
  );
  $("sound-button").setAttribute(
    "aria-label",
    preferences.sound ? "关闭音效" : "开启音效",
  );
  $("sound-button").title = preferences.sound ? "关闭音效" : "开启音效";
  $("sound-button").innerHTML =
    `<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z${preferences.sound ? "M17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" : "M17 9l5 6m0-6-5 6"}"/></svg>`;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
  } catch {
    /* optional preferences */
  }
}

document
  .querySelectorAll("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => setView(button.dataset.view)),
  );
document.querySelectorAll("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    currentFilter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => {
      item.classList.toggle("active", item === button);
      item.setAttribute("aria-pressed", String(item === button));
    });
    renderShop();
  }),
);
$("upgrade-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-buy]");
  if (!button) return;
  const id = button.dataset.buy;
  if (buyUpgrade(state, id)) {
    toast(
      `${names[id]} 已安装 · ${UPGRADES.find((upgrade) => upgrade.id === id).benefit}`,
      "reward",
    );
    playSound("upgrade");
    save();
    render();
  }
});
$("business-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-business-buy]");
  if (!button) return;
  const id = button.dataset.businessBuy;
  const result = buyGameBusinessUpgrade(state, id);
  if (!result.ok) return toast(result.reason, "error");
  const upgrade = BUSINESS_UPGRADES.find((item) => item.id === id);
  toast(`${upgrade.name}：提案已落地。`, "reward");
  playSound("upgrade");
  save();
  render();
});
$("narrative-current").addEventListener("click", (event) => {
  const button = event.target.closest("[data-narrative-option]");
  if (!button) return;
  const result = chooseGameNarrative(state, button.dataset.narrativeEvent, button.dataset.narrativeOption);
  if (!result.ok) return toast(result.reason, "error");
  save();
  render();
  $("narrative-title").focus({ preventScroll: true });
  toast("回信已寄出。", "reward");
});
$("narrative-ending").addEventListener("click", (event) => {
  if (!event.target.closest("[data-narrative-continue]")) return;
  $("compute-button").scrollIntoView({ behavior: preferences.reduceMotion ? "instant" : "smooth", block: "center" });
  $("compute-button").focus({ preventScroll: true });
});
function focusModule(event) {
  const module = event.target.closest("[data-module]");
  if (!module) return;
  currentFilter = "all";
  document.querySelector('[data-filter="all"]').click();
  const card = $(`upgrade-${module.dataset.module}`);
  card.classList.add("focused");
  card.scrollIntoView({
    behavior: preferences.reduceMotion ? "instant" : "smooth",
    block: "center",
  });
  setTimeout(() => card.classList.remove("focused"), 2500);
}
$("hardware-svg").addEventListener("click", focusModule);
$("hardware-svg").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    focusModule(event);
  }
});
$("compute-button").addEventListener("click", compute);
document.addEventListener("keydown", (event) => {
  if (
    event.code !== "Space" ||
    event.repeat ||
    currentView !== "workshop" ||
    event.target.closest(
      'button,input,a,select,textarea,dialog,[role="button"]',
    ) ||
    document.querySelector("dialog[open]")
  )
    return;
  event.preventDefault();
  compute();
});
$("chapter-button").addEventListener("click", () => {
  setView("history");
  const chapter = state.challenge
    ? CHAPTERS.find((item) => item.id === state.challenge.id)
    : nextChapter();
  if (chapter)
    $(`chapter-${chapter.id}`).scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
});
$("chapter-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-challenge]");
  if (!button) return;
  const result = startChallenge(state, button.dataset.challenge);
  if (!result.ok) toast(result.reason, "error");
  else {
    toast("委托已接下：70% 算力投入应用，日常订单继续营业。");
    save();
    render();
  }
});
$("settings-button").addEventListener("click", () =>
  $("settings-dialog").showModal(),
);
$("save-button").addEventListener("click", () => save(true));
$("reduce-motion").addEventListener("change", (event) => {
  preferences.reduceMotion = event.target.checked;
  applyPreferences();
});
$("sound-button").addEventListener("click", () => {
  preferences.sound = !preferences.sound;
  applyPreferences();
  playSound("upgrade");
});
$("reset-confirm").addEventListener(
  "input",
  (event) => ($("reset-button").disabled = event.target.value !== "重新开始"),
);
$("reset-button").addEventListener("click", () => {
  if ($("reset-confirm").value !== "重新开始") return;
  state = createGame();
  deliveryLog = [];
  hardwareSignature = "";
  chapterSignature = "";
  storySignature = "";
  lastFrame = Date.now();
  save();
  render();
  $("settings-dialog").close();
  $("reset-confirm").value = "";
  $("reset-button").disabled = true;
  setView("workshop");
  toast("车库重新开门。这一次，梦想还在。");
});
$("export-button").addEventListener("click", () => {
  const blob = new Blob([serializeGame(state)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `huang-sir-workshop-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("存档已导出，换浏览器时可以导入。");
});
$("import-button").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("存档文件过大");
    const raw = JSON.parse(await file.text());
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      raw.version !== 1 ||
      !raw.levels ||
      typeof raw.levels !== "object" ||
      Array.isArray(raw.levels) ||
      typeof raw.money !== "number" ||
      !Number.isFinite(raw.money) ||
      raw.money < 0
    )
      throw new Error("无法识别工坊存档");
    ({ state } = restoreGame(raw));
    deliveryLog = [];
    hardwareSignature = "";
    chapterSignature = "";
    storySignature = "";
    lastFrame = Date.now();
    save();
    render();
    $("settings-dialog").close();
    toast(
      raw.performanceModel === "workshop"
        ? "存档已导入，已保留进度并迁移到解析模型。"
        : "存档已导入。欢迎回到你的工坊。",
    );
  } catch (error) {
    toast(`导入失败：${error.message}，当前进度已保留。`, "error");
  }
  event.target.value = "";
});
window.addEventListener("pagehide", () => save());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) save();
});
window.addEventListener("storage", (event) => {
  if (event.key === SAVE_KEY && event.newValue) {
    ({ state } = restoreGame(event.newValue));
    deliveryLog = [];
    storySignature = "";
    hardwareSignature = "";
    chapterSignature = "";
    lastFrame = Date.now();
    render();
  }
});

createShop();
createBusinessShop();
applyPreferences();
render();
if (migratedTileModel) toast("Tile 模式已移除，已保留进度并迁移到解析模型。");
if (!storageAvailable) {
  $("save-status").textContent = "无法自动存档 · 可导出备份";
  toast("本机存档暂不可用，你仍可游玩并导出进度。", "error");
}
if (offline.seconds >= 60 && offline.earned > 0) {
  $("offline-copy").textContent =
    `离开 ${time(offline.seconds)}，工坊自动交付 ${format(offline.completed)} 笔订单。离线结算最多计入 8 小时。`;
  $("offline-reward").textContent = `+${cash(offline.earned)}`;
  $("welcome-dialog").showModal();
}
save();
setInterval(() => {
  const now = Date.now();
  const delta = Math.max(0, (now - lastFrame) / 1000);
  lastFrame = now;
  processEvents(tickGame(state, delta));
  render();
  if (now - lastSave >= 5000) save();
}, 250);
