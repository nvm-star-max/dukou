#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const folder = path.dirname(fileURLToPath(import.meta.url));
const tokens = process.argv.slice(2);
const languageIndex = tokens.indexOf("--lang");
const language = languageIndex < 0 ? "en" : tokens[languageIndex + 1];
if (!["en", "zh"].includes(language)) {
  console.error("Use --lang en or --lang zh");
  process.exit(1);
}
if (languageIndex >= 0) tokens.splice(languageIndex, 2);
const [command = "help", ...args] = tokens;
const text = (en, zh) => (language === "zh" ? zh : en);
const roles = {
  relay: {
    script: "server.mjs",
    fields: { host: "HOST", port: "PORT", data: "TRANSFER_SERVER_DATA" },
  },
  peer: {
    script: "client.mjs",
    fields: {
      port: "CLIENT_PORT",
      "peer-port": "PEER_PORT",
      data: "TRANSFER_CLIENT_DATA",
    },
  },
  direct: {
    script: "direct-host.mjs",
    fields: {
      port: "DIRECT_PORT",
      "admin-port": "DIRECT_LOCAL_PORT",
      bind: "DIRECT_BIND",
      data: "DIRECT_DATA",
      http: "DIRECT_HTTP",
      "trust-proxy": "DIRECT_TRUST_PROXY",
    },
  },
};

function usage() {
  console.log(`${text("Dukou CLI", "渡口 CLI")}

  dukou relay  [--host ADDRESS] [--port 8787] [--data DIR]
  dukou peer   [--port 8788] [--peer-port 8789] [--data DIR]
  dukou direct [--port 18788] [--admin-port 18789] [--bind ADDRESS] [--data DIR]
                [--http 1 --trust-proxy 1]
  dukou doctor [--url https://your-relay.example]
  dukou help   [--lang en|zh]

${text("Run peer on every participating device and configure the same relay in each local UI.\nPublic relay access requires trusted HTTPS. Keep management ports private.\nCLI defaults to English; --lang zh switches help and diagnostics to Chinese.", "每台对等设备运行 peer，并在本机 UI 配置同一发现服务与各自的账号/密钥。\n公网 relay 必须通过可信 HTTPS 反向代理开放；direct 可用可信 HTTPS 反向代理或内建 TLS。不要对外开放本机管理端口。")}`);
}

function options(tokens, allowed) {
  const result = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i]?.replace(/^--/, "");
    if (
      !tokens[i]?.startsWith("--") ||
      !allowed.includes(key) ||
      !tokens[i + 1] ||
      tokens[i + 1].startsWith("--")
    )
      throw new Error(
        `${text("Invalid option", "无效参数")}: ${tokens[i] || text("missing value", "缺少值")}`,
      );
    result[key] = tokens[i + 1];
  }
  return result;
}

async function doctor(tokens) {
  const { url } = options(tokens, ["url"]);
  console.log(
    `Node.js ${process.version} | ${process.platform}/${process.arch}`,
  );
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error(text("Node.js 22+ is required", "需要 Node.js 22+"));
  for (const port of [8787, 8788, 18788]) {
    const server = net.createServer();
    const free = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    console.log(
      `${text("Local port", "本机端口")} ${port}: ${free ? text("available", "可用") : text("in use", "已占用")}`,
    );
  }
  if (url) {
    const endpoint = new URL("/health", url);
    if (
      endpoint.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(endpoint.hostname)
    )
      throw new Error(
        text("Public relays require HTTPS", "公网发现服务必须使用 HTTPS"),
      );
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(8000),
    });
    console.log(
      `${text("Relay", "发现服务")}: ${response.status} ${endpoint.origin}`,
    );
    if (!response.ok) process.exitCode = 1;
  }
}

try {
  if (["help", "--help", "-h"].includes(command)) usage();
  else if (command === "doctor") await doctor(args);
  else if (roles[command]) {
    const role = roles[command];
    const values = options(args, Object.keys(role.fields));
    const env = { ...process.env };
    for (const [key, value] of Object.entries(values)) {
      if (
        key.includes("port") &&
        (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      )
        throw new Error(
          `${key}: ${text("port must be 1-65535", "必须是 1-65535 的端口")}`,
        );
      if (["http", "trust-proxy"].includes(key) && !["0", "1"].includes(value))
        throw new Error(`${key}: ${text("must be 0 or 1", "必须是 0 或 1")}`);
      env[role.fields[key]] = value;
    }
    const child = spawn(process.execPath, [path.join(folder, role.script)], {
      env,
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  } else throw new Error(`${text("Unknown command", "未知命令")}: ${command}`);
} catch (error) {
  console.error(error.message);
  usage();
  process.exitCode = 1;
}
