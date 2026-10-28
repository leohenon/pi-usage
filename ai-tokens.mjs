#!/usr/bin/env node
import { createReadStream, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVIDERS = { anthropic: 'claude', 'claude-agent-sdk': 'claude', openai: 'chat', 'openai-codex': 'chat' };
const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function calendarDay(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86400000;
}

export function tokenRecord(entry) {
  const message = entry.type === 'usage' ? { ...entry, role: 'assistant' } : entry.message;
  if (!['message', 'usage'].includes(entry.type) || message?.role !== 'assistant') return null;
  const provider = PROVIDERS[message.provider];
  if (!provider || !message.usage) return null;
  const usage = message.usage;
  // Pi normalizes these into disjoint categories, including cached input.
  let total = usage.totalTokens;
  if (!validNumber(total)) {
    const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
    if (!fields.every(validNumber)) return null;
    total = fields.reduce((sum, value) => sum + value, 0);
  }
  if (total <= 0) return null;
  const timestamp = message.timestamp ?? entry.timestamp;
  const date = new Date(timestamp);
  if (!timestamp || !Number.isFinite(date.getTime())) return null;
  // Forked session files can contain the same billed response. Never count it twice.
  const id = message.responseId
    ? `${provider}:${message.responseId}`
    : `${provider}:${entry.id ?? ''}:${date.toISOString()}:${message.model ?? ''}:${total}`;
  const started = new Date(message.timestamp).getTime();
  const completed = new Date(entry.timestamp).getTime();
  const interval = entry.type === 'message' && Number.isFinite(started) && Number.isFinite(completed) && completed > started
    ? [started, completed] : [];
  return [id, provider, dayKey(date), total, ...interval];
}

async function sessionFiles(directory, warnings) {
  const files = [];
  async function walk(path) {
    try {
      for (const item of await readdir(path, { withFileTypes: true })) {
        if (item.isDirectory()) await walk(join(path, item.name));
        else if (item.isFile() && item.name.endsWith('.jsonl')) files.push(join(path, item.name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || path !== directory) warnings.add('Some session directories could not be read.');
    }
  }
  await walk(directory);
  return files.sort();
}

export async function scanSessions(directory, cachePath) {
  const warnings = new Set();
  let cached = {};
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const data = JSON.parse(await readFile(cachePath, 'utf8'));
    if (data.version === 2 && data.timezone === timezone && data.directory === directory && data.files && typeof data.files === 'object') cached = data.files;
  } catch { /* Missing or corrupt cache is rebuilt from the source logs. */ }
  const files = await sessionFiles(directory, warnings);
  const next = {};
  const records = [];
  let firstActivity = null;
  for (const path of files) {
    try {
      const info = await stat(path);
      const previous = cached[path];
      if (previous?.size === info.size && previous.mtime === info.mtimeMs && Array.isArray(previous.records)) {
        for (const record of previous.records) records.push(record);
        next[path] = { size: previous.size, mtime: previous.mtime, records: previous.records, malformed: previous.malformed, firstActivity: previous.firstActivity };
        if (Number.isFinite(previous.firstActivity) && (firstActivity === null || previous.firstActivity < firstActivity)) firstActivity = previous.firstActivity;
        if (previous.malformed) warnings.add('Some malformed or incomplete log lines were skipped.');
        continue;
      }
      const parsed = [];
      let malformed = false;
      let firstEvent = null;
      const stream = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      // Surface stream failures through the async iterator, rather than an uncaught event.
      stream.on('error', () => lines.close());
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const timestamp = new Date(entry.timestamp).getTime();
            if (Number.isFinite(timestamp) && timestamp <= Date.now()) {
              if (firstEvent === null || timestamp < firstEvent) firstEvent = timestamp;
            }
            const record = tokenRecord(entry);
            if (record) {
              parsed.push(record);
            }
          } catch { malformed = true; }
        }
        if (stream.errored) throw stream.errored;
      } finally { stream.destroy(); }
      for (const record of parsed) records.push(record);
      if (firstEvent !== null && (firstActivity === null || firstEvent < firstActivity)) firstActivity = firstEvent;
      const after = await stat(path);
      if (after.size === info.size && after.mtimeMs === info.mtimeMs) {
        next[path] = { size: info.size, mtime: info.mtimeMs, records: parsed, malformed, firstActivity: firstEvent };
      }
      if (malformed) warnings.add('Some malformed or incomplete log lines were skipped.');
    } catch { warnings.add('Some session files could not be read.'); }
  }
  try {
    await mkdir(resolve(cachePath, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, timezone, directory, files: next }), { mode: 0o600 });
    await rename(temporary, cachePath);
  } catch { warnings.add('Token cache could not be saved; totals are still available.'); }
  return { records, firstActivity, files: files.length, warnings: [...warnings] };
}

export function summarize(records, now = new Date(), selection = 'both') {
  const providerKeys = selection === 'both' ? ['claude', 'chat'] : [selection === 'gpt' ? 'chat' : 'claude'];
  const emptyTotals = () => Object.fromEntries([...providerKeys, 'total'].map(key => [key, 0]));
  const today = dayKey(now);
  const month = `${today.slice(0, 7)}-01`;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const week = dayKey(monday);
  const seen = new Set();
  const unique = records.filter(([id, provider, date]) => providerKeys.includes(provider) && date <= today && !seen.has(id) && seen.add(id));
  const first = unique.reduce((start, record) => !start || record[2] < start ? record[2] : start, null);
  const periods = [ ['All time', first], ['This month', month], ['This week', week] ];
  const rows = periods.map(([label, start]) => {
    const totals = emptyTotals();
    for (const [, provider, date, tokens] of unique) {
      if (start && date >= start) {
        totals[provider] += tokens;
        totals.total += tokens;
      }
    }
    const days = start ? calendarDay(today) - calendarDay(start) + 1 : 0;
    const dailyAverage = Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, days ? total / days : 0]));
    return { label, start, end: today, days, totals, dailyAverage };
  });
  const daily = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    daily.push({ date: dayKey(date), ...emptyTotals() });
  }
  const byDate = new Map(daily.map(day => [day.date, day]));
  for (const [, provider, date, tokens] of unique) {
    const day = byDate.get(date);
    if (day) { day[provider] += tokens; day.total += tokens; }
  }
  const monthly = [];
  if (first) {
    const [year, month] = first.split('-').map(Number);
    const cursor = new Date(year, month - 1, 1);
    while (dayKey(cursor).slice(0, 7) <= today.slice(0, 7)) {
      monthly.push({ month: dayKey(cursor).slice(0, 7), ...emptyTotals() });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const byMonth = new Map(monthly.map(item => [item.month, item]));
    for (const [, provider, date, tokens] of unique) {
      const bucket = byMonth.get(date.slice(0, 7));
      bucket[provider] += tokens;
      bucket.total += tokens;
    }
  }
  return { selection, firstRecordedDay: first, responses: unique.length, periods: rows, daily, monthly };
}

export function intervalTotal(intervals, now = Date.now()) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start && end <= now)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, lastEnd = -Infinity;
  for (const [start, end] of sorted) {
    total += Math.max(0, end - Math.max(start, lastEnd));
    lastEnd = Math.max(lastEnd, end);
  }
  return total;
}

export function workingTime(scan, now = new Date()) {
  const modelIntervals = scan.records.filter(record => record.length === 6).map(record => [record[4], record[5]]);
  const first = scan.firstActivity === null ? null : dayKey(new Date(scan.firstActivity));
  return {
    since: first,
    days: first ? Math.max(0, calendarDay(dayKey(now)) - calendarDay(first)) : null,
    modelMs: modelIntervals.length ? intervalTotal(modelIntervals, now.getTime()) : null,
  };
}

function duration(milliseconds) {
  if (milliseconds === null) return 'unavailable';
  const minutes = Math.floor(milliseconds / 60000);
  if (!minutes) return '<1m';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, mins && `${mins}m`].filter(Boolean).join(' ');
}

export function renderSummary(summary, { color = false, width = 76 } = {}) {
  width = Math.max(24, Math.min(76, width));
  const inner = width - 6;
  const paint = (code, text) => color && code ? `\x1b[${code}m${text}\x1b[0m` : text;
  const compact = value => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const claudeColor = '38;5;173', chatColor = '38;5;79';
  const providers = [['claude', 'Claude', claudeColor, '█'], ['chat', 'GPT', chatColor, '▓']]
    .filter(([key]) => !summary.selection || summary.selection === 'both' || key === (summary.selection === 'gpt' ? 'chat' : 'claude'));
  const columns = providers.length === 2 ? [...providers, ['total', 'Total', '1']] : providers;
  const visible = text => text.replace(/\x1b\[[0-9;]*m/g, '').length;
  const border = text => paint('2', text);
  const lines = [border('╭' + '─'.repeat(width - 2) + '╮')];
  function row(text = '') {
    lines.push(border('│') + '  ' + text + ' '.repeat(Math.max(0, inner - visible(text))) + '  ' + border('│'));
  }
  function textRows(text, code = '') {
    // Plain-text wrapping keeps ANSI sequences and border alignment intact.
    const words = text.split(/\s+/);
    let line = '';
    for (let word of words) {
      if (line && line.length + word.length + 1 > inner) { row(paint(code, line)); line = ''; }
      while (word.length > inner) { row(paint(code, word.slice(0, inner))); word = word.slice(inner); }
      line += (line ? ' ' : '') + word;
    }
    if (line) row(paint(code, line));
  }
  row(paint('1', 'Token usage'));
  row();
  if (inner >= 46) {
    const labelWidth = 16, columnWidth = Math.floor((inner - labelWidth) / columns.length);
    row('Period'.padEnd(labelWidth) + columns.map(([, label, code]) => paint(code, label.padStart(columnWidth))).join(''));
    row(border('─'.repeat(inner)));
    for (const [index, period] of summary.periods.entries()) {
      if (index) row();
      const totals = columns.map(([key]) => period.totals[key]);
      row(period.label.padEnd(labelWidth) + totals.map((value, index) => paint(columns[index][0] === 'total' ? '1' : '', compact(value).padStart(columnWidth))).join(''));
      row(paint('2', '  avg / day'.padEnd(labelWidth) + columns.map(([key]) => period.dailyAverage[key])
        .map(value => compact(value).padStart(columnWidth)).join('')));
    }
  } else {
    for (const [index, period] of summary.periods.entries()) {
      if (index) row();
      textRows(period.label, '1');
      for (const [provider, label] of columns) {
        textRows(`${label}: ${compact(period.totals[provider])} · ${compact(period.dailyAverage[provider])}/day`);
      }
    }
  }
  if (summary.monthly?.length) {
    row();
    row(border('─'.repeat(inner)));
    const legend = providers.map(([, label, code, glyph]) => paint(code, `${glyph} ${label}`)).join('    ');
    if (inner >= 14 + visible(legend) + 4) row(paint('1', 'All-time usage') + ' '.repeat(inner - 14 - visible(legend)) + legend);
    else { textRows('All-time usage', '1'); row(); row(providers.map(([, label, code, glyph]) => paint(code, `${glyph} ${label}`)).join('  ')); }
    row();
    const max = Math.max(...summary.monthly.map(month => month.total), 0) * 1.2;
    const plotWidth = inner - 8, height = 10;
    const perPage = Math.max(1, Math.floor(plotWidth / 6));
    const fraction = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    for (let offset = 0; offset < summary.monthly.length; offset += perPage) {
      if (offset) row();
      const months = summary.monthly.slice(offset, offset + perPage);
      const slotWidth = Math.floor(plotWidth / months.length);
      const center = text => {
        const left = Math.floor((slotWidth - text.length) / 2);
        return ' '.repeat(Math.max(0, left)) + text + ' '.repeat(Math.max(0, slotWidth - left - text.length));
      };
      row(' '.repeat(8) + months.map(month => paint('2', center(compact(month.total)))).join(''));
      row();
      for (let level = height; level >= 1; level--) {
        const tick = [height, height / 2].includes(level) ? compact(max * level / height) : '';
        const bars = months.map(month => {
          const totalHeight = max ? month.total / max * height : 0;
          const claudeHeight = max ? (month.claude ?? 0) / max * height : 0;
          const bottom = level - 1;
          const coverage = Math.min(1, Math.max(0, totalHeight - bottom));
          const claudeCoverage = Math.min(coverage, Math.max(0, claudeHeight - bottom));
          const isClaude = claudeCoverage >= coverage - claudeCoverage;
          let glyph = ' ';
          if (coverage >= 1) glyph = isClaude ? '█' : '▓';
          else if (coverage > 0) glyph = fraction[Math.max(1, Math.round(coverage * 8))];
          const bar = glyph.repeat(Math.min(3, slotWidth - 2));
          return paint(isClaude ? claudeColor : chatColor, center(bar));
        }).join('');
        row(border(tick.padStart(7) + '│') + bars);
      }
      row(border('      0└' + '─'.repeat(slotWidth * months.length)));
      row(' '.repeat(8) + months.map(month => {
        const [year, monthNumber] = month.month.split('-').map(Number);
        const label = new Intl.DateTimeFormat('en', { month: 'short' }).format(new Date(year, monthNumber - 1, 1));
        return center(label);
      }).join(''));
      row(border(' '.repeat(8) + months.map(month => center(month.month.slice(0, 4))).join('')));
    }
  }
  row();
  row(border('─'.repeat(inner)));
  if (summary.time?.since) {
    textRows(`Using Pi for ${summary.time.days} days`, '2');
    textRows(`Model time (recorded): ${duration(summary.time.modelMs)}`, '2');
  }
  else if (!summary.firstRecordedDay) textRows('No recorded token usage found.', '2');
  for (const warning of summary.warnings ?? []) {
    if (!warning.includes('malformed')) textRows(warning, '33');
  }
  row();
  lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ai-tokens [--provider gpt|claude|both] [--json] [--no-color]\n\nClaude and OpenAI token totals from local Pi session logs.\nShows all-time, current calendar month/week, and average tokens per calendar day.\nWeek starts Monday. Includes cached input. No network requests.\nSources: $PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions.');
    return 0;
  }
  let selection = 'both';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--provider' && ['gpt', 'claude', 'both'].includes(args[index + 1])) {
      selection = args[++index];
    } else if (!['--json', '--no-color'].includes(argument)) {
      console.error('Usage: ai-tokens [--provider gpt|claude|both] [--json] [--no-color]');
      return 2;
    }
  }
  const directory = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'sessions');
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ai-tokens', 'sessions.json');
  if (process.stderr.isTTY) process.stderr.write('Reading token history…\r');
  const scan = await scanSessions(directory, cache);
  const records = scan.records.filter(record => selection === 'both' || record[1] === (selection === 'gpt' ? 'chat' : 'claude'));
  const result = { ...summarize(records, new Date(), selection), time: workingTime({ ...scan, records }), files: scan.files, warnings: scan.warnings };
  if (process.stderr.isTTY) process.stderr.write('\x1b[2K\r');
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    const color = Boolean(process.stdout.isTTY) && !args.includes('--no-color') && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
    console.log('\n' + renderSummary(result, { color, width: process.stdout.columns ?? 76 }) + '\n');
  }
  return scan.warnings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = await main();
}
