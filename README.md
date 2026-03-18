# 🦞 OpenClaw Monitor

OpenClaw 运维监控面板 - 像素风格可视化界面

![Status](https://img.shields.io/badge/status-operational-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## 功能特性

- 📊 **实时监控** - CPU、内存、任务队列状态
- 🎮 **像素风格** - 复古终端美学
- 🔄 **自动刷新** - 每 30 秒自动更新数据
- 🌐 **Web 界面** - 浏览器即可访问
- 📱 **响应式设计** - 适配各种屏幕尺寸

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

### 3. 访问监控面板

打开浏览器访问: http://localhost:8766

## API 接口

| 接口 | 描述 |
|------|------|
| `GET /api/status` | 获取完整系统状态 |
| `GET /api/cpu` | 获取 CPU 使用率 |
| `GET /api/memory` | 获取内存使用率 |
| `GET /health` | 健康检查 |

## 项目结构

```
openclaw-monitor/
├── server.js          # 后端服务 (Node.js)
├── public/
│   └── index.html     # 前端监控界面
├── package.json       # 项目配置
└── README.md          # 项目文档
```

## 技术栈

- **后端**: Node.js 原生 HTTP 服务
- **前端**: 原生 HTML/CSS/JavaScript
- **样式**: VT323 像素字体

## 公开访问配置

使用 Cloudflare Tunnel 将服务暴露到公网：

```bash
# 启动 tunnel（每次重启会生成新 URL）
cd ~/.openclaw/workspace/openclaw-monitor
cloudflared tunnel --url http://localhost:8766
```

**注意事项：**
- Mac 关机或休眠后链接会失效
- 每次重启 tunnel 会生成新 URL（固定 URL 需注册 Cloudflare 账号）
- 日志位置：`~/.openclaw/workspace/openclaw-monitor/tunnel.log`

## License

MIT © chenchongkuxixi-coder
