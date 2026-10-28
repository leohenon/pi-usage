#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVIDERS = [
  { name: 'OpenAI', url: 'https://status.openai.com' },
  { name: 'Claude', url: 'https://status.claude.com' },
];
const clean = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const label = value => clean(value).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const dateValue = value => Number.isFinite(Date.parse(value)) ? value : null;

async function getJSON(url, fetcher) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'ai-status/1.0' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function normalize(provider, summary, incidents) {
  if (!summary?.status || typeof summary.status.indicator !== 'string' || !Array.isArray(summary.components)) {
    throw new Error('Unexpected status response');
  }
  if (!Array.isArray(incidents)) throw new Error('Unexpected incident response');
  const active = incidents.filter(incident => !['resolved', 'postmortem', 'completed'].includes(incident.status));
  return {
    name: provider.name, url: provider.url,
    indicator: clean(summary.status.indicator), description: clean(summary.status.description) || 'Status unavailable',
    components: summary.components.filter(component => component.status !== 'operational' && !component.group)
      .map(component => ({ name: clean(component.name), status: clean(component.status) })),
    incidents: active.map(incident => {
      const updates = [...(incident.incident_updates ?? [])].sort((a, b) =>
        (Date.parse(b.display_at ?? b.created_at) || 0) - (Date.parse(a.display_at ?? a.created_at) || 0));
      return { name: clean(incident.name), status: clean(incident.status), impact: clean(incident.impact),
        updatedAt: dateValue(updates[0]?.display_at ?? updates[0]?.created_at ?? incident.updated_at),
        update: clean(updates[0]?.body),
        url: typeof incident.shortlink === 'string' && incident.shortlink.startsWith('https://') ? clean(incident.shortlink) : provider.url,
      };
    }),
    maintenance: (summary.scheduled_maintenances ?? []).filter(item => ['in_progress', 'verifying'].includes(item.status))
      .map(item => ({ name: clean(item.name), status: clean(item.status) })),
    warnings: [],
  };
}

export async function fetchStatus(provider, fetcher = fetch) {
  try {
    const summary = await getJSON(`${provider.url}/api/v2/summary.json`, fetcher);
    let incidents = summary.incidents;
    let incidentError = false;
    // OpenAI's summary does not include incidents; fetch the official incident feed too.
    if (!Array.isArray(incidents)) {
      try { incidents = (await getJSON(`${provider.url}/api/v2/incidents.json`, fetcher)).incidents; }
      catch { incidentError = true; incidents = []; }
      if (!Array.isArray(incidents)) { incidentError = true; incidents = []; }
    }
    const result = normalize(provider, summary, incidents);
    if (incidentError) result.warnings.push('Incident feed unavailable; incident details could not be checked.');
    return result;
  } catch (error) {
    let reason = 'Network error or unexpected status response.';
    if (error.name === 'TimeoutError') reason = 'Status request timed out.';
    else if (/^HTTP \d+$/.test(error.message)) reason = `Status endpoint returned ${error.message}.`;
    return { name: provider.name, url: provider.url, error: reason };
  }
}

export function renderStatus(results, { color = false, width = 76, now = new Date() } = {}) {
  width = Math.max(28, Math.min(76, width));
  const inner = width - 6;
  const paint = (code, text) => color && code ? `\x1b[${code}m${text}\x1b[0m` : text;
  const border = text => paint('2', text);
  const visible = text => text.replace(/\x1b\[[0-9;]*m/g, '').length;
  const lines = [border('╭' + '─'.repeat(width - 2) + '╮')];
  function row(text = '') { lines.push(border('│') + '  ' + text + ' '.repeat(Math.max(0, inner - visible(text))) + '  ' + border('│')); }
  function textRows(text, code = '') {
    let line = '';
    for (let word of clean(text).split(' ')) {
      if (line && line.length + word.length + 1 > inner) { row(paint(code, line)); line = ''; }
      while (word.length > inner) { row(paint(code, word.slice(0, inner))); word = word.slice(inner); }
      line += (line ? ' ' : '') + word;
    }
    if (line) row(paint(code, line));
  }
  row(paint('1', 'AI service status'));
  textRows(`Checked ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(now)}`, '2');
  for (const result of results) {
    row();
    row(border('─'.repeat(inner)));
    const healthy = !result.error && result.indicator === 'none' && !result.components?.length && !result.incidents?.length && !result.maintenance?.length && !result.warnings?.length;
    let status = 'Issue reported', code = '33';
    if (result.error) status = 'Unknown';
    else if (healthy) { status = 'Operational'; code = '32'; }
    else if (result.warnings?.length && result.indicator === 'none' && !result.incidents?.length && !result.components?.length) status = 'Partially checked';
    else if (['major', 'critical'].includes(result.indicator)) { status = 'Outage reported'; code = '31'; }
    const gap = inner - result.name.length - status.length;
    if (gap >= 2) row(paint('1', result.name) + ' '.repeat(gap) + paint(code, status));
    else { textRows(result.name, '1'); textRows(status, code); }
    if (result.error) textRows(result.error, '33');
    else {
      if (healthy) textRows('No active incidents reported.', '2');
      else if (result.indicator !== 'none') textRows(result.description, code);
      for (const component of result.components) textRows(`${component.name}: ${label(component.status)}`, '33');
      for (const incident of result.incidents) {
        row();
        textRows(`${label(incident.status)} · ${incident.name}`, '1');
        if (incident.update) textRows(incident.update);
        if (incident.updatedAt) textRows(`Updated ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(incident.updatedAt))}`, '2');
        textRows(incident.url, '2');
      }
      for (const maintenance of result.maintenance) textRows(`Maintenance · ${maintenance.name} (${label(maintenance.status)})`, '33');
      for (const warning of result.warnings) textRows(warning, '33');
    }
    textRows(result.url, '2');
  }
  row();
  row(border('─'.repeat(inner)));
  textRows('Official reports only; unreported overloads may not appear.', '2');
  row();
  lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ai-status [--json] [--no-color]\n\nLive OpenAI and Claude service status from official public feeds.\nShows active outages, degraded services, incidents and ongoing maintenance.\nNo login, model requests, or credentials required.\nOnly reported issues are visible; this cannot detect every overload or account-specific error.');
    return 0;
  }
  if (args.some(arg => !['--json', '--no-color'].includes(arg))) {
    console.error('Unknown argument. Usage: ai-status [--json] [--no-color]');
    return 2;
  }
  const providers = await Promise.all(PROVIDERS.map(provider => fetchStatus(provider)));
  const now = new Date();
  if (args.includes('--json')) console.log(JSON.stringify({ checkedAt: now.toISOString(), providers }, null, 2));
  else {
    const color = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' && !args.includes('--no-color');
    console.log('\n' + renderStatus(providers, { color, width: process.stdout.columns ?? 76, now }) + '\n');
  }
  return providers.some(provider => provider.error || provider.warnings.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = await main();
}
