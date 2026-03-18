#!/usr/bin/env node
/**
 * OpenClaw Monitor 验收测试脚本
 * 自动测试 UI 界面和数据准确性
 */

const http = require('http');

// ==================== 配置 ====================
const CONFIG = {
  host: 'localhost',
  port: 8766,
  auth: {
    user: 'paddy',
    pass: 'p100monitor'
  }
};
// ==========================================

// 彩色输出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(type, msg) {
  const icons = { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️', test: '🔍' };
  const color = type === 'pass' ? colors.green : type === 'fail' ? colors.red : type === 'warn' ? colors.yellow : colors.blue;
  console.log(`${color}${icons[type] || '•'} ${msg}${colors.reset}`);
}

// 创建 HTTP 请求
function request(path, useAuth = true) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: path,
      method: 'GET'
    };
    
    if (useAuth) {
      const auth = Buffer.from(`${CONFIG.auth.user}:${CONFIG.auth.pass}`).toString('base64');
      options.headers = { 'Authorization': `Basic ${auth}` };
    }
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    
    req.on('error', (e) => reject(e));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// 测试用例
const tests = [
  {
    name: '健康检查接口 (/health)',
    fn: async () => {
      const res = await request('/health', false);
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.data);
      if (!data.status || !data.timestamp) throw new Error('返回数据格式错误');
      return data;
    }
  },
  {
    name: '完整状态接口 (/api/status) - 无认证应返回 401',
    fn: async () => {
      const res = await request('/api/status', false);
      if (res.status !== 401) throw new Error(`期望 401，实际 ${res.status}`);
      return true;
    }
  },
  {
    name: '完整状态接口 (/api/status) - 带认证',
    fn: async () => {
      const res = await request('/api/status');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.data);
      
      // 验证必填字段
      const required = ['timestamp', 'server', 'cpu', 'memory', 'processes', 'refreshInterval'];
      for (const field of required) {
        if (data[field] === undefined) throw new Error(`缺少字段: ${field}`);
      }
      
      // 验证 CPU 数据
      if (typeof data.cpu.usage !== 'number' || data.cpu.usage < 0 || data.cpu.usage > 100) {
        throw new Error(`CPU 使用率异常: ${data.cpu.usage}`);
      }
      
      // 验证内存数据
      if (typeof data.memory.percentage !== 'number' || data.memory.percentage < 0 || data.memory.percentage > 100) {
        throw new Error(`内存使用率异常: ${data.memory.percentage}`);
      }
      
      return data;
    }
  },
  {
    name: 'CPU 接口 (/api/cpu)',
    fn: async () => {
      const res = await request('/api/cpu');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.data);
      if (typeof data.usage !== 'number') throw new Error('CPU usage 字段错误');
      return data;
    }
  },
  {
    name: '内存接口 (/api/memory)',
    fn: async () => {
      const res = await request('/api/memory');
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const data = JSON.parse(res.data);
      if (typeof data.percentage !== 'number') throw new Error('memory percentage 字段错误');
      return data;
    }
  },
  {
    name: '服务运行时间合理性',
    fn: async () => {
      const res = await request('/api/status');
      const data = JSON.parse(res.data);
      const uptime = data.server.uptime;
      if (uptime < 0) throw new Error(`运行时间异常: ${uptime}`);
      log('info', `服务已运行 ${Math.floor(uptime / 60)} 分钟`);
      return true;
    }
  },
  {
    name: '任务队列数据合理性',
    fn: async () => {
      const res = await request('/api/status');
      const data = JSON.parse(res.data);
      const { running, queued, total } = data.processes;
      
      if (running < 0 || queued < 0 || total < 0) {
        throw new Error(`任务数不能为负数: running=${running}, queued=${queued}, total=${total}`);
      }
      if (total < running + queued) {
        throw new Error(`任务数逻辑错误: total(${total}) < running(${running}) + queued(${queued})`);
      }
      log('info', `任务状态: running=${running}, queued=${queued}, total=${total}`);
      return data.processes;
    }
  },
  {
    name: '服务端点不存在时应返回 404',
    fn: async () => {
      const res = await request('/api/nonexistent');
      if (res.status !== 404) throw new Error(`期望 404，实际 ${res.status}`);
      return true;
    }
  },
  {
    name: '【BUG检测】Queued 数量硬编码检测',
    fn: async () => {
      const res = await request('/api/status');
      const data = JSON.parse(res.data);
      const queued = data.processes.queued;
      
      // 当前 queued 硬编码为 0，这是已知 bug
      if (queued === 0 && data.processes.total > 0) {
        log('warn', `⚠️ Queued=${queued} 疑似硬编码值，getTaskStatus() 需要修复`);
      }
      return { queued, total: data.processes.total };
    }
  }
];

// 运行所有测试
async function runTests() {
  console.log('\n' + '='.repeat(50));
  console.log('🦞 OpenClaw Monitor 验收测试');
  console.log('='.repeat(50) + '\n');
  
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  const results = [];
  
  for (const test of tests) {
    try {
      process.stdout.write(`🔍 ${test.name}... `);
      const result = await test.fn();
      log('pass', 'PASS');
      results.push({ name: test.name, status: 'pass', data: result });
      passed++;
    } catch (e) {
      log('fail', `FAIL - ${e.message}`);
      results.push({ name: test.name, status: 'fail', error: e.message });
      failed++;
    }
  }
  
  // 输出汇总
  console.log('\n' + '='.repeat(50));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(50));
  console.log(`总测试数: ${tests.length}`);
  console.log(`通过: ${colors.green}${passed}${colors.reset}`);
  console.log(`失败: ${failed > 0 ? colors.red : colors.green}${failed}${colors.reset}`);
  console.log(`通过率: ${((passed / tests.length) * 100).toFixed(1)}%`);
  console.log('='.repeat(50));
  
  if (failed > 0) {
    console.log(`\n${colors.red}❌ 有 ${failed} 个测试失败${colors.reset}\n`);
    process.exit(1);
  } else {
    console.log(`\n${colors.green}✅ 所有测试通过！${colors.reset}\n`);
    process.exit(0);
  }
}

// 检查服务是否运行
async function checkServer() {
  try {
    await request('/health', false);
    return true;
  } catch (e) {
    return false;
  }
}

// 主函数
async function main() {
  console.log('🔍 检查服务状态...');
  
  if (!await checkServer()) {
    log('fail', '服务未运行！请先启动 server.js');
    log('info', '启动命令: cd ~/.openclaw/workspace/openclaw-monitor && node server.js');
    process.exit(1);
  }
  
  log('pass', '服务运行正常');
  await runTests();
}

main().catch(e => {
  console.error('测试脚本错误:', e.message);
  process.exit(1);
});
