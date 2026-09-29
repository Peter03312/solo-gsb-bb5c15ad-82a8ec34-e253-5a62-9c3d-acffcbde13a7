'use strict';

/* 多设备事件对时工具前端逻辑：收集设备配置 → 调 /api/sync → 渲染统一时间线 */

const devicesEl = document.getElementById('devices');
const tpl = document.getElementById('tpl-device');
const statusEl = document.getElementById('status');
const resultPanel = document.getElementById('result-panel');
const summaryEl = document.getElementById('summary');
const errorsEl = document.getElementById('errors');
const tbody = document.getElementById('timeline-body');
const chkHideExtrapolated = document.getElementById('chk-hide-extrapolated');
const chkOnlyUncertain = document.getElementById('chk-only-uncertain');
const chkCompact = document.getElementById('chk-compact');
const windowStartEl = document.getElementById('window-start');
const windowEndEl = document.getElementById('window-end');
const windowStatusEl = document.getElementById('window-status');
const windowCountsEl = document.getElementById('window-counts');
const pairLinkFieldEl = document.getElementById('pair-link-field');
const pairStatusFieldEl = document.getElementById('pair-status-field');
const pairStartValueEl = document.getElementById('pair-start-value');
const pairEndValueEl = document.getElementById('pair-end-value');
const pairStatusEl = document.getElementById('pair-status');
const pairSummaryEl = document.getElementById('pair-summary');
const pairBodyEl = document.getElementById('pair-body');

const WINDOW_CLASS_LABELS = { hit: '确定命中', partial: '可能命中', miss: '未命中' };
const WINDOW_CLASS_BADGES = { hit: 'badge-hit', partial: 'badge-partial', miss: 'badge-miss' };
const PAIR_STATUS_LABELS = {
  paired: '已配对',
  unpaired: '未配对',
  ambiguous: '歧义',
  conflict: '时间冲突',
};
const PAIR_STATUS_BADGES = {
  paired: 'badge-paired',
  unpaired: 'badge-unpaired',
  ambiguous: 'badge-ambiguous',
  conflict: 'badge-conflict',
};

let lastResult = null;
let lastPairResult = null;

function addDevice(data) {
  const node = tpl.content.cloneNode(true);
  const root = node.querySelector('.device');
  root.querySelector('.btn-remove').addEventListener('click', () => root.remove());
  if (data) {
    root.querySelector('.device-name').value = data.name || '';
    root.querySelector('.device-timefield').value = data.timeField || '';
    root.querySelector('.device-anchors').value = data.anchors || '';
    root.querySelector('.device-events').value = data.events || '';
  }
  devicesEl.appendChild(node);
  return root;
}

function setStatus(msg, cls) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

/** 解析锚点文本：每行 "本地时间, 基准时间[, ±误差毫秒]"（也支持 -> 或 Tab 分隔，# 开头为注释）。 */
function parseAnchorLines(text) {
  const anchors = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/\s*(?:,|->|\t)\s*/);
    if (parts.length < 2 || parts.length > 3) {
      errors.push({ line: idx + 1, message: '格式应为：本地时间, 基准时间[, ±误差毫秒]' });
      return;
    }
    const anchor = { local: parts[0], ref: parts[1] };
    if (parts.length === 3) {
      const errText = parts[2].replace(/^[±+]\s*/, '').trim();
      if (!/^\d+(\.\d+)?$/.test(errText)) {
        errors.push({ line: idx + 1, message: `误差须为非负毫秒数（得到 "${parts[2]}"）` });
        return;
      }
      anchor.err = Number(errText);
    }
    anchors.push(anchor);
  });
  return { anchors, errors };
}

function collectDevices() {
  const devices = [];
  const problems = [];
  document.querySelectorAll('.device').forEach((el, i) => {
    const name = el.querySelector('.device-name').value.trim() || `设备 ${i + 1}`;
    const timeField = el.querySelector('.device-timefield').value.trim();
    const { anchors, errors } = parseAnchorLines(el.querySelector('.device-anchors').value);
    for (const e of errors) {
      problems.push(`[${name}] 锚点第 ${e.line} 行：${e.message}`);
    }
    devices.push({
      name,
      timeField,
      anchors,
      eventsText: el.querySelector('.device-events').value,
    });
  });
  return { devices, problems };
}

async function doSync() {
  const { devices, problems } = collectDevices();
  if (devices.length === 0) {
    setStatus('请先添加至少 1 台设备', 'error');
    return;
  }
  if (problems.length > 0) {
    setStatus(problems.join('；'), 'error');
    return;
  }
  setStatus('校时中…');
  try {
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(data.error || `请求失败（HTTP ${resp.status}）`, 'error');
      return;
    }
    lastResult = data;
    clearWindowSearch();
    clearPairResults();
    renderResult(data);
    setStatus(`完成：${data.eventCount} 条事件已合并`, 'ok');
  } catch (err) {
    setStatus(`请求出错：${err.message}`, 'error');
  }
}

function fmtIso(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

function renderResult(data) {
  resultPanel.classList.remove('hidden');

  summaryEl.innerHTML = '';
  const items = [
    ['设备数', data.deviceCount],
    ['事件总数', data.eventCount],
    ['外推事件', data.extrapolatedCount],
    ['顺序不确定', data.orderUncertainCount],
    ['生成时间', new Date(data.generatedAt).toLocaleString()],
  ];
  for (const [label, value] of items) {
    const span = document.createElement('span');
    const isWarn = (label === '外推事件' || label === '顺序不确定') && value > 0;
    span.innerHTML = `${label}：<strong class="${isWarn ? 'warn' : ''}">${value}</strong>`;
    summaryEl.appendChild(span);
  }

  const allErrors = []
    .concat((data.errors || []).map((e) => `[${e.device}] 事件 ${e.index + 1}：${e.message}`))
    .concat((data.parseErrors || []).map((e) => `[${e.device}] JSONL 第 ${e.line} 行：${e.message}`));
  if (allErrors.length > 0) {
    errorsEl.classList.remove('hidden');
    errorsEl.innerHTML = allErrors.map((e) => `<div>⚠ ${escapeHtml(e)}</div>`).join('');
  } else {
    errorsEl.classList.add('hidden');
    errorsEl.innerHTML = '';
  }

  renderTable();
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setWindowStatus(msg, cls) {
  windowStatusEl.textContent = msg || '';
  windowStatusEl.className = 'status' + (cls ? ' ' + cls : '');
}

/** 时间窗检索：把当前时间线发给服务端按校正区间分类；窗口非法/缺失/倒置时仅提示，不改动上次结果。 */
async function doWindowSearch() {
  if (!lastResult) {
    setWindowStatus('请先执行“校时并合并”生成统一时间线', 'error');
    return;
  }
  try {
    const resp = await fetch('/api/window-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        windowStart: windowStartEl.value,
        windowEnd: windowEndEl.value,
        timeline: lastResult.timeline,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setWindowStatus(data.error || `检索失败（HTTP ${resp.status}）`, 'error');
      return;
    }
    lastResult.timeline.forEach((entry, i) => {
      entry.windowClass = data.classes[i] || null;
    });
    renderWindowCounts(data.counts);
    setWindowStatus(`窗口：${fmtIso(data.window.startMs)} ~ ${fmtIso(data.window.endMs)}`, 'ok');
    renderTable();
  } catch (err) {
    setWindowStatus(`检索出错：${err.message}`, 'error');
  }
}

function renderWindowCounts(counts) {
  windowCountsEl.classList.remove('hidden');
  windowCountsEl.innerHTML =
    `<span>确定命中：<strong class="wc-hit">${counts.hit}</strong></span>` +
    `<span>可能命中：<strong class="wc-partial">${counts.partial}</strong></span>` +
    `<span>未命中：<strong class="wc-miss">${counts.miss}</strong></span>`;
}

/** 清除时间窗检索结果（保留输入框内容，便于调整起止后重新检索）。 */
function clearWindowSearch() {
  if (lastResult) {
    lastResult.timeline.forEach((entry) => {
      delete entry.windowClass;
    });
  }
  windowCountsEl.classList.add('hidden');
  windowCountsEl.innerHTML = '';
  setWindowStatus('');
  renderTable();
}

function setPairStatus(msg, cls) {
  pairStatusEl.textContent = msg || '';
  pairStatusEl.className = 'status' + (cls ? ' ' + cls : '');
}

/**
 * 操作配对分析：把当前时间线与字段/状态配置发给服务端，按校正区间求跨设备耗时。
 * 参数非法（字段名空缺、两状态值相同）时服务端返回 400，仅提示错误，保留上次分析结果。
 */
async function doPairAnalyze() {
  if (!lastResult) {
    setPairStatus('请先执行“校时并合并”生成统一时间线', 'error');
    return;
  }
  const linkField = pairLinkFieldEl.value.trim();
  const statusField = pairStatusFieldEl.value.trim();
  const startValue = pairStartValueEl.value;
  const endValue = pairEndValueEl.value;
  if (!linkField) {
    setPairStatus('请填写关联字段名', 'error');
    return;
  }
  if (!statusField) {
    setPairStatus('请填写状态字段名', 'error');
    return;
  }
  if (startValue === '' || endValue === '') {
    setPairStatus('请填写开始状态值与结束状态值', 'error');
    return;
  }
  if (startValue === endValue) {
    setPairStatus('开始状态值与结束状态值不能相同', 'error');
    return;
  }
  try {
    const resp = await fetch('/api/operation-duration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        linkField,
        statusField,
        startValue,
        endValue,
        timeline: lastResult.timeline,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setPairStatus(data.error || `分析失败（HTTP ${resp.status}）`, 'error');
      return;
    }
    lastPairResult = data;
    renderPairResult(data);
    setPairStatus(
      `扫描 ${data.scanned} 条事件：已配对 ${data.counts.paired} 组，跳过 ${data.skipped} 条`,
      'ok'
    );
  } catch (err) {
    setPairStatus(`分析出错：${err.message}`, 'error');
  }
}

/** 清除配对分析结果（保留四个输入框内容，便于调整后重新分析）。 */
function clearPairResults() {
  lastPairResult = null;
  pairSummaryEl.classList.add('hidden');
  pairSummaryEl.innerHTML = '';
  pairBodyEl.innerHTML = '';
  setPairStatus('');
}

function renderPairResult(data) {
  const c = data.counts;
  pairSummaryEl.classList.remove('hidden');
  pairSummaryEl.innerHTML =
    `<span>已配对：<strong class="wc-hit">${c.paired}</strong></span>` +
    `<span>未配对：<strong class="wc-miss">${c.unpaired}</strong></span>` +
    `<span>歧义：<strong class="wc-partial">${c.ambiguous}</strong></span>` +
    `<span>时间冲突：<strong style="color:var(--danger)">${c.conflict}</strong></span>` +
    `<span>跳过事件：<strong>${data.skipped}</strong>` +
    `（缺字段 ${data.skippedMissingField}，状态不匹配 ${data.skippedStatusMismatch}）</span>`;

  pairBodyEl.innerHTML = '';
  if (data.groups.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="dur-none">没有可分组的事件：所有事件均因缺字段或状态不匹配被跳过（共 ${data.skipped} 条）</td>`;
    pairBodyEl.appendChild(tr);
    return;
  }
  data.groups.forEach((g) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="pair-key">${escapeHtml(formatLinkValue(g.linkValue))}</td>` +
      `<td>${renderPairStatus(g)}</td>` +
      `<td>${renderPairSide(g.starts, g.startCount)}</td>` +
      `<td>${renderPairSide(g.ends, g.endCount)}</td>` +
      `<td>${renderPairDuration(g)}</td>`;
    pairBodyEl.appendChild(tr);
  });
}

function renderPairStatus(group) {
  const badge =
    `<span class="badge ${PAIR_STATUS_BADGES[group.status]}">${PAIR_STATUS_LABELS[group.status]}</span>`;
  if (group.status === 'paired' && group.crossDevice) {
    return `${badge}<span class="badge badge-cross" title="开始与结束来自不同设备">跨设备</span>`;
  }
  let note = '';
  if (group.status === 'unpaired') {
    note = `<div class="dur-none">缺${group.startCount === 0 ? '开始' : '结束'}端</div>`;
  } else if (group.status === 'ambiguous') {
    note = `<div class="dur-none">开始 ${group.startCount} 条 / 结束 ${group.endCount} 条</div>`;
  }
  return badge + note;
}

function renderPairSide(events, count) {
  if (count === 0) return '<span class="dur-none">—</span>';
  if (count > 1) return `<span class="dur-none">${count} 条候选（不配对）</span>`;
  const e = events[0];
  return (
    `<div class="pair-interval"><span class="dev">${escapeHtml(e.device)}</span></div>` +
    `<div class="pair-interval">${escapeHtml(fmtIso(e.correctedEarliest))}</div>` +
    `<div class="pair-interval">${escapeHtml(fmtIso(e.correctedLatest))}</div>`
  );
}

function renderPairDuration(group) {
  if (group.status !== 'paired') {
    return '<span class="dur-none">不输出时长</span>';
  }
  return (
    `<div class="dur-paired">${formatDuration(group.durationMinMs)} ~ ${formatDuration(group.durationMaxMs)}</div>` +
    `<div class="dur-none">${group.durationMinMs} ~ ${group.durationMaxMs} ms</div>`
  );
}

/** 关联值展示：对象/数组给 JSON；数字/布尔原样；null 与空串显式标出。 */
function formatLinkValue(value) {
  if (value === null) return 'null';
  if (value === '') return '（空字符串）';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 把毫秒数格式化为便于阅读的时长（不足 1 ms 保留小数，长时长带 s/min 换算）。 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${Math.round(ms) / 1000} s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min} min ${sec} s`;
}

function renderTable() {
  if (!lastResult) return;
  const hideExtrapolated = chkHideExtrapolated.checked;
  const onlyUncertain = chkOnlyUncertain.checked;
  tbody.innerHTML = '';
  let visible = 0;
  lastResult.timeline.forEach((entry) => {
    if (hideExtrapolated && entry.extrapolated) return;
    if (onlyUncertain && !entry.orderUncertain) return;
    visible++;
    const tr = document.createElement('tr');
    if (entry.extrapolated) tr.classList.add('extrapolated');
    if (entry.orderUncertain) tr.classList.add('uncertain');

    const badges = [
      entry.extrapolated
        ? `<span class="badge badge-warn">${entry.extrapolated === 'before' ? '区间前' : '区间后'}</span>`
        : '<span class="badge badge-ok">内插</span>',
    ];
    if (entry.orderUncertain) {
      badges.push('<span class="badge badge-uncertain">顺序不确定</span>');
    }
    if (entry.windowClass) {
      badges.push(
        `<span class="badge ${WINDOW_CLASS_BADGES[entry.windowClass]}">${WINDOW_CLASS_LABELS[entry.windowClass]}</span>`
      );
    }

    tr.innerHTML =
      `<td class="mono">${visible}</td>` +
      `<td>${escapeHtml(entry.device)}</td>` +
      `<td class="mono col-raw">${escapeHtml(fmtIso(entry.rawTime))}</td>` +
      `<td class="mono">${escapeHtml(fmtIso(entry.correctedTime))}</td>` +
      `<td class="range-cell">${renderRange(entry)}</td>` +
      `<td>${badges.join(' ')}</td>` +
      `<td class="event-cell">${escapeHtml(JSON.stringify(entry.event))}</td>`;
    tbody.appendChild(tr);
  });
}

/** 渲染校正区间 [最早, 最晚]；误差为 0 时区间退化为点，仅显示 ±0。 */
function renderRange(entry) {
  if (!entry.uncertaintyMs) return '<span class="muted">±0 ms</span>';
  return (
    `<div>${escapeHtml(fmtIso(entry.correctedEarliest))}</div>` +
    `<div>${escapeHtml(fmtIso(entry.correctedLatest))}</div>` +
    `<div class="muted">±${entry.uncertaintyMs} ms</div>`
  );
}

function exportJsonl() {
  if (!lastResult || !lastResult.jsonl) return;
  const blob = new Blob([lastResult.jsonl + '\n'], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `merged-timeline-${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadSample() {
  devicesEl.innerHTML = '';
  addDevice({
    name: 'switch-A',
    timeField: 'ts',
    anchors: [
      '# 本地时间, 基准时间, ±误差毫秒（可选）',
      '2026-09-21T10:00:00.000Z, 2026-09-21T10:00:02.500Z, 1000',
      '2026-09-21T10:10:00.000Z, 2026-09-21T10:10:02.000Z, 1000',
    ].join('\n'),
    events: [
      '{"ts":"2026-09-21T09:59:50.000Z","level":"INFO","msg":"boot","opId":"T-100","phase":"START"}',
      '{"ts":"2026-09-21T10:00:05.000Z","level":"ERROR","msg":"port 3 link down","opId":"T-200","phase":"START"}',
      '{"ts":"2026-09-21T10:05:00.000Z","level":"WARN","msg":"crc errors rising"}',
      '{"ts":"2026-09-21T10:10:05.000Z","level":"INFO","msg":"snmp poll ok","opId":"T-100","phase":"END"}',
    ].join('\n'),
  });
  addDevice({
    name: 'server-B',
    timeField: '',
    anchors: [
      '2026-09-21T10:00:10.000Z, 2026-09-21T10:00:05.000Z, 1000',
      '2026-09-21T10:10:10.000Z, 2026-09-21T10:10:04.500Z, 1000',
    ].join('\n'),
    events: [
      '{"time":"2026-09-21T10:00:12.000Z","level":"INFO","msg":"nic flap detected","opId":"T-300","phase":"START"}',
      '{"time":"2026-09-21T10:05:10.000Z","level":"ERROR","msg":"retransmit timeout","opId":"T-200","phase":"END"}',
      '{"time":"2026-09-21T10:10:20.000Z","level":"INFO","msg":"backup finished","opId":"T-100","phase":"DONE"}',
    ].join('\n'),
  });
  setStatus('已载入示例（含 ±误差锚点，可演示“顺序不确定”标记），可直接点击“校时并合并”；合并后可在“操作配对”中输入关联字段 opId、状态字段 phase、状态值 START / END', 'ok');
}

document.getElementById('btn-add-device').addEventListener('click', () => addDevice());
document.getElementById('btn-sample').addEventListener('click', loadSample);
document.getElementById('btn-sync').addEventListener('click', doSync);
document.getElementById('btn-export').addEventListener('click', exportJsonl);
document.getElementById('btn-window-search').addEventListener('click', doWindowSearch);
document.getElementById('btn-window-clear').addEventListener('click', clearWindowSearch);
document.getElementById('btn-pair-analyze').addEventListener('click', doPairAnalyze);
document.getElementById('btn-pair-clear').addEventListener('click', clearPairResults);
[pairLinkFieldEl, pairStatusFieldEl, pairStartValueEl, pairEndValueEl].forEach((el) =>
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doPairAnalyze();
  })
);
[windowStartEl, windowEndEl].forEach((el) =>
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doWindowSearch();
  })
);
chkHideExtrapolated.addEventListener('change', renderTable);
chkOnlyUncertain.addEventListener('change', renderTable);
chkCompact.addEventListener('change', () => {
  document.body.classList.toggle('compact', chkCompact.checked);
});

// 初始给一台空设备
addDevice();
