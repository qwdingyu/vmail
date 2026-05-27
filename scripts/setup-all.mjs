#!/usr/bin/env node
/**
 * setup-all.mjs — 一键配置 vmail 部署
 *
 * 只需提供 CF_API_TOKEN，自动完成：
 * 1. 查询 Cloudflare Account ID
 * 2. 查找域名 Zone ID
 * 3. 创建或查找 D1 数据库
 * 4. 生成随机密钥（COOKIES_SECRET 等）
 * 5. 设置所有 GitHub Secrets
 * 6. 触发 GitHub Actions 部署
 *
 * 用法：
 *   CF_API_TOKEN=cfat_xxx node scripts/setup-all.mjs
 *
 * 可选环境变量：
 *   EMAIL_DOMAIN       - 邮箱域名 (默认 eforge.xyz)
 *   D1_DATABASE_NAME   - D1 数据库名 (默认 vmail-db)
 *   GITHUB_REPO        - GitHub 仓库 (默认 qwdingyu/vmail)
 *   TRIGGER_DEPLOY     - 设置任意值则自动触发部署 (默认不触发)
 */

import { randomBytes } from "node:crypto";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG = {
  cfApiToken: process.env.CF_API_TOKEN,
  emailDomain: process.env.EMAIL_DOMAIN || "eforge.xyz",
  d1DatabaseName: process.env.D1_DATABASE_NAME || "vmail-db",
  githubRepo: process.env.GITHUB_REPO || "qwdingyu/vmail",
  triggerDeploy: !!process.env.TRIGGER_DEPLOY,
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function generateSecret(length = 32) {
  return randomBytes(length).toString("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cfRequest(path, opts = {}) {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${CONFIG.cfApiToken}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    const msg = data.errors?.map((e) => e.message).join(", ") || data.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`Cloudflare API ${res.status} ${url}: ${msg}`);
  }
  return data;
}

async function ghRun(cmd) {
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
    return out.trim();
  } catch (err) {
    throw new Error(`gh command failed: ${cmd}\n${err.stderr || err.message}`);
  }
}

/**
 * 通过 stdin 管道设置 GitHub Secret，避免 shell 转义问题
 */
async function ghSetSecret(name, value) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(`gh secret set ${name} --app actions --repo ${CONFIG.githubRepo}`, {
      input: value,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`gh secret set ${name} failed:\n${err.stderr || err.message}`);
  }
}

// ─── 步骤 1: 获取 Account ID ─────────────────────────────────────────────────

async function getAccountId() {
  console.log("🔍 步骤 1: 查询 Cloudflare Account ID...");
  const data = await cfRequest("/accounts");
  const accounts = data.result || [];

  if (accounts.length === 0) {
    throw new Error("未找到任何 Cloudflare 账户，请检查 API Token 权限");
  }

  // 如果有多个账户，使用第一个（或可以通过环境变量指定 guid）
  const account = accounts.find((a) => a.guid === process.env.CF_ACCOUNT_GUID) || accounts[0];
  console.log(`  ✅ Account ID: ${account.id}`);
  console.log(`     Account 名称: ${account.name}`);
  return account.id;
}

// ─── 步骤 2: 获取 Zone ID ────────────────────────────────────────────────────

async function getZoneId() {
  console.log(`\n🔍 步骤 2: 查找域名 "${CONFIG.emailDomain}" 的 Zone ID...`);
  const data = await cfRequest(`/zones?name=${encodeURIComponent(CONFIG.emailDomain)}&per_page=1`);
  const zones = data.result || [];

  if (zones.length === 0) {
    throw new Error(
      `域名 "${CONFIG.emailDomain}" 未在任何 Zone 中找到。\n` +
        `请确认域名已添加到 Cloudflare，且 API Token 有 Zone Read 权限。`
    );
  }

  const zone = zones[0];
  console.log(`  ✅ Zone ID: ${zone.id}`);
  console.log(`     域名: ${zone.name} (${zone.status})`);
  return zone.id;
}

// ─── 步骤 3: 创建或查找 D1 数据库 ────────────────────────────────────────────

async function getOrCreateD1Database(accountId) {
  console.log(`\n🔍 步骤 3: 查找或创建 D1 数据库 "${CONFIG.d1DatabaseName}"...`);

  // 3a. 列出已有数据库
  const listData = await cfRequest(`/accounts/${accountId}/d1/database`);
  const databases = listData.result || [];
  const existing = databases.find((db) => db.name === CONFIG.d1DatabaseName);

  if (existing) {
    console.log(`  ✅ 已存在 D1 数据库: ${existing.name}`);
    console.log(`     Database ID: ${existing.uuid}`);
    console.log(`     创建时间: ${existing.created_at}`);
    return { id: existing.uuid, name: existing.name };
  }

  // 3b. 创建新数据库
  console.log(`  📦 未找到，正在创建新 D1 数据库...`);
  const createData = await cfRequest(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: { name: CONFIG.d1DatabaseName },
  });

  if (!createData.result?.uuid) {
    throw new Error(`创建 D1 数据库失败: ${JSON.stringify(createData).slice(0, 200)}`);
  }

  const db = createData.result;
  console.log(`  ✅ D1 数据库创建成功: ${db.name}`);
  console.log(`     Database ID: ${db.uuid}`);

  // 等待数据库就绪
  console.log(`  ⏳ 等待数据库初始化...`);
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const statusData = await cfRequest(`/accounts/${accountId}/d1/database/${db.uuid}`);
    if (statusData.result?.version !== "beta") {
      break;
    }
    if (i % 5 === 0) console.log(`     等待中... (${i * 2}s)`);
  }

  return { id: db.uuid, name: db.name };
}

// ─── 步骤 4: 生成随机密钥 ────────────────────────────────────────────────────

function generateSecrets() {
  console.log("\n🔐 步骤 4: 生成随机密钥...");

  const secrets = {
    COOKIES_SECRET: generateSecret(32),
    TURNSTILE_KEY: "",         // 可选，需要用户在 Cloudflare 创建
    TURNSTILE_SECRET: "",      // 可选
    PASSWORD: "",              // 可选，空表示无密码保护
    API_RATE_LIMIT_PER_MINUTE: "100",
    SHOW_AFF: "false",         // 默认不显示广告
    ENABLE_OPENAPI: "true",    // 默认启用 OpenAPI
  };

  console.log(`  ✅ COOKIES_SECRET: ${secrets.COOKIES_SECRET.slice(0, 16)}...`);
  console.log(`  ✅ API_RATE_LIMIT: ${secrets.API_RATE_LIMIT_PER_MINUTE}/min`);
  console.log(`  ✅ ENABLE_OPENAPI: ${secrets.ENABLE_OPENAPI}`);
  console.log(`  ℹ️  TURNSTILE_KEY/SECRET: 留空（可选，需要 Cloudflare Turnstile 配置）`);
  console.log(`  ℹ️  PASSWORD: 留空（可选，设置后管理页面需要密码）`);

  return secrets;
}

// ─── 步骤 5: 设置 GitHub Secrets ─────────────────────────────────────────────

async function setGithubSecrets(accountId, d1Database, secrets) {
  console.log("\n☁️  步骤 5: 设置 GitHub Secrets...");

  const allSecrets = {
    CF_API_TOKEN: CONFIG.cfApiToken,
    CF_ACCOUNT_ID: accountId,
    D1_DATABASE_ID: d1Database.id,
    D1_DATABASE_NAME: d1Database.name,
    EMAIL_DOMAIN: CONFIG.emailDomain,
    ...secrets,
  };

  // 跳过空值
  const toSet = Object.entries(allSecrets).filter(([, v]) => v !== "");

  for (const [name, value] of toSet) {
    console.log(`  📝 设置 ${name}...`);
    await ghSetSecret(name, value);
    console.log(`     ✅ ${name}`);
  }

  // 显示跳过的
  const skipped = Object.entries(allSecrets).filter(([, v]) => v === "");
  if (skipped.length > 0) {
    console.log(`\n  ⏭️  跳过的可选 Secrets（值为空）:`);
    for (const [name] of skipped) {
      console.log(`     - ${name}`);
    }
  }

  return allSecrets;
}

// ─── 步骤 6: 触发部署 ────────────────────────────────────────────────────────

async function triggerDeploy() {
  if (!CONFIG.triggerDeploy) {
    console.log("\n⏭️  跳过自动部署（设置 TRIGGER_DEPLOY=1 环境变量可自动触发）");
    return;
  }

  console.log("\n🚀 步骤 6: 触发 GitHub Actions 部署...");
  await ghRun(`gh workflow run .github/workflows/deploy.yml --repo ${CONFIG.githubRepo}`);
  console.log("  ✅ 部署已触发！");
  console.log(`     查看日志: gh run list --repo ${CONFIG.githubRepo}`);
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────

async function main() {
  // 验证必要的环境变量
  if (!CONFIG.cfApiToken) {
    console.error("❌ 缺少 CF_API_TOKEN 环境变量");
    console.error("用法: CF_API_TOKEN=cfat_xxx node scripts/setup-all.mjs");
    process.exit(1);
  }

  if (!CONFIG.cfApiToken.startsWith("cfat_")) {
    console.error("❌ CF_API_TOKEN 格式不正确，应以 'cfat_' 开头");
    process.exit(1);
  }

  // 检查 gh CLI
  try {
    await ghRun("gh auth status");
  } catch {
    console.error("❌ gh CLI 未配置，请运行: gh auth login");
    process.exit(1);
  }

  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║         Vmail 一键部署配置工具                         ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║  域名:     ${CONFIG.emailDomain.padEnd(34)}║`);
  console.log(`║  数据库:   ${CONFIG.d1DatabaseName.padEnd(34)}║`);
  console.log(`║  仓库:     ${CONFIG.githubRepo.padEnd(34)}║`);
  console.log(`║  Token:    ${CONFIG.cfApiToken.slice(0, 12)}...`.padEnd(36) + "║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  try {
    // 执行所有步骤
    const accountId = await getAccountId();
    const zoneId = await getZoneId();
    const d1Database = await getOrCreateD1Database(accountId);
    const secrets = generateSecrets();
    await setGithubSecrets(accountId, d1Database, secrets);
    await triggerDeploy();

    // 总结
    console.log("\n╔═══════════════════════════════════════════════════════╗");
    console.log("║  🎉 配置完成！                                       ║");
    console.log("╠═══════════════════════════════════════════════════════╣");
    console.log("║  GitHub Secrets 已设置:                               ║");
    console.log(`║    CF_API_TOKEN     ✅                                ║`);
    const pad = (text, totalLen = 50) => text + " ".repeat(Math.max(0, totalLen - text.length));
    console.log(`║    CF_ACCOUNT_ID    ✅ ${pad(accountId.slice(0, 8) + "...")}`);
    console.log(`║    D1_DATABASE_ID   ✅ ${pad(d1Database.id.slice(0, 8) + "...")}`);
    console.log(`║    D1_DATABASE_NAME ✅ ${pad(d1Database.name)}`);
    console.log(`║    EMAIL_DOMAIN     ✅ ${pad(CONFIG.emailDomain)}`);
    console.log("║    COOKIES_SECRET   ✅" + " ".repeat(38) + "║");
    console.log("╠═══════════════════════════════════════════════════════╣");
    console.log("║  可选（未设置，需要时手动添加）:                        ║");
    console.log("║    TURNSTILE_KEY/SECRET - Cloudflare Turnstile        ║");
    console.log("║    PASSWORD           - 管理密码                       ║");
    console.log("╠═══════════════════════════════════════════════════════╣");
    console.log("║  下一步:                                              ║");
    console.log("║    1. push 代码或手动触发部署:                         ║");
    console.log("║       gh workflow run deploy.yml                      ║");
    console.log(`║       --repo ${CONFIG.githubRepo}` + " ".repeat(14) + "║");
    console.log("║    2. 查看部署日志:                                    ║");
    console.log(`║       gh run list --repo ${CONFIG.githubRepo}` + " ".repeat(2) + "║");
    console.log("╚═══════════════════════════════════════════════════════╝");
  } catch (err) {
    console.error(`\n❌ 配置失败: ${err.message}`);
    process.exit(1);
  }
}

main();
