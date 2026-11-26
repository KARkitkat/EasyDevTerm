# DevTerm 架构说明

面向维护者的技术文档。描述 UI、功能、逻辑的实现方式、关键数据流与设计取舍。使用向内容见 [README.md](../README.md)。

---

## 1. 技术选型与总体架构

| 层 | 技术 | 理由 |
|---|---|---|
| 后端 | Tauri 2 + Rust(tokio) | 轻量(exe ~7MB)、纯 Rust 网络栈无 OpenSSL、便于交叉编译 |
| 前端 | WebView2 + 原生 ES Modules JS | 免构建步骤,去掉 node 工具链(老系统无法升级 node) |
| 终端渲染 | xterm.js 5.5(本地 vendor) | 唯一能正确处理路由器启动日志 `\r` 刷行与 ANSI 转义的成熟方案,自绘不值得 |
| 串口 | `serialport` crate(default-features=false) | 成熟、支持 Windows 友好名枚举 |
| SSH 协议 | 未实现(按需求移除) | — |

```
┌─────────────── WebView2 (src/*.js) ───────────────┐
│  terminals.js  xterm.js 实例 + 标签页               │
│  panels.js     四个侧边面板(全部 UI 入口)           │
│  ipc.js        invoke() / channel() 包装            │
└──────────────┬─────────────────────────────────────┘
               │ invoke(cmd, args) / Channel<String> 事件流
┌──────────────▼───────────── Rust (src-tauri/src) ──┐
│  lib.rs        命令注册 + 4 个全局 State             │
│  session.rs    会话抽象: id/状态/关闭信号            │
│  serial.rs     串口传输    telnet.rs  Telnet 传输    │
│  tftp.rs       TFTP 服务端+客户端  rsh.rs 隐藏会话   │
│  discover.rs   网卡/扫描/文件对话框                  │
│  settings.rs   config.json       cmds.rs cmds.json  │
└────────────────────────────────────────────────────┘
```

`lib.rs:31` 的 `generate_handler!` 注册了 31 个 IPC 命令;`lib.rs:22-26` 管理 4 个全局状态:`SessionManager`、`SettingsStore`、`TftpServer`、`Arc<RshManager>`。

## 2. 目录与文件清单

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/index.html` | 36 | 单页骨架:侧边栏 5 按钮 + 标签栏 + 终端区;vendor 脚本引入 |
| `src/app.js` | 12 | 入口:IPC 自检 → `initPanels()` |
| `src/ipc.js` | 17 | `invoke()` 包装;轻量 `channel()`(见 §5.1) |
| `src/terminals.js` | 184 | xterm 实例 + 标签页管理;会话桥接钩子 `window.__devterm*` |
| `src/panels.js` | 1251 | 五个面板全部 UI 逻辑(连接/发现/TFTP/快捷命令/设置) |
| `src/autologin.js` | 93 | 自动登录状态机(提示符触发,纯逻辑无 DOM/IPC) |
| `src/style.css` | 69 | 布局(侧边栏/标签/面板 flex)与列表滚动、拖柄样式 |
| `src/assets/vendor/` | — | xterm.js / addon-fit UMD dist(npm tgz 解包,无构建) |
| `src-tauri/src/session.rs` | 165 | 传输无关会话抽象与生命周期管理 |
| `src-tauri/src/serial.rs` | 335 | 串口传输 + 单 IO 循环 + 注册表 |
| `src-tauri/src/telnet.rs` | 214 | Telnet 传输 + IAC 过滤 + 注册表 |
| `src-tauri/src/rsh.rs` | 359 | 隐藏 Telnet shell(登录/标记法 exec/ls 解析) |
| `src-tauri/src/tftp.rs` | 889 | RFC1350 编解码、服务端、客户端、目录辅助 |
| `src-tauri/src/discover.rs` | 366 | 网卡枚举、网段扫描、源 IP 探测、Win32 文件对话框 |
| `src-tauri/src/webview_check.rs` | 115 | 启动前 WebView2 运行时检测(缺失时 TaskDialog 引导下载/退出) |
| `src-tauri/src/settings.rs` | 118 | config.json 读写(SettingsStore) |
| `src-tauri/src/cmds.rs` | 59 | cmds.json 读写 |
| `src-tauri/src/lib.rs` | 67 | 模块注册、State 管理、31 个命令 |
| `tools/hosttest/` | ~500 | 纯逻辑单测 24 项(宿主运行):IAC/base64/ls 解析/TFTP 包/标记提取 |
| `tools/ptytest/` | ~120 | pty 回环集成测试(验证串口轮询模式正确性) |

## 3. 后端模块详解

### 3.1 session.rs — 会话抽象

三种传输(串口/Telnet,SSH 已移除)统一为同一形状:

- `SessionTx = Channel<String>`(`session.rs:11`):每个会话一条 Tauri Channel,承载 JSON 事件字符串(`{"event":"data","bytes":"<base64>"}` / `{"event":"state","state":"open|closed"}`)
- `SessionManager`(`session.rs:56`):`id → SessionHandle{info, close_tx}` 的 Mutex 表;`close()` 通过 oneshot 发送关闭信号
- `spawn_session_task()`(`session.rs:130`):分配 id → 注册 handle → `spawn_blocking` 启动 IO 任务。**约定:任务内部自行在 Channel 上广播 `open`/`closed` 状态事件**(管理器只存状态,不做路由)

### 3.2 serial.rs — 串口

- `serial_open`(`serial.rs:130` 附近):打开时拉起 DTR+RTS(部分设备 console 依赖)
- **单 IO 循环模型**(关键设计):一个阻塞线程内循环「服务写队列 → 读(50ms 超时)」。写命令通过 `mpsc::sync_channel(64)` 入队(`PortEntry.write_tx`),由 IO 循环在两次读之间取出写出
  - 为什么:最初版本读写共享 `Mutex<SerialPort>`,写必须等读的 50ms 超时释放锁,键入延迟可达数百 ms;改为队列后写命令微秒级入队、 ≤50ms 内实际写出
- `PORT_REGISTRY`(`serial.rs:111`):`id → PortEntry{write_tx, close, tx}`,供 `serial_write`/`serial_close` 命令查用
- `serial_write` 数据走 base64(前端 `toB64`),`base64_decode` 为手写实现(注意 `=` 填充跳过,见 hosttest 用例)

### 3.3 telnet.rs — Telnet

- TCP 连接 + **最小 IAC 协商**:`iac_filter`(`telnet.rs:37`)对 DO/WILL 一律回 WONT/DONT(拒绝全部选项)、跳过子协商(SB…SE)、`IAC IAC` 还原 0xFF 数据。路由器场景足够
- IO 模型与串口相同(mpsc 队列 + 单循环),`TELNET_REGISTRY`(`telnet.rs:91`)存 `id → write_tx`
- IAC 过滤器被 `rsh.rs` 复用

### 3.4 rsh.rs — 隐藏会话(路由器文件浏览的核心)

一条进程内后台 Telnet 连接(无标签页),busybox telnetd 每个 TCP 连接 fork 独立 shell,因此与用户可见终端互不影响。**仅支持 Telnet 目标**(串口是单会话物理线路,见 §8)。

- **登录状态机**(`connect_and_login`,`rsh.rs:55` 附近):读流中出现 `login:` 发用户名、`Password:` 发密码、末行以 `#`/`$` 结尾视为提示符;随后发 `echo __RDY__` **在原始流中等待回显**(2000ms)确认 shell 可执行——不能用 `exec_raw` 做这个探测,因为它只提取标记间内容
- **标记法 exec**(`exec_raw`):发送 `echo __DTS__; <cmd>; echo __DTE__:$?`,收集输出直到出现 `__DTE__:`,然后提取
  - **提取必须按行首锚定**:telnetd 会回显整条命令,回显行内本身就含 `__DTS__`/`__DTE__` 字样;按"标记前必须是 `\n`/`\r`/串首"匹配才能跳过回显。提取结果再 `trim_start_matches(['\r','\n'])`
- **`ls -F` 双格式解析**(`parse_ls_f`):设备的 ls 在管道下可能输出裸名(`bin/`、`sh*`、`ipc_ioos=`)或长格式(`srw------- 1 root root 0 ... ipc_ioos`)。长格式判定:首 token ≥9 字符、首字符 ∈ `-dl sbcp`、其余 ∈ `rwxstST-`;文件名取最后一个 token,类型取权限串首字符,剥除 `=`/`*`/`@` 后缀
- 会话按 IP 缓存于 `RshManager`(Arc 全局),失效(执行出错)自动重连
- 命令: `rsh_exec`(任意命令)、`rsh_pwd`(浏览器初始目录)、`rsh_ls`

### 3.5 tftp.rs — TFTP 服务端与客户端

**协议编解码**(纯函数,hosttest 有镜像测试):`parse_request`(RRQ/WRQ + blksize 选项)、`make_data/ack/error/oack`、`parse_ack/oack/error`。

**服务端** `tftp_server_start`(`tftp.rs:224` 附近):

- 绑定请求端口;**端口被占自动回退**:先试 8 个随机端口(40000-60000 由纳秒抖动),再退 `:0` 由系统分配,返回消息中含实际端口(前端解析 `随机端口 (\d+)`)
- 主循环只收首个 RRQ/WRQ,随后每个传输切到独立临时 socket + 独立线程(标准 TFTP 并发模型)
- RRQ:按 blksize 分块 + 逐块 ACK 确认重传(1s×5);末块(长度 < blksize)结束
- WRQ:有选项回 OACK(无则 ACK0),收 DATA 回 ACK;`run_transfer`(`tftp.rs:334`)写文件句柄在 Done 事件前显式 drop
- `safe_filename`:拒绝路径穿越、绝对路径、控制字符(所有落盘文件名必须过这一关)
- 端口被占回退后,前端生成的设备命令会附带端口号(busybox `tftp ... HOST [PORT]`)

**客户端** `tftp_get` / `tftp_put`:阻塞实现包在 `spawn_blocking`,请求时协商 `blksize=1468`,按块推送进度。

**目录辅助**:`tftp_list_dir`(名称/大小/修改时间,`time_format` 手写 UTC 格式化)、`tftp_copy_in`(外部文件复制入服务目录,**同文件守卫**:canonicalize 相等则跳过,避免 Windows 自复制 os error 32)、`tftp_export`(服务目录 → 用户另存路径,同样有同文件守卫 + error 32/33 重试 5 次)。

### 3.6 discover.rs — 发现与系统对话框

- **多网卡枚举** `list_local_ips`:Windows `GetAdaptersAddresses`(AF_INET,只取 Up 状态)。注意 `sockaddr.sa_data` 是 **i8**,转 `u8` 否则 `192.168.x.x` 显示为负数
- **网段扫描** `scan_subnet`:对选定网卡的 /24(1~254,排除自身)做 64 线程 `connect_timeout(400ms)` 扫描;**流式返回**(found 事件即时推送,扫到即显示),探测顺序 `.1/.254/.2/.100` 优先(网关最快出现)
- **网关快扫** `scan_gateways`:对**所有**本机网卡的 `.1` 并发探测(多网卡多网段场景)
- `local_ip_toward(dst)`:UDP socket `bind 0.0.0.0` 后 `connect((dst,9))` 取 `local_addr`——得到本机通往目标的源 IP,**不发包**。用于生成设备端 `tftp` 命令中的 PC IP
- `pick_files` / `pick_save_path`:Win32 公共对话框(`GetOpenFileNameW` 多选 / `GetSaveFileNameW`),windows-sys 0.59 的 `Win32_UI_Controls_Dialogs` feature,**零新增依赖**。细节:
  - 结构体是 WIDE 变体(PWSTR/PCWSTR),filter/title 用 `encode_utf16` 构造
  - 多选结果为双 NUL 结尾的 `dir\0file1\0file2\0\0`,解析时按 `windows(2).position(双NUL)` 截断再 split
  - ANSI 文件名(GBK)无法经 `from_utf16_lossy` 正确还原,v1 接受此限制

### 3.7 webview_check.rs — 启动前 WebView2 检测

`run()` 在 `Builder` 构造**之前**调用 `ensure_or_exit()`:经 `tauri::webview_version()`(WebView2Loader 的 `GetAvailableCoreWebView2BrowserVersionString`)探测运行时,缺失则 `TaskDialogIndirect` 弹中文引导窗(「去下载」经 `ShellExecuteW` 打开 fwlink 链接后退出 /「退出」直接退出),comctl32 v6 activation context 由 tauri-build 默认 manifest 提供;TaskDialog 失败时退回 `MessageBoxW` 纯文本。检测必须在 Builder 之前——tauri 自己的检测发生在创建 webview 时,那时弹英文错误且窗口已挂起。

### 3.8 settings.rs / cmds.rs — 持久化

均存放于 **exe 同目录**(便携式约定):

- `config.json`(`Settings`,settings.rs:10):`scan_port`、`scan_local_ip`、`baud_rate`、`tftp_dir`、`tftp_port`、`cmd_upload_ip`、`cmd_download_ip`、`cmd_download_name`、`telnet_user`、`telnet_password`(明文,开发工具取舍)、`ui_heights`(面板列表高度 JSON)、`device_history`(最近连接设备)、`auto_login_*`(自动登录,见 §4.4)
- `cmds.json`(cmds.rs:9):`[{name, cmd, group}]`;首次运行写入三条默认命令

## 4. 前端模块

### 4.1 ipc.js — IPC 桥

- `invoke`:直通 `window.__TAURI_INTERNALS__.invoke`
- `channel(onMessage)`:官方 `Channel` 的等价轻实现。**要点**:Rust 侧 `tauri::ipc::Channel` 要求参数值 `toJSON()` 返回 `"__CHANNEL__:<callbackId>"`;消息以 `{message, index}` 信封经 `runCallback` 送达,必须解出 `.message` 再交给回调——漏掉信封解包是曾经"传输事件全部丢失"的根因

### 4.2 terminals.js — 会话与标签

- `sessions: Map<id, {term, fit, wrap, tab, label, kind, ip, port}>`;kind/ip/port 在创建时以 meta 传入(不解析标签文本)
- 创建时固定动作:`term-host` div `width/height:100%`(否则 fit 以画布自身尺寸计算,形成循环依赖,表现为"只显示一半");`ResizeObserver` 观察共享容器 `#term-area`,面板开合/窗口缩放自动 `fit()`
- `window.__devterm*` 桥接钩子(供 panels.js 跨面板访问):
  - `__devtermSerialSessions()` / `__devtermAllSessions()` / `__devtermTelnetIps()`
  - `__devtermSendToSession(id, text)`:**只走传输通道发送,不做本地 term.write**——设备回显会自然显示,本地再写一遍会导致命令双显并顶乱提示符行
  - `__devtermActiveSession()`:返回 `{id, kind, ip, port}`(TFTP 面板"跟随当前窗口"与快捷命令"发送到活动窗口"的基础)

### 4.3 panels.js — 面板 UI(全部业务入口)

单例侧边面板 `ensurePanel(title)`,五个入口由 `initPanels` 绑定侧边栏按钮:

- **新建连接** `showConnectPanel(mode)`:串口/Telnet 双标签;`handleSessionEvent` 统一分发 data/state 事件(data 同时喂给自动登录状态机,见 §4.4)。成功连接(表单/历史条目/发现面板共用 `openSerial`/`openTelnet`)自动经 `history_add` 记录设备并 `autoLogin.begin` 挂自动登录;面板底部「最近连接」区块(`renderDeviceHistory`,位于「重新扫描」按钮之下)点击即用存储参数重连,附「清除」按钮
- **发现设备** `showDiscoverPanel`:网卡下拉 + 端口输入(变更即持久化)+ 流式扫描(`found` 事件即时添加条目)+ 扫描所有.1;按钮 tooltip 动态生成"扫描 ip.* 的 1~254 的 N 端口"
- **TFTP** `showTftpPanel`(最复杂):
  - 路由器文件浏览(顶部):跟随当前窗口(telnet 活动时自动填 IP:端口、已存密码则自动连接)→ `rsh_pwd` 定初始目录 → `rsh_ls` 列表(📁/📄 + ⬇ 图标按钮);`上传` 全宽按钮位于列表与拖柄之间
  - TFTP 服务端:目录/端口/启停(端口回退解析见 §3.5)
  - 串口命令助手:上传卡片(选文件路径 + 网卡 IP → `tftp -g -l name ip`,文件 `tftp_copy_in` 入服务目录)/ 下载卡片(文件名 + IP → `tftp -p -l name ip`);两卡片独立记忆 IP;动作:复制命令 或 发送到串口会话(经 `__devtermSendToSession`,可见执行)
  - 传输记录:**按文件一行**(`transferRows: Map<dir:file, element>`,服务端事件原地更新 `[0%]→[99%]→[成功/失败]`,上限 100 行);上传流程本身不建行,只对服务端建的行做最终校验定格
  - 列表高度拖柄 `makeResizable`:列表下方 grip,固定高度(不随内容收缩),持久化于 `ui_heights`
- **快捷命令** `showCmdsPanel`:分组渲染;**点击命令直接发送到当前活动窗口**(`__devtermActiveSession().id`),下方短暂提示"已发送到 \<会话>";无活动窗口时复制到剪贴板;`编辑全部` 用 JSON 文本框批量编辑

### 4.4 autologin.js — 自动登录(提示符触发)

**为什么不是连接后盲发**:串口打开时拉 DTR+RTS,多数开发板会复位,启动日志要数秒后才出 `login:`;连接瞬间盲发会打进 U-Boot 被吞掉。SecureCRT 的自动登录同为提示符触发。

- 配置(见 §7 `auto_login_*`):总开关 + 二选一模式——`global`(一组账号密码通吃)/`per_device`(按 `target` 精确匹配规则,串口为 COM 名如 `COM4`、Telnet 为 `host:port`;**无匹配回退全局组**)
- 挂钩点(全在 panels.js):`openSerial`/`openTelnet` 成功后 `begin(sid, send, user, pass)`(凭据取自 `credentialsFor(devKey)`);`handleSessionEvent` 的 data 分支把解码前 bytes 喂 `feed(sid, bytes)`;`onSessionClose` 里 `drop(sid)` 清理。三个连接入口(表单/历史重连/发现面板)共用 open 函数,自动全覆盖
- **状态机**(每会话独立):stage0 等 `/(?:login|username):\s*$/i`(流尾 256 字符滑窗,TextDecoder stream 模式防多字节截断)→ 发 `user\r` → stage1 等 `/password:\s*$/i` → 发 `pass\r` → stage2 完成。stage1 带 10s 超时(无密码提示的设备直接放弃,不悬挂)
- 已发的凭据回显不含 `login:`,不会自触发;发送经 `sendToSessionAny`(按会话 kind 分发 serial_write/telnet_write),与用户键入同通道,设备回显自然上屏
- 隐藏 rsh 会话不经此路径(rsh.rs 自己登录),互不影响

## 5. 关键数据流

```
设备 → 屏幕:
  IO循环 read ──▶ base64 ──▶ Channel {"event":"data"} ──▶ xterm.write

键入 → 设备:
  xterm.onData ──▶ toB64 ──▶ serial_write/telnet_write ──▶ 队列 ──▶ 端口/TCP

上传(PC → 路由器当前目录):
  pick_files ──▶ tftp_copy_in(入服务目录) ──▶ rsh_exec("tftp -g -l 'cwd/name' -r 'name' <pcIp>[:port]")
  ├─ PC 服务端收 RRQ ──▶ Start/Progress/Done 事件 ──▶ 传输记录行
  └─ 完成后 rsh_ls(cwd) 验证文件存在 ──▶ 行定格 成功/失败

下载(路由器文件 → PC 指定路径):
  pick_save_path ──▶ rsh_exec("tftp -p -l 'remote' -r 'name' <pcIp>[:port]")
  ├─ 设备推 WRQ ──▶ PC 服务端落盘服务目录 ──▶ 事件进度
  └─ tftp_export(srvDir, name, savePath) ──▶ 同文件守卫 / 重试拷贝

隐藏会话列目录:
  connect_and_login(状态机+__RDY__探测) ──▶ exec(行首锚定标记法) ──▶ parse_ls_f
```

## 6. 事件协议(Channel 消息)

| 通道 | 格式 | 生产者 |
|---|---|---|
| 会话事件 | `{"event":"data","bytes":"<b64>"}` / `{"event":"state","state":"open\|closed","reason":"..."}` | serial/telnet IO 循环 |
| TFTP 事件 | `{"kind":"start\|progress\|done\|error","dir":"get\|put","file":...,"bytes":...,"total":...,"speed":...}` | TFTP 服务端传输线程 |
| 扫描事件 | `{"event":"found","ip":...,"port":...}` / `{"event":"progress","scanned":...,"total":...}` / `{"event":"done"}` | 网段/网关扫描 |
| 服务端状态 | `{"kind":"state","state":"running\|stopped"}` | tftp_server_start |

所有 Channel 事件均为 JSON 字符串,前端 `channel()` 已解信封,handlers 内 `JSON.parse` 一次。

## 7. 持久化文件

### config.json(exe 同目录,settings.rs:10)

| 字段 | 用途 |
|---|---|
| scan_port / scan_local_ip | 发现面板端口与网卡 |
| baud_rate | 串口默认波特率 |
| tftp_dir / tftp_port | TFTP 服务目录与端口 |
| cmd_upload_ip / cmd_download_ip / cmd_download_name | 串口命令助手两张卡片独立记忆 |
| telnet_user / telnet_password | 隐藏会话登录凭据(明文,取舍见 §9) |
| ui_heights | 三个可拖列表的高度 JSON |
| device_history | 最近成功连接的设备(`{kind:"serial"\|"telnet", ...连接参数, label}`,去重后插头部,上限 20;`history_add` 命令写入,新建连接面板「最近连接」区块展示并可点击重连) |
| auto_login_enabled / auto_login_mode | 自动登录总开关;模式 `global`(全局一组)\|`per_device`(按设备规则) |
| auto_login_user / auto_login_pass | 全局默认账号密码(明文,取舍同 telnet_password) |
| auto_login_rules | 按设备规则 `[{target:"COM4"\|"ip:port", user, pass}]`;`per_device` 模式无匹配时回退全局组 |

### cmds.json(exe 同目录,cmds.rs:9)

`[{"name":"...","cmd":"...","group":"..."}]`,group 用于面板分组显示。

## 8. 已知限制与设计取舍

- **文件浏览仅支持 Telnet 目标**:串口是单会话物理线路,无法开第二条连接;虚拟 COM 方案(com0com)只能 PC 侧共享,设备侧仍是同一 shell,无收益。串口场景用「命令助手」(生成/复制/发送 `tftp` 命令)
- **不自动跟随可见终端的 cd**:解析用户输入流不可靠(别名/子 shell 会误判);浏览器目录是面板自有状态
- **下载/上传不经用户可见终端**:全部通过隐藏 Telnet 会话执行,用户终端零输出
- **文件对话框为 ANSI 兼容取舍**:windows-sys 0.59 Dialogs 模块字段为宽字符,但多选解析经 UTF-16,GBK 特殊字符文件名可能乱码(v1 接受)
- **telnet 密码明文存 config.json**:开发工具取舍(自动登录的 `auto_login_pass`/`auto_login_rules` 同)
- **自动登录为提示符触发,v1 不重试**:凭据错误导致设备重提 `login:` 时不会再次注入(避免死循环);重新手动连接即可。无 `login:` 提示而直接进 shell 的设备不注入
- **前端改动需重跑 cargo build**:Tauri 资源编译期嵌入,`frontendDist` 指向 `../src`
- **xterm.js 不做本地回显注入**:发送命令只写传输通道;本地写一遍 + 设备回显一遍会双显并顶乱提示符

## 9. 构建、测试与部署

- **迭代构建**:`cargo zigbuild --profile fast --target x86_64-pc-windows-gnu`(fast = 无 LTO/codegen-units 16/不 strip,增量 ~20s;release ~90s、7.4MB)
- **正式包**:用 `--release`;产物 = `target/x86_64-pc-windows-gnu/release/easydevterm-app.exe` + `webview2-com-sys/*/out/x64/WebView2Loader.dll`(**必须 x64 目录**的 dll,arm64/x86 版会报 0xc000007b)
- **单测**:`tools/hosttest`(宿主 cargo test,IAC 过滤、base64 往返、ls 双格式解析、TFTP 包编解码、标记提取,共 24 项)。windows-gnu 目标跑不了 cargo test(缺 dlltool),纯逻辑一律放 hosttest
- **集成**:tools/ptytest 验证轮询读写模式;Windows 侧 com0com 可选

## 10. 维护备忘(常见修改落点)

| 想改什么 | 落点 |
|---|---|
| 新增 IPC 命令 | 对应模块 `#[tauri::command]` → `lib.rs` `generate_handler` → 前端 `invoke` |
| 修改终端渲染/标签行为 | `src/terminals.js` |
| 新增面板或面板功能 | `src/panels.js` + `initPanels` 按钮绑定 + `index.html` 侧边栏 |
| 传输记录展示格式 | `panels.js` `setTransferRow` 及两处 evCh |
| TFTP 协议行为(超时/块大小/重传) | `src-tauri/src/tftp.rs` 常量区 |
| 隐藏会话登录流程 | `src-tauri/src/rsh.rs` `connect_and_login` |
| 扫描策略(超时/并发/顺序) | `src-tauri/src/discover.rs` `scan_subnet` |
| 默认配置值 | `src-tauri/src/settings.rs` `Default for Settings` |
| 自动登录触发/凭据逻辑 | `src/autologin.js`(状态机)+ `panels.js` `openSerial`/`openTelnet`(挂钩) |
| 默认快捷命令 | `src-tauri/src/cmds.rs` `cmds_list` 兜底分支 |
