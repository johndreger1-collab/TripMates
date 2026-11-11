# Prompts for Claude Code

Copy and paste these. Keep them short: the detail lives in CLAUDE.md and docs/.

## First session (Phase R0)

> This repo is Tripmates (formerly the Rugby Trip Companion). Read CLAUDE.md, then docs/STATUS.md,
> docs/ARCHITECTURE.md and docs/PHASES.md. Don't write code yet.
>
> (Optional) My Level UP app's source is at `<path>`. It's a separate app on the
> same framework; read its package.json, folder layout, API client, sign-in,
> service worker and deploy setup, and tell me where it differs from what these
> docs assume. If I haven't given a path, use the docs' defaults.
>
> Then plan Phase R0: list the files you'll create or change and your
> assumptions. The Apps Script ID is `<script id>`. Wait for my go-ahead.

## Each later phase

> Do Phase R<n>. Follow CLAUDE.md: files and assumptions first, then build, then
> two-phone test steps, then update docs/STATUS.md and open a PR.

## When a phone test fails

> Phone test for R<n> failed. Phone: <iPhone Safari / Android Chrome / installed app>.
> Step: <step>. Expected: <x>. Saw: <y>. Error text or screenshot: <…>.
> Find the cause before changing code, and tell me what you think it is.

## Pasting editor test results

> Here is the Execution log from `run<Name>Tests` in the Apps Script editor:
> <paste>. Interpret it, and fix anything that failed.

## Before a trip

> We leave for <city> on <date>. Check docs/STATUS.md and tell me what is not
> yet safe to rely on, what to test on both phones before we go, and what to
> re-verify in the Seed list.
