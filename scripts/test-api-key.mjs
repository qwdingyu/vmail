#!/usr/bin/env node
/**
 * Vmail API Key 端到端测试脚本
 *
 * 测试覆盖：
 * 1. 认证中间件 - 各种认证场景
 * 2. 创建邮箱 - POST /api/v1/mailboxes
 * 3. 获取邮箱 - GET /api/v1/mailboxes/:id
 * 4. 获取收件箱 - GET /api/v1/mailboxes/:id/messages
 * 5. 获取邮件详情 - GET /api/v1/mailboxes/:id/messages/:messageId
 * 6. 删除邮件 - DELETE /api/v1/mailboxes/:id/messages/:messageId
 * 7. 权限隔离 - 不同 API Key 不能互相访问
 * 8. 限流检查 - Rate Limiting
 *
 * 用法:
 *   node scripts/test-api-key.mjs [--base-url URL] [--api-key KEY]
 */

import { spawn } from 'child_process';

// ─── 配置 ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
};

const BASE_URL = getArg('--base-url') || 'https://vmail.eforege.xyz';
const EXISTING_API_KEY = getArg('--api-key');

// ─── 测试框架 ────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function pass(test, detail) {
  passCount++;
  console.log(`  ✅ PASS: ${test}${detail ? ' — ' + detail : ''}`);
}

function fail(test, detail) {
  failCount++;
  console.log(`  ❌ FAIL: ${test}${detail ? ' — ' + detail : ''}`);
}

function skip(test, reason) {
  skipCount++;
  console.log(`  ⏭️  SKIP: ${test} — ${reason}`);
}

async function api(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, headers: res.headers, body };
}

// ─── 辅助：获取域名 ──────────────────────────────────────────────────────────

async function getConfig() {
  const { body } = await api('/config');
  return body;
}

// ─── 辅助：创建 API Key（通过 wrangler 或直接 API） ──────────────────────────

async function createApiKeyViaApi() {
  // POST /api/api-keys 需要 turnstile，如果没有 turnstile 配置则直接可用
  const config = await getConfig();
  if (config.turnstileEnabled) {
    return null; // 需要 turnstile token，无法通过脚本自动创建
  }

  const { status, body } = await api('/api/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: 'test-key-' + Date.now() }),
  });

  if (status === 201 && body?.data?.key) {
    return body.data.key;
  }
  return null;
}

// ─── 测试套件 ────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║         Vmail API Key 端到端测试                      ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  Base URL: ${BASE_URL.padEnd(35)}║`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);

  // 获取配置
  let config;
  try {
    config = await getConfig();
    console.log(`\n📋 站点配置:`);
    console.log(`  域名: ${Array.isArray(config.emailDomain) ? config.emailDomain.join(', ') : config.emailDomain}`);
    console.log(`  Turnstile: ${config.turnstileEnabled ? '启用' : '未启用'}`);
    console.log(`  OpenAPI: ${config.openApiEnabled ? '启用' : '禁用'}`);
    console.log(`  限流: ${config.apiRateLimitPerMinute} req/min`);
  } catch (e) {
    console.error(`\n❌ 无法连接站点: ${e.message}`);
    process.exit(1);
  }

  if (!config.openApiEnabled) {
    console.log(`\n⚠️  OpenAPI 已禁用，所有 API Key 测试将被跳过`);
    skip('全部测试', 'OpenAPI 已禁用 (ENABLE_OPENAPI=false)');
    printSummary();
    return;
  }

  const domain = Array.isArray(config.emailDomain) ? config.emailDomain[0] : config.emailDomain;
  if (!domain) {
    console.log(`\n⚠️  未配置 EMAIL_DOMAIN，测试将被跳过`);
    skip('全部测试', '未配置 EMAIL_DOMAIN');
    printSummary();
    return;
  }

  // 获取或创建 API Key
  let testKey = EXISTING_API_KEY;
  if (!testKey) {
    console.log(`\n🔑 尝试自动创建测试 API Key...`);
    testKey = await createApiKeyViaApi();
    if (testKey) {
      console.log(`  ✅ 已创建: ${testKey.substring(0, 15)}...`);
    } else if (config.turnstileEnabled) {
      console.log(`  ⚠️  Turnstile 已启用，无法自动创建 API Key`);
      console.log(`  请手动创建 API Key 或通过 --api-key 参数传入`);
      console.log(`\n  用法: node scripts/test-api-key.mjs --api-key vmail_xxxx`);
      skip('需要 API Key', 'Turnstile 已启用，请手动创建 key 后传入');
      printSummary();
      return;
    } else {
      console.log(`  ❌ 自动创建失败`);
      skip('需要 API Key', '自动创建失败');
      printSummary();
      return;
    }
  }

  console.log(`\n🔑 使用 API Key: ${testKey.substring(0, 15)}...`);

  // 创建第二个 API Key 用于权限隔离测试
  let testKey2 = null;
  if (!EXISTING_API_KEY) {
    testKey2 = await createApiKeyViaApi();
    if (testKey2) {
      console.log(`🔑 第二个 API Key: ${testKey2.substring(0, 15)}...`);
    }
  }

  const authHeader = (key) => ({ 'X-API-Key': key });
  const bearerHeader = (key) => ({ 'Authorization': `Bearer ${key}` });

  // ── 测试 1: 认证中间件 ──────────────────────────────────────────────────
  console.log(`\n📋 测试 1: 认证中间件`);

  // 1a. 无 API Key
  {
    const { status, body } = await api('/api/v1/mailboxes');
    if (status === 401 && body?.error?.code === 'UNAUTHORIZED') {
      pass('无 API Key 返回 401');
    } else {
      fail(`无 API Key 返回 401`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
    }
  }

  // 1b. 无效 API Key
  {
    const { status, body } = await api('/api/v1/mailboxes', {
      headers: authHeader('vmail_invalidkey12345678901234567890'),
    });
    if (status === 401 && body?.error?.code === 'UNAUTHORIZED') {
      pass('无效 API Key 返回 401', `message: ${body.error.message}`);
    } else {
      fail(`无效 API Key 返回 401`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
    }
  }

  // 1c. 有效 API Key (X-API-Key header)
  {
    const { status } = await api('/api/v1/mailboxes', { headers: authHeader(testKey) });
    // 应该返回 404 (没有邮箱) 或 200/201，但不应是 401
    if (status !== 401 && status !== 403) {
      pass('有效 API Key (X-API-Key) 通过认证', `状态: ${status}`);
    } else {
      fail(`有效 API Key (X-API-Key) 通过认证`, `得到 ${status}`);
    }
  }

  // 1d. 有效 API Key (Bearer header)
  {
    const { status } = await api('/api/v1/mailboxes', { headers: bearerHeader(testKey) });
    if (status !== 401 && status !== 403) {
      pass('有效 API Key (Bearer) 通过认证', `状态: ${status}`);
    } else {
      fail(`有效 API Key (Bearer) 通过认证`, `得到 ${status}`);
    }
  }

  // ── 测试 2: 创建邮箱 ───────────────────────────────────────────────────
  console.log(`\n📋 测试 2: 创建邮箱 (POST /api/v1/mailboxes)`);

  let mailboxId;
  let mailboxAddress;

  // 2a. 创建随机邮箱（空 body）
  {
    const { status, body } = await api('/api/v1/mailboxes', {
      method: 'POST',
      headers: authHeader(testKey),
      body: JSON.stringify({}),
    });
    if (status === 201 && body?.data?.id && body?.data?.address) {
      mailboxId = body.data.id;
      mailboxAddress = body.data.address;
      pass('创建随机邮箱', `id=${mailboxId}, address=${mailboxAddress}`);
    } else {
      fail(`创建随机邮箱返回 201`, `得到 ${status}: ${JSON.stringify(body?.error || body)}`);
    }
  }

  // 2b. 创建指定 localPart 的邮箱
  {
    const customLocalPart = `test-${Date.now()}`;
    const { status, body } = await api('/api/v1/mailboxes', {
      method: 'POST',
      headers: authHeader(testKey),
      body: JSON.stringify({ localPart: customLocalPart, domain }),
    });
    if (status === 201 && body?.data?.address === `${customLocalPart}@${domain}`) {
      pass('创建指定 localPart 邮箱', `address=${body.data.address}`);
    } else {
      fail(`创建指定 localPart 邮箱`, `得到 ${status}: ${JSON.stringify(body?.error || body)}`);
    }
  }

  // 2c. 无效域名
  {
    const { status, body } = await api('/api/v1/mailboxes', {
      method: 'POST',
      headers: authHeader(testKey),
      body: JSON.stringify({ domain: 'invalid.com' }),
    });
    if (status === 400 && body?.error?.code === 'VALIDATION_ERROR') {
      pass('无效域名返回 400');
    } else {
      fail(`无效域名返回 400`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
    }
  }

  // 2d. 检查 Rate Limit headers
  {
    const { status, headers, body } = await api('/api/v1/mailboxes', {
      method: 'POST',
      headers: authHeader(testKey),
      body: '{}',
    });
    const limit = headers.get('X-RateLimit-Limit');
    const remaining = headers.get('X-RateLimit-Remaining');
    if (limit && remaining !== null) {
      pass('返回 Rate Limit headers', `Limit=${limit}, Remaining=${remaining}`);
    } else {
      fail(`返回 Rate Limit headers`, `X-RateLimit-Limit=${limit}, X-RateLimit-Remaining=${remaining}`);
    }
  }

  // ── 测试 3: 获取邮箱信息 ───────────────────────────────────────────────
  console.log(`\n📋 测试 3: 获取邮箱信息 (GET /api/v1/mailboxes/:id)`);

  if (mailboxId) {
    // 3a. 获取存在的邮箱
    {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}`, {
        headers: authHeader(testKey),
      });
      if (status === 200 && body?.data?.id === mailboxId && body?.data?.address === mailboxAddress) {
        pass('获取邮箱信息', `messageCount=${body.data.messageCount}`);
      } else {
        fail(`获取邮箱信息返回 200`, `得到 ${status}: ${JSON.stringify(body?.error || body)}`);
      }
    }

    // 3b. 获取不存在的邮箱
    {
      const { status, body } = await api('/api/v1/mailboxes/nonexistent-id', {
        headers: authHeader(testKey),
      });
      if (status === 404 && body?.error?.code === 'NOT_FOUND') {
        pass('不存在的邮箱返回 404');
      } else {
        fail(`不存在的邮箱返回 404`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
      }
    }

    // 3c. 权限隔离：用第二个 key 访问第一个 key 的邮箱
    if (testKey2) {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}`, {
        headers: authHeader(testKey2),
      });
      if (status === 403 && body?.error?.code === 'FORBIDDEN') {
        pass('权限隔离：不同 API Key 不能访问他人邮箱');
      } else {
        fail(`权限隔离`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
      }
    } else {
      skip('权限隔离', '没有第二个 API Key');
    }
  } else {
    skip('获取邮箱信息', '邮箱创建失败，跳过');
  }

  // ── 测试 4: 收件箱操作 ─────────────────────────────────────────────────
  console.log(`\n📋 测试 4: 收件箱操作`);

  if (mailboxId) {
    // 4a. 获取空收件箱
    {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}/messages`, {
        headers: authHeader(testKey),
      });
      if (status === 200 && Array.isArray(body?.data) && body?.pagination) {
        pass('获取空收件箱', `total=${body.pagination.total}, totalPages=${body.pagination.totalPages}`);
      } else {
        fail(`获取空收件箱返回 200`, `得到 ${status}: ${JSON.stringify(body?.error || body)}`);
      }
    }

    // 4b. 获取不存在的邮件
    {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}/messages/fake-msg-id`, {
        headers: authHeader(testKey),
      });
      if (status === 404 && body?.error?.code === 'NOT_FOUND') {
        pass('不存在的邮件返回 404');
      } else {
        fail(`不存在的邮件返回 404`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
      }
    }

    // 4c. 删除不存在的邮件
    {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}/messages/fake-msg-id`, {
        method: 'DELETE',
        headers: authHeader(testKey),
      });
      if (status === 404) {
        pass('删除不存在的邮件返回 404');
      } else {
        fail(`删除不存在的邮件返回 404`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
      }
    }

    // 4d. 权限隔离：收件箱
    if (testKey2) {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}/messages`, {
        headers: authHeader(testKey2),
      });
      if (status === 403 && body?.error?.code === 'FORBIDDEN') {
        pass('权限隔离：收件箱操作');
      } else {
        fail(`权限隔离：收件箱`, `得到 ${status}: ${JSON.stringify(body?.error)}`);
      }
    }
  }

  // ── 测试 5: 分页参数 ───────────────────────────────────────────────────
  console.log(`\n📋 测试 5: 分页参数`);

  if (mailboxId) {
    {
      const { status, body } = await api(`/api/v1/mailboxes/${mailboxId}/messages?page=2&limit=10&sort=asc`, {
        headers: authHeader(testKey),
      });
      if (status === 200 && body?.pagination?.page === 2 && body?.pagination?.limit === 10) {
        pass('分页参数正确传递', `page=${body.pagination.page}, limit=${body.pagination.limit}`);
      } else {
        fail(`分页参数`, `得到 ${status}: ${JSON.stringify(body?.pagination)}`);
      }
    }
  }

  // ── 测试 6: 错误响应格式一致性 ──────────────────────────────────────────
  console.log(`\n📋 测试 6: 错误响应格式一致性`);

  const errorEndpoints = [
    { method: 'GET', path: '/api/v1/mailboxes', desc: '无认证' },
    { method: 'GET', path: '/api/v1/mailboxes/nonexistent', desc: '404', headers: authHeader(testKey) },
    { method: 'POST', path: '/api/v1/mailboxes', desc: '无效域名', headers: authHeader(testKey), body: JSON.stringify({ domain: 'bad.com' }) },
  ];

  for (const ep of errorEndpoints) {
    const { body } = await api(ep.path, { method: ep.method, headers: ep.headers, body: ep.body });
    if (body?.error?.code && body?.error?.message) {
      pass(`错误格式一致: ${ep.desc}`, `code=${body.error.code}, message=${body.error.message}`);
    } else {
      fail(`错误格式一致: ${ep.desc}`, `响应: ${JSON.stringify(body)}`);
    }
  }

  // ── 测试 7: CORS ───────────────────────────────────────────────────────
  console.log(`\n📋 测试 7: CORS 支持`);

  {
    const res = await fetch(`${BASE_URL}/api/v1/mailboxes`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://example.com' },
    });
    const acoc = res.headers.get('access-control-allow-origin');
    if (acoc === '*' || acoc === 'https://example.com') {
      pass('CORS 预检通过', `Access-Control-Allow-Origin: ${acoc}`);
    } else {
      fail(`CORS 预检`, `Access-Control-Allow-Origin: ${acoc}`);
    }
  }

  // ── 总结 ───────────────────────────────────────────────────────────────
  printSummary();
}

function printSummary() {
  const total = passCount + failCount + skipCount;
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║                    测试结果汇总                       ║`);
  console.log(`╠═══════════════════════════════════════════════════════╣`);
  console.log(`║  总计: ${String(total).padEnd(20)}通过: ${String(passCount).padEnd(20)}║`);
  console.log(`║  失败: ${String(failCount).padEnd(20)}跳过: ${String(skipCount).padEnd(20)}║`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

runTests().catch((err) => {
  console.error(`\n💥 测试执行出错:`, err);
  process.exit(1);
});
