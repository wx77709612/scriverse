import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '../..');

describe('ChatGPT MCP launcher', () => {
  test('exposes a documented npm entry point', () => {
    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['chatgpt:start']).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-chatgpt-mcp.ps1',
    );
  });

  test.skipIf(process.platform !== 'win32')('prints help without starting local services', () => {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(projectRoot, 'scripts', 'start-chatgpt-mcp.ps1'),
        '-Help',
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm run chatgpt:start');
    expect(result.stdout).toContain('SCRIVERSE_API_KEY');
    expect(result.stdout).toContain('CONTROL_PLANE_API_KEY');
    expect(result.stdout).toContain('TUNNEL_CLIENT_PATH');
  });
});
