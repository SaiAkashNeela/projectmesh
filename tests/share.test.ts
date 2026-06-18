import { describe, expect, test } from 'vitest';

import {
  MCP_HTTP_PATH,
  MCP_HTTP_PORT,
  buildChatGptMcpUrl,
  getProjectmeshServiceStatePath,
  getProjectmeshNgrokConfigPath,
  getNgrokInstallHint,
  getNgrokManualSetupMessage,
  resolveNgrokAsset,
} from '../src/index.js';

describe('share launcher helpers', () => {
  test('maps macOS arm64 to the darwin arm64 archive', () => {
    const asset = resolveNgrokAsset({ platform: 'darwin', arch: 'arm64', libc: 'unknown' });
    expect(asset.archiveType).toBe('zip');
    expect(asset.url).toContain('ngrok-v3-stable-darwin-arm64.zip');
  });

  test('maps Linux x64 to the linux amd64 archive', () => {
    const asset = resolveNgrokAsset({ platform: 'linux', arch: 'x64', libc: 'glibc' });
    expect(asset.archiveType).toBe('tgz');
    expect(asset.url).toContain('ngrok-v3-stable-linux-amd64.tgz');
  });

  test('keeps alpine detection visible for Linux musl environments', () => {
    const asset = resolveNgrokAsset({ platform: 'linux', arch: 'arm64', libc: 'musl' });
    expect(asset.variantLabel).toContain('alpine');
    expect(asset.url).toContain('ngrok-v3-stable-linux-arm64.tgz');
  });

  test('returns manual install guidance for windows', () => {
    const hint = getNgrokInstallHint({ platform: 'win32', arch: 'x64', libc: 'unknown' });
    expect(hint.mode).toBe('manual');
    expect(hint.message).toContain('Windows App Store');
  });

  test('renders the public MCP URL for ChatGPT setup', () => {
    expect(buildChatGptMcpUrl('https://example.ngrok.app')).toBe(
      'https://example.ngrok.app/mcp',
    );
  });

  test('renders ngrok manual setup help with the documented auth token command', () => {
    const text = getNgrokManualSetupMessage(MCP_HTTP_PORT, MCP_HTTP_PATH);
    expect(text).toContain('ngrok config add-authtoken $YOUR_TOKEN');
    expect(text).toContain('https://dashboard.ngrok.com/get-started/your-authtoken');
    expect(text).toContain(`http://127.0.0.1:${MCP_HTTP_PORT}${MCP_HTTP_PATH}`);
  });

  test('stores service state under the projectmesh home directory', () => {
    const statePath = getProjectmeshServiceStatePath('/tmp/projectmesh-home');
    expect(statePath).toBe('/tmp/projectmesh-home/run/services.json');
  });

  test('resolves the ngrok config path under the user home directory', () => {
    expect(getProjectmeshNgrokConfigPath('/tmp/home')).toBe('/tmp/home/.config/ngrok/ngrok.yml');
  });
});
