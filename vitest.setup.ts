// loadConfig turns demo mode on from this env var, so a developer shell
// with DEVHUD_DEMO=1 exported flipped real-mode tests (write gates, server,
// CLI) to demo and failed them. Tests that want demo mode set it themselves.
delete process.env.DEVHUD_DEMO;
