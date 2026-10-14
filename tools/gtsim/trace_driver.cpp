#include "simulator.h"
#include <chrono>
#include <fstream>
#include <iomanip>
#include <map>
#include <memory>
#include <random>
#include <set>
#include <stdexcept>
#include <string>

using namespace GTSim;
DAG* build_gemm_h100(int M, int N, int K);

namespace {
constexpr const char* revision = "45a996c1585e60e98194057d94f7e664d41150ba";
std::string invocation_id() {
    const auto timestamp = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    return "gtsim-" + std::to_string(timestamp) + "-" + std::to_string(std::random_device{}());
}
std::string quoted(const std::string& value) {
    std::string result = "\"";
    const char* digits = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '\\' || c == '"') { result += '\\'; result += c; }
        else if (c < 0x20) {
            result += "\\u00"; result += digits[c >> 4]; result += digits[c & 15];
        } else result += c;
    }
    return result + '"';
}
std::string event_id(int id) { return "node-" + std::to_string(id); }
std::string sm_id(int id) { return "sm-" + std::to_string(id); }
std::string component_id(const DAGNode* node) {
    return sm_id(node->sm_id) + "." + node->pipeline_type;
}
void ids(std::ostream& out, const std::vector<int>& values) {
    out << '[';
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i) out << ',';
        out << quoted(event_id(values[i]));
    }
    out << ']';
}
void optional_cycle(std::ostream& out, int cycle) {
    if (cycle < 0) out << "null";
    else out << cycle;
}
int positive(const std::string& text) {
    std::size_t consumed = 0;
    int result = std::stoi(text, &consumed);
    if (consumed != text.size() || result <= 0) throw std::runtime_error("Expected a positive integer: " + text);
    return result;
}
void export_trace(const std::string& path, const Simulator& simulator,
                  int M, int N, int K, int max_cycles, bool success,
                  const std::string& run_id, double wall_time_seconds) {
    std::ofstream out(path);
    if (!out) throw std::runtime_error("Cannot write trace: " + path);
    const auto& cfg = simulator.config;
    // The experiment key is reproducible; the invocation ID is deliberately
    // separate because repeated runs have independent clocks and wall times.
    const std::string experiment_id = std::string("gtsim-") + revision + "-gemm-"
        + std::to_string(M) + "x" + std::to_string(N) + "x" + std::to_string(K)
        + "-l2-" + std::to_string(cfg.l2_bandwidth_bytes_per_cycle)
        + "-sram-" + std::to_string(cfg.sram_bandwidth_bytes_per_cycle)
        + "-limit-" + std::to_string(max_cycles);
    std::size_t unissued = 0, incomplete = 0, emitted = 0;
    for (const auto* node : simulator.dag->nodes) {
        if (node->start < 0) ++unissued;
        else if (!node->finished || node->end < 0) ++incomplete;
        else ++emitted;
    }
    out << "{\n\"schemaVersion\":1,\n\"meta\":{\"title\":\"GTSim H100 GEMM "
        << M << 'x' << N << 'x' << K
        << "\",\"producer\":\"GTSim v0.1.0 + GPU-sim read-only observer\","
        << "\"producerRevision\":" << quoted(revision)
        << ",\"backend\":\"GTSim\",\"backendVersion\":\"0.1.0\","
        << "\"capabilities\":[\"tile_tasks\"],\"granularity\":\"tile\","
        << "\"experimentId\":" << quoted(experiment_id)
        << ",\"runId\":" << quoted(run_id)
        << ",\"timeDomain\":" << quoted("gtsim:" + run_id + ":cycle")
        << ",\"evidenceKind\":\"simulation\",\"timeUnit\":\"cycle\","
        << "\"description\":\"Official hand-written H100 GEMM timing graph. Intervals use native DAGNode first-issue start and completion end. No numerical GEMM execution, measured silicon transactions, or reconstructed internal memory stages. Components are active SM and native pipeline groups; idle SMs are omitted.\","
        << "\"config\":{\"M\":" << M << ",\"N\":" << N << ",\"K\":" << K
        << ",\"tileM\":128,\"tileN\":256,\"tileK\":64,\"numSms\":" << cfg.num_sms
        << ",\"l2BandwidthBytesPerCycle\":" << cfg.l2_bandwidth_bytes_per_cycle
        << ",\"l2WriteBandwidthBytesPerCycle\":" << cfg.l2_write_bandwidth_bytes_per_cycle
        << ",\"sramBandwidthBytesPerCycle\":" << cfg.sram_bandwidth_bytes_per_cycle
        << ",\"dramBandwidthGBps\":" << cfg.dram_bandwidth_gbps
        << ",\"schedulePolicy\":\"upstream GTO\",\"modelProfile\":\"make_h100_sxm_config\"},"
        << "\"command\":\"gtsim_trace --m " << M << " --n " << N << " --k " << K
        << " --l2-bandwidth " << cfg.l2_bandwidth_bytes_per_cycle
        << " --sram-bandwidth " << cfg.sram_bandwidth_bytes_per_cycle
        << " --max-cycles " << max_cycles << " --output <trace.json>\"},\n";
    std::map<int, std::set<std::string>> groups;
    for (const auto* node : simulator.dag->nodes) groups[node->sm_id].insert(node->pipeline_type);
    out << "\"components\":[{\"id\":\"gpu\",\"label\":\"H100 timing model\",\"kind\":\"gpu\"}";
    for (const auto& [sm, pipelines] : groups) {
        out << ",{\"id\":" << quoted(sm_id(sm)) << ",\"label\":" << quoted("SM " + std::to_string(sm))
            << ",\"kind\":\"sm\",\"parentId\":\"gpu\"}";
        for (const auto& pipeline : pipelines) {
            out << ",{\"id\":" << quoted(sm_id(sm) + "." + pipeline)
                << ",\"label\":" << quoted("SM " + std::to_string(sm) + " / " + pipeline)
                << ",\"kind\":\"pipeline-group\",\"parentId\":" << quoted(sm_id(sm)) << '}';
        }
    }
    out << "],\n\"events\":[\n";
    bool first = true;
    for (const auto* node : simulator.dag->nodes) {
        // Incomplete and unissued nodes have no complete interval. Preserve
        // their native timestamps separately rather than inventing endpoints.
        if (node->start < 0 || !node->finished || node->end < 0) continue;
        if (!first) out << ",\n";
        first = false;
        out << "{\"id\":" << quoted(event_id(node->id)) << ",\"name\":" << quoted(node->name)
            << ",\"category\":" << quoted(node->pipeline_type)
            << ",\"componentId\":" << quoted(component_id(node))
            << ",\"start\":" << node->start << ",\"end\":" << node->end << ",\"dependencies\":";
        ids(out, node->depends_on);
        out << ",\"args\":{\"granularity\":\"tile\",\"nodeId\":" << node->id << ",\"op\":" << quoted(node->op)
            << ",\"warpId\":" << node->warp_id << ",\"threadBlockId\":" << node->thread_block_id
            << ",\"smId\":" << node->sm_id << ",\"issueCycle\":" << node->issue_cycle
            << ",\"tmaIssueCompleteCycle\":";
        optional_cycle(out, node->tma_issue_complete_cycle);
        out << ",\"issueDependencies\":";
        ids(out, node->issue_depends_on);
        out << ",\"tile\":{\"rowOffset\":" << node->tile.r_off
            << ",\"colOffset\":" << node->tile.c_off << ",\"rows\":" << node->tile.r
            << ",\"cols\":" << node->tile.c << "}}}";
    }
    out << "\n],\n\"metrics\":{\"totalCycles\":" << simulator.cycle
        << ",\"wallTimeSeconds\":" << std::setprecision(17) << wall_time_seconds
        << ",\"timingScope\":\"Simulator::run only; excludes download, build, graph construction, and trace export\""
        << ",\"totalNodeCount\":" << simulator.dag->nodes.size()
        << ",\"completedNodeCount\":" << simulator.completed_node_count
        << ",\"emittedEventCount\":" << emitted
        << ",\"unissuedNodeCount\":" << unissued
        << ",\"startedIncompleteNodeCount\":" << incomplete
        << ",\"simulationCompleted\":" << (success ? "true" : "false")
        << ",\"omittedNodes\":[";
    first = true;
    for (const auto* node : simulator.dag->nodes) {
        if (node->start >= 0 && node->finished && node->end >= 0) continue;
        if (!first) out << ',';
        first = false;
        out << "{\"id\":" << quoted(event_id(node->id)) << ",\"status\":"
            << quoted(node->start < 0 ? "unissued" : "started-incomplete") << ",\"start\":";
        optional_cycle(out, node->start);
        out << ",\"end\":"; optional_cycle(out, node->end);
        out << ",\"dependencies\":"; ids(out, node->depends_on);
        out << ",\"issueDependencies\":"; ids(out, node->issue_depends_on);
        out << '}';
    }
    out << "]}}\n";
    out.flush();
    if (!out) throw std::runtime_error("Failed while writing trace: " + path);
}
} // namespace

int main(int argc, char* argv[]) {
    try {
        int M = 256, N = 256, K = 128, max_cycles = 1000000;
        std::string output = "trace.json";
        SimulatorConfig config = make_h100_sxm_config();
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (i + 1 >= argc) throw std::runtime_error("Missing value for " + arg);
            const std::string value = argv[++i];
            if (arg == "--m") M = positive(value);
            else if (arg == "--n") N = positive(value);
            else if (arg == "--k") K = positive(value);
            else if (arg == "--max-cycles") max_cycles = positive(value);
            else if (arg == "--output") output = value;
            else if (arg == "--l2-bandwidth") config.l2_bandwidth_bytes_per_cycle = positive(value);
            else if (arg == "--sram-bandwidth") config.sram_bandwidth_bytes_per_cycle = positive(value);
            else throw std::runtime_error("Unknown argument: " + arg);
        }
        if (M % 128 || N % 256 || K % 64)
            throw std::runtime_error("Official builder requires M multiple of 128, N of 256, K of 64; this harness rejects truncation.");
        // Upstream uses whole cache-line budgets (integer division). Values
        // below one 128-byte line would prevent any L2 transaction advancing.
        if (config.l2_bandwidth_bytes_per_cycle < config.l2_line_size_bytes)
            throw std::runtime_error("L2 bandwidth must be >= 128 bytes/cycle for this upstream model.");
        // Avoid silent overflow or accidentally launching huge graphs through
        // the prototype. This is a small-workload observer, not a batch service.
        if (M > 2048 || N > 2048 || K > 2048)
            throw std::runtime_error("Prototype dimensions must be <= 2048.");
        std::unique_ptr<DAG> dag(build_gemm_h100(M, N, K));
        if (dag->nodes.size() > 50000) throw std::runtime_error("Prototype graph limit: 50,000 nodes.");
        config.silence_mode = true;
        Simulator simulator(dag.get(), config);
        const std::string run_id = invocation_id();
        const auto run_start = std::chrono::steady_clock::now();
        const bool success = simulator.run(max_cycles, true);
        const double wall_time_seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - run_start).count();
        export_trace(output, simulator, M, N, K, max_cycles, success, run_id, wall_time_seconds);
        return success ? 0 : 2;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
