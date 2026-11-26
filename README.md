# DevTerm — 路由器开发多会话终端

面向路由器/嵌入式开发的多会话终端工具:串口(COM)与 Telnet 多标签连接、TFTP 文件传输(含路由器文件浏览)、网段设备自动发现、快捷命令。Windows 便携运行,无需安装。

## 功能一览

- **多会话终端**:串口(115200 等常用波特率,USB 转串口友好名识别)与 Telnet(任意端口)多标签并存,ANSI/VT100 转义正确渲染(xterm.js)
- **自动发现**:按选定网卡流式扫描 /24 网段 TCP 端口(默认 23),扫到即显示;一键探测所有网卡的 `.1` 网关
- **TFTP**:
  - 服务端(UDP 69,可改端口;端口被占自动换随机端口)服务指定 PC 目录
  - 路由器文件浏览:通过隐藏 Telnet 会话列目录(不干扰已连接终端),文件一键下载/上传
  - 串口命令助手:自动生成 `tftp -g/-p` 命令,复制或直接发送到串口会话
  - 传输记录按文件实时显示百分比进度
- **快捷命令**:分组管理常用命令,点击发送到当前活动窗口;存储于 exe 同目录 `cmds.json`,可手工编辑
- **自动登录**:设置面板配置账号密码,监视设备输出,出现 `login:`/`Password:` 提示符时自动输入;支持全局默认一组或按设备(COM 名 / IP:端口)指定规则,无匹配回退全局
- **设置持久化**:`config.json`(exe 同目录)记住扫描端口、网卡、服务目录、登录凭据、自动登录、界面高度等

## 运行

需要两个文件在同一目录:

```
easydevterm-app.exe
WebView2Loader.dll    ← 必须 x64 版
```

双击 `easydevterm-app.exe` 即可(Win10/11 自带 WebView2)。启动时自动检测 WebView2 运行时,缺失时弹窗引导下载(去下载/退出)。`config.json`、`cmds.json` 首次使用后自动生成在 exe 同目录。

> 首次启动 TFTP 服务端时 Windows 防火墙会弹窗,请放行(否则设备无法连接)。若 69 端口被其他 TFTP 服务(如 Tftpd64)占用,程序自动改用随机端口,生成的设备端命令会自动携带该端口。

## 从源码构建(Linux 交叉编译)

在 Ubuntu(含老旧的 16.04,无 root 也可)上交叉编译出 Windows exe。全部工具链放在项目 `toolchain/` 目录内,不污染系统:

```bash
# 1) 一次性准备工具链(约 2GB,装在项目 toolchain/ 内)
./toolchain/bootstrap.sh   # 首次执行;或按 toolchain/README 手动安装 rustup + zig

# 2) 每次构建前
source env.sh
export PATH="$PWD/toolchain/bin:$PATH" RC="$PWD/toolchain/bin/devterm-rc"

# 3) 构建(日常迭代用 fast,发布用 release)
cd src-tauri
cargo zigbuild --profile fast --target x86_64-pc-windows-gnu      # 快,~20s
cargo zigbuild --release     --target x86_64-pc-windows-gnu      # 正式包

# 4) 产物
# src-tauri/target/x86_64-pc-windows-gnu/<profile>/easydevterm-app.exe
# 加上 build/webview2-com-sys/*/out/x64/WebView2Loader.dll 一起分发
```

关键点(老系统交叉编译的坑,详见 `docs/ARCHITECTURE.md`):

- 全程纯 Rust 网络栈(russh 系列未用、无 OpenSSL),链接器用 zig cc(`cargo-zigbuild`)
- Tauri 资源编译需要 windres,项目内置 `toolchain/bin/devterm-rc` 包装器(经 `RC` 环境变量注入),内部转调 `zig rc`
- 前端**无构建步骤**:原生 ES Modules + 本地 vendor 的 xterm.js,`tauri.conf.json` 的 `frontendDist` 直接指向 `../src`,因此前端改动也需重跑 cargo build(资源编译期嵌入)

## 目录结构

```
├── env.sh                  # 工具链环境(source 后 cargo/zig 可用)
├── toolchain/              # 项目内自包含工具链(git 忽略,可重建)
├── src/                    # 前端(原生 JS,无构建)
│   ├── app.js / ipc.js / terminals.js / panels.js / style.css
│   └── assets/vendor/      # xterm.js 5.5 dist(npm tgz 解包)
├── src-tauri/              # Rust 后端(Tauri 2)
│   └── src/                # 10 个模块,见 docs/ARCHITECTURE.md
├── tools/
│   ├── hosttest/           # 纯逻辑单元测试(宿主跑):IAC/base64/ls 解析/TFTP 包
│   └── ptytest/            # pty 串口回环集成测试
└── dist/                   # 分发产物(exe + dll)
```

## 测试

```bash
source env.sh
cd tools/hosttest && cargo test --lib   # 24 项单测
cd tools/ptytest && cargo run           # pty 回环演示
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构、模块、数据流、事件协议、设计取舍(维护必读)
