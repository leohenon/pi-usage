# pi-usage

Three terminal commands for Pi Anthropic/OpenAI OAuth subscription usage:

- **ai-usage** — Anthropic and OpenAI subscription limits and plan info.
- **ai-tokens** — local Pi token totals, averages, charts, and model time.
- **ai-status** — OpenAI and Claude service health and incidents.

## Install

Requires **Node.js**.

```sh
git clone https://github.com/leohenon/pi-usage.git
cd pi-usage
npm link
```

Run from any directory:

```sh
ai-usage
ai-tokens
ai-status
```

Flags:

```sh
ai-usage --provider gpt
ai-tokens --provider claude
```
