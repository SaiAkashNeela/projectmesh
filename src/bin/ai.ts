#!/usr/bin/env node
import path from 'node:path';

import { runCli } from '../cli.js';

function buildArgv() {
  const invokedAs = path.basename(process.argv[1] ?? '');
  if (invokedAs === 'projectmesh-new') {
    return ['new', ...process.argv.slice(2)];
  }
  if (invokedAs === 'projectmesh-start') {
    return ['start', ...process.argv.slice(2)];
  }
  if (invokedAs === 'projectmesh-stop') {
    return ['stop', ...process.argv.slice(2)];
  }
  if (invokedAs === 'projectmesh-status') {
    return ['status', ...process.argv.slice(2)];
  }
  if (invokedAs === 'projectmesh-dashboard') {
    return ['dashboard', ...process.argv.slice(2)];
  }
  if (invokedAs === 'projectmesh-mcp-http') {
    return ['mcp-http', ...process.argv.slice(2)];
  }
  if (invokedAs === 'projectmesh-share') {
    return ['share', ...process.argv.slice(2)];
  }
  return process.argv.slice(2);
}

runCli(buildArgv())
  .then((output) => {
    if (output) {
      process.stdout.write(`${output}\n`);
    }
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
