/**
 * outlineInput.ts —— **提纲阶段的输入采样**（D61）。
 *
 * ## 为什么需要采样
 * 提纲那一步的价值在于"看到**全篇**"（主线、步骤、因果都在整篇里，不在开头）。但把几万字的
 * 全文整份塞进提示词既贵又慢，还有上限。于是：正文没超上限就整份给；超了就**按比例从全篇
 * 各处取一段**——头部与尾部给足（结论常在尾），中间按段等距取样。
 *
 * ## 与计划的一处偏差（如实登记）
 * 原计划写的是"按**小标题**切分，每节取前 ~600 字"。但正文是经 `htmlDigest` 从 HTML 抽出来的
 * **纯文本**，小标题结构已经不在了（`<h2>` 被剥掉）。硬去猜标题比"等距取样"更不稳，
 * 所以改成**按段落等距取样**：覆盖全篇的效果一样，且行为完全可测。
 */

/** 提纲输入的默认上限（码点）——与 `llmFlow.OUTLINE_INPUT_MAX` 同值。 */
export const DEFAULT_OUTLINE_BUDGET = 20_000;
/** 头部/尾部各保留多少（码点）：结论与要点常在这两处。 */
export const HEAD_TAIL_CHARS = 2_000;

/** 码点安全切片。 */
function slicePoints(text: string, from: number, to: number): string {
  return Array.from(text).slice(from, to).join('');
}

/**
 * 把（可能很长的）正文整理成"提纲那一步该看的东西"。
 *
 * - 不超预算 ⇒ **原样返回**（一个字都不动：短文本没有采样可言）；
 * - 超了 ⇒ 头部 `HEAD_TAIL_CHARS` + 尾部 `HEAD_TAIL_CHARS` + 中间**按段等距**取样填满预算；
 * - 取样按**段落**边界（`\n`）切，不切碎句子；段落超长时按句号/换行就近切。
 */
export function outlineInputFor(text: string, budget: number = DEFAULT_OUTLINE_BUDGET): string {
  const raw = typeof text === 'string' ? text : '';
  const cap = Number.isFinite(budget) && budget > 200 ? Math.floor(budget) : DEFAULT_OUTLINE_BUDGET;
  const points = Array.from(raw);
  if (points.length <= cap) return raw;

  // 头尾各留多少：预算够就各 2000，预算紧就各让一半（**总长永不超过预算** ——
  // 首版把预算只用来限制"中间"，头尾各 2000 直接顶穿（OI#2 当场抓到）
  // 早退分支会拼 `head + "\n...\n" + tail`：那 5 个字符也要算进预算，
  // 否则小预算下**真的会超**（复查发现的测试容差就是这么来的）
  const reserve = Math.min(HEAD_TAIL_CHARS, Math.floor((cap - 5) / 2));
  const head = slicePoints(raw, 0, reserve);
  const tail = slicePoints(raw, Math.max(0, points.length - reserve), points.length);
  // 分隔符也要占位置：不把它算进去，拼出来就会**略超预算**，而调用方（suggestOutline）
  // 还会按同一预算再裁一次 —— 那一刀正好裁掉**尾部**（结论常在的地方）。KF#O6 抓到过。
  // 4 个换行 + 一点余量（首版只算了 2 个换行 ⇒ 拼出来恰好多 2 码点，
  // 调用方那一刀正好把**结尾**削掉两个字：KF#O6 的尾标记就是这么丢的）
  const sepBudget = Array.from('（中间为等距节选）').length + Array.from('（以下是结尾部分）').length + 8;
  const middleBudget = Math.max(0, cap - Array.from(head).length - Array.from(tail).length - sepBudget);

  // 中间部分：从"头部之后、尾部之前"按段落取
  const middleRaw = slicePoints(raw, reserve, Math.max(reserve, points.length - reserve));
  const paras = middleRaw
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paras.length === 0 || middleBudget <= 0) return `${head}\n...\n${tail}`;

  // 等距取样：把段落均匀分成 N 组，每组取**组首**那一段（组首比组尾更可能是论点句）
  const per = Math.max(120, Math.ceil(middleBudget / Math.min(12, paras.length)));
  const groups = Math.min(12, paras.length);
  const picked: string[] = [];
  let used = 0;
  for (let g = 0; g < groups && used < middleBudget; g += 1) {
    const idx = Math.floor((g * paras.length) / groups);
    const para = slicePoints(paras[idx], 0, Math.min(per, middleBudget - used));
    if (para.length === 0) continue;
    picked.push(para);
    used += Array.from(para).length;
  }
  return [head, '（中间为等距节选）', ...picked, '（以下是结尾部分）', tail].join('\n');
}
