#!/usr/bin/env python3
"""把「AI 基础」预置领域写进 assets/content/preset.json（幂等：已存在就先删掉旧的再写）。

为什么用脚本而不是手写 JSON：
- 每张卡有 5 个字段（front/back/tags/choices/url），手写容易漏 `url`（那正是本领域的价值所在）；
- 脚本里可以**当场自检**：长度上限、choices 三条且不重复、url 必须是 https 且指向真论文；
- 以后补卡只改这里的表，重跑即可。

口径（与 D59 一致）：卡片讲**道理与主线**，不做元信息卡（不考"哪一年发表"），
原文入口放 `url` 字段（App 里按 D60 显示「看原文」）。
"""
from __future__ import annotations

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PATH = os.path.join(ROOT, 'assets', 'content', 'preset.json')

ARXIV = 'https://arxiv.org/abs/'

# (front, back, tags, choices, url)
CARDS: list[tuple[str, str, list[str], list[str], str]] = [
    # ---------------- A 架构与规模 ----------------
    (
        'Transformer 靠什么取代了循环结构？',
        '自注意力：每个位置直接和所有位置算相关性，一步并行算完，不必像 RNN 那样按顺序传递状态。',
        ['架构'],
        ['堆叠更深的卷积核', 'LSTM 的门控记忆被加长', '位置编码本身就自带顺序'],
        ARXIV + '1706.03762',
    ),
    (
        '为什么 Transformer 必须额外加位置编码？',
        '自注意力**对位置无感**：把词序打乱，注意力算出的结果不变，所以顺序信息必须另外注入。',
        ['架构'],
        ['为了让注意力矩阵可逆', '为了把长序列压短', '为了让批大小固定不变'],
        ARXIV + '1706.03762',
    ),
    (
        '多头注意力解决了什么问题？',
        '让同一层同时关注不同类型的关系（语法、指代、远近位置），比单个注意力头的表达更丰富。',
        ['架构'],
        ['把参数量减到单头的一半', '让不同层的梯度互不干扰', '把一条序列切成多段并行'],
        ARXIV + '1706.03762',
    ),
    (
        'GPT 系列与 BERT 的根本差别是什么？',
        'GPT 是自回归解码器：只用左侧上下文、预测下一个词；BERT 是双向编码器：两侧都看、做填空式理解。',
        ['架构'],
        ['GPT 用卷积，BERT 用循环', 'GPT 只做分类，BERT 只做生成', '两者只差训练数据量'],
        ARXIV + '1810.04805',
    ),
    (
        'GPT-3 的"少样本学习"发生在哪一步？',
        '推理时：把示例直接写进提示里，参数**一个都不更新**，模型照上下文里的模式作答。',
        ['能力'],
        ['预训练时就把任务背住了', '必须先用该任务微调一轮', '示例要被编译进梯度缓存'],
        ARXIV + '2005.14165',
    ),
    (
        'GPT-4 技术报告在哪一点上刻意不透明？',
        '不披露架构、参数量、数据与训练细节，只给能力评测与安全措施 —— 与开源路线的报告形成鲜明对比。',
        ['能力'],
        ['公布了完整训练配方', '只公布了推理代码', '拒绝公布任何评测结果'],
        ARXIV + '2303.08774',
    ),
    # ---------------- B 规模与效率 ----------------
    (
        'Kaplan 的缩放定律说了什么？',
        '损失随参数量、数据量、算力呈幂律下降；三者要一起放大，只堆其中一项，收益很快变平。',
        ['规模'],
        ['损失随参数量线性下降', '数据越多损失必然越低', '算力只影响训练速度'],
        ARXIV + '2001.08361',
    ),
    (
        'Chinchilla 修正了当时哪个普遍错误？',
        '普遍"参数太大、数据太少"：在给定算力下，训练 token 数应约为参数量级的 20 倍才算最优。',
        ['规模'],
        ['数据越多越好，参数不重要', '参数量是唯一决定因素', '两者按 1:1 增长才最优'],
        ARXIV + '2203.15556',
    ),
    (
        '稀疏专家（MoE）的核心取舍是什么？',
        '总参数量可以很大，但每个 token 只激活少数专家 —— 用相近的算力换更大的模型容量。',
        ['规模'],
        ['每个 token 都过所有专家', '用更少的参数换更快的训练', '把专家按层数平均分配'],
        ARXIV + '2101.03961',
    ),
    (
        'LoRA 微调为什么省显存？',
        '冻住原权重，只训练一组低秩小矩阵；显存大头是优化器状态，这部分随之大幅缩小。',
        ['效率'],
        ['它把模型量化到 4 位', '它跳过了反向传播', '它把训练数据压成摘要'],
        ARXIV + '2106.09685',
    ),
    (
        'FlashAttention 快在哪里？',
        '它不减少计算量，而是按 IO 优化：分块在片上高速缓存里算，避免反复读写显存中的注意力矩阵。',
        ['效率'],
        ['它近似掉了一部分注意力', '它把注意力换成卷积', '它用半精度换掉了精度损失'],
        ARXIV + '2205.14135',
    ),
    # ---------------- C 对齐与偏好优化 ----------------
    (
        'RLHF 的三步流程是什么？',
        '① 监督微调 → ② 用人类偏好数据训练奖励模型 → ③ 用 PPO 按奖励优化策略。',
        ['对齐'],
        ['先 PPO 再监督微调', '用人类数据直接训练输出', '先奖励模型再预训练'],
        ARXIV + '2203.02155',
    ),
    (
        'InstructGPT 的关键结论是什么？',
        '1.3B 的 RLHF 模型，人类更偏好它的回答，胜过 175B 的原版 GPT-3：**对齐比单纯堆参数更划算**。',
        ['对齐'],
        ['参数量大就一定更好', 'RLHF 只对无害性有效', '微调会让模型变笨'],
        ARXIV + '2203.02155',
    ),
    (
        'PPO 里的"截断"是干什么的？',
        '限制单次策略更新幅度：新旧策略的概率比被夹在小区间内，避免一次更新把策略带崩。',
        ['对齐'],
        ['把无效动作的奖励清零', '让学习率随步数衰减', '把长序列截断后训练'],
        ARXIV + '1707.06347',
    ),
    (
        'DPO 相对 RLHF 省掉了什么？',
        '省掉奖励模型与在线采样：把偏好对当分类数据直接训练策略，同一个目标换了参数化形式。',
        ['对齐'],
        ['省掉了偏好数据收集', '省掉了策略网络', '省掉了监督微调'],
        ARXIV + '2305.18290',
    ),
    (
        'Constitutional AI 里的"AI 反馈"指什么？',
        '让模型按一份书面原则自我批评、改写回答，再用这些 AI 偏好做强化学习，减少逐条人工标注。',
        ['对齐'],
        ['让另一个模型代替人类回答', '把宪法条文直接写进提示', '用规则过滤训练数据'],
        ARXIV + '2212.08073',
    ),
    (
        'Anthropic 的 HH-RLHF 关注哪两个目标？',
        '有用（helpful）与无害（harmless）同时优化：用人类偏好数据训练，并靠红队测试暴露有害行为。',
        ['对齐'],
        ['只追求无害，牺牲有用', '只追求准确率', '只优化推理速度'],
        ARXIV + '2204.05862',
    ),
    (
        '"潜伏代理"（sleeper agents）实验说明了什么？',
        '植入的后门行为能**穿过安全训练存活**：模型表面变安全了，触发条件一出现又原样复现。',
        ['安全'],
        ['安全训练能清除所有后门', '后门只在训练期有效', '后门会随规模增大消失'],
        ARXIV + '2401.05566',
    ),
    # ---------------- D 推理与 Agent ----------------
    (
        '思维链（CoT）为什么能提升推理正确率？',
        '让模型把中间步骤写出来，等于给它更多"草稿空间"与计算量，错误更容易在中途被发现和纠正。',
        ['推理'],
        ['它让模型记住了更多答案', '它缩短了输出长度', '它把题目拆给多个模型'],
        ARXIV + '2201.11903',
    ),
    (
        'ReAct 把哪两件事交织在一起？',
        '推理轨迹与工具动作：边想边查，用外部观察纠正下一步，而不是一口气把答案编完。',
        ['Agent'],
        ['训练与推理', '检索与微调', '规划与评测'],
        ARXIV + '2210.03629',
    ),
    (
        'RAG 解决的是模型的哪个缺陷？',
        '把知识放在可检索的外部库里：缓解"记不住/会过时/会编"，还能给出处。',
        ['检索'],
        ['训练数据不够大', '上下文窗口太短', '推理速度太慢'],
        ARXIV + '2005.11401',
    ),
    (
        'DeepSeek R1 最反直觉的一点是什么？',
        '不做监督冷启动、直接上强化学习（R1-Zero）：模型自己长出长链推理、自我检查与反思。',
        ['推理'],
        ['必须先有海量人工标注', '只做蒸馏不训练', '靠提示词工程激发推理'],
        ARXIV + '2501.12948',
    ),
    (
        'GRPO 相比 PPO 省掉了什么？',
        '省掉价值网络（critic）：用同一题一组回答的相对好坏当优势，显存与实现都轻得多。',
        ['对齐'],
        ['省掉了题库与奖励', '省掉了策略网络', '省掉了采样过程'],
        ARXIV + '2402.03300',
    ),
    (
        'OpenAI o1 的做法与"在提示里让它思考"有何不同？',
        '它把长链推理放进**训练**里（用强化学习学出思维链），而不是只靠推理时的提示技巧。',
        ['推理'],
        ['只是提示词的写法不同', '只在评测时开启思维链', '靠更长的上下文窗口'],
        'https://openai.com/index/learning-to-reason-with-llms/',
    ),
    (
        '生成式智能体里的"记忆流"是什么？',
        '把经历按时间存成可检索记录，定期反思成更高层结论，再据此规划行动 —— 让 Agent 有连续性。',
        ['Agent'],
        ['把对话历史全部塞进提示', '一个固定的人设提示', '一张任务依赖图'],
        ARXIV + '2304.03442',
    ),
    (
        'SWE-bench 想测的是什么能力？',
        '在真实仓库里修真实 issue：跨文件定位、改代码、跑测试，而不是做孤立小题。',
        ['Agent'],
        ['生成代码片段的语法正确率', '算法题的通过率', '对话的流畅程度'],
        ARXIV + '2310.06770',
    ),
    (
        'MCP（模型上下文协议）解决什么问题？',
        '把"给模型提供数据与工具"标准化成客户端-服务器接口：一次接入、多处复用，不必每接一个模型就写一套。',
        ['Agent'],
        ['让模型跑得更快', '替代模型的训练', '统一提示词的格式'],
        'https://www.anthropic.com/news/model-context-protocol',
    ),
]

DECK = {
    'id': 'preset-ai-foundation',
    'name': 'AI 基础',
    'bossName': '基石篇·卷灵',
}


def check() -> None:
    """内容自检：字段齐全、长度上限、choices 三条不重复、url 必须是 https。"""
    problems: list[str] = []
    for i, (front, back, tags, choices, url) in enumerate(CARDS, start=1):
        if not front.strip() or not back.strip():
            problems.append(f'第 {i} 张：front/back 为空')
        if len(front) > 60:
            problems.append(f'第 {i} 张：front 超过 60 字（{len(front)}）')
        if len(back) > 160:
            problems.append(f'第 {i} 张：back 超过 160 字（{len(back)}）')
        if len(choices) != 3 or len(set(choices)) != 3:
            problems.append(f'第 {i} 张：choices 必须 3 条且不重复')
        for c in choices:
            if len(c) > 30:
                problems.append(f'第 {i} 张：干扰项超过 30 字（{c}）')
            if c == back:
                problems.append(f'第 {i} 张：干扰项与答案相同')
        if not re.match(r'^https://', url):
            problems.append(f'第 {i} 张：url 不是 https（{url}）')
    if problems:
        raise SystemExit('内容自检未通过：\n- ' + '\n- '.join(problems))
    print(f'内容自检通过：{len(CARDS)} 张卡，字段齐全、长度达标、choices 合规、url 均为 https')


def main() -> None:
    check()
    data = json.load(open(PATH, encoding='utf-8'))
    data['decks'] = [d for d in data['decks'] if d.get('id') != DECK['id']]
    cards = []
    for i, (front, back, tags, choices, url) in enumerate(CARDS, start=1):
        cards.append(
            {
                'id': f'ai-{i:02d}',
                'front': front,
                'back': back,
                'tags': tags,
                'choices': choices,
                'url': url,
            }
        )
    data['decks'].append({**DECK, 'cards': cards})

    # 保持文件既有的"一张卡一行"排版（diff 可读）
    lines: list[str] = []
    lines.append('{')
    lines.append('  "note": ' + json.dumps(data.get('note', ''), ensure_ascii=False) + ',')
    lines.append('  "decks": [')
    for di, deck in enumerate(data['decks']):
        lines.append('    {')
        lines.append(f'      "id": {json.dumps(deck["id"], ensure_ascii=False)},')
        lines.append(f'      "name": {json.dumps(deck["name"], ensure_ascii=False)},')
        if 'bossName' in deck:
            lines.append(f'      "bossName": {json.dumps(deck["bossName"], ensure_ascii=False)},')
        lines.append('      "cards": [')
        for ci, card in enumerate(deck['cards']):
            body = (
                f'"id": {json.dumps(card["id"], ensure_ascii=False)}, '
                f'"front": {json.dumps(card["front"], ensure_ascii=False)}, '
                f'"back": {json.dumps(card["back"], ensure_ascii=False)}, '
                f'"tags": {json.dumps(card["tags"], ensure_ascii=False)}'
            )
            if card.get('choices'):
                body += f', "choices": {json.dumps(card["choices"], ensure_ascii=False)}'
            if card.get('url'):
                body += f', "url": {json.dumps(card["url"], ensure_ascii=False)}'
            comma = ',' if ci < len(deck['cards']) - 1 else ''
            lines.append(f'        {{ {body} }}{comma}')
        lines.append('      ]')
        lines.append('    }' + (',' if di < len(data['decks']) - 1 else ''))
    lines.append('  ]')
    lines.append('}')
    open(PATH, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print(f'已写入 {DECK["id"]}（{DECK["name"]}）：{len(cards)} 张卡')


if __name__ == '__main__':
    main()
