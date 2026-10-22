/**
 * Integration tests for the stdio transport — src/stdio-server.mjs.
 *
 * The server is spawned as a real child process and driven over stdin/stdout,
 * the same framing mcp-proxy uses: newline-delimited JSON-RPC.
 *
 * The SDK's StdioClientTransport is used for the MCP conversation, and the
 * raw stdout is recorded separately to assert that the stream carries
 * JSON-RPC only — any stray print would corrupt the protocol.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, 'stdio-server.mjs');

const FLOWCHART = `graph TD
    A[Start] --> B[End]`;

const INVALID_DIAGRAM = `this is not a valid mermaid diagram at all`;

let transport;
let client;

/** Raw stdout of the server process, line by line. */
const stdoutLines = [];
/** Transport/protocol level errors reported by the SDK. */
const transportErrors = [];
let rawBuffer = '';

before(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    stderr: 'pipe',
  });

  client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {}, onerror: (err) => transportErrors.push(err) },
  );

  await client.connect(transport);

  // Tap the raw stdout stream — the transport already consumes it, this
  // listener only records it so the purity can be asserted.
  transport._process.stdout.on('data', (chunk) => {
    rawBuffer += chunk.toString('utf-8');
    let index;
    while ((index = rawBuffer.indexOf('\n')) !== -1) {
      const line = rawBuffer.slice(0, index);
      rawBuffer = rawBuffer.slice(index + 1);
      if (line.trim()) stdoutLines.push(line);
    }
  });
});

after(async () => {
  try {
    await client?.close();
  } catch {
    // The EOF test may have closed the transport already.
  }
});

// ---------------------------------------------------------------------------
// MCP protocol
// ---------------------------------------------------------------------------

test('initialize returns server info', () => {
  const serverInfo = client.getServerVersion();
  assert.equal(serverInfo.name, 'mermaid-mcp');
  assert.equal(serverInfo.version, '1.0.0');
});

test('initialize exposes tool capability', () => {
  assert.ok(client.getServerCapabilities()?.tools);
});

test('tools/list returns 2 tools', async () => {
  const result = await client.listTools();
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['render', 'validate']);
});

// ---------------------------------------------------------------------------
// validate tool
// ---------------------------------------------------------------------------

test('validate — valid flowchart', async () => {
  const result = await client.callTool({ name: 'validate', arguments: { diagram: FLOWCHART } });
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text || '';
  assert.ok(text.startsWith('Valid:'), `unexpected text: ${text}`);
});

test('validate — invalid diagram is error', async () => {
  const result = await client.callTool({
    name: 'validate',
    arguments: { diagram: INVALID_DIAGRAM },
  });
  assert.equal(result.isError, true);
});

// ---------------------------------------------------------------------------
// render tool
// ---------------------------------------------------------------------------

test('render — PNG', async () => {
  const result = await client.callTool({
    name: 'render',
    arguments: { diagram: FLOWCHART, format: 'png', backgroundColor: 'white' },
  });
  assert.equal(result.isError, undefined);

  const image = result.content.find((c) => c.type === 'image');
  assert.ok(image);
  assert.equal(image.mimeType, 'image/png');

  const bytes = Buffer.from(image.data, 'base64');
  assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47'); // PNG magic
});

test('render — SVG', async () => {
  const result = await client.callTool({
    name: 'render',
    arguments: { diagram: FLOWCHART, format: 'svg' },
  });
  assert.equal(result.isError, undefined);

  const image = result.content.find((c) => c.type === 'image');
  assert.ok(image);
  assert.equal(image.mimeType, 'image/svg+xml');
  assert.ok(image.data.length > 0);
});

// ---------------------------------------------------------------------------
// stdio-specific guarantees
// ---------------------------------------------------------------------------

test('stdout carries JSON-RPC only', () => {
  assert.ok(stdoutLines.length > 0, 'no messages received');
  assert.deepEqual(transportErrors, [], 'transport reported errors');

  for (const line of stdoutLines) {
    const message = JSON.parse(line); // throws on non-JSON output
    assert.equal(message.jsonrpc, '2.0');
  }
});

test('logs go to stderr, not stdout', () => {
  const stderr = transport.stderr.read()?.toString('utf-8') || '';
  assert.ok(
    stderr.includes('mermaid-mcp running on stdio'),
    `expected a startup log on stderr, got: ${stderr.slice(0, 200)}`,
  );
});

test('exits cleanly when stdin is closed (EOF)', async () => {
  const child = transport._process;
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));

  // Closing the transport ends the server's stdin — the same shutdown
  // sequence mcp-proxy performs before escalating to SIGTERM.
  await transport.close();

  const result = await exited;
  assert.equal(result.code, 0, 'server should exit on stdin EOF without a signal');
  assert.equal(result.signal, null);
});
