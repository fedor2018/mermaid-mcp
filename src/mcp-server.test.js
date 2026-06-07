/**
 * Integration tests for mcp-server.mjs — HTTP server and MCP protocol.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { setTimeout as sleep } from 'timers/promises';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Diagram fixtures
// ---------------------------------------------------------------------------
const FLOWCHART = `graph TD
    A[Start] --> B[End]`;

const GANTT = `gantt
    title A Gantt Diagram
    dateFormat  YYYY-MM-DD
    section Section
    A task       :a1, 2024-01-01, 30d`;

const PIE_DIAGRAM = `pie
    title Sample
    "Work": 40
    "Play": 60`;

const INVALID_DIAGRAM = `this is not a valid mermaid diagram at all`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSSE(raw) {
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error('No data line found in SSE response');
}

function sendMCPRequest(port, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: params || {},
      id: 1,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const data = JSON.parse(raw);
          resolve({ status: res.statusCode, data });
        } catch {
          try {
            const data = parseSSE(raw);
            resolve({ status: res.statusCode, data });
          } catch (err) {
            reject(new Error(`Response parse failed: ${err.message}, body: ${raw.substring(0, 500)}`));
          }
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendHTTPRequest(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: options.path || '/mcp',
      method: options.method || 'POST',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let server;
const TEST_PORT = 39950;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

before(async () => {
  const mod = await import('./mcp-server.mjs');
  server = mod.startServer(TEST_PORT);
  await sleep(500);
});

after(() => {
  return new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// MCP protocol tests
// ---------------------------------------------------------------------------

test('tools/list returns 2 tools', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/list', {});
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.data?.result?.tools));
  assert.equal(result.data.result.tools.length, 2);
  const names = result.data.result.tools.map((t) => t.name).sort();
  assert.equal(names[0], 'render');
  assert.equal(names[1], 'validate');
});

test('initialize returns server info', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  assert.equal(result.status, 200);
  assert.ok(result.data?.result?.serverInfo);
  assert.equal(result.data.result.serverInfo.name, 'mermaid-mcp');
  assert.equal(result.data.result.serverInfo.version, '1.0.0');
});

// ---------------------------------------------------------------------------
// validate tool tests
// ---------------------------------------------------------------------------

test('validate — valid flowchart', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'validate',
    arguments: { diagram: FLOWCHART },
  });
  assert.equal(result.status, 200);
  assert.ok(result.data?.result?.content);
  assert.equal(result.data.result.isError, undefined);
  const text = result.data.result.content[0]?.text || '';
  assert.ok(text.startsWith('Valid:'));
});

test('validate — invalid diagram is error', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'validate',
    arguments: { diagram: INVALID_DIAGRAM },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data?.result?.isError, true);
});

test('validate — empty diagram is error', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'validate',
    arguments: { diagram: '' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data?.result?.isError, true);
});

test('validate — gantt diagram type detected', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'validate',
    arguments: { diagram: GANTT },
  });
  const text = result.data.result.content[0]?.text || '';
  assert.ok(text.includes('gantt'));
});

test('validate — pie diagram type detected', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'validate',
    arguments: { diagram: PIE_DIAGRAM },
  });
  const text = result.data.result.content[0]?.text || '';
  assert.ok(text.includes('pie'));
});

// ---------------------------------------------------------------------------
// render tool tests
// ---------------------------------------------------------------------------

test('render — PNG', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'render',
    arguments: { diagram: FLOWCHART, format: 'png', backgroundColor: 'white' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data?.result?.isError, undefined);
  const content = result.data?.result?.content;
  assert.ok(Array.isArray(content));
  assert.ok(content.length >= 2);
  const textItem = content.find((c) => c.type === 'text');
  assert.ok(textItem);
  assert.ok(textItem.text.includes('PNG'));
  const imageItem = content.find((c) => c.type === 'image');
  assert.ok(imageItem);
  assert.equal(imageItem.mimeType, 'image/png');
});

test('render — SVG', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'render',
    arguments: { diagram: FLOWCHART, format: 'svg', backgroundColor: 'white' },
  });
  assert.equal(result.status, 200);
  const content = result.data?.result?.content;
  const textItem = content.find((c) => c.type === 'text');
  assert.ok(textItem.text.includes('SVG'));
  const imageItem = content.find((c) => c.type === 'image');
  assert.equal(imageItem.mimeType, 'image/svg+xml');
});

test('render — pie diagram PNG', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'render',
    arguments: { diagram: PIE_DIAGRAM, format: 'png', backgroundColor: 'white' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data?.result?.isError, undefined);
  const content = result.data?.result?.content;
  const imageItem = content.find((c) => c.type === 'image');
  assert.ok(imageItem);
  assert.equal(imageItem.mimeType, 'image/png');
});

test('render — invalid diagram is error', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'render',
    arguments: { diagram: INVALID_DIAGRAM, format: 'png', backgroundColor: 'white' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.data?.result?.isError, true);
});

test('render — default format is PNG', async () => {
  const result = await sendMCPRequest(TEST_PORT, 'tools/call', {
    name: 'render',
    arguments: { diagram: FLOWCHART },
  });
  assert.equal(result.status, 200);
  const content = result.data?.result?.content;
  const imageItem = content.find((c) => c.type === 'image');
  assert.equal(imageItem.mimeType, 'image/png');
});

// ---------------------------------------------------------------------------
// HTTP error codes
// ---------------------------------------------------------------------------

test('GET /mcp returns 405', async () => {
  const result = await sendHTTPRequest(TEST_PORT, { method: 'GET' });
  assert.equal(result.status, 405);
});

test('PUT /mcp returns 405', async () => {
  const result = await sendHTTPRequest(TEST_PORT, { method: 'PUT' });
  assert.equal(result.status, 405);
});

test('DELETE /mcp returns 405', async () => {
  const result = await sendHTTPRequest(TEST_PORT, { method: 'DELETE' });
  assert.equal(result.status, 405);
});

test('wrong path returns 405', async () => {
  const result = await sendHTTPRequest(TEST_PORT, { method: 'POST', path: '/wrong' });
  assert.equal(result.status, 405);
});

test('text/plain returns 415', async () => {
  const result = await sendHTTPRequest(TEST_PORT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(result.status, 415);
});

test('multipart/form-data returns 415', async () => {
  const result = await sendHTTPRequest(TEST_PORT, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data' },
    body: 'hello',
  });
  assert.equal(result.status, 415);
});

test('oversized payload returns 413', async () => {
  const bigBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'validate',
      arguments: { diagram: 'A'.repeat(config.maxBodySize + 1000) },
    },
    id: 1,
  });
  const result = await sendHTTPRequest(TEST_PORT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bigBody).toString(),
    },
    body: bigBody,
  });
  assert.equal(result.status, 413);
});

test('invalid JSON returns 400', async () => {
  const result = await sendHTTPRequest(TEST_PORT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(result.status, 400);
});
