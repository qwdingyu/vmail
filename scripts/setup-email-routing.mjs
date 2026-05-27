#!/usr/bin/env node
/**
 * setup-email-routing.mjs
 *
 * 通过 Cloudflare API 自动配置 Email Routing：
 * 1. 查找 eforge.xyz 的 Zone ID
 * 2. 启用 Email Routing（自动添加 MX / SPF / DKIM 记录）
 * 3. 创建 Catch-All 规则，将所有邮件转发到 vmail Worker
 *
 * 环境变量：
 *   CF_API_TOKEN  - Cloudflare API Token（需要 Zone Read + Email Routing Edit + Email Routing Rules Write）
 *   CF_ACCOUNT_ID - Cloudflare Account ID
 *
 * 用法：
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=xxx node scripts/setup-email-routing.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ─── 读取配置 ────────────────────────────────────────────────────────────────

function loadWrangler() {
  const raw = readFileSync(join(ROOT, "wrangler.toml"), "utf-8");
  const nameMatch = raw.match(/^name\s*=\s*"([^"]+)"/m);
  return {
    workerName: nameMatch ? nameMatch[1] : "vmail",
  };
}

const CONFIG = {
  apiToken: process.env.CF_API_TOKEN,
  accountId: process.env.CF_ACCOUNT_ID,
  emailDomain: process.env.EMAIL_DOMAIN || "eforge.xyz",
  ...loadWrangler(),
};

if (!CONFIG.apiToken) {
  console.error("错误：请设置 CF_API_TOKEN 环境变量");
  console.error("  在 Cloudflare Dashboard → Profile → API Tokens → Create Token");
  console.error("  权限需要：Zone Read + Email Routing Edit + Email Routing Rules Write");
  process.exit(1);
}
if (!CONFIG.accountId) {
  console.error("错误：请设置 CF_ACCOUNT_ID 环境变量");
  process.exit(1);
}

// ─── Cloudflare API 封装 ─────────────────────────────────────────────────────

async function cfRequest(path, opts = {}) {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${CONFIG.apiToken}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare API ${res.status} ${path}: ${body}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── 步骤 1：查找 Zone ID ────────────────────────────────────────────────────

async function findZoneId(domain) {
  console.log(`\n📋 步骤 1: 查找 ${domain} 的 Zone ID...`);

  const res = await cfRequest(`/zones?name=${encodeURIComponent(domain)}`);

  if (!res.success) {
    throw new Error(`API 请求失败: ${JSON.stringify(res.errors)}`);
  }

  const zone = res.result?.find(
    (z) => z.name === domain && z.status === "active"
  );

  if (!zone) {
    throw new Error(
      `域名 ${domain} 在您的 Cloudflare 账户中未找到，或状态不是 active。\n` +
        `请确认域名已添加到 Cloudflare 且 DNS 由 Cloudflare 管理。`
    );
  }

  console.log(`  ✅ Zone ID: ${zone.id}`);
  console.log(`  ✅ 域名: ${zone.name} (${zone.status})`);
  return zone.id;
}

// ─── 步骤 2：检查 / 启用 Email Routing ───────────────────────────────────────

async function enableEmailRouting(zoneId) {
  console.log(`\n📋 步骤 2: 检查 Email Routing 状态...`);

  // 先检查当前状态
  const statusRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`);

  if (!statusRes.success) {
    throw new Error(`检查 Email Routing 状态失败: ${JSON.stringify(statusRes.errors)}`);
  }

  const currentStatus = statusRes.result?.status;
  console.log(`  当前状态: ${currentStatus || "未知"}`);

  if (currentStatus === "enabled") {
    console.log("  ✅ Email Routing 已启用，跳过");
    return statusRes.result;
  }

  console.log("  ⏳ 正在启用 Email Routing...");
  console.log("  （这将自动添加 MX、SPF、DKIM DNS 记录）");

  const enableRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  if (!enableRes.success) {
    throw new Error(`启用 Email Routing 失败: ${JSON.stringify(enableRes.errors)}`);
  }

  console.log("  ✅ Email Routing 已启用");

  // 等待 DNS 记录生效
  console.log("  ⏳ 等待 DNS 记录生效（最多 60 秒）...");
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const checkRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`);
    if (checkRes.result?.status === "enabled") {
      console.log(`  ✅ DNS 记录已生效（${(i + 1) * 5} 秒）`);
      return checkRes.result;
    }
    if (i % 2 === 0) {
      console.log(`    等待中... ${(i + 1) * 5}秒`);
    }
  }

  console.log("  ⚠️  DNS 记录可能尚未完全生效，但 Email Routing 已启用");
  return enableRes.result;
}

// ─── 步骤 3：创建 Email Routing 规则 ─────────────────────────────────────────

async function createRoutingRule(zoneId) {
  console.log(`\n📋 步骤 3: 创建邮件路由规则...`);
  console.log(`  将所有 ${CONFIG.emailDomain} 邮件转发到 ${CONFIG.workerName} Worker`);

  // 先列出已有规则
  const listRes = await cfRequest(`/zones/${zoneId}/email/routing/rules`);

  if (!listRes.success) {
    throw new Error(`列出路由规则失败: ${JSON.stringify(listRes.errors)}`);
  }

  const existing = listRes.result?.find(
    (rule) =>
      rule.action?.type === "worker" &&
      rule.action?.value === CONFIG.workerName
  );

  if (existing) {
    console.log(`  ✅ 规则已存在: ${existing.name} (ID: ${existing.id})`);
    console.log(`  正在更新规则...`);

    const updateRes = await cfRequest(
      `/zones/${zoneId}/email/routing/rules/${existing.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: "Vmail Catch-All",
          match: { all: [{ field: "header", op: "exists", value: "from" }] },
          action: { type: "worker", value: CONFIG.workerName },
        }),
      }
    );

    if (!updateRes.success) {
      throw new Error(`更新路由规则失败: ${JSON.stringify(updateRes.errors)}`);
    }
    console.log("  ✅ 规则已更新");
    return updateRes.result;
  }

  console.log("  ⏳ 正在创建规则...");

  const createRes = await cfRequest(`/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify({
      name: "Vmail Catch-All",
      match: { all: [{ field: "header", op: "exists", value: "from" }] },
      action: { type: "worker", value: CONFIG.workerName },
    }),
  });

  if (!createRes.success) {
    throw new Error(`创建路由规则失败: ${JSON.stringify(createRes.errors)}`);
  }

  console.log(`  ✅ 规则已创建 (ID: ${createRes.result.id})`);
  return createRes.result;
}

// ─── 步骤 4：验证 ────────────────────────────────────────────────────────────

async function verifySetup(zoneId) {
  console.log(`\n📋 步骤 4: 验证配置...`);

  // 检查 MX 记录
  const dnsRes = await cfRequest(`/zones/${zoneId}/dns_records?type=MX`);
  const mxRecords = dnsRes.result?.filter(
    (r) => r.name === CONFIG.emailDomain || r.name === `@${CONFIG.emailDomain}`
  ) || [];

  if (mxRecords.length > 0) {
    console.log(`  ✅ MX 记录: ${mxRecords.map((r) => `${r.priority} ${r.content}`).join(", ")}`);
  } else {
    console.log("  ⚠️  未找到 MX 记录（可能需要等待 DNS 传播）");
  }

  // 检查路由规则
  const rulesRes = await cfRequest(`/zones/${zoneId}/email/routing/rules`);
  const rules = rulesRes.result || [];
  console.log(`  ✅ 路由规则数量: ${rules.length}`);
  for (const rule of rules) {
    console.log(`    - ${rule.name}: ${rule.action?.type} → ${rule.action?.value || "N/A"}`);
  }

  return { mxRecords, rules };
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║         Vmail Email Routing 自动配置工具              ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║  域名:    ${CONFIG.emailDomain.padEnd(35)}║`);
  console.log(`║  Worker:  ${CONFIG.workerName.padEnd(35)}║`);
  console.log(`║  Account: ${CONFIG.accountId.substring(0, 8)}...`.padEnd(36) + "║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  try {
    const zoneId = await findZoneId(CONFIG.emailDomain);
    await enableEmailRouting(zoneId);
    await createRoutingRule(zoneId);
    await verifySetup(zoneId);

    console.log(`\n🎉 Email Routing 配置完成！`);
    console.log(`\n验证方法：`);
    console.log(`  1. 发送测试邮件到 test@${CONFIG.emailDomain}`);
    console.log(`  2. 访问 https://mail.${CONFIG.emailDomain} 查看是否收到`);
    console.log(`  3. 检查 DNS: dig ${CONFIG.emailDomain} MX`);
  } catch (err) {
    console.error(`\n❌ 配置失败: ${err.message}`);
    process.exit(1);
  }
}

main();
