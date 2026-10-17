// Independent annotated model actions. The runner consumes inputs from conversations.json,
// but never consumes its expect objects when constructing a model response.
type Prep = {
  tool: 'start_task' | 'update_task' | 'clarify_task' | 'acknowledge_task';
  args: Record<string, unknown>;
};
export type ContractTurn = {
  alias?: string;
  prep: Prep;
  intent?: 'second_hand' | 'housing' | 'companion' | 'carry';
  question?: { key: string; text: string; alias: string };
  replyTo?: string;
  react?: boolean;
  deny?: boolean;
  owner?: string;
  scope?: string;
  source?: 'unavailable' | 'no_exact_match';
};
const value = (kind: string, fields: Record<string, unknown>) => ({ kind, ...fields });
const condition = (
  key: string,
  data: unknown,
  sourceQuote: string,
  goalId: string | null = null,
  strength = 'hard',
) => ({ key, value: data, sourceQuote, goalId, strength });
const cash = (amountPence: number, quote: string, goalId: string | null = null, unit = 'item') =>
  condition('budget', value('money', { amountPence, unit }), quote, goalId);
const area = (text: string, quote = text) =>
  condition('area', value('location', { area: text }), quote);
const text = (key: string, text: string, quote: string, strength = 'hard') =>
  condition(key, value('text', { text }), quote, null, strength);
const date = (key: string, from: string, to: string, quote: string) =>
  condition(key, value('date_range', { from, to }), quote);
const goal = (id: string, title: string, sourceQuote: string) => ({
  id,
  title,
  sourceQuote,
  required: true,
  criteria: [{ id: 'subject', label: title, constraintKey: null, strength: 'hard' }],
});
const start = (
  alias: string,
  category: string,
  objective: string,
  goals: unknown[],
  constraints: unknown[],
  intent: ContractTurn['intent'],
): ContractTurn => ({
  alias,
  intent,
  prep: { tool: 'start_task', args: { category, objective, goals, constraints } },
});
const update = (
  alias: string,
  constraints: unknown[] = [],
  outcome: unknown = null,
): ContractTurn => ({
  alias,
  prep: {
    tool: 'update_task',
    args: { taskRef: '$' + alias, referenceQuote: null, goals: [], constraints, outcome },
  },
});
const question = (turn: ContractTurn, key: string, text: string, alias: string): ContractTurn => ({
  ...turn,
  question: { key, text, alias },
});
const finish = (
  alias: string,
  quote: string,
  goalIds: string[] = [],
  intent = 'achieved',
): ContractTurn => ({ ...update(alias, [], { intent, goalIds, quote }), react: true });
const radius = (turn: ContractTurn, alias: string, wording = '最多接受多久单程路程？') =>
  question(turn, 'max_travel_minutes', wording, alias);
const duration = condition('max_travel_minutes', value('duration', { minutes: 30 }), '半小时以内');
const ack = (alias: string): ContractTurn => ({
  alias,
  prep: { tool: 'acknowledge_task', args: {} },
  react: true,
});

export const SCRIPTED_TASK_TURNS: Record<string, ContractTurn[]> = {
  desk_chair: [
    radius(
      start(
        'furniture',
        'second_hand',
        '收书桌和办公椅',
        [goal('desk', '书桌', '书桌'), goal('chair', '办公椅', '办公椅')],
        [
          area('E14'),
          cash(5000, '每件50镑以内'),
          condition('self_collect', value('boolean', { value: true }), '能自提'),
        ],
        'second_hand',
      ),
      'furniture-radius-question',
    ),
    {
      ...update('furniture', [duration]),
      replyTo: 'furniture-radius-question',
      intent: 'second_hand',
    },
    {
      ...update('furniture', [
        cash(7000, '桌子可以到70镑', 'desk'),
        cash(5000, '椅子还是50', 'chair'),
      ]),
      intent: 'second_hand',
    },
    {
      ...update('furniture', [], {
        intent: 'achieved',
        goalIds: ['chair'],
        quote: '椅子已经买到了',
      }),
      intent: 'second_hand',
      question: {
        key: 'custom:desk_priority',
        text: '书桌还有哪项需要优先核对？',
        alias: 'furniture-last-reply',
      },
    },
    { ...finish('furniture', '这个需求解决了'), replyTo: 'furniture-last-reply' },
  ],
  cat_housing: [
    question(
      start(
        'housing',
        'housing',
        '找可养猫一居室',
        [goal('home', '一居室', '一居室')],
        [
          area('Stratford'),
          cash(160000, '月租1600镑以内', null, 'month'),
          text('pets', '猫', '允许养猫'),
          date('move_in_date', '2026-11-01', '2026-11-30', '11月入住'),
        ],
        'housing',
      ),
      'move_in_date',
      '十一月具体哪天入住？',
      'housing-move-in-question',
    ),
    {
      ...update('housing', [
        date('move_in_date', '2026-11-05', '2026-11-05', '11月5日入住'),
        text('pets', '猫', '猫一定要允许'),
      ]),
      replyTo: 'housing-move-in-question',
      intent: 'housing',
    },
    {
      ...update('housing', [
        condition('bills', value('boolean', { value: true }), '最好包bills', null, 'preference'),
      ]),
      intent: 'housing',
    },
    { ...update('housing', [text('exclude', 'studio', 'Studio不考虑')]), intent: 'housing' },
    finish('housing', '房子找好了'),
  ],
  beginner_bad: [
    radius(
      start(
        'badminton',
        'other',
        '找周末新手羽毛球搭子',
        [goal('partner', '羽毛球搭子', '羽毛球搭子')],
        [area('E14'), text('day', '周末', '周末'), text('level', '初学者', '初学者')],
        'companion',
      ),
      'badminton-radius-question',
    ),
    {
      ...update('badminton', [duration]),
      replyTo: 'badminton-radius-question',
      intent: 'companion',
    },
    {
      ...update('badminton', [
        text('day', '周日', '周日下午'),
        text('time', '下午', '周日下午'),
        text('exclude', '周六', '周六不行'),
      ]),
      intent: 'companion',
    },
    {
      ...update('badminton', [
        text('custom:indoor', '室内', '室内的'),
        condition(
          'custom:fee_ok',
          value('boolean', { value: true }),
          '收费也可以',
          null,
          'preference',
        ),
      ]),
      intent: 'companion',
    },
    finish('badminton', '已经解决'),
  ],
  switch_back: [
    question(
      start(
        'desk',
        'second_hand',
        '收书桌',
        [goal('desk', '书桌', '书桌')],
        [area('E14'), cash(5000, '50镑以内')],
        'second_hand',
      ),
      'custom:budget_options',
      '继续按原预算找，还是先了解价格稍高的备选？',
      'desk-budget-question',
    ),
    start(
      'housing',
      'housing',
      '找一居室',
      [goal('home', '一居室', '一居室')],
      [area('Stratford'), cash(160000, '月租1600以内', null, 'month')],
      'housing',
    ),
    {
      ...update('desk', [cash(7000, '可以到70')]),
      replyTo: 'desk-budget-question',
      intent: 'second_hand',
    },
  ],
  ambiguous: [
    start('desk', 'second_hand', '找桌子', [goal('desk', '桌子', '桌子')], [], 'second_hand'),
    start('housing', 'housing', '找房', [goal('home', '房源', '找房')], [], 'housing'),
    { prep: { tool: 'clarify_task', args: { reason: 'ambiguous_reference' } } },
  ],
  not_complete: [
    start(
      'badminton',
      'other',
      '找新手羽毛球搭子',
      [goal('partner', '羽毛球搭子', '羽毛球搭子')],
      [area('E14'), text('level', '新手', '新手')],
      'companion',
    ),
    ack('badminton'),
    ack('badminton'),
  ],
  cancel: [
    start(
      'chair',
      'second_hand',
      '买办公椅',
      [goal('chair', '办公椅', '办公椅')],
      [cash(5000, '50镑以内')],
      'second_hand',
    ),
    finish('chair', '取消这个需求', [], 'cancelled'),
  ],
  scope: [
    {
      ...start(
        'private-housing',
        'housing',
        '找房',
        [goal('home', '房源', '找房')],
        [area('E14')],
        'housing',
      ),
      scope: 'private',
    },
    {
      scope: 'unrelated-group',
      prep: { tool: 'clarify_task', args: { reason: 'missing_goal' } },
    },
  ],
  ownership: [
    {
      ...start(
        'desk',
        'second_hand',
        '收书桌',
        [goal('desk', '书桌', '书桌')],
        [area('E14')],
        'second_hand',
      ),
      owner: 'user-a',
    },
    { ...update('desk', [cash(50000, '预算改成500')]), owner: 'user-b', deny: true },
  ],
  carry_role: [
    question(
      start(
        'carry',
        'other',
        '提供帮带空间找需求方',
        [goal('carry', '帮带空间', '空余行李')],
        [
          text('route_from', '伦敦', '伦敦'),
          text('route_to', '上海', '上海'),
          text('capacity', '2公斤', '2公斤'),
          date('date', '2026-11-01', '2026-11-01', '2026年11月1日'),
        ],
        'carry',
      ),
      'custom:carry_items',
      '你能接受帮带哪些物品？',
      'carry-item-question',
    ),
    {
      ...update('carry', [text('feature', '衣服', '只能带衣服')]),
      replyTo: 'carry-item-question',
      intent: 'carry',
    },
  ],
  no_match: [
    {
      ...radius(
        start(
          'badminton',
          'other',
          '找新手羽毛球搭子',
          [goal('partner', '羽毛球搭子', '羽毛球')],
          [area('E14'), text('level', '新手', '新手'), text('day', '周末', '周末')],
          'companion',
        ),
        'badminton-radius-question',
      ),
      source: 'no_exact_match',
      question: {
        key: 'max_travel_minutes',
        text: '这次还未确认到适合新手的选项。最多接受多久单程通勤？',
        alias: 'badminton-radius-question',
      },
    },
    {
      ...radius(
        update('badminton', [area('E14周边', '附近也可以')]),
        'badminton-radius-question-next',
      ),
      replyTo: 'badminton-radius-question',
      intent: 'companion',
      source: 'no_exact_match',
    },
  ],
  user_solved: [
    {
      ...start(
        'furniture',
        'second_hand',
        '找桌椅',
        [goal('desk', '书桌', '桌椅'), goal('chair', '办公椅', '桌椅')],
        [cash(5000, '每件50以内')],
        'second_hand',
      ),
      source: 'unavailable',
    },
    finish('furniture', '都买到了'),
  ],
};
