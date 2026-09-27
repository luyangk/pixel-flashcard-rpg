/**
 * 会话层共享类型（Plan 3 · T2）—— 先于 battleFlow/growth/persist 落定，
 * 避免后续任务各自声明同名类型造成漂移（brief Files 注记）。
 *
 * 本文件为纯类型声明：零运行时代码、零 import、无平台 API。
 * src/app 层允许引用 platform（clock/env/rngProvider/storage），但仍不得触碰 DOM
 * ——画面属 Plan 4；Plan 3 的 app 层是"可编程驱动的数据流主干"。
 */

import type { Card, Deck } from '@core/types';

/**
 * 全库视图：装配层所有派生口径（vit/spi 计数、卡池生成、Boss 计数）都以整个存档
 * 的 cards 为依据，而非本场参战池（PRD §6.5 红线 N-1）。decks 一并携带，
 * 供主题筛选与卷灵命名等消费方读取，本任务不消费。
 */
export interface SessionCards {
  readonly decks: Deck[];
  readonly cards: Card[];
}

/**
 * 会话阶段（PRD §2.2/§2.3 菜单→备战→战斗→结算）。
 * 本任务只实现 'fighting' 段的数据流（battleFlow.ts）；其余阶段的推进归 T3/T4/T7。
 */
export type Phase = 'menu' | 'preparing' | 'fighting' | 'result';
