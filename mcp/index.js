#!/usr/bin/env node
// MCP server exposing the jira-dash board to Claude sessions over stdio.
//
// Same config resolution as the rest of jira-dash: config.json is resolved
// relative to the repo root by server/config.js itself (not relative to this
// file), so this works whether it's invoked from anywhere on disk. If
// config.json is missing, loadConfig()'s error is surfaced as a clear MCP
// startup failure rather than a silent crash.
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from '../server/config.js';
import { BUCKETS } from '../server/actions.js';
import { boardStatus, doRefresh, ackCard, moveCard, cardComments } from './handlers.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`jira-dash-mcp: failed to load config.json: ${e.message}`);
  process.exit(1);
}
const root = new URL('..', import.meta.url).pathname;
const statePath = join(root, 'data', 'state.json');
const ctx = { config, statePath };

const server = new McpServer({ name: 'jira-dash', version: '1.0.0' });

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errorText = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

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
  async () => text(await boardStatus(ctx)),
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
    return result.error ? errorText(result.error) : text(result);
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
    return result.error ? errorText(result.error) : text(result);
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
      bucket: z.enum(BUCKETS).describe(`Target bucket: one of ${BUCKETS.join(', ')}`),
    },
  },
  async ({ key, bucket }) => {
    const result = await moveCard({ ...ctx, key, bucket });
    return result.error ? errorText(result.error) : text(result);
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
      'said on a card before deciding whether to ack it.',
    inputSchema: { key: z.string().describe('Jira issue key, e.g. "PROJ-123"') },
  },
  async ({ key }) => {
    const result = await cardComments({ ...ctx, key });
    return result.error ? errorText(result.error) : text(result);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
