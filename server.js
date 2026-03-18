/**
 * OpenClaw Monitor - 后端服务
 * 端口: 8766 | 认证: paddy / p100monitor
 */

const http = require('http');
const urlModule = require('url');
const { exec } = require('child_process');
const pathModule = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 8766;
const REFRESH_INTERVAL = 30000;

const AUTH_USER = 'paddy';
const AUTH_PASS = 'p100monitor';

function checkAuth(header) {
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const colonIdx = decoded.indexOf(':');
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);
  return user === AUTH_USER && pass === AUTH_PASS;
}

function sendAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenClaw"', 'Content-Type': 'text/html' });
  res.end('<h1>401 Unauthorized</h1>');
}

// ── System Data ──
let cache = {
  timestamp: Date.now(),
  cpu: { usage: 0, idle: 100 },
  memory: { total: 0, used: 0, free: 0, percentage: 0 },
  context: { used: 0, limit: 205376, pct: 0 },
  processes: [],
  sessions: 0,
  status: { level: 'operational', reason: '' }
};

function getCpu() {
  return new Promise(function(resolve) {
    exec('top -l 1 -n 0', { maxBuffer: 1024 * 1024 }, function(err, stdout) {
      if (err) { resolve({ usage: 0, idle: 100 }); return; }
      var uMatch = stdout.match(/(\d+\.?\d*)% user/);
      var sMatch = stdout.match(/(\d+\.?\d*)% sys/);
      var iMatch = stdout.match(/(\d+\.?\d*)% idle/);
      var u = uMatch ? parseFloat(uMatch[1]) : 0;
      var s = sMatch ? parseFloat(sMatch[1]) : 0;
      var i = iMatch ? parseFloat(iMatch[1]) : 100;
      resolve({ usage: parseFloat((u + s).toFixed(1)), idle: parseFloat(i.toFixed(1)) });
    });
  });
}

function getMem() {
  return new Promise(function(resolve) {
    exec('vm_stat', { maxBuffer: 1024 * 1024 }, function(err, stdout) {
      if (err) { resolve({ total: os.totalmem(), used: 0, free: os.freemem(), percentage: 0 }); return; }
      var ps = 4096;
      var freePages = stdout.match(/Pages free:\s*(\d+)/);
      var actPages = stdout.match(/Pages active:\s*(\d+)/);
      var wiredPages = stdout.match(/Pages wired down:\s*(\d+)/);
      var free = freePages ? parseInt(freePages[1]) * ps : 0;
      var act = actPages ? parseInt(actPages[1]) * ps : 0;
      var wired = wiredPages ? parseInt(wiredPages[1]) * ps : 0;
      var total = os.totalmem();
      var pct = parseFloat(((act + wired) / total * 100).toFixed(1));
      resolve({ total: total, used: act + wired, free: free, percentage: pct });
    });
  });
}

function getContext() {
  return new Promise(function(resolve) {
    var f = pathModule.join(os.homedir(), '.openclaw', 'workspace', 'session-status.json');
    fs.readFile(f, 'utf8', function(err, data) {
      if (err) { resolve({ used: 0, limit: 205376, pct: 0 }); return; }
      try {
        var j = JSON.parse(data);
        var u = j.contextUsed || 0, l = j.contextLimit || 205376;
        resolve({ used: u, limit: l, pct: Math.round(u / l * 100) });
      } catch(e) { resolve({ used: 0, limit: 205376, pct: 0 }); }
    });
  });
}

function getProcesses() {
  return new Promise(function(resolve) {
    exec('ps aux | grep -E "openclaw-gateway|openclaw-node|openclaw-monitor|evolver|openclaw$" | grep -v grep | head -10', { maxBuffer: 64 * 1024 }, function(err, stdout) {
      if (err || !stdout.trim()) { resolve([]); return; }
      var lines = stdout.trim().split('\n').slice(0, 8);
      var procs = lines.map(function(line) {
        var parts = line.trim().split(/\s+/);
        var cpu = parseFloat(parts[2]) || 0;
        var mem = parseFloat(parts[3]) || 0;
        var cmd = parts.slice(10).join(' ') || parts.slice(4).join(' ') || '';
        var name = 'Process', desc = cmd.slice(0, 50);
        if (cmd.indexOf('openclaw-gateway') !== -1) { name = 'Gateway'; desc = 'OpenClaw 网关服务'; }
        else if (cmd.indexOf('openclaw-node') !== -1) { name = 'Node'; desc = 'OpenClaw 节点服务'; }
        else if (cmd.indexOf('server.js') !== -1 || cmd.indexOf('openclaw-monitor') !== -1) { name = 'Monitor'; desc = '运维监控面板'; }
        else if (cmd.indexOf('evolver') !== -1) { name = 'Evolver'; desc = 'OpenClaw 进化引擎'; }
        else if (cmd.indexOf('openclaw ') !== -1) { name = 'OpenClaw'; desc = 'OpenClaw 主进程'; }
        return { name: name, desc: desc, cpu: cpu, mem: mem };
      });
      resolve(procs);
    });
  });
}

function getSessions() {
  return new Promise(function(resolve) {
    exec('python3 ' + __dirname + '/get-sessions.py', { maxBuffer: 64 * 1024 }, function(err, stdout) {
      resolve(parseInt(stdout.trim()) || 0);
    });
  });
}

function checkHealth() {
  return new Promise(function(resolve) {
    exec('ps aux | grep "openclaw-gateway" | grep -v grep | wc -l', { maxBuffer: 4096, timeout: 3000 }, function(err, stdout) {
      if (parseInt(stdout.trim()) === 0) { resolve({ status: 'crashed', reason: 'Gateway 进程不存在' }); return; }
      var req = http.get('http://127.0.0.1:27239/health', { timeout: 3000 }, function(res) { resolve({ status: 'operational', reason: '' }); });
      req.on('error', function() { resolve({ status: 'frozen', reason: 'Gateway 进程存在但无响应' }); });
      req.on('timeout', function() { req.destroy(); resolve({ status: 'frozen', reason: 'Gateway 健康检查超时' }); });
    });
  });
}

async function update() {
  try {
    var results = await Promise.all([getCpu(), getMem(), getContext(), getProcesses(), getSessions(), checkHealth()]);
    var cpu = results[0], mem = results[1], ctx = results[2], procs = results[3], sessions = results[4], health = results[5];
    var level = 'operational', reason = '';
    if (health.status === 'crashed') { level = 'crashed'; reason = health.reason; }
    else if (health.status === 'frozen') { level = 'frozen'; reason = health.reason; }
    else if (cpu.usage > 80 || mem.percentage > 90) { level = 'high_load'; reason = 'CPU ' + cpu.usage + '% / 内存 ' + mem.percentage + '%'; }
    else if (cpu.usage > 60 || mem.percentage > 75) { level = 'warning'; reason = 'CPU ' + cpu.usage + '% / 内存 ' + mem.percentage + '%'; }
    cache = { timestamp: Date.now(), cpu: cpu, memory: mem, context: ctx, processes: procs, sessions: sessions, status: { level: level, reason: reason } };
  } catch(e) { console.error('Update error:', e.message); }
}

function fmtBytes(b) {
  if (!b) return '0 B';
  var i = Math.floor(Math.log(b) / Math.log(1024));
  return parseFloat((b / Math.pow(1024, i)).toFixed(1)) + ' BKMGT'.charAt(i);
}

function fmtToken(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// ── P100 Data ──
function readJson(p) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return null;
}

function getP100() {
  var idx = readJson(pathModule.join(os.homedir(), '.openclaw', 'workspace', 'index_project-schedule.json'));
  var risk = readJson(pathModule.join(os.homedir(), '.openclaw', 'workspace', 'index_risk-tracking.json'));
  var risks = [];
  if (idx) {
    for (var di = 0; di < (idx.docs || []).length; di++) {
      var doc = idx.docs[di];
      var risksArr = (doc.key_insights && doc.key_insights.critical_risks) || [];
      for (var ri = 0; ri < risksArr.length; ri++) {
        var r = risksArr[ri];
        if (r.severity === 'HIGH') risks.push({ id: r.id, title: r.title, description: r.description, impact: r.impact, severity: r.severity });
      }
    }
  }
  if (risk) {
    for (var i = 0; i < (risk.docs || []).length; i++) {
      var d = risk.docs[i];
      if (d.severity === 'HIGH') risks.push({ id: d.id, title: d.title, description: d.description, impact: d.impact, severity: d.severity });
    }
  }
  var milestones = {};
  if (idx) {
    for (var mi = 0; mi < (idx.docs || []).length; mi++) {
      var m = idx.docs[mi];
      if (m.key_insights && m.key_insights.milestones) {
        for (var k in m.key_insights.milestones) milestones[k] = m.key_insights.milestones[k];
      }
    }
  }
  var decisions = [];
  if (idx) {
    for (var di2 = 0; di2 < (idx.docs || []).length; di2++) {
      var doc2 = idx.docs[di2];
      var decs = (doc2.key_insights && doc2.key_insights.key_decisions) || [];
      for (var dj = 0; dj < decs.length; dj++) {
        decisions.push({ date: doc2.key_insights.meeting_date, text: decs[dj] });
      }
    }
  }
  return {
    version: idx ? idx.version : '2.0',
    last_updated: idx ? idx.last_updated : '',
    topics: idx ? Object.keys(idx.topics || {}) : [],
    doc_count: idx ? Object.values(idx.topics || {}).reduce(function(s, t) { return s + (t.doc_count || 0); }, 0) : 0,
    milestones: milestones,
    recent_docs: idx ? idx.docs.slice(0, 5).map(function(d) { return { title: d.title, date: (d.key_insights && d.key_insights.meeting_date) || d.last_updated || '' }; }) : [],
    critical_risks: risks.slice(0, 5),
    decisions: decisions.slice(0, 5),
    project_phase: 'DVT',
    next_milestone: '2026-03-31 DVT 出货',
    bom: { total: 67, cn: 67, us: 70 }
  };
}

function getP100Risks() {
  var risk = readJson(pathModule.join(os.homedir(), '.openclaw', 'workspace', 'index_risk-tracking.json'));
  var idx = readJson(pathModule.join(os.homedir(), '.openclaw', 'workspace', 'index_project-schedule.json'));
  var items = [];
  if (risk) {
    for (var i = 0; i < (risk.docs || []).length; i++) {
      var d = risk.docs[i];
      items.push({ id: d.id, title: d.title, description: d.description, impact: d.impact, severity: d.severity, status: d.status, date: d.first_identified });
    }
  }
  if (idx) {
    for (var j = 0; j < (idx.docs || []).length; j++) {
      var doc = idx.docs[j];
      var risksArr = (doc.key_insights && doc.key_insights.critical_risks) || [];
      for (var k = 0; k < risksArr.length; k++) {
        var r = risksArr[k];
        items.push({ id: r.id, title: r.title, description: r.description, impact: r.impact, severity: r.severity, status: 'OPEN', date: doc.key_insights && doc.key_insights.meeting_date, source: doc.title });
      }
    }
  }
  return { items: items, total: items.length };
}

function getP100Docs() {
  var files = ['index_project-schedule.json', 'index_product-definition.json', 'index_supply-chain.json', 'index_risk-tracking.json'];
  var items = [];
  for (var fi = 0; fi < files.length; fi++) {
    var d = readJson(pathModule.join(os.homedir(), '.openclaw', 'workspace', files[fi]));
    if (!d) continue;
    for (var di = 0; di < (d.docs || []).length; di++) {
      var doc = d.docs[di];
      items.push({ title: doc.title, type: d.topic || '文档', date: (doc.key_insights && doc.key_insights.meeting_date) || doc.last_updated || '', url: doc.url || doc.source_url || '' });
    }
  }
  items.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return { items: items, total: items.length };
}

function getP100BOM() {
  return {
    '眼镜-结构料': ['G2 A 镜框组件（灰）', 'G2 A 镜框（灰）', 'G2 A 镜框装饰片（灰）', 'G2 A 桩头装饰片（左/右-灰）', 'G2 A 演示样机光机底盖（左/右-灰）', 'G2 A MIC支撑件（左）', 'G2 A 光敏支撑件（右）', 'G2 A 转轴', 'G2 A 电池仓装饰片（灰）', 'G2 A 电池仓组件（灰）', 'G2 A 电池外壳（左/右-灰）', 'G2 A 电池内壳（左/右-灰）', 'G2 A 前框磁铁', 'G2 A 导电弹片', 'G2 A 镜框硅胶（灰）', '限位转轴（左上/左下/右上/右下）', 'G2 A 鼻托支架', '鼻托托叶', 'G2 A 电池仓螺丝', '支撑件螺丝', '机牙M1x2.5'],
    '眼镜-辅料': ['防水透气膜', 'G2 A 电池背胶', 'G2 A 导电泡棉', 'G2 A 光波导镜片背胶（左/右）', 'G2 A 波导片保护膜（左/右）', 'G2 A FPC固定背胶', 'G2 A 电池仓防水透声膜（前/后）', 'G2 A 电池仓防水透声膜（后右）', 'G2 A 镜框MIC防水透声膜', 'G2 A 光机背板绝缘胶带', 'G2 A 电池仓绝缘胶带（左/右）', '工程胶水', 'UV胶（DU-3526W）', 'Superx8008黑胶', '转轴热熔胶(5518BK)', 'K85速干胶', '干膜润滑剂MDF-001AP', '波导光机AA胶水', 'UV密封胶水', '常温结构胶', '光机底盖 SR'],
    '眼镜-光学': ['G2 A 光波导镜片（左）_四维', 'G2 A 光波导镜片（左）_至格', 'G2 A 光波导镜片（右）_四维', 'G2 A 光波导镜片（右）_至格', 'G2 A 平光镜片（左/右）'],
    '眼镜-硬件': ['G2 A 主板（左/右）', 'G2 A 镜框FPC', 'G2 A 电池仓FPC（左/右）', 'G2 A 电池组件-P', 'G2 A 电池（左/右）-P'],
    '展台-硬件': ['G2 POSM 主板', '联想 K12C 平板电脑', '一拖多适配器', '拓展坞', '转换插头-中转美'],
    '展台-线材': ['转 12V 电源线', 'Type A转Type C 电源线', 'Type C 母转公', 'Type C转Type C 电源线', 'Y型充电通讯线'],
    '展台-结构件': ['灯箱', 'Mirror', 'PAD保护壳', 'POSM主板保护壳', '支架硅胶', '展台硅胶']
  };
}

function getP100Schedule() {
  var idx = readJson(pathModule.join(os.homedir(), '.openclaw', 'workspace', 'index_project-schedule.json'));
  var items = [];
  if (idx) {
    items = idx.docs.map(function(d) { return { title: d.title, date: (d.key_insights && d.key_insights.meeting_date) || '', type: '周会纪要', url: d.url || '' }; });
  }
  return { items: items, total: items.length };
}

// ── Server ──
var mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

var server = http.createServer(function(req, res) {
  var parsedUrl = urlModule.parse(req.url);
  var pathname = parsedUrl.pathname;
  
  if (pathname !== '/health' && !checkAuth(req.headers['authorization'])) { sendAuth(res); return; }
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (pathname === '/api/status' || pathname === '/status') {
    res.end(JSON.stringify({
      timestamp: cache.timestamp,
      server: { version: '1.0.0', uptime: os.uptime(), platform: os.platform(), hostname: os.hostname() },
      cpu: { usage: cache.cpu.usage, idle: cache.cpu.idle, cores: os.cpus().length },
      memory: { total: cache.memory.total, used: cache.memory.used, free: cache.memory.free, percentage: cache.memory.percentage, totalFormatted: fmtBytes(cache.memory.total), usedFormatted: fmtBytes(cache.memory.used), percentageFormatted: cache.memory.percentage + '%' },
      context: { used: cache.context.used, limit: cache.context.limit, pct: cache.context.pct, usedFormatted: fmtToken(cache.context.used), limitFormatted: fmtToken(cache.context.limit) },
      processes: cache.processes, sessions: cache.sessions, status: cache.status, refreshInterval: REFRESH_INTERVAL
    }));
  } else if (pathname === '/api/p100') {
    res.end(JSON.stringify(getP100()));
  } else if (pathname === '/api/p100/risks') {
    res.end(JSON.stringify(getP100Risks()));
  } else if (pathname === '/api/p100/bom') {
    res.end(JSON.stringify(getP100BOM()));
  } else if (pathname === '/api/p100/docs') {
    res.end(JSON.stringify(getP100Docs()));
  } else if (pathname === '/api/p100/schedule') {
    res.end(JSON.stringify(getP100Schedule()));
  } else if (pathname === '/health') {
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
  } else {
    // Static files
    var filePath = pathname === '/' ? '/index.html' : pathname;
    var fullPath = pathModule.join(__dirname, 'public', filePath);
    var ext = pathModule.extname(fullPath);
    res.setHeader('Content-Type', mimeTypes[ext] || 'text/plain');
    fs.readFile(fullPath, function(err, data) {
      if (err) { res.writeHead(404); res.end('Not found'); }
      else { res.end(data); }
    });
  }
});

server.listen(PORT, function() {
  console.log('🦞 Server running at http://localhost:' + PORT);
  update();
  setInterval(update, REFRESH_INTERVAL);
});

module.exports = server;
