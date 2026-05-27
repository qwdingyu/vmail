#!/usr/bin/env node
/**
 * setup-email-routing.mjs
 *
 * 通过 Cloudflare API 自动配置 Email Routing：
 * 1. 查找域名的 Zone ID
 * 2. 启用 Email Routing（自动添加 MX / SPF / DKIM 记录）
 * 3. 创建 Catch-All 规则，将所有邮件转发到 vmail Worker
 *
 * 环境变量：
 *   CF_API_TOKEN  - Cloudflare API Token
 *   CF_ACCOUNT_ID - Cloudflare Account ID
 *   EMAIL_DOMAIN  - 邮箱域名 (默认 eforge.xyz)
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

  const body = await res.text();
  let data = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    return { ok: false, status: res.status, body, data };
  }

  return { ok: true, status: res.status, body, data };
}

// ─── 步骤 1：查找 Zone ID ────────────────────────────────────────────────────

async function findZoneId(domain) {
  console.log(`\n📋 步骤 1: 查找 ${domain} 的 Zone ID...`);

  const res = await cfRequest(`/zones?name=${encodeURIComponent(domain)}`);
  if (!res.ok) {
    throw new Error(`API 请求失败 (${res.status}): ${res.body}`);
  }

  if (!res.data?.success) {
    throw new Error(`API 请求失败: ${JSON.stringify(res.data?.errors)}`);
  }

  const zone = res.data.result?.find(
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enableEmailRouting(zoneId) {
  console.log(`\n📋 步骤 2: 检查 Email Routing 状态...`);

  // 先检查当前状态
  const statusRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`);

  if (!statusRes.ok) {
    // 403/404 可能意味着 Email Routing 尚未启用
    if (statusRes.status === 403 || statusRes.status === 404) {
      console.log("  Email Routing 尚未启用，尝试通过 API 启用...");
    } else {
      throw new Error(`检查 Email Routing 状态失败 (${statusRes.status}): ${statusRes.body}`);
    }
  } else if (statusRes.data?.success) {
    const currentStatus = statusRes.data.result?.status;
    console.log(`  当前状态: ${currentStatus || "未知"}`);

    if (currentStatus === "enabled") {
      console.log("  ✅ Email Routing 已启用，跳过");
      return true;
    }
    console.log("  Email Routing 未启用，尝试通过 API 启用...");
  }

  // 尝试通过 POST 启用 Email Routing
  // Cloudflare API 文档：POST /zones/{zone_id}/email/routing/dns
  const enableRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`, {
    method: "POST",
  });

  if (!enableRes.ok) {
    console.log(`  ⚠️  API 启用失败 (${enableRes.status}): ${enableRes.body}`);
    console.log("");
    console.log("  ╔═══════════════════════════════════════════════════════════╗");
    console.log("  ║  需要手动启用 Email Routing：                            ║");
    console.log("  ║                                                         ║");
    console.log("  ║  1. 登录 Cloudflare Dashboard                          ║");
    console.log("  ║  2. 进入 Workers & Pages → Email Routing               ║");
    console.log(`  ║  3. 选择域名 ${CONFIG.emailDomain}                     ║`);
    console.log('  ║  4. 点击 "Enable Email Routing" 启用                   ║');
    console.log("  ║  5. 然后重新运行此脚本创建路由规则                       ║");
    console.log("  ╚═══════════════════════════════════════════════════════════╝");
    console.log("");
    console.log("  或者，在 Cloudflare Dashboard 中：");
    console.log(`    Email → Email Routing → ${CONFIG.emailDomain} → Enable`);
    console.log("");
    process.exit(1);
  }

  if (enableRes.data?.success) {
    console.log("  ✅ Email Routing 已启用");

    // 等待 DNS 记录生效
    console.log("  ⏳ 等待 DNS 记录生效（最多 60 秒）...");
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const checkRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`);
      if (checkRes.ok && checkRes.data?.result?.status === "enabled") {
        console.log(`  ✅ DNS 记录已生效（${(i + 1) * 5} 秒）`);
        return true;
      }
      if (i % 2 === 0) {
        console.log(`    等待中... ${(i + 1) * 5}秒`);
      }
    }
    console.log("  ⚠️  DNS 记录可能尚未完全生效，但 Email Routing 已启用");
    return true;
  }

  console.log("  ⚠️  API 返回成功但无结果数据，可能需要等待");
  return true;
}

// ─── 步骤 3：创建 Email Routing 规则 ─────────────────────────────────────────

async function createRoutingRule(zoneId) {
  console.log(`\n📋 步骤 3: 创建邮件路由规则...`);
  console.log(`  将所有 ${CONFIG.emailDomain} 邮件转发到 ${CONFIG.workerName} Worker`);

  // 先列出已有规则
  const listRes = await cfRequest(`/zones/${zoneId}/email/routing/rules`);

  if (!listRes.ok) {
    throw new Error(`列出路由规则失败 (${listRes.status}): ${listRes.body}`);
  }

  if (!listRes.data?.success) {
    throw new Error(`列出路由规则失败: ${JSON.stringify(listRes.data?.errors)}`);
  }

  const existing = listRes.data.result?.find(
    (rule) =>
      rule.actions?.[0]?.type === "worker" &&
      (rule.actions?.[0]?.value === CONFIG.workerName ||
       Array.isArray(rule.actions?.[0]?.value) && rule.actions?.[0]?.value?.[0] === CONFIG.workerName)
  );

  // Cloudflare API: actions.value 是 array<string>
  // 参考: https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/
  const rulePayload = {
    name: "Vmail Catch-All",
    matchers: [{ type: "regex", field: "to", value: ".*@" + CONFIG.emailDomain }],
    actions: [{ type: "worker", value: [CONFIG.workerName] }],
  };

  if (existing) {
    console.log(`  ✅ 规则已存在: ${existing.name} (ID: ${existing.id})`);
    console.log(`  正在更新规则...`);

    const updateRes = await cfRequest(
      `/zones/${zoneId}/email/routing/rules/${existing.id}`,
      {
        method: "PATCH",
        body: JSON.stringify(rulePayload),
      }
    );

    if (!updateRes.ok) {
      throw new Error(`更新路由规则失败 (${updateRes.status}): ${updateRes.body}`);
    }
    if (!updateRes.data?.success) {
      throw new Error(`更新路由规则失败: ${JSON.stringify(updateRes.data?.errors)}`);
    }
    console.log("  ✅ 规则已更新");
    return updateRes.data.result;
  }

  console.log("  ⏳ 正在创建规则...");

  const createRes = await cfRequest(`/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify(rulePayload),
  });

  if (!createRes.ok) {
    throw new Error(`创建路由规则失败 (${createRes.status}): ${createRes.body}`);
  }

  if (!createRes.data?.success) {
    throw new Error(`创建路由规则失败: ${JSON.stringify(createRes.data?.errors)}`);
  }

  console.log(`  ✅ 规则已创建 (ID: ${createRes.data.result.id})`);
  return createRes.data.result;
}

// ─── 步骤 4：验证 ────────────────────────────────────────────────────────────

async function verifySetup(zoneId) {
  console.log(`\n📋 步骤 4: 验证配置...`);

  // 检查 Email Routing 状态
  const dnsRes = await cfRequest(`/zones/${zoneId}/email/routing/dns`);
  if (dnsRes.ok && dnsRes.data?.success) {
    const status = dnsRes.data.result?.status;
    if (status === "enabled") {
      console.log("  ✅ Email Routing: 已启用");
    } else {
      console.log(`  ⚠️  Email Routing 状态: ${status || "未知"}`);
    }
  } else {
    console.log("  ⚠️  无法检查 Email Routing 状态");
  }

  // 检查 MX 记录
  const mxRes = await cfRequest(`/zones/${zoneId}/dns_records?type=MX`);
  if (mxRes.ok && mxRes.data?.success) {
    const mxRecords = mxRes.data.result?.filter(
      (r) => r.name === CONFIG.emailDomain || r.name === `@${CONFIG.emailDomain}`
    ) || [];

    if (mxRecords.length > 0) {
      console.log(`  ✅ MX 记录: ${mxRecords.map((r) => `${r.priority} ${r.content}`).join(", ")}`);
    } else {
      console.log("  ⚠️  未找到 MX 记录（可能需要等待 DNS 传播）");
    }
  }

  // 检查路由规则
  const rulesRes = await cfRequest(`/zones/${zoneId}/email/routing/rules`);
  if (rulesRes.ok && rulesRes.data?.success) {
    const rules = rulesRes.data.result || [];
    console.log(`  ✅ 路由规则数量: ${rules.length}`);
    for (const rule of rules) {
      const action = rule.actions?.[0];
      const actionValue = Array.isArray(action?.value) ? action.value.join(", ") : (action?.value || "N/A");
      console.log(`    - ${rule.name}: ${action?.type} → ${actionValue}`);
    }
  }

  console.log("");
  console.log("  公共 DNS 验证（在终端运行）：");
  console.log(`    dig ${CONFIG.emailDomain} MX`);
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

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
