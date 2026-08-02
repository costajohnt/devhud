#!/usr/bin/env node
// MCP server exposing the simon-dash board to Claude sessions over stdio.
//
// Same config resolution as the rest of simon-dash: config.json is resolved
// relative to the repo root by server/config.ts itself (not relative to this
// file), so this works whether it's invoked from anywhere on disk. If
// config.json is missing, loadConfig()'s error is surfaced as a clear MCP
// startup failure rather than a silent crash.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../server/config.ts';
import { BUCKETS } from '../server/actions.ts';
import { boardStatus, doRefresh, ackCard, moveCard, cardComments, transitionCard, commentCard, commentPr } from './handlers.ts';
import type { Ctx } from './handlers.ts';
import type { Config } from '../server/types.ts';

const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
let config: Config;
try {
  config = loadConfig(configPath);
} catch (e) {
  console.error(`simon-dash-mcp: failed to load config.json: ${(e as Error).message}`);
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const statePath = join(root, 'data', 'state.json');
const ctx: Ctx = { config, statePath, configPath };

const server = new McpServer({ name: 'simon-dash', version: '1.0.0' });

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const errorText = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

server.registerTool(
  'board_status',
  {
    title: 'Board status',
    description:
      'Returns the full current board snapshot: cards grouped into buckets (needs_attention, ' +
      'in_progress, waiting_review, in_qa), TODO items, unlinked PRs, closed PRs, merged cards, ' +
      'merged total, and recent activity. This is a read of the last computed snapshot, not a live ' +
      'fetch, so call `refresh` first if you need up-to-the-minute Jira/GitHub data. Use this to ' +
      'answer "what does my board look like right now" or "what needs attention".',
    inputSchema: {},
  },
  async () => {
    const snap = await boardStatus(ctx);
    return 'error' in snap ? errorText(snap.error) : text(snap);
  },
);

server.registerTool(
  'refresh',
  {
    title: 'Refresh from Jira and GitHub',
    description:
      'Fetches fresh data from Jira and GitHub (or demo data in demo mode) and rebuilds the board. ' +
      'Returns a compact summary: card counts per bucket, any per-source errors, and which cards ' +
      'newly crossed into "merged" on this refresh. Use this before `board_status` when the caller ' +
      'needs current data rather than whatever was last computed. This is the only tool that makes ' +
      'network calls to Jira/GitHub.',
    inputSchema: {},
  },
  async () => {
    const result = await doRefresh(ctx);
    return 'error' in result ? errorText(result.error) : text(result);
  },
);

server.registerTool(
  'ack_card',
  {
    title: 'Acknowledge a card',
    description:
      'Acknowledges a card\'s attention flags (new comments, CI failing, etc). Clears the flags and, ' +
      'if the card was in needs_attention, moves it to its prior override bucket or a bucket derived ' +
      'from its Jira status. Does not undo a previous manual move. Use this after reviewing a card ' +
      'that showed up in needs_attention and there is nothing further to do right now.',
    inputSchema: { key: z.string().describe('Jira issue key, e.g. "PROJ-123"') },
  },
  async ({ key }) => {
    const result = await ackCard({ ...ctx, key });
    return 'error' in result ? errorText(result.error) : text(result);
  },
);

server.registerTool(
  'move_card',
  {
    title: 'Move a card to a bucket',
    description:
      'Pins a card to a specific bucket, overriding the classifier until a new attention trigger ' +
      `fires (CI failing, a new comment, or a merge-not-in-test). Bucket must be one of: ${BUCKETS.join(', ')}. ` +
      'Use this to manually organize the board, e.g. moving a card the classifier put in ' +
      'in_progress into waiting_review because you know a review request is coming.',
    inputSchema: {
      key: z.string().describe('Jira issue key, e.g. "PROJ-123"'),
      bucket: z.enum(BUCKETS as [string, ...string[]]).describe(`Target bucket: one of ${BUCKETS.join(', ')}`),
    },
  },
  async ({ key, bucket }) => {
    const result = await moveCard({ ...ctx, key, bucket });
    return 'error' in result ? errorText(result.error) : text(result);
  },
);

server.registerTool(
  'card_comments',
  {
    title: 'Card comments',
    description:
      'Returns one card\'s comment history: the full last-10 comments merged from Jira and GitHub ' +
      '(newest first), plus `newComments` — the subset that\'s unseen since the last ack/move and ' +
      'currently driving its attention flags. Use this to read what a reviewer or teammate actually ' +
      'said on a card before deciding whether to ack it. Only works for cards still on the active ' +
      'board (any of the four buckets); a card that has already merged and moved into mergedCards is ' +
      'found but returns empty comments/newComments arrays — that history isn\'t carried into the ' +
      'merged-card record.',
    inputSchema: { key: z.string().describe('Jira issue key, e.g. "PROJ-123"') },
  },
  async ({ key }) => {
    const result = await cardComments({ ...ctx, key });
    return 'error' in result ? errorText(result.error) : text(result);
  },
);

// --- Write-back tools ---
// These are REAL mutations of Jira/GitHub, gated by writeEnabled in
// config.json (server/writeback.ts's checkWriteGate refuses otherwise) and
// always a no-op in demo mode. Because this is an MCP tool, not a UI with a
// confirm dialog, the approval gate has to be behavioral: every description
// below explicitly tells the model to draft the content, show it to the
// user, and wait for explicit approval in conversation before calling the
// tool — never call these speculatively or as a side effect of some other
// request (mirrors oss-autopilot's draft-then-post pattern for PR/issue
// comments).

server.registerTool(
  'transition_card',
  {
    title: 'Transition a Jira card',
    description:
      'Moves a Jira issue to a different workflow status (e.g. "In Review", "Done") via the Jira ' +
      'transitions API. This is a REAL write to Jira — gated by writeEnabled in config.json (refuses ' +
      'with a clear error otherwise) and always a no-op in demo mode. Before calling this tool, state ' +
      'the exact target status to the user and only call it after they explicitly approve it in ' +
      'conversation. Never transition a card speculatively or as a side effect of answering some other ' +
      'question.',
    inputSchema: {
      key: z.string().describe('Jira issue key, e.g. "PROJ-123"'),
      status: z.string().describe('Target workflow status name, e.g. "In Review" — must match one of the card\'s available transitions'),
    },
  },
  async ({ key, status }) => {
    const result = await transitionCard({ ...ctx, key, status });
    return result.error ? errorText(result.error as string) : text(result);
  },
);

server.registerTool(
  'comment_card',
  {
    title: 'Comment on a Jira card',
    description:
      'Posts a plain-text comment on a Jira issue. This is a REAL write to Jira — gated by writeEnabled ' +
      'in config.json (refuses with a clear error otherwise) and always a no-op in demo mode. Draft the ' +
      'exact comment text and show it to the user in your response before calling this tool; only call ' +
      'it after the user has explicitly approved that exact wording in conversation. Never post ' +
      'speculatively.',
    inputSchema: {
      key: z.string().describe('Jira issue key, e.g. "PROJ-123"'),
      body: z.string().describe('Plain-text comment body (wrapped in a minimal ADF doc before posting)'),
    },
  },
  async ({ key, body }) => {
    const result = await commentCard({ ...ctx, key, body });
    return result.error ? errorText(result.error as string) : text(result);
  },
);

server.registerTool(
  'comment_pr',
  {
    title: 'Comment on a GitHub PR',
    description:
      'Posts a plain-text comment on a GitHub pull request (issue-comments API). This is a REAL write ' +
      'to GitHub — gated by writeEnabled in config.json (refuses with a clear error otherwise) and ' +
      'always a no-op in demo mode. Draft the exact comment text and show it to the user in your ' +
      'response before calling this tool; only call it after the user has explicitly approved that ' +
      'exact wording in conversation. Never post speculatively.',
    inputSchema: {
      repo: z.string().describe('org/repo, e.g. "acme/webapp"'),
      number: z.number().describe('PR number'),
      body: z.string().describe('Plain-text comment body'),
    },
  },
  async ({ repo, number, body }) => {
    const result = await commentPr({ ...ctx, repo, number, body });
    return result.error ? errorText(result.error as string) : text(result);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
