import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createScriverseMcpServer, loadScriverseMcpConfig } from "./scriverse-mcp.js";

try {
  const config = loadScriverseMcpConfig();
  serveStdio(
    () => createScriverseMcpServer(config),
    { onerror: (error) => console.error(`Scriverse MCP transport error: ${error.message}`) }
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Scriverse MCP Bridge 启动失败");
  process.exitCode = 1;
}
