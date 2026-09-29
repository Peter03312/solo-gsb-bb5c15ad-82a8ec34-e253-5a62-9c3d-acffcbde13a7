'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTime,
  normalizeAnchors,
  correctTime,
  mergeTimeline,
  parseJsonl,
  toJsonl,
  normalizeWindow,
  classifyWindow,
  normalizePairingParams,
  analyzeOperationPairs,
} = require('../lib/timesync');

const A = (iso) => Date.parse(iso);

test('parseTime 支持 epoch 毫秒与 ISO 字符串', () => {
  assert.equal(parseTime(1000), 1000);
  assert.equal(parseTime('1000'), 1000);
  assert.equal(parseTime('1970-01-01T00:00:01.000Z'), 1000);
  assert.ok(Number.isNaN(parseTime('not-a-time')));
  assert.ok(Number.isNaN(parseTime('')));
});

test('normalizeAnchors 拒绝本地时间倒序或重复', () => {
  assert.throws(
    () => normalizeAnchors([
      { local: 2000, ref: 2000 },
      { local: 1000, ref: 3000 },
    ]),
    /本地时间倒序/
  );
  assert.throws(
    () => normalizeAnchors([
      { local: 1000, ref: 1000 },
      { local: 1000, ref: 2000 },
    ]),
    /本地时间倒序/
  );
});

test('normalizeAnchors 拒绝基准时间倒序或重复', () => {
  assert.throws(
    () => normalizeAnchors([
      { local: 1000, ref: 5000 },
      { local: 2000, ref: 4000 },
    ]),
    /基准时间倒序/
  );
  assert.throws(
    () => normalizeAnchors([
      { local: 1000, ref: 5000 },
      { local: 2000, ref: 5000 },
    ]),
    /基准时间倒序/
  );
});

test('normalizeAnchors 拒绝空锚点与无法解析的时间', () => {
  assert.throws(() => normalizeAnchors([]), /至少需要 1 个/);
  assert.throws(() => normalizeAnchors([{ local: 'x', ref: 1 }]), /无法解析/);
});

test('分段线性校时：区间内插值', () => {
  const anchors = normalizeAnchors([
    { local: A('2026-09-21T10:00:00Z'), ref: A('2026-09-21T10:00:02Z') },
    { local: A('2026-09-21T10:10:00Z'), ref: A('2026-09-21T10:10:01Z') },
  ]);
  // 中点：本地 +5min -> 基准 10:05:01.5
  const mid = correctTime(A('2026-09-21T10:05:00Z'), anchors);
  assert.equal(mid.corrected, A('2026-09-21T10:05:01.500Z'));
  assert.equal(mid.extrapolated, null);
  // 锚点本身
  const onAnchor = correctTime(A('2026-09-21T10:00:00Z'), anchors);
  assert.equal(onAnchor.corrected, A('2026-09-21T10:00:02Z'));
  assert.equal(onAnchor.extrapolated, null);
});

test('分段线性校时：区间外按最近段斜率外推并标记', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 1000 },
    { local: 10000, ref: 11000 }, // 斜率 1，偏移 +1000
  ]);
  const before = correctTime(-5000, anchors);
  assert.equal(before.corrected, -4000);
  assert.equal(before.extrapolated, 'before');

  const after = correctTime(20000, anchors);
  assert.equal(after.corrected, 21000);
  assert.equal(after.extrapolated, 'after');
});

test('单锚点做平移，非锚点位置标记为外推', () => {
  const anchors = normalizeAnchors([{ local: 1000, ref: 5000 }]);
  assert.deepEqual(correctTime(1000, anchors), { corrected: 5000, uncertainty: 0, extrapolated: null });
  assert.deepEqual(correctTime(2000, anchors), { corrected: 6000, uncertainty: 0, extrapolated: 'after' });
  assert.deepEqual(correctTime(0, anchors), { corrected: 4000, uncertainty: 0, extrapolated: 'before' });
});

test('多段锚点使用各自区间的斜率', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0 },
    { local: 10000, ref: 10000 }, // 第一段斜率 1
    { local: 20000, ref: 30000 }, // 第二段斜率 2
  ]);
  assert.equal(correctTime(5000, anchors).corrected, 5000);
  assert.equal(correctTime(15000, anchors).corrected, 20000);
  // 尾部外推沿用第二段斜率 2
  const after = correctTime(25000, anchors);
  assert.equal(after.corrected, 40000);
  assert.equal(after.extrapolated, 'after');
});

test('mergeTimeline 合并多设备并按校正时间排序', () => {
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0 }, { local: 10000, ref: 10000 }],
      events: [{ ts: 5000, msg: 'a1' }, { ts: 20000, msg: 'a2-extrapolated' }],
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 1000 }, { local: 10000, ref: 11000 }],
      events: [{ ts: 1000, msg: 'b1' }],
    },
  ]);
  assert.equal(merged.eventCount, 3);
  assert.equal(merged.extrapolatedCount, 1);
  assert.deepEqual(
    merged.timeline.map((e) => e.correctedTime),
    [2000, 5000, 20000]
  );
  assert.equal(merged.timeline[2].extrapolated, 'after');
});

test('mergeTimeline 中任一设备锚点非法则整体抛错', () => {
  assert.throws(
    () => mergeTimeline([
      { name: 'ok', anchors: [{ local: 0, ref: 0 }], events: [] },
      { name: 'bad', anchors: [{ local: 5, ref: 5 }, { local: 1, ref: 6 }], events: [] },
    ]),
    /倒序/
  );
});

test('时间字段自动探测与指定字段', () => {
  const merged = mergeTimeline([
    {
      name: 'auto',
      anchors: [{ local: 0, ref: 0 }],
      events: [{ time: 1000 }, { timestamp: 2000 }],
    },
    {
      name: 'custom',
      timeField: 'localTime',
      anchors: [{ local: 0, ref: 0 }],
      events: [{ localTime: 3000 }],
    },
  ]);
  assert.equal(merged.eventCount, 3);
  assert.equal(merged.errors.length, 0);
});

test('缺少时间字段的事件记入 errors，不进入时间线', () => {
  const merged = mergeTimeline([
    { name: 'dev', anchors: [{ local: 0, ref: 0 }], events: [{ msg: 'no time' }] },
  ]);
  assert.equal(merged.eventCount, 0);
  assert.equal(merged.errors.length, 1);
});

test('parseJsonl 跳过空行并报告坏行', () => {
  const { events, errors } = parseJsonl('{"a":1}\n\nnot-json\n[1,2]\n{"b":2}');
  assert.equal(events.length, 2);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 3);
});

test('toJsonl 输出每行一个可解析的 JSON', () => {
  const merged = mergeTimeline([
    { name: 'dev', anchors: [{ local: 0, ref: 0 }], events: [{ ts: 0, msg: 'x' }] },
  ]);
  const lines = toJsonl(merged).split('\n');
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.device, 'dev');
  assert.equal(obj.correctedTimeMs, 0);
  assert.equal(obj.extrapolated, null);
  assert.deepEqual(obj.event, { ts: 0, msg: 'x' });
});

/* ---------- 时间不确定性：锚点 ±误差、校正区间与顺序不确定 ---------- */

test('normalizeAnchors 解析可选 ±误差，缺省按 0 处理', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0 },
    { local: 1000, ref: 1000, err: 50 },
    { local: 2000, ref: 2000, err: '75.5' },
    { local: 3000, ref: 3000, err: '±100' },
  ]);
  assert.deepEqual(anchors.map((a) => a.err), [0, 50, 75.5, 100]);
});

test('normalizeAnchors 拒绝负数或非数字误差并定位锚点序号', () => {
  assert.throws(
    () => normalizeAnchors([
      { local: 0, ref: 0 },
      { local: 1000, ref: 1000, err: -5 },
    ]),
    /第 2 个锚点的误差无效/
  );
  assert.throws(
    () => normalizeAnchors([
      { local: 0, ref: 0, err: 'abc' },
    ]),
    /第 1 个锚点的误差无效/
  );
  assert.throws(
    () => normalizeAnchors([{ local: 0, ref: 0, err: '-3' }]),
    /第 1 个锚点的误差无效/
  );
});

test('区间内不确定度按锚点误差线性插值', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0, err: 100 },
    { local: 10000, ref: 10000, err: 300 },
  ]);
  // 中点：误差 = (100 + 300) / 2 = 200
  const mid = correctTime(5000, anchors);
  assert.equal(mid.corrected, 5000);
  assert.equal(mid.uncertainty, 200);
  assert.equal(mid.extrapolated, null);
  // 锚点上不确定度等于该锚点误差
  assert.equal(correctTime(0, anchors).uncertainty, 100);
  assert.equal(correctTime(10000, anchors).uncertainty, 300);
});

test('外推时不确定度按区间算术随距离放大', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0, err: 100 },
    { local: 10000, ref: 10000, err: 300 },
  ]);
  // 首锚点之前半个段长：ratio = -0.5 -> |1.5|*100 + 0.5*300 = 300
  const before = correctTime(-5000, anchors);
  assert.equal(before.uncertainty, 300);
  assert.equal(before.extrapolated, 'before');
  // 末锚点之后一个段长：ratio = 2 -> 1*100 + 2*300 = 700
  const after = correctTime(20000, anchors);
  assert.equal(after.uncertainty, 700);
  assert.equal(after.extrapolated, 'after');
});

test('单锚点平移时不确定度保持不变', () => {
  const anchors = normalizeAnchors([{ local: 1000, ref: 5000, err: 250 }]);
  assert.equal(correctTime(1000, anchors).uncertainty, 250);
  assert.equal(correctTime(999999, anchors).uncertainty, 250);
});

test('correctDevice 输出校正区间（最早/最晚 = 中心值 ± 不确定半宽）', () => {
  const merged = mergeTimeline([
    {
      name: 'dev',
      anchors: [{ local: 0, ref: 0, err: 100 }, { local: 10000, ref: 10000, err: 100 }],
      events: [{ ts: 5000 }],
    },
  ]);
  const e = merged.timeline[0];
  assert.equal(e.correctedTime, 5000);
  assert.equal(e.uncertaintyMs, 100);
  assert.equal(e.correctedEarliest, 4900);
  assert.equal(e.correctedLatest, 5100);
  assert.equal(e.orderUncertain, false);
});

test('未填写误差按 0 处理：区间退化为点', () => {
  const merged = mergeTimeline([
    { name: 'dev', anchors: [{ local: 0, ref: 0 }, { local: 10000, ref: 10000 }], events: [{ ts: 5000 }] },
  ]);
  const e = merged.timeline[0];
  assert.equal(e.uncertaintyMs, 0);
  assert.equal(e.correctedEarliest, e.correctedTime);
  assert.equal(e.correctedLatest, e.correctedTime);
});

test('相邻事件校正区间相交时两侧都标记为顺序不确定', () => {
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0, err: 1000 }, { local: 10000, ref: 10000, err: 1000 }],
      events: [{ ts: 5000, msg: 'a' }], // 中心 5000，区间 [4000, 6000]
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 5500, err: 1000 }, { local: 10000, ref: 15500, err: 1000 }],
      events: [{ ts: 0, msg: 'b' }], // 中心 5500，区间 [4500, 6500]，与 a 相交
    },
  ]);
  assert.equal(merged.eventCount, 2);
  assert.equal(merged.orderUncertainCount, 2);
  assert.deepEqual(merged.timeline.map((e) => e.orderUncertain), [true, true]);
  // 排序仍按中心值
  assert.deepEqual(merged.timeline.map((e) => e.correctedTime), [5000, 5500]);
});

test('区间不相交的相邻事件不标记顺序不确定', () => {
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0, err: 100 }, { local: 10000, ref: 10000, err: 100 }],
      events: [{ ts: 1000, msg: 'a' }], // 区间 [900, 1100]
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 5000, err: 100 }, { local: 10000, ref: 15000, err: 100 }],
      events: [{ ts: 0, msg: 'b' }], // 区间 [4900, 5100]
    },
  ]);
  assert.equal(merged.orderUncertainCount, 0);
  assert.deepEqual(merged.timeline.map((e) => e.orderUncertain), [false, false]);
});

test('顺序不确定标记沿相邻链传播（1-2 与 2-3 相交 -> 三条都标记）', () => {
  const mk = (name, offset) => ({
    name,
    anchors: [{ local: 0, ref: offset, err: 600 }, { local: 10000, ref: offset + 10000, err: 600 }],
    events: [{ ts: 0 }],
  });
  // 中心值 0 / 1000 / 2000，半宽 600：相邻两两相交，1 与 3 不相交
  const merged = mergeTimeline([mk('a', 0), mk('b', 1000), mk('c', 2000)]);
  assert.equal(merged.orderUncertainCount, 3);
  assert.deepEqual(merged.timeline.map((e) => e.orderUncertain), [true, true, true]);
});

test('toJsonl 包含校正区间与顺序不确定标记', () => {
  const merged = mergeTimeline([
    {
      name: 'dev',
      anchors: [{ local: 0, ref: 0, err: 500 }, { local: 10000, ref: 10000, err: 500 }],
      events: [{ ts: 2000, msg: 'x' }],
    },
  ]);
  const obj = JSON.parse(toJsonl(merged).split('\n')[0]);
  assert.equal(obj.correctedTimeMs, 2000);
  assert.equal(obj.correctedEarliestMs, 1500);
  assert.equal(obj.correctedLatestMs, 2500);
  assert.equal(obj.uncertaintyMs, 500);
  assert.equal(obj.orderUncertain, false);
  assert.equal(obj.correctedEarliest, new Date(1500).toISOString());
  assert.equal(obj.correctedLatest, new Date(2500).toISOString());
});

/* ---------- 时间窗检索：窗口解析与区间相交分类 ---------- */

test('normalizeWindow 支持 ISO 8601 与 epoch 毫秒（数字或数字字符串）', () => {
  const start = Date.parse('2026-09-21T10:00:00.000Z');
  const end = Date.parse('2026-09-21T11:00:00.000Z');
  assert.deepEqual(
    normalizeWindow('2026-09-21T10:00:00.000Z', '2026-09-21T11:00:00.000Z'),
    { startMs: start, endMs: end }
  );
  assert.deepEqual(normalizeWindow(start, end), { startMs: start, endMs: end });
  assert.deepEqual(normalizeWindow(String(start), String(end)), { startMs: start, endMs: end });
  // 起点等于终点：合法（点窗口）
  assert.deepEqual(normalizeWindow(start, start), { startMs: start, endMs: start });
});

test('normalizeWindow 拒绝缺失、无法解析或起点晚于终点', () => {
  assert.throws(() => normalizeWindow('', 1000), /请填写时间窗起点/);
  assert.throws(() => normalizeWindow(undefined, 1000), /请填写时间窗起点/);
  assert.throws(() => normalizeWindow(null, 1000), /请填写时间窗起点/);
  assert.throws(() => normalizeWindow('  ', 1000), /请填写时间窗起点/);
  assert.throws(() => normalizeWindow(1000, ''), /请填写时间窗终点/);
  assert.throws(() => normalizeWindow(1000, undefined), /请填写时间窗终点/);
  assert.throws(() => normalizeWindow('not-a-time', 1000), /时间窗起点无法解析/);
  assert.throws(() => normalizeWindow(1000, 'xyz'), /时间窗终点无法解析/);
  assert.throws(() => normalizeWindow(2000, 1000), /起点晚于终点/);
});

test('classifyWindow 按校正区间与窗口的相交关系分三类并计数', () => {
  const mk = (earliest, latest) => ({ correctedEarliest: earliest, correctedLatest: latest });
  const entries = [
    mk(1500, 2500), // 完整在窗内 -> 确定命中
    mk(500, 1500), // 左缘部分相交 -> 可能命中
    mk(2500, 3500), // 右缘部分相交 -> 可能命中
    mk(0, 9999), // 包住整个窗口 -> 可能命中
    mk(0, 500), // 不相交 -> 未命中
    mk(3500, 4000), // 不相交 -> 未命中
    mk(2000, 2000), // 点事件在窗内 -> 确定命中
    mk(1000, 1000), // 点事件恰在窗口起点（边界算相交）-> 确定命中
  ];
  const { counts, results } = classifyWindow(entries, 1000, 3000);
  assert.deepEqual(counts, { hit: 3, partial: 3, miss: 2 });
  assert.deepEqual(
    results.map((r) => r.windowClass),
    ['hit', 'partial', 'partial', 'partial', 'miss', 'miss', 'hit', 'hit']
  );
  assert.deepEqual(results.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('classifyWindow 可直接作用于 mergeTimeline 的时间线条目且不改动原条目', () => {
  const merged = mergeTimeline([
    {
      name: 'dev',
      anchors: [{ local: 0, ref: 0, err: 100 }, { local: 10000, ref: 10000, err: 100 }],
      events: [{ ts: 5000 }, { ts: 9000 }],
    },
  ]);
  // 两条事件的校正区间分别为 [4900, 5100] 与 [8900, 9100]
  const before = JSON.stringify(merged.timeline);
  const { counts, results } = classifyWindow(merged.timeline, 4950, 9200);
  assert.deepEqual(results.map((r) => r.windowClass), ['partial', 'hit']);
  assert.deepEqual(counts, { hit: 1, partial: 1, miss: 0 });
  assert.equal(JSON.stringify(merged.timeline), before);
});

test('classifyWindow 空时间线返回全零计数', () => {
  const { counts, results } = classifyWindow([], 0, 1000);
  assert.deepEqual(counts, { hit: 0, partial: 0, miss: 0 });
  assert.deepEqual(results, []);
});

/* ---------- 操作配对 / 跨设备耗时：分组、跳过与区间耗时 ---------- */

/** 构造与 mergeTimeline 同构的时间线条目（区间为点或 [lo, hi]）。 */
function mkEntry(device, event, lo, hi) {
  const mid = lo === hi ? lo : (lo + hi) / 2;
  return {
    device,
    rawTime: mid,
    correctedTime: mid,
    uncertaintyMs: (hi - lo) / 2,
    correctedEarliest: lo,
    correctedLatest: hi,
    orderUncertain: false,
    extrapolated: null,
    event,
  };
}

test('normalizePairingParams 校验字段名空缺与两状态值相同', () => {
  assert.throws(() => normalizePairingParams({}), /请填写关联字段名/);
  assert.throws(() => normalizePairingParams({ linkField: '  ' }), /请填写关联字段名/);
  assert.throws(
    () => normalizePairingParams({ linkField: 'opId' }),
    /请填写状态字段名/
  );
  assert.throws(
    () => normalizePairingParams({ linkField: 'opId', statusField: 'phase' }),
    /请填写开始状态值/
  );
  assert.throws(
    () => normalizePairingParams({ linkField: 'opId', statusField: 'phase', startValue: 'S' }),
    /请填写结束状态值/
  );
  assert.throws(
    () => normalizePairingParams({ linkField: 'opId', statusField: 'phase', startValue: 'S', endValue: 'S' }),
    /不能相同/
  );
  // 字段名去空白；状态值按字符串比较，"1" 与 1 视为同一状态
  assert.throws(
    () => normalizePairingParams({ linkField: 'opId', statusField: 'phase', startValue: 1, endValue: '1' }),
    /不能相同/
  );
  // 状态值不做去空白，"S " 与 "S" 是两个合法的不同状态
  const p = normalizePairingParams({
    linkField: ' opId ', statusField: 'phase', startValue: 'S ', endValue: 'E',
  });
  assert.deepEqual(p, { linkField: 'opId', statusField: 'phase', startValue: 'S ', endValue: 'E' });
});

test('同组恰有一条开始和一条结束才配对，缺一端为未配对', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 1000),
    mkEntry('B', { opId: 'x', phase: 'END' }, 2000, 2000),
    mkEntry('A', { opId: 'only-start', phase: 'START' }, 3000, 3000),
    mkEntry('B', { opId: 'only-end', phase: 'END' }, 4000, 4000),
  ];
  const { groups, counts, skipped } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.equal(skipped, 0);
  assert.deepEqual(counts, { paired: 1, unpaired: 2, ambiguous: 0, conflict: 0 });
  assert.equal(groups.length, 3);
  assert.equal(groups[0].status, 'paired');
  assert.equal(groups[0].durationMinMs, 1000);
  assert.equal(groups[0].durationMaxMs, 1000);
  assert.equal(groups[0].crossDevice, true);
  assert.equal(groups[1].status, 'unpaired');
  assert.equal(groups[1].startCount, 1);
  assert.equal(groups[1].endCount, 0);
  assert.equal(groups[1].durationMinMs, null);
  assert.equal(groups[2].status, 'unpaired');
  assert.equal(groups[2].startCount, 0);
  assert.equal(groups[2].endCount, 1);
});

test('任一端重复标歧义，不输出时长（含 1 对多与多对多）', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 1000),
    mkEntry('B', { opId: 'x', phase: 'START' }, 1100, 1100),
    mkEntry('B', { opId: 'x', phase: 'END' }, 2000, 2000),
    mkEntry('A', { opId: 'y', phase: 'START' }, 1000, 1000),
    mkEntry('B', { opId: 'y', phase: 'START' }, 1100, 1100),
    mkEntry('A', { opId: 'y', phase: 'END' }, 2000, 2000),
    mkEntry('B', { opId: 'y', phase: 'END' }, 2100, 2100),
  ];
  const { groups, counts } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.deepEqual(counts, { paired: 0, unpaired: 0, ambiguous: 2, conflict: 0 });
  for (const g of groups) {
    assert.equal(g.status, 'ambiguous');
    assert.equal(g.durationMinMs, null);
    assert.equal(g.durationMaxMs, null);
  }
  assert.equal(groups[0].startCount, 2);
  assert.equal(groups[0].endCount, 1);
  assert.equal(groups[1].startCount, 2);
  assert.equal(groups[1].endCount, 2);
});

test('缺字段或状态不匹配的事件跳过并分类计数', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 1000),
    mkEntry('A', { phase: 'END' }, 2000, 2000), // 缺关联字段
    mkEntry('A', { opId: 'y' }, 3000, 3000), // 缺状态字段
    mkEntry('B', { opId: 'z', phase: 'RETRY' }, 4000, 4000), // 状态不匹配
    mkEntry('B', { opId: 'x', phase: 'END' }, 5000, 5000),
  ];
  const { groups, counts, scanned, skipped, skippedMissingField, skippedStatusMismatch } =
    analyzeOperationPairs(entries, {
      linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
    });
  assert.equal(scanned, 5);
  assert.equal(skipped, 3);
  assert.equal(skippedMissingField, 2);
  assert.equal(skippedStatusMismatch, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].status, 'paired');
  assert.deepEqual(counts, { paired: 1, unpaired: 0, ambiguous: 0, conflict: 0 });
});

test('校正区间求耗时：区间分离时最短/最长为确定范围', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 1200),
    mkEntry('B', { opId: 'x', phase: 'END' }, 2000, 2500),
  ];
  const { groups } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  // 最短 = 2000 − 1200 = 800；最长 = 2500 − 1000 = 1500
  assert.equal(groups[0].status, 'paired');
  assert.equal(groups[0].durationMinMs, 800);
  assert.equal(groups[0].durationMaxMs, 1500);
});

test('区间相交时最短保留为零，最长仍给上界', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 2000),
    mkEntry('B', { opId: 'x', phase: 'END' }, 1500, 2600),
  ];
  const { groups } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  // max(0, 1500 − 2000) = 0；2600 − 1000 = 1600
  assert.equal(groups[0].status, 'paired');
  assert.equal(groups[0].durationMinMs, 0);
  assert.equal(groups[0].durationMaxMs, 1600);
});

test('边界相接不算冲突：结束最早等于开始最晚时最短为 0', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 2000),
    mkEntry('B', { opId: 'x', phase: 'END' }, 2000, 3000),
  ];
  const { groups, counts } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.equal(counts.conflict, 0);
  assert.equal(groups[0].status, 'paired');
  assert.equal(groups[0].durationMinMs, 0);
  assert.equal(groups[0].durationMaxMs, 2000);
});

test('结束最晚严格早于开始最早时标时间冲突且不输出时长', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 5000, 6000),
    mkEntry('B', { opId: 'x', phase: 'END' }, 3000, 4000),
  ];
  const { groups, counts } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.equal(groups[0].status, 'conflict');
  assert.equal(groups[0].durationMinMs, null);
  assert.equal(groups[0].durationMaxMs, null);
  assert.deepEqual(counts, { paired: 0, unpaired: 0, ambiguous: 0, conflict: 1 });
});

test('同设备配对 crossDevice=false，且组按首次出现顺序输出', () => {
  const entries = [
    mkEntry('A', { opId: 'second', phase: 'START' }, 2000, 2000),
    mkEntry('A', { opId: 'first', phase: 'START' }, 1000, 1000),
    mkEntry('A', { opId: 'first', phase: 'END' }, 1500, 1500),
    mkEntry('A', { opId: 'second', phase: 'END' }, 2600, 2600),
  ];
  const { groups } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.deepEqual(groups.map((g) => g.linkValue), ['second', 'first']);
  assert.equal(groups[0].crossDevice, false);
  assert.equal(groups[0].durationMinMs, 600);
});

test('关联值支持数字与对象；状态值按字符串匹配（数字状态 1 匹配 "1"）', () => {
  const entries = [
    mkEntry('A', { opId: 42, code: 1 }, 1000, 1000),
    mkEntry('B', { opId: 42, code: '2' }, 2000, 2000),
    mkEntry('A', { opId: { a: 1 }, code: '1' }, 3000, 3000),
    mkEntry('B', { opId: { a: 1 }, code: 2 }, 4000, 4000),
  ];
  const { groups, skipped } = analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'code', startValue: '1', endValue: 2,
  });
  assert.equal(skipped, 0);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].linkValue, 42);
  assert.equal(groups[0].durationMaxMs, 1000);
  assert.deepEqual(groups[1].linkValue, { a: 1 });
  assert.equal(groups[1].durationMaxMs, 1000);
});

test('analyzeOperationPairs 不改动传入时间线条目；空时间线返回零结果', () => {
  const entries = [
    mkEntry('A', { opId: 'x', phase: 'START' }, 1000, 1200),
    mkEntry('B', { opId: 'x', phase: 'END' }, 2000, 2200),
  ];
  const before = JSON.stringify(entries);
  analyzeOperationPairs(entries, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.equal(JSON.stringify(entries), before);

  const empty = analyzeOperationPairs([], {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.counts, { paired: 0, unpaired: 0, ambiguous: 0, conflict: 0 });
  assert.equal(empty.skipped, 0);
});

test('配对分析直接作用于 mergeTimeline 的时间线（端到端复用既有合并结果）', () => {
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0 }, { local: 10000, ref: 10000 }],
      events: [{ ts: 1000, opId: 'job', phase: 'START' }],
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 1000 }, { local: 10000, ref: 11000 }],
      events: [{ ts: 1000, opId: 'job', phase: 'END' }],
    },
  ]);
  const { groups } = analyzeOperationPairs(merged.timeline, {
    linkField: 'opId', statusField: 'phase', startValue: 'START', endValue: 'END',
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].status, 'paired');
  // A 校正 1000，B 校正 2000，均为点区间 -> 耗时 1000 ms
  assert.equal(groups[0].durationMinMs, 1000);
  assert.equal(groups[0].durationMaxMs, 1000);
  assert.equal(groups[0].start.device, 'dev-A');
  assert.equal(groups[0].end.device, 'dev-B');
});
