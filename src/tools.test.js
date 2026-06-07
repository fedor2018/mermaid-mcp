/**
 * Tests for tools.js — MCP tool registration and schemas.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from './tools.js';

test('registerTools is a function', () => {
  assert.equal(typeof registerTools, 'function');
});

test('registerTools registers two tools', () => {
  const registered = [];
  const mockServer = {
    registerTool: (name, config, cb) => {
      registered.push({ name, config, hasHandler: typeof cb === 'function' });
    },
  };
  registerTools(mockServer);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, 'validate');
  assert.equal(registered[1].name, 'render');
  assert.ok(registered[0].hasHandler);
  assert.ok(registered[1].hasHandler);
});

test('registerTools — validate has inputSchema and title', () => {
  let validateConfig;
  const mockServer = {
    registerTool: (name, config, cb) => {
      if (name === 'validate') validateConfig = config;
    },
  };
  registerTools(mockServer);
  assert.ok(validateConfig.inputSchema);
  assert.equal(validateConfig.title, 'Validate Mermaid Diagram');
});

test('registerTools — render has inputSchema with format and backgroundColor', () => {
  let renderConfig;
  const mockServer = {
    registerTool: (name, config, cb) => {
      if (name === 'render') renderConfig = config;
    },
  };
  registerTools(mockServer);
  assert.ok(renderConfig.inputSchema);
  assert.equal(renderConfig.title, 'Render Mermaid Diagram');
});
