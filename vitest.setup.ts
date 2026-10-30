// loadConfig turns demo mode on from these env vars, so a developer shell
// with DEVHUD_DEMO=1 exported flipped real-mode tests (write gates, server,
// CLI) to demo and failed them. Tests that want demo mode set it themselves.
for (const name of ['DEVHUD_DEMO', 'SIMON_DASH_DEMO', 'JIRA_DASH_DEMO']) delete process.env[name];
