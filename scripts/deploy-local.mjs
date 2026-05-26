#!/usr/bin/env node

/*
 * Vmail 本地部署脚本
 * 自动完成：占位符替换 → 构建 → D1 迁移 → 部署 → 域名绑定 → 恢复 wrangler.toml
 *
 * 使用方式：
 *   cd vmail && node scripts/deploy-local.mjs
 *
 * 环境变量（也可通过脚本内 CONFIG 对象配置）：
 *   CF_API_TOKEN       - Cloudflare API Token
 *   CF_ACCOUNT_ID      - Cloudflare Account ID (可选，自动查询)
 *   D1_DATABASE_ID     - D1 数据库 ID (可选，自动查询 vmail)
 *   D1_DATABASE_NAME   - D1 数据库名称，默认 vmail
 *   EMAIL_DOMAIN       - 邮箱域名，默认 mail.eforge.xyz
 *   COOKIES_SECRET     - Cookie 加密密钥 (可选，自动生成)
 *   TURNSTILE_KEY      - Turnstile Site Key (可选)
 *   TURNSTILE_SECRET   - Turnstile Secret Key (可选)
 *   PASSWORD           - 站点访问密码 (可选)
 *   API_RATE_LIMIT     - API 限流 (可选，默认 100)
 *   SHOW_AFF           - 是否显示推广 (可选)
 *   ENABLE_OPENAPI     - 是否启用 OpenAPI (可选，默认 true)
 *   CUSTOM_DOMAIN      - 自定义域名，默认 mail.eforge.xyz
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WRANGLER_TOML = join(ROOT, "wrangler.toml");

// ── 配置 ──────────────────────────────────────────────
const CONFIG = {
  accountId: process.env.CF_ACCOUNT_ID || "f4c2f5b7c4134455ba93f1ebc0233664",
  d1DatabaseId: process.env.D1_DATABASE_ID || null,
  d1DatabaseName: process.env.D1_DATABASE_NAME || "vmail",
  emailDomain: process.env.EMAIL_DOMAIN || "mail.eforge.xyz",
  cookiesSecret: process.env.COOKIES_SECRET || null,
  turnstileKey: process.env.TURNSTILE_KEY || "",
  turnstileSecret: process.env.TURNSTILE_SECRET || "",
  password: process.env.PASSWORD || "",
  apiRateLimit: process.env.API_RATE_LIMIT || "100",
  showAff: process.env.SHOW_AFF || "",
  enableOpenApi: process.env.ENABLE_OPENAPI || "true",
  customDomain: process.env.CUSTOM_DOMAIN || "mail.eforge.xyz",
  workerService: process.env.WORKER_SERVICE || "vmail",
};

// ── 工具函数 ──────────────────────────────────────────
function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, { cwd: ROOT, stdio: opts.silent ? "pipe" : "inherit", encoding: "utf-8" });
    return out.trim();
  } catch (err) {
    if (opts.optional) return null;
    throw new Error(`Command failed: ${cmd}\n${err.stdout || ""}\n${err.stderr || err.message}`);
  }
}

function generateSecret() {
  return run("openssl rand -base64 32", { silent: true });
}

// 通过 wrangler API 查询 D1 数据库
function findD1Database(name) {
  try {
    const out = run("npx wrangler d1 list --format json", { silent: true });
    // wrangler d1 list may not support --format json, fallback to text parsing
    const databases = JSON.parse(out);
    if (Array.isArray(databases)) {
      return databases.find((db) => db.name === name || db.database_name === name);
    }
  } catch {
    // Fallback: parse text output
    try {
      const out = run("npx wrangler d1 list", { silent: true });
      const lines = out.split("\n");
      for (const line of lines) {
        if (line.includes(name)) {
          const match = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (match) return { uuid: match[1], name };
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

// ── wrangler.toml 管理 ────────────────────────────────
const BACKUP_FILE = join(ROOT, "wrangler.toml.backup");

function backupWrangler() {
  if (!existsSync(BACKUP_FILE)) {
    const content = readFileSync(WRANGLER_TOML, "utf-8");
    writeFileSync(BACKUP_FILE, content);
    console.log("  Backed up wrangler.toml → wrangler.toml.backup");
  }
}

function restoreWrangler() {
  if (existsSync(BACKUP_FILE)) {
    const backup = readFileSync(BACKUP_FILE, "utf-8");
    writeFileSync(WRANGLER_TOML, backup);
    // Remove backup
    const { unlinkSync } = await import("node:fs");
    unlinkSync(BACKUP_FILE);
    console.log("  Restored wrangler.toml from backup");
  }
}

function buildWranglerToml() {
  const d1Id = CONFIG.d1DatabaseId;
  if (!d1Id) {
    const db = findD1Database(CONFIG.d1DatabaseName);
    if (db) {
      CONFIG.d1DatabaseId = db.uuid;
      console.log(`  Auto-resolved D1 database ID: ${db.uuid}`);
    } else {
      throw new Error(
        `Cannot find D1 database "${CONFIG.d1DatabaseName}". ` +
        `Create it with: npx wrangler d1 create ${CONFIG.d1DatabaseName}\n` +
        `Or set D1_DATABASE_ID environment variable.`
      );
    }
  }

  if (!CONFIG.cookiesSecret) {
    CONFIG.cookiesSecret = generateSecret();
    console.log(`  Generated COOKIES_SECRET: ${CONFIG.cookiesSecret}`);
  }

  let toml = `name = "${CONFIG.workerService}"
main = "worker/src/index.ts"

# 打包配置
minify = true
compatibility_flags = [ "nodejs_compat" ]
compatibility_date = "2025-03-01"
keep_vars = true

# 启用 D1 数据库
[[d1_databases]]
binding = "DB"
database_name = "${CONFIG.d1DatabaseName}"
database_id = "${CONFIG.d1DatabaseId}"
migrations_dir = "worker/drizzle"

# 定义环境变量和密钥
[vars]
EMAIL_DOMAIN = "${CONFIG.emailDomain}"
TURNSTILE_KEY = "${CONFIG.turnstileKey}"
COOKIES_SECRET = "${CONFIG.cookiesSecret}"
TURNSTILE_SECRET = "${CONFIG.turnstileSecret}"
`;

  // 可选变量：只有非空时才写入
  if (CONFIG.password) {
    toml += `PASSWORD = "${CONFIG.password}"\n`;
  }
  if (CONFIG.apiRateLimit) {
    toml += `API_RATE_LIMIT_PER_MINUTE = "${CONFIG.apiRateLimit}"\n`;
  }
  if (CONFIG.showAff) {
    toml += `SHOW_AFF = "${CONFIG.showAff}"\n`;
  }
  if (CONFIG.enableOpenApi) {
    toml += `ENABLE_OPENAPI = "${CONFIG.enableOpenApi}"\n`;
  }

  toml += `
# 配置邮件处理
[triggers]
crons = ["0 * * * *"] # 每小时运行一次清理任务

# 构建配置
[build]
command = "pnpm run build"

# 静态资源配置
[assets]
binding = "ASSETS"
directory = "frontend/build/client"
`;

  writeFileSync(WRANGLER_TOML, toml);
  console.log("  Generated wrangler.toml with real values");
}

// ── 域名绑定 ──────────────────────────────────────────
async function bindCustomDomain() {
  const { spawn } = await import("node:child_process");
  const domainScript = join(ROOT, "..", "scripts", "cloudflare", "workers_custom_domain_bind.mjs");

  if (!existsSync(domainScript)) {
    console.log(`  Domain script not found at ${domainScript}, skipping auto-bind.`);
    console.log(`  Manually bind: CF_WORKER_SERVICE="${CONFIG.workerService}" CF_CUSTOM_DOMAIN="${CONFIG.customDomain}" node scripts/cloudflare/workers_custom_domain_bind.mjs`);
    return;
  }

  console.log(`  Binding custom domain: ${CONFIG.customDomain} → ${CONFIG.workerService}`);

  return new Promise((resolve, reject) => {
    const child = spawn("node", [domainScript], {
      env: {
        ...process.env,
        CF_API_TOKEN: process.env.CF_API_TOKEN || "",
        CF_ACCOUNT_ID: CONFIG.accountId,
        CF_WORKER_SERVICE: CONFIG.workerService,
        CF_CUSTOM_DOMAIN: CONFIG.customDomain,
        CF_WAIT_ATTEMPTS: "12",
        CF_WAIT_INTERVAL_MS: "5000",
      },
      stdio: "inherit",
      cwd: ROOT,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Domain binding script exited with code ${code}`));
    });
  });
}

// ── 主流程 ────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║        Vmail Deploy Script                   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  // Step 0: 备份 wrangler.toml
  console.log("[1/7] Backing up wrangler.toml...");
  backupWrangler();
  console.log();

  // Step 1: 生成带真实值的 wrangler.toml
  console.log("[2/7] Configuring wrangler.toml...");
  console.log(`  D1 Database: ${CONFIG.d1DatabaseName}`);
  console.log(`  Email Domain: ${CONFIG.emailDomain}`);
  console.log(`  Rate Limit: ${CONFIG.apiRateLimit}/min`);
  console.log(`  OpenAPI: ${CONFIG.enableOpenApi}`);
  buildWranglerToml();
  console.log();

  // Step 2: 安装依赖
  console.log("[3/7] Installing dependencies...");
  run("pnpm install --no-frozen-lockfile");
  console.log();

  // Step 3: 构建前端
  console.log("[4/7] Building frontend...");
  run("pnpm run build");
  console.log();

  // Step 4: 应用 D1 迁移
  console.log("[5/7] Applying D1 migrations...");
  try {
    run(`npx wrangler d1 migrations apply ${CONFIG.d1DatabaseName} --remote`);
    console.log("  D1 migrations applied successfully");
  } catch (err) {
    console.log(`  Warning: D1 migration failed (may already be applied): ${err.message}`);
  }
  console.log();

  // Step 5: 部署到 Cloudflare
  console.log("[6/7] Deploying to Cloudflare Workers...");
  const deployOutput = run("npx wrangler deploy", { silent: true });
  console.log(deployOutput);
  console.log();

  // Step 6: 恢复 wrangler.toml
  console.log("[7/7] Restoring wrangler.toml...");
  restoreWrangler();
  console.log();

  // Step 7: 绑定自定义域名
  console.log("[BONUS] Binding custom domain...");
  try {
    await bindCustomDomain();
  } catch (err) {
    console.log(`  Domain binding warning: ${err.message}`);
  }
  console.log();

  // 验证
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║        Deployment Complete!                   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();
  console.log(`Worker URL:    https://${CONFIG.workerService}.<account>.workers.dev`);
  console.log(`Custom Domain: https://${CONFIG.customDomain}`);
  console.log();
  console.log("Verify:");
  console.log(`  curl -s https://${CONFIG.customDomain}/config | jq`);
  console.log(`  curl -s https://${CONFIG.customDomain}/api/stats | jq`);
  console.log();

  // 输出 GitHub Secrets 配置提示
  console.log("═".repeat(50));
  console.log("GitHub Secrets 配置（用于自动部署）:");
  console.log("═".repeat(50));
  console.log(`  CF_API_TOKEN       = <你的 Cloudflare API Token>`);
  console.log(`  CF_ACCOUNT_ID      = ${CONFIG.accountId}`);
  console.log(`  D1_DATABASE_ID     = ${CONFIG.d1DatabaseId}`);
  console.log(`  D1_DATABASE_NAME   = ${CONFIG.d1DatabaseName}`);
  console.log(`  EMAIL_DOMAIN       = ${CONFIG.emailDomain}`);
  console.log(`  COOKIES_SECRET     = ${CONFIG.cookiesSecret}`);
  if (CONFIG.turnstileKey) console.log(`  TURNSTILE_KEY      = ${CONFIG.turnstileKey}`);
  if (CONFIG.turnstileSecret) console.log(`  TURNSTILE_SECRET   = ${CONFIG.turnstileSecret}`);
  if (CONFIG.password) console.log(`  PASSWORD           = ${CONFIG.password}`);
  console.log(`  API_RATE_LIMIT_PER_MINUTE = ${CONFIG.apiRateLimit}`);
  console.log(`  ENABLE_OPENAPI     = ${CONFIG.enableOpenApi}`);
  console.log("═".repeat(50));
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message);
  // 尝试恢复 wrangler.toml
  try {
    if (existsSync(BACKUP_FILE)) {
      const { writeFileSync, unlinkSync } = await import("node:fs");
      writeFileSync(WRANGLER_TOML, readFileSync(BACKUP_FILE, "utf-8"));
      unlinkSync(BACKUP_FILE);
      console.log("  Restored wrangler.toml from backup");
    }
  } catch {
    // ignore
  }
  process.exit(1);
});
