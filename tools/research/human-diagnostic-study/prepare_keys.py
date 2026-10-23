#!/usr/bin/env python3
"""Create six task-specific scoring drafts and frozen executor mappings, outside web."""
import hashlib,json
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
SPECS={
 'triton-softmax-axis':('归约轴被删去后广播错位','max/sum 在指定 dim 归约时丢失轴，x 减 max 和 num 除 sum 按错误维度广播；二维 dim=1 暴露问题，dim=0/一维对照通过。',['保持归约轴维度 keep_dims=True','显式 expand_dims/reshape，在每个指定归约轴恢复广播语义'],['将同一非对称二维输入从 dim=1 改 dim=0，比较沿目标轴的和是否约为 1','增加非方形/多轴输入，区分广播错位与 exp 数值误差'],['只修 dim=1 或硬编码方形数据','将问题归为 GPU 调度或实测内存竞态']),
 'triton-negative-zero':('浮点零常量丢失符号位','scalar_constant 对 value == 0 统一构造 null，-0.0 与 +0.0 数值相等但符号位不同，浮点负零错误地变为正零。',['按浮点 dtype 构造保留符号的常量，整数零仍按整数规则处理','显式检测负零并生成正确浮点位型，覆盖目标浮点 dtype'],['比较同 dtype 的 -0.0/+0.0 和非零控制的输出字节','跨 float16/float32/float64 检查符号位；数值 allclose 不足以验证'],['只用 == 或 allclose 宣告修复','将此前单独发现的缓存键碰撞当成本任务已冻结 wrapper 的唯一根因']),
 'triton-constexpr-filter':('编译期列表推导式忽略 if 谓词','visit_ListComp 遍历元素后无条件 append，未评估 comp.ifs；过滤本应丢弃的项仍进入常量序列，GPU 输出长度与元素均随之错误。',['在 append 前逐项求所有编译期谓词的合取','等价、保留求值语义的编译期过滤实现；无 if 时结果不变'],['对同一 tuple 比较不过滤、部分过滤、全过滤','使用两个 if 验证 AND 及短路语义，不仅验证单一 cutoff'],['改运行时输出以掩盖编译期错误','硬编码示例 tuple 或只修测试 wrapper']),
 'liger-poly':('低精度中间幂运算或归约导致溢出/精度失效','poly_norm 加载半精度 X 后在过窄 dtype 中形成高阶幂/相关归约；大隐藏维 FP16 失败而对应 FP32 和小维 FP16 控制通过。必须在高阶中间值形成前扩精度。',['加载 X 后转 FP32，再执行多项式/归约并保持契约输出 dtype','数值等价稳定缩放或足够精度的计算路径；仍需全部实机隐藏测试'],['固定 seed/shape，仅切 FP16 与 FP32，区分精度路径与索引问题','固定 dtype 改 width/scale，验证高阶量的动态范围预测'],['溢出发生之后才 cast','输出统一改 FP32 而违反原输出 dtype 契约','仅凭该证据断言某条硬件指令先后顺序']),
 'liger-sparse':('大公共偏移使 sparsemax 阈值计算失稳','sparsemax 应平移不变，但直接在大偏移值上 cumsum 及计算含 -1 的阈值会丢失小差量；实际传入的量化数组为 oracle 输入。按有限 row max 先平移、再一致计算阈值与输出可避开该问题。',['有限 row max 平移，阈值和 x-tau 使用同一坐标系','数学等价且保持投影/阈值契约的稳定实现'],['同一相对行加入公共偏移，输出应不变（按实际表示的输入比较）','常量行应均匀 1/width；比较不同宽度及大正负偏移'],['只在最终输出处减 max，阈值仍使用原坐标','任意重归一化或 hardcode 常量行而未证明一般 sparsemax 等价','把所有错误都归为输入量化而忽略参考也使用实际输入']),
 'liger-grpo':('input_ids 与 mask 地址步长假设错误','kernel 假设 ids 的列 stride 为 1，并将 ids 行 stride 用于 mask；非连续、不同 prefix 或 broadcast view 使读取错误。应分别传 ids/mask 两维 strides，已有 storage offset 由张量指针携带。',['分别使用 ids.stride(0/1) 与 mask.stride(0/1) 计算地址','保持值、mask、dtype 契约的显式 contiguous 规范化；性能开销另测'],['固定逻辑数组，改变 ids 或 mask 的 storage layout，结果应相同','分别构造 strided_ids/strided_mask/broadcast_views 以区分两个地址错误'],['仅改 ids 列 stride，仍复用 mask 的错误 stride','对所有输出取消 mask','把传入指针的 storage offset 再重复加一次'])}

def main():
 catalog=json.loads((ROOT/'out/research/repair-v2-study/frozen/catalog-before.json').read_text())
 plans={}
 for base in ['natural-fault-expansion','liger-faults']:
  for spec in json.loads((ROOT/f'out/research/{base}/private-plan.json').read_text())['tasks']:plans[spec['id']]=(base,spec)
 target=HERE/'private';target.mkdir(exist_ok=True)
 rows=[]
 for task in catalog['tasks']:
  base,spec=plans[task['id']];title,mechanism,equivalent,counter,wrong=SPECS[task['id']]
  executor=ROOT/f'tools/research/{base}/evaluate_candidate.py';verifier=ROOT/f'tools/research/{base}/verify.py';runner=ROOT/f'tools/research/{base}/run.py';plan=ROOT/f'out/research/{base}/plan.json'
  assert sha(plan)==spec['hiddenSpecSHA256']
  mapping={'taskId':task['id'],'baseDirectory':f'out/research/{base}','executor':str(executor.relative_to(ROOT)),'executorSha256':sha(executor),'verifier':str(verifier.relative_to(ROOT)),'verifierSha256':sha(verifier),'runner':str(runner.relative_to(ROOT)),'runnerSha256':sha(runner),'hiddenPlan':str(plan.relative_to(ROOT)),'hiddenSpecSHA256':sha(plan),'hiddenCaseIds':spec['hiddenCaseIds'],'visibleCaseIds':[c['id'] for c in task['cases']], 'command':['python3',str(executor.relative_to(ROOT)),'--candidate','CANDIDATE_JSON','--output','NEW_OUTPUT_DIRECTORY','--base',f'out/research/{base}'],'scope':'Existing actual-GPU executor. Not run on any human candidate; no human participant exists yet.'}
  key={'format':'human-task-rubric-draft-v2','status':'DRAFT — expert review and independent rater calibration pending','taskId':task['id'],'rootCauseId':spec['rootCauseId'],'title':title,'mechanismForFullCredit':mechanism,'allowedEquivalentExplanationsAndRepairs':equivalent,'counterfactualPredictions':counter,'insufficientOrWrongAnswers':wrong,'localizationTargets':[dict(region,path=next(f['path'] for f in task['files'] if f['id']==region['source_id']),sourceSha256=next(f['sha256'] for f in task['files'] if f['id']==region['source_id'])) for region in spec['relevantRegions']], 'failureEvidence':[{'caseId':c['id'],'evidenceIds':c['evidenceRefs'],'parameters':c['parameters']} for c in task['cases'] if c['status']!='passed'],'passingControls':[{'caseId':c['id'],'evidenceIds':c['evidenceRefs'],'parameters':c['parameters']} for c in task['cases'] if c['status']=='passed'],'scoring':'Four 0/1/2 dimensions: mechanism, localization, evidence, counterfactual. Correct alternatives need not match gold text; unsupported causal certainty loses mechanism/evidence credit. Exact line targets are guides, not an automatic semantic correctness oracle.','repairExecutor':mapping}
  path=target/(task['id']+'.rubric.json');path.write_text(json.dumps(key,ensure_ascii=False,indent=2)+'\n');rows.append({'taskId':task['id'],'rubricPath':str(path.relative_to(ROOT)),'rubricSha256':sha(path),'repairHarnessSha256':sha(executor),'executor':mapping})
 (target/'executor-map.json').write_text(json.dumps({'format':'human-executor-map-v2','catalogSha256':sha(ROOT/'out/research/repair-v2-study/frozen/catalog-before.json'),'tasks':rows},ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'tasks':len(rows),'status':'Six actual task keys drafted, not expert-reviewed; no human results.'}))
if __name__=='__main__':main()
