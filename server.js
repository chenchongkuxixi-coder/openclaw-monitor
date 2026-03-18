/**
 * OpenClaw 运维监控面板 - 后端服务
 * 提供真实系统数据 API + HTTP Basic Auth 保护
 *
 * ============================================================
 * 服务端口: 8766 (所有修改统一指向此端口)
 * ============================================================
 * 本地访问: http://localhost:8766
 * 公网访问: cloudflared tunnel --url http://localhost:8766
 * 日志位置: ~/.openclaw/workspace/openclaw-monitor/tunnel.log
 *
 * 注意事项:
 * - Mac 关机或休眠后链接失效
 * - 每次重启 tunnel 会生成新 URL
 * - 固定 URL 需注册 Cloudflare 账号
 * ============================================================
 */

const http = require('http');
const url = require('url');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ==================== 配置 ====================
const PORT = 8766;  // 【重要】所有修改统一指向此端口
const REFRESH_INTERVAL = 30000; // 30s 刷新间隔

// 认证配置（访问公网地址时需要输入）
const AUTH_USER = 'paddy';
const AUTH_PASS = 'p100monitor';
// ===========================================

// 简单的 Base64 校验
function checkAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;
  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString();
  const [user, pass] = decoded.split(':');
  return user === AUTH_USER && pass === AUTH_PASS;
}

// 发送 401 认证挑战
function sendAuthChallenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="OpenClaw Monitor"',
    'Content-Type': 'text/html'
  });
  res.end('<h1>401 Unauthorized</h1><p>需要登录才能访问</p>');
}

// 系统数据缓存
let systemCache = {
  timestamp: Date.now(),
  cpu: { usage: 0, idle: 100 },
  memory: { total: 0, used: 0, free: 0, percentage: 0 },
  context: { used: 0, limit: 205376, pct: 0 },
  processes: []
};

// 获取 CPU 使用率 (macOS)
function getCpuUsage() {
  return new Promise((resolve) => {
    exec('top -l 1 -n 0', { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve({ usage: 0, idle: 100 }); return; }
      const userMatch = stdout.match(/(\d+\.?\d*)% user/);
      const sysMatch = stdout.match(/(\d+\.?\d*)% sys/);
      const idleMatch = stdout.match(/(\d+\.?\d*)% idle/);
      
      const user = userMatch ? parseFloat(userMatch[1]) : 0;
      const sys = sysMatch ? parseFloat(sysMatch[1]) : 0;
      const idle = idleMatch ? parseFloat(idleMatch[1]) : 100;
      
      resolve({ usage: parseFloat((user + sys).toFixed(1)), idle: parseFloat(idle.toFixed(1)) });
    });
  });
}

// 获取内存使用率 (macOS)
function getMemoryUsage() {
  return new Promise((resolve) => {
    exec('vm_stat', { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve({ total: os.totalmem(), used: 0, free: os.freemem(), percentage: 0 }); return; }
      
      const pageSize = 4096;
      const freeMatch = stdout.match(/Pages free:\s*(\d+)/);
      const activeMatch = stdout.match(/Pages active:\s*(\d+)/);
      const inactiveMatch = stdout.match(/Pages inactive:\s*(\d+)/);
      const wiredMatch = stdout.match(/Pages wired down:\s*(\d+)/);
      
      const free = freeMatch ? parseInt(freeMatch[1]) * pageSize : 0;
      const active = activeMatch ? parseInt(activeMatch[1]) * pageSize : 0;
      const inactive = inactiveMatch ? parseInt(inactiveMatch[1]) * pageSize : 0;
      const wired = wiredMatch ? parseInt(wiredMatch[1]) * pageSize : 0;
      
      const total = os.totalmem();
      const used = active + wired;
      const percentage = parseFloat(((used / total) * 100).toFixed(1));
      
      resolve({ total, used, free: free + inactive, percentage });
    });
  });
}

// 获取 Context 使用情况（从状态文件读取，由 agent 写入）
function getContextUsage() {
  return new Promise((resolve) => {
    const statusFile = path.join(os.homedir(), '.openclaw', 'workspace', 'session-status.json');
    fs.readFile(statusFile, 'utf8', (err, data) => {
      if (err) { resolve({ used: 0, limit: 205376, pct: 0 }); return; }
      try {
        const json = JSON.parse(data);
        const used = json.contextUsed || 0;
        const limit = json.contextLimit || 205376;
        resolve({ used, limit, pct: Math.round((used / limit) * 100) });
      } catch (e) { resolve({ used: 0, limit: 205376, pct: 0 }); }
    });
  });
}

// 获取运行中的进程列表
function getProcessList() {
  return new Promise((resolve) => {
    exec('ps aux | grep -E "openclaw|openclaw-node|openclaw-gateway|openclaw-monitor" | grep -v grep | head -10', { maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      
      const lines = stdout.trim().split('\n');
      const processes = lines.slice(0, 8).map(line => {
        const parts = line.trim().split(/\s+/);
        const cpu = parseFloat(parts[2]) || 0;
        const mem = parseFloat(parts[3]) || 0;
        const cmd = parts.slice(10).join(' ') || parts.slice(4).join(' ') || 'Unknown';
        
        // 提取进程名
        let name = 'Process';
        if (cmd.includes('openclaw-gateway')) name = 'Gateway';
        else if (cmd.includes('openclaw-node')) name = 'Node';
        else if (cmd.includes('openclaw-monitor')) name = 'Monitor';
        else if (cmd.includes('server.js')) name = 'Server';
        else if (cmd.includes('evolver')) name = 'Evolver';
        
        return { name, cpu, mem, cmd: cmd.slice(0, 60) };
      });
      
      resolve(processes);
    });
  });
}

// 获取总 session 数
function getSessionCount() {
  return new Promise((resolve) => {
    exec('tail -200 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | grep -i "session" | tail -3 || echo ""', { maxBuffer: 64 * 1024 }, (err, stdout) => {
      const match = stdout.match(/(\d+)\s*active/i);
      resolve(match ? parseInt(match[1]) : 0);
    });
  });
}

// 更新所有系统数据
async function updateSystemData() {
  try {
    const [cpu, memory, context, processes, sessions] = await Promise.all([
      getCpuUsage(),
      getMemoryUsage(),
      getContextUsage(),
      getProcessList(),
      getSessionCount()
    ]);
    
    systemCache = {
      timestamp: Date.now(),
      cpu,
      memory,
      context,
      processes,
      sessions
    };
  } catch (error) {
    console.error('Error updating system data:', error);
  }
}

// 格式化字节为可读字符串
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 格式化 token 数量
function formatToken(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

// API 路由处理
function handleApi(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // 认证检查（health 接口除外）
  const authHeader = req.headers['authorization'];
  if (pathname !== '/health' && !checkAuth(authHeader)) {
    sendAuthChallenge(res);
    return;
  }
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (pathname === '/api/status' || pathname === '/status') {
    const response = {
      timestamp: systemCache.timestamp,
      server: { version: '1.0.0', uptime: os.uptime(), platform: os.platform(), hostname: os.hostname() },
      cpu: { usage: systemCache.cpu.usage, idle: systemCache.cpu.idle, cores: os.cpus().length },
      memory: {
        total: systemCache.memory.total,
        used: systemCache.memory.used,
        free: systemCache.memory.free,
        percentage: systemCache.memory.percentage,
        totalFormatted: formatBytes(systemCache.memory.total),
        usedFormatted: formatBytes(systemCache.memory.used),
        percentageFormatted: systemCache.memory.percentage + '%'
      },
      context: {
        used: systemCache.context.used,
        limit: systemCache.context.limit,
        pct: systemCache.context.pct,
        usedFormatted: formatToken(systemCache.context.used),
        limitFormatted: formatToken(systemCache.context.limit)
      },
      processes: systemCache.processes,
      sessions: systemCache.sessions,
      refreshInterval: REFRESH_INTERVAL
    };
    res.end(JSON.stringify(response));
  } else if (pathname === '/health') {
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// 静态文件服务
function serveStatic(req, res) {
  const authHeader = req.headers['authorization'];
  if (!checkAuth(authHeader)) {
    sendAuthChallenge(res);
    return;
  }
  
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);
  
  const extname = path.extname(filePath);
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
  
  res.setHeader('Content-Type', contentTypes[extname] || 'text/plain');
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.statusCode = err.code === 'ENOENT' ? 404 : 500;
      res.end(err.code === 'ENOENT' ? 'File not found' : 'Server error');
    } else {
      res.end(content);
    }
  });
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  if (parsedUrl.pathname.startsWith('/api/') || parsedUrl.pathname === '/health') {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`🦞 OpenClaw Monitor Server running at http://localhost:${PORT}`);
  console.log(`🔐 Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log(`🔄 Refresh interval: ${REFRESH_INTERVAL / 1000}s`);
  updateSystemData();
  setInterval(updateSystemData, REFRESH_INTERVAL);
});

module.exports = server;
