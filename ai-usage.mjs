#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVIDERS = [
  { id: 'openai-codex', title: 'GPT', url: 'https://chatgpt.com/backend-api/wham/usage' },
  { id: 'anthropic', title: 'Claude', url: 'https://api.anthropic.com/api/oauth/usage' },
];
const number = value => typeof value === 'number' && Number.isFinite(value);
const titleCase = value => value.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const percent = value => `${Number(value.toFixed(1))}%`;

function money(value) {
  if (!value || !number(value.amount_minor) || !number(value.exponent) || !value.currency) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: value.currency })
      .format(value.amount_minor / 10 ** value.exponent);
  } catch { return null; }
}

export function claudeCard(data, profile = null) {
  const tier = profile?.organization?.rate_limit_tier ?? '';
  let plan = 'Plan unavailable';
  if (tier.includes('max_20x')) plan = 'Max 20x';
  else if (tier.includes('max_5x')) plan = 'Max 5x';
  else if (profile?.account?.has_claude_max || tier.includes('max')) plan = 'Max (tier unavailable)';
  else if (profile?.account?.has_claude_pro || tier.includes('pro')) plan = 'Pro';
  else if (tier.includes('enterprise')) plan = 'Enterprise';
  else if (tier.includes('team')) plan = 'Team';
  const card = { title: 'Claude', subtitle: plan, windows: [], details: [] };
  // The current structured list includes model limits absent from the legacy fields.
  if (Array.isArray(data.limits) && data.limits.length) {
    for (const limit of data.limits) {
      const scope = [limit.scope?.model?.display_name, limit.scope?.surface?.display_name].filter(Boolean).join(' · ');
      const label = limit.kind === 'session' ? 'Current session'
        : limit.kind === 'weekly_all' ? 'All models'
        : scope || titleCase(limit.kind ?? 'Usage limit');
      card.windows.push({ label, group: limit.group === 'weekly' ? 'Weekly limits' : 'Session',
        used: number(limit.percent) ? limit.percent : null, reset: limit.resets_at ?? null, direction: 'used' });
    }
  } else {
    for (const [key, value] of Object.entries(data)) {
      if (!value || !('utilization' in Object(value)) || key === 'extra_usage') continue;
      const label = key === 'five_hour' ? 'Current session' : key === 'seven_day' ? 'All models'
        : titleCase(key.replace(/^seven_day_/, ''));
      card.windows.push({ label, group: key.startsWith('seven_day') ? 'Weekly limits' : 'Session',
        used: number(value.utilization) ? value.utilization : null, reset: value.resets_at ?? null, direction: 'used' });
    }
  }
  const breakdown = data.seven_day_breakdown?.rows;
  if (Array.isArray(breakdown)) {
    card.breakdown = breakdown.filter(row => number(row.percent))
      .map(row => ({ label: row.display_name ?? titleCase(row.key), percent: row.percent }));
  }
  if (Array.isArray(data.weekly_scoped_shares)) {
    for (const share of data.weekly_scoped_shares) {
      const limit = data.limits?.[share.limit_index];
      const name = limit?.scope?.model?.display_name;
      if (name && number(share.used_percent_of_weekly) && number(share.allowance_percent_of_weekly)) {
        card.details.push(`${name}: ${percent(share.used_percent_of_weekly)} of total weekly allowance used · ${percent(share.allowance_percent_of_weekly)} allocated`);
      }
    }
  }
  const spend = data.spend;
  if (spend) {
    card.details.push(`Usage credits: ${spend.enabled ? 'Enabled' : 'Disabled'}`);
    const used = money(spend.used), limit = money(spend.limit), balance = money(spend.balance);
    if (used) card.details.push(`${used} spent${limit ? ` / ${limit} limit` : ''}`);
    if (balance) card.details.push(`${balance} balance`);
    if (spend.disabled_reason) card.details.push(`Reason: ${titleCase(spend.disabled_reason)}`);
  } else if (data.extra_usage) {
    const extra = data.extra_usage;
    card.details.push(`Extra usage: ${extra.is_enabled ? 'Enabled' : 'Disabled'}`);
    // Legacy credit amounts are minor currency units; do not assume a currency or scale.
    if (extra.currency && number(extra.decimal_places)) {
      const used = money({ amount_minor: extra.used_credits, currency: extra.currency, exponent: extra.decimal_places });
      const limit = money({ amount_minor: extra.monthly_limit, currency: extra.currency, exponent: extra.decimal_places });
      if (used) card.details.push(`${used} spent${limit ? ` / ${limit} limit` : ''}`);
    }
  }
  if (!card.windows.length) card.details.unshift('Usage limits unavailable in the provider response.');
  return card;
}

function windowLabel(window) {
  const seconds = window.limit_window_seconds;
  if (seconds === 604800) return 'Weekly usage limit';
  if (seconds === 18000) return '5-hour usage limit';
  if (number(seconds) && seconds > 0) return `${seconds / 3600}-hour usage limit`;
  return 'Usage limit';
}

export function openaiCard(data, now = Date.now()) {
  // OpenAI's usage API distinguishes Pro tiers by these plan identifiers.
  const proPlans = { prolite: 'Pro plan (100)', pro: 'Pro plan (200)', promax: 'Pro plan (500)' };
  const subtitle = proPlans[data.plan_type] ?? (data.plan_type ? `${titleCase(data.plan_type)} plan` : 'Subscription usage');
  const card = { title: 'GPT', subtitle, windows: [], details: [] };
  function addLimits(limits, group) {
    if (!limits) return;
    for (const key of ['primary_window', 'secondary_window']) {
      const window = limits[key];
      if (!window) continue;
      const reset = number(window.reset_at) ? new Date(window.reset_at * 1000).toISOString()
        : number(window.reset_after_seconds) ? new Date(now + window.reset_after_seconds * 1000).toISOString() : null;
      card.windows.push({ label: windowLabel(window), group, used: number(window.used_percent) ? window.used_percent : null,
        reset, direction: 'remaining' });
    }
    if (limits.limit_reached) card.details.push(`${group}: limit reached`);
    else if (limits.allowed === false) card.details.push(`${group}: currently unavailable`);
  }
  addLimits(data.rate_limit, 'Plan limits');
  addLimits(data.code_review_rate_limit, 'Code review');
  for (const limit of data.additional_rate_limits ?? []) {
    addLimits(limit.rate_limit, limit.limit_name ?? limit.metered_feature ?? 'Additional limit');
  }
  const credits = data.credits;
  if (credits) {
    card.details.push(`Credits remaining: ${credits.unlimited ? 'Unlimited' : credits.balance ?? 'Unavailable'}`);
    if (credits.overage_limit_reached) card.details.push('Credit overage limit reached');
  }
  for (const [model, usage] of Object.entries(data.model_usage ?? {})) {
    const status = usage.available === true ? 'Available' : usage.available === false ? 'Unavailable' : 'Status unavailable';
    card.details.push(`${model}: ${status}`);
    if (usage.available_at) card.details.push(`Available again: ${usage.available_at}`);
    if (usage.credits_would_enable) card.details.push('Additional credits would enable this model');
  }
  const resets = data.rate_limit_reset_credits;
  if (number(resets?.available_count)) card.details.push(`Limit resets available: ${resets.available_count}`);
  if (data.spend_control?.reached) card.details.push('Spending limit reached');
  if (!card.windows.length) card.details.unshift('Usage limits unavailable in the provider response.');
  return card;
}

export function resetText(value, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Reset time unavailable';
  const date = new Date(value);
  const minutes = Math.ceil((date.getTime() - now) / 60000);
  const absolute = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(date);
  if (minutes <= 0) return `Reset due · ${absolute}`;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  const relative = [days && `${days}d`, hours && `${hours}h`, (!days || !hours) && mins && `${mins}m`].filter(Boolean).join(' ');
  return `Resets in ${relative} · ${absolute}`;
}

function wrap(text, width) {
  if (text.length <= width) return [text];
  const lines = [''];
  for (const word of text.split(/\s+/)) {
    if (lines.at(-1) && lines.at(-1).length + word.length + 1 > width) lines.push('');
    let rest = word;
    while (rest.length > width) {
      lines[lines.length - 1] = rest.slice(0, width);
      lines.push('');
      rest = rest.slice(width);
    }
    lines[lines.length - 1] += (lines.at(-1) ? ' ' : '') + rest;
  }
  return lines;
}

export function renderCard(card, { color = false, width = 76, now = Date.now() } = {}) {
  width = Math.max(24, Math.min(76, width));
  const inner = width - 6;
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const accent = card.title === 'Claude' ? '38;5;173' : '38;5;79';
  const visible = text => text.replace(/\x1b\[[0-9;]*m/g, '').length;
  const border = text => paint('2', text);
  const lines = [border('╭' + '─'.repeat(width - 2) + '╮')];
  function row(text = '') {
    lines.push(border('│') + '  ' + text + ' '.repeat(Math.max(0, inner - visible(text))) + '  ' + border('│'));
  }
  function textRows(text, style = '') {
    for (const line of wrap(text, inner)) row(paint(style, line));
  }
  function pair(left, right, leftStyle, rightStyle) {
    const gap = inner - left.length - right.length;
    if (gap >= 2) row(paint(leftStyle, left) + ' '.repeat(gap) + paint(rightStyle, right));
    else {
      textRows(left, leftStyle);
      if (right) textRows(right, rightStyle);
    }
  }
  pair(card.title, card.subtitle ?? '', `1;${accent}`, '2');
  row();
  if (card.error) textRows(card.error, '31');
  else {
    let lastGroup;
    for (const window of card.windows) {
      if (lastGroup !== undefined) row();
      if (window.group !== lastGroup && !['Session', 'Plan limits'].includes(window.group)) {
        textRows(window.group.toUpperCase(), '2');
      }
      lastGroup = window.group;
      let amount = null;
      if (number(window.used)) {
        amount = window.used;
        if (window.direction === 'remaining') amount = Math.max(0, 100 - amount);
      }
      const label = amount === null ? 'Unavailable' : `${percent(amount)} ${window.direction}`;
      const statusColor = window.used >= 90 ? '1;31' : '1';
      pair(window.label, label, '', statusColor);
      const reset = resetText(window.reset, now);
      if (amount !== null) {
        const barWidth = inner;
        const filled = Math.round(Math.min(100, Math.max(0, amount)) / 100 * barWidth);
        const bar = paint(window.used >= 90 ? '31' : accent, '━'.repeat(filled))
          + paint('2', '─'.repeat(barWidth - filled));
        row(bar);
      }
      textRows(reset, '2');
    }
    if (card.details?.length) {
      row();
      row(border('─'.repeat(inner)));
      for (const detail of card.details) textRows(detail, '2');
    }
  }
  row();
  lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
  return lines.join('\n');
}

export async function fetchCard(provider, credentials, fetcher = fetch) {
  if (credentials?.type !== 'oauth' || typeof credentials.access !== 'string' || !credentials.access) {
    return { title: provider.title, error: `No Pi OAuth login found. Run /login in Pi for ${provider.title}.` };
  }
  const headers = { Authorization: `Bearer ${credentials.access}`, Accept: 'application/json' };
  if (provider.id === 'anthropic') {
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['User-Agent'] = 'ai-usage/1.0';
  } else if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId;
  try {
    const options = () => ({ headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    // Profile is optional: failure must not hide otherwise valid usage limits.
    const profileRequest = provider.id === 'anthropic'
      ? fetcher('https://api.anthropic.com/api/oauth/profile', options())
        .then(response => response.ok ? response.json() : null).catch(() => null)
      : Promise.resolve(null);
    const [response, profile] = await Promise.all([fetcher(provider.url, options()), profileRequest]);
    if (!response.ok) {
      const message = response.status === 401 ? 'Pi login expired or rejected. Use this provider in Pi to refresh it, or run /login.'
        : response.status === 403 ? 'Usage access denied by the provider (HTTP 403).'
        : response.status === 429 ? 'Usage endpoint rate-limited (HTTP 429). Try again later.'
        : `Usage endpoint returned HTTP ${response.status}.`;
      // Never print response bodies: they may contain account details or echoed credentials.
      return { title: provider.title, error: message };
    }
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
    return provider.id === 'anthropic' ? claudeCard(data, profile) : openaiCard(data);
  } catch (error) {
    return { title: provider.title, error: error.name === 'TimeoutError' ? 'Usage request timed out.' : 'Could not retrieve usage (network error or unexpected response).' };
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ai-usage [--provider gpt|claude|both] [--json] [--no-color]\n\nShows Claude and OpenAI Codex subscription limits using Pi OAuth logins.\nRead-only: no token refresh, credential writes, browser cookies, or API calls to models.\nRequires Node.js 22+. Credentials: $PI_CODING_AGENT_DIR/auth.json or ~/.pi/agent/auth.json.');
    return 0;
  }
  let selection = 'both';
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--provider' && ['gpt', 'claude', 'both'].includes(args[index + 1])) {
      selection = args[++index];
    } else if (!['--json', '--no-color'].includes(argument)) {
      console.error('Usage: ai-usage [--provider gpt|claude|both] [--json] [--no-color]');
      return 2;
    }
  }
  let auth;
  try {
    const directory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Invalid credentials');
  } catch {
    console.error('Cannot read Pi auth.json. Check PI_CODING_AGENT_DIR or log in using /login in Pi.');
    return 1;
  }
  const providers = PROVIDERS.filter(provider => selection === 'both' || provider.id === (selection === 'gpt' ? 'openai-codex' : 'anthropic'));
  const cards = await Promise.all(providers.map(provider => fetchCard(provider, auth[provider.id])));
  const now = Date.now();
  if (args.includes('--json')) console.log(JSON.stringify({ updatedAt: new Date(now).toISOString(), providers: cards }, null, 2));
  else {
    const color = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' && !args.includes('--no-color');
    console.log('\n' + cards.map(card => renderCard(card, { color, width: process.stdout.columns ?? 76, now })).join('\n'));
  }
  return cards.some(card => card.error) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = await main();
}
