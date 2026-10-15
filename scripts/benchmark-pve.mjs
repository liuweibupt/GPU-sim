import assert from "node:assert/strict";
import {
  createRace,
  tickRace,
  getRaceStats,
  getRaceUpgradeCost,
  buyRaceUpgrade,
  manualRaceCompute,
  startRaceProject,
} from "../lib/pve-race.js";
import { getFinanceStats, executeIPO } from "../lib/pve-market.js";
import { MODEL_INFO, getWorkloadPerformance } from "../lib/compute-model.js";

const plan = [
  "alu",
  "l1",
  "alu",
  "dram",
  "clock",
  "alu",
  "scheduler",
  "l2",
  "alu",
  "clock",
  "alu",
  "tensor",
  "l1",
  "alu",
  "scheduler",
  "l2",
  "tensor",
  "alu",
  "hbm",
];
const round = (value) => Math.round(value * 100) / 100;
function benchmark(strategy) {
  const race = createRace(0);
  const player = race.companies[0];
  let index = 0;
  let expanded = false;
  for (let elapsed = 0; elapsed < 3600; elapsed++) {
    if (strategy === "active-balanced") {
      manualRaceCompute(race);
      if (!player.finance.listed && player.game.totalEarned >= 600)
        executeIPO(player);
      if (index < plan.length && buyRaceUpgrade(race, plan[index]).ok) index++;
      if (player.project.phase === "ready") startRaceProject(race);
    } else if (strategy === "compute-overexpansion") {
      if (!expanded) manualRaceCompute(race);
      if (!expanded && player.game.money >= 1000) {
        executeIPO(player);
        expanded = true;
      }
      if (expanded)
        for (let purchase = 0; purchase < 50; purchase++) {
          const ids = ["alu", "clock"].sort(
            (a, b) => getRaceUpgradeCost(race, a) - getRaceUpgradeCost(race, b),
          );
          if (!ids.some((id) => buyRaceUpgrade(race, id).ok)) break;
        }
    }
    tickRace(race, 1);
    if (
      strategy === "compute-overexpansion"
        ? player.finance.bankrupt
        : Boolean(race.winnerId)
    )
      break;
  }
  const stats = getRaceStats(race);
  return {
    strategy,
    elapsedSeconds: race.elapsed,
    winnerId: race.winnerId,
    playerBankrupt: player.finance.bankrupt,
    milestones: race.milestones,
    companies: stats.companies.map((company) => ({
      id: company.id,
      cash: round(company.money),
      operatingRevenue: round(company.totalEarned),
      ipoProceeds: round(
        race.companies.find((raw) => raw.id === company.id).finance.ipoProceeds,
      ),
      operatingCostPerSecond: round(company.finance.operatingCost),
      passiveNetFlowPerSecond: round(company.finance.netFlow),
      debt: round(company.finance.debt),
      creditLimit: round(company.finance.creditLimit),
      hardware: company.levels,
      project: company.project.phase,
    })),
  };
}

const scenarios = ["active-balanced", "idle", "compute-overexpansion"].map(
  benchmark,
);
assert.equal(
  scenarios[0].winnerId,
  "player",
  "Thoughtful active play must be able to win from zero.",
);
assert.ok(
  ["lisa", "grey"].includes(scenarios[1].winnerId),
  "Opponents must develop without player input.",
);
assert.equal(
  scenarios[2].playerBankrupt,
  true,
  "Unfunded overexpansion must carry a real failure risk.",
);
const bare = getWorkloadPerformance({}, "fp32");
console.log(
  JSON.stringify(
    {
      model: {
        id: MODEL_INFO.id,
        version: MODEL_INFO.version,
        calibration: "unmeasured teaching parameters",
        bareFp32: {
          operations: bare.features.operations,
          bytes: bare.features.bytes,
          cycles: bare.cycles,
          throughput: bare.throughput,
        },
      },
      policyNotes: [
        "All companies start with one ALU and no money.",
        "Active policy clicks once per simulated second, follows the published hardware plan, and uses one IPO.",
        "Passive demand is capped; manual participation is an additional active-play benefit.",
        "Overexpansion invests in ALU/clock only and stops manual participation after expanding.",
        "These deterministic scenarios demonstrate viability and failure, not every possible strategy.",
      ],
      activeHardwarePlan: plan,
      scenarios,
    },
    null,
    2,
  ),
);
