'use strict';

const path = require('path');
const express = require('express');
const {
  parseJsonl,
  mergeTimeline,
  toJsonl,
  normalizeWindow,
  classifyWindow,
  normalizePairingParams,
  analyzeOperationPairs,
  AUTO_TIME_FIELDS,
} = require('./lib/timesync');

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/sync
 * body: { devices: [{ name, timeField?, anchors: [{local, ref}], eventsText }] }
 * eventsText 为 JSONL 原文；服务端解析、校时、合并后返回统一时间线与可下载的 JSONL。
 */
app.post('/api/sync', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.devices) || body.devices.length === 0) {
    return res.status(400).json({ error: '至少需要 1 台设备' });
  }
  if (body.devices.length > 50) {
    return res.status(400).json({ error: '设备数量超过上限（50）' });
  }

  // 先解析各设备 JSONL，解析错误不阻断，随结果返回
  const devices = [];
  const parseErrors = [];
  for (const d of body.devices) {
    const name = (d && typeof d.name === 'string' ? d.name.trim() : '') || '未命名设备';
    const { events, errors } = parseJsonl(d && d.eventsText);
    for (const e of errors) parseErrors.push({ device: name, ...e });
    devices.push({
      name,
      timeField: typeof d.timeField === 'string' && d.timeField.trim() ? d.timeField.trim() : undefined,
      anchors: Array.isArray(d.anchors) ? d.anchors : [],
      events,
    });
  }

  let merged;
  try {
    merged = mergeTimeline(devices);
  } catch (err) {
    return res.status(422).json({ error: err.message, parseErrors });
  }

  merged.parseErrors = parseErrors;
  merged.jsonl = toJsonl(merged);
  res.json(merged);
});

/** POST /api/parse-anchors：前端实时校验锚点文本（每行 "本地时间, 基准时间[, ±误差毫秒]"）。 */
app.post('/api/parse-anchors', (req, res) => {
  const text = (req.body && req.body.text) || '';
  const anchors = [];
  const errors = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return;
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
  res.json({ anchors, errors });
});

/**
 * POST /api/window-search
 * body: { windowStart, windowEnd, timeline: [{ correctedEarliest, correctedLatest, ... }] }
 * 时间窗检索：把每条事件的校正区间与窗口做区间相交判断，返回三类计数
 * （确定命中/可能命中/未命中）及每条事件（按提交顺序）的类别。
 * 窗口起止缺失、无法解析或起点晚于终点时返回 400 及中文错误，调用方不应改动已有结果。
 */
app.post('/api/window-search', (req, res) => {
  const body = req.body || {};
  let window;
  try {
    window = normalizeWindow(body.windowStart, body.windowEnd);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const timeline = Array.isArray(body.timeline) ? body.timeline : [];
  const { counts, results } = classifyWindow(timeline, window.startMs, window.endMs);
  res.json({
    window: { startMs: window.startMs, endMs: window.endMs },
    counts,
    classes: results.map((r) => r.windowClass),
  });
});

/**
 * POST /api/operation-duration
 * body: { linkField, statusField, startValue, endValue, timeline }
 * 操作配对分析：在 /api/sync 产出的时间线上，按关联字段把同一次操作的开始/结束事件
 * 配对，用两端的校正区间求跨设备耗时范围（最短/最长，毫秒）。
 * 字段名空缺或开始/结束状态值相同时返回 400 及中文错误，调用方不应改动上次分析结果。
 * 缺字段或状态不匹配的事件跳过并计数；未配对、歧义、时间冲突的组不输出时长。
 */
app.post('/api/operation-duration', (req, res) => {
  const body = req.body || {};
  let params;
  try {
    params = normalizePairingParams(body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const timeline = Array.isArray(body.timeline) ? body.timeline : [];
  const result = analyzeOperationPairs(timeline, params);
  result.params = params;
  res.json(result);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, autoTimeFields: AUTO_TIME_FIELDS }));

app.listen(PORT, () => {
  console.log(`多设备事件对时工具已启动: http://localhost:${PORT}`);
});
