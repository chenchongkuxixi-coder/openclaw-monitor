/**
 * OpenClaw 运维监控面板 - 后端服务
 * 提供真实系统数据 API + HTTP Basic Auth 保护
 *
 * ============================================================
 * 公开访问配置（Cloudflare Tunnel）
 * ============================================================
 * 启动: cloudflared tunnel --url http://localhost:8766
 * 日志: ~/.openclaw/workspace/openclaw-monitor/tunnel.log
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
const PORT = 8766;
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
  processes: { running: 0, queued: 0, total: 0 }
};

// 获取 CPU 使用率 (macOS)
function getCpuUsage() {
  return new Promise((resolve) => {
    exec('top -l 1 -n 0', { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ usage: 0, idle: 100 });
        return;
      }
      const userMatch = stdout.match(/(\d+\.?\d*)% user/);
      const sysMatch = stdout.match(/(\d+\.?\d*)% sys/);
      const idleMatch = stdout.match(/(\d+\.?\d*)% idle/);
      
      const user = userMatch ? parseFloat(userMatch[1]) : 0;
      const sys = sysMatch ? parseFloat(sysMatch[1]) : 0;
      const idle = idleMatch ? parseFloat(idleMatch[1]) : 100;
      
      resolve({
        usage: parseFloat((user + sys).toFixed(1)),
        idle: parseFloat(idle.toFixed(1))
      });
    });
  });
}

// 获取内存使用率 (macOS)
function getMemoryUsage() {
  return new Promise((resolve) => {
    exec('vm_stat', { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ total: os.totalmem(), used: 0, free: os.freemem(), percentage: 0 });
        return;
      }
      
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
      
      resolve({
        total,
        used,
        free: free + inactive,
        percentage
      });
    });
  });
}

// 获取 OpenClaw 任务队列状态
function getTaskStatus() {
  return new Promise((resolve) => {
    // 先尝试快速获取 sessions 数量（解析 gateway 日志）
    exec('tail -50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log 2>/dev/null | grep -i "session" | tail -1 || echo ""', { maxBuffer: 64 * 1024, timeout: 3000 }, (err, stdout) => {
      let sessionsFromLog = 0;
      const logMatch = stdout.match(/sessions?\s*(\d+)/i);
      if (logMatch) sessionsFromLog = parseInt(logMatch[1]) || 0;
      
      // 同时检查 openclaw 进程数
      exec('ps aux | grep -c "[o]penclaw" 2>/dev/null || echo 0', { maxBuffer: 64 * 1024, timeout: 3000 }, (err2, stdout2) => {
        const processCount = parseInt(stdout2.trim()) || 0;
        
        resolve({
          running: processCount > 0 ? processCount : 1,
          queued: 0,
          total: sessionsFromLog > 0 ? sessionsFromLog : processCount
        });
      });
    });
  });
}

// 更新所有系统数据
async function updateSystemData() {
  try {
    const [cpu, memory, tasks] = await Promise.all([
      getCpuUsage(),
      getMemoryUsage(),
      getTaskStatus()
    ]);
    
    systemCache = {
      timestamp: Date.now(),
      cpu,
      memory,
      processes: tasks
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
  
  // 设置 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (pathname === '/api/status' || pathname === '/status') {
    const response = {
      timestamp: systemCache.timestamp,
      server: {
        version: '1.0.0',
        uptime: os.uptime(),
        platform: os.platform(),
        hostname: os.hostname()
      },
      cpu: {
        usage: systemCache.cpu.usage,
        idle: systemCache.cpu.idle,
        cores: os.cpus().length
      },
      memory: {
        total: systemCache.memory.total,
        used: systemCache.memory.used,
        free: systemCache.memory.free,
        percentage: systemCache.memory.percentage,
        totalFormatted: formatBytes(systemCache.memory.total),
        usedFormatted: formatBytes(systemCache.memory.used),
        percentageFormatted: systemCache.memory.percentage + '%'
      },
      processes: systemCache.processes,
      refreshInterval: REFRESH_INTERVAL
    };
    
    res.end(JSON.stringify(response));
  } else if (pathname === '/api/cpu' || pathname === '/cpu') {
    res.end(JSON.stringify(systemCache.cpu));
  } else if (pathname === '/api/memory' || pathname === '/memory') {
    res.end(JSON.stringify(systemCache.memory));
  } else if (pathname === '/health') {
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// 静态文件服务
function serveStatic(req, res) {
  // 静态文件也需要认证
  const authHeader = req.headers['authorization'];
  if (!checkAuth(authHeader)) {
    sendAuthChallenge(res);
    return;
  }
  
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);
  
  const extname = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
  };
  
  const contentType = contentTypes[extname] || 'text/plain';
  res.setHeader('Content-Type', contentType);
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.statusCode = 404;
        res.end('File not found');
      } else {
        res.statusCode = 500;
        res.end('Server error');
      }
    } else {
      res.end(content);
    }
  });
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  
  if (parsedUrl.pathname.startsWith('/api/') || 
      ['/status', '/cpu', '/memory', '/health'].includes(parsedUrl.pathname)) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`🦞 OpenClaw Monitor Server running at http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/status`);
  console.log(`🔐 Auth: ${AUTH_USER} / ${AUTH_PASS}`);
  console.log(`🔄 Refresh interval: ${REFRESH_INTERVAL / 1000}s`);
  
  // 初始数据获取
  updateSystemData();
  
  // 定时更新数据
  setInterval(updateSystemData, REFRESH_INTERVAL);
});

module.exports = server;
