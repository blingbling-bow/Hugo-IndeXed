---
title: 系统面清单与覆盖缺口
createTime: 2026/10/25 10:00:00
permalink: /seewo-manager/seewocore/inventory-and-gaps/
---

# 系统面清单与覆盖缺口

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>16 分钟</template>
  <template #difficulty>进阶</template>
</DocProp>

本文回答一个具体问题：**前几份文档还漏了什么，本轮补上了什么，还剩什么没覆盖。** 证据分为【观测】（日志 / 系统实测）、【静态】（二进制或文件清单）、【推断】（由前两类推出）、【未知】（无证据）四类。

配套阅读：[架构与运行原理](/seewo-manager/seewocore/architecture/) · [数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/) · [日志加密与解密](/seewo-manager/seewocore/log-encryption/)

## 0. 本轮补上的 8 个缺口

| 之前的空白 | 现在的结果 |
|---|---|
| 只讲主服务，没讲整条服务链 | 5 个自启服务 + `/winService` 统一参数 + `needGuard/guardCount` 守护关系 |
| 只说"有驱动"，没说哪几个 | **3 个 `.sys`**：`SeewoKeLiteLady`、`SeewoZoroWall`、`WinCPUoC64`（含各自路径与状态） |
| 只说"有本地端口"，没列接口 | **40 个本地端点**（`/api/v1/*` + `/forward/*`），含本地管理密码鉴权 |
| 不知道它把状态存哪 | 落盘清单：`SeewoCore.ini` / `CAP.data` / `usbview.xml` / `virtual-camera.json` / `.sentry` / `lightIot`；**无本地 SQLite** |
| 没讲线程 / IO 模型 | 每 watcher 一条 **IOCP 线程**、ThreadPool + Timer、websocketpp/asio、paho 异步回调 |
| 没讲自修复的实际行为 | `Auto repair policy: 0` + `Application integrity check passed, no repair needed.` |
| 没说它怎么装卸软件 | `MsiExec.exe /I{…}` `/X{…}` 卸载串 + winget 包目录采集 |
| 不知道硬件枚举粒度 | `usbview.xml`（35.6 KB）**USB/UVC 设备树全量** |

## 1. 服务链（本机实测）

`Win32_Service` 中与希沃相关的服务如下：

| 服务名 | 状态 | 启动 | 账户 | 命令行 |
|---|---|---|---|---|
| `SeewoCoreService` | Running | Auto | LocalSystem | `SeewoCore.exe /winService` |
| `SeewoFreezeUpdateAssist` | Running | Auto | LocalSystem | `SeewoFreeze\SeewoFreezeUpdateAssist.exe /winService` |
| `SeewoLauncherGuard` | Running | Auto | LocalSystem | `SeewoLauncerGuard\SeewoLauncherGuard.exe /winService` |
| `szGuarderService` | Running | Auto | LocalSystem | `szGuarder\szGuarder.exe -r` |
| `SeewoProxyLayerService` | Stopped | Manual | LocalSystem | `ProxyLayerService\proxyLayerService.exe /winService` |

**统一特征**：4 个服务带 `/winService` 参数，说明使用同一套框架（日志中称为 `HugoProcess`）、同一套日志格式、同一套加密沉槽。

守护关系在日志中写明：

```text
[Boot Service]|service { serviceName: "SeewoFreezeUpdateAssist" } needGuard: true guardCount: 5
[GUARD] TIME_DELAY_GUARD=30          （来自 SeewoCore.ini）
```

【推断】`szGuarderService -r`（`-r` 约为 restart / repair）+ `SeewoLauncherGuard` 构成"守护的守护"，防止主服务被杀后无人拉起。

::: note 一个容易误判的项
本机还有一个 `HugoProgs AutoStartService`，其 `PathName` 指向用户临时目录下的解压残留——那是**本机用户自己解压的第三方项目残留**，不属于希沃组件，列出以避免误判。
:::

## 2. 驱动栈（本机实测）

`Win32_SystemDriver` 中的相关驱动：

| 驱动服务名 | 状态 | 启动 | 文件 |
|---|---|---|---|
| `SeewoKeLiteLady` | **Running** | Manual | `…\SeewoDriverService\SeewoKeLiteLady\build_win10signed\SeewoKeLiteLady_amd64.sys` |
| `SeewoZoroWall` | **Running** | Manual | `…\SeewoDriverService\SeewoZoroWall\build_win10signed\SeewoZoroWall_amd64.sys` |
| `SeewoCore.cpu.temperature` | Stop Pending | Disabled | `…\SeewoCore\module\opex\win10\WinCPUoC64.sys` |
| `SeewoFreezeAssist.cpu.temp` | Stop Pending | Disabled | `…\SeewoFreeze\win10\WinCPUoC64.sys` |

### 2.1 SeewoKeLiteLady：文件保护过滤驱动

这个驱动有大量日志证据：

```text
[KeLiteLady Filter] AddRegisterProtectedPath [SOFTWARE\WOW6432Node\Seewo\SeewoFreeze] Success
[KeLiteLady Filter] Add FileProtected AllowProcess [11204] Success     (按 PID 逐个放行)
Allow [\??\C:\…\SeewoServiceAssistant.exe] KeLiteLady Check             (可执行前校验)
```

即：受保护路径（注册表 + 文件）无法被随意修改，只有登记在 `AllowProcess` 白名单中的 PID 能写入。

### 2.2 SeewoZoroWall：仅有存在性证据

驱动 Running、目录 `C:\ProgramData\Seewo\SWZoroHttps` 存在。【推断】与 HTTPS / 网络拦截相关（同系列有 `SWZoroHttps` 组件），【未知】具体拦截点与规则。

### 2.3 WinCPUoC64.sys：CPU 温度相关

两处出现，均为 `Disabled` / `Stop Pending`。【推断】用于 CPU 温度 / OEM 接口读取（`opex` 模块对应性能与散热），当前未启用。

### 2.4 内核通信

```text
[error] dwIoControlCode:2147491884 ,CreateFileW failed :2
```

对应 IOCTL `0x8000202C`，设备名【未知】。

## 3. 本地 API 面（40 个端点）

同机组件（`EasiNote`、`SeewoSmartPen`、`SeewoLightAudio`、`SeewoVoiceService`、`SeewoWindowBlock` 等）通过 `127.0.0.1:<动态端口>`（本次为 49405）的 HTTPS / WebSocket 总线调用主服务。日志中实际出现过以下端点。

### 3.1 设备与绑定

```text
/api/v1/device/id · /device/type · /device/version · /device/bind_qrcode · /device/keyboard
/api/v1/bind/info · /pre_bind/device · /school/bind_option · /school/classrooms · /school/stage
/api/v1/qrCode/generate · /qrCode/notify · /qrCode/remoteAuth
```

### 3.2 屏幕与锁屏

```text
/api/v1/screenlock/lockfeedback · /screenlock/unlockfeedback · /screenlock/updateQrUrl
/api/v1/screenSaver/reset · /api/v1/cancelResidentNotice/feedback
```

### 3.3 系统与性能

```text
/api/v1/get_disk_data · /api/v1/processAcceleration/getProcessesInfo · /api/v1/network/openpanel
/api/v1/lightAudio/info · /api/v1/light_iot/thing_property_get/iot_subs
```

### 3.4 管理鉴权

```text
/api/v1/admin/password/auth · /password/authMode
```

::: important 这一条很关键
本地 API 并非"谁都能调"，它设有管理密码。密码存放在 `SeewoCore.ini`：

```text
[ADMIN]
PASSWORDV3=<口令哈希，64 hex 字符>
```

算法【未知】（64 hex 为 32 字节，可能是 hash + salt 或 AES 密文）；`V3` 说明有版本演进。该端点是否有调用方 IP / PID 校验也【未知】——这决定了"本机任意用户能否直接解锁屏幕"。
:::

### 3.5 转发命名空间

本地组件到主服务的路由如下：

```text
/forward/SeewoHugoHttp/  →  SeewoHugoService / SeewoLightAudio / SeewoSmartPen /
                            SeewoVoiceService / SeewoWindowBlock / systemcleaner /
                            virus / wisdomPlatform / processAcceleration
/forward/freeze/         →  冰点还原
```

`systemcleaner`、`virus`、`wisdomPlatform` 这三个名字说明：清理、杀毒、智慧平台也在同一条总线上。

### 3.6 传输细节

```text
HttpsServer-tls [h1] node:SeewoProxyHttp ip:127.0.0.1 port:0 thread:1
Websocket Connect 127.0.0.1:65374 /forward/SeewoHugoHttp/SeewoSmartPen
websocket proxy wss://127.0.0.1:49405/SeewoSmartPen connect success
handle_read_frame error: asio.ssl.stream:1 (stream truncated)      ← websocketpp + asio SSL
```

## 4. 落盘清单

### 4.1 `C:\ProgramData\Seewo\SeewoCore\`

| 文件 | 大小 | 含义 |
|---|---:|---|
| `SeewoCore.ini` | 272 B | **本地配置**：`[ADMIN] PASSWORDV3`、`[BIND-CACHE] school-code=<学校代码>`、`[GUARD] TIME_DELAY_GUARD=30`、`[PERMISSION] FREEZE=yes`、`[device] id=<设备ID>` |
| `usbview.xml` | 35,626 B | **USB/UVC 设备树全量枚举**（控制器 / Hub / 摄像头规格，`<UvcViewAll>` 格式） |
| `virtual-camera.json` | 49 B | 虚拟摄像头组件版本记录 |
| `CAP.data` | 190 B | 二进制（非明文，用途【未知】） |
| `lightIot\deviceConfig.json` | 53,152 B | IoT 灯光 / 护眼设备配置（云端下发） |
| `lightIot\*\*.png` | 18–124 KB ×4 | IoT 通知图（visual_presenter / voice_microphone / wisdom_platform） |
| `.sentry\` | — | crashpad 本地崩溃报告（`__sentry-event`、breadcrumbs、`last_crash`） |
| `log\SeewoCore-*.log` | 20–138 KB ×19 | 加密日志，详见[日志加密与解密](/seewo-manager/seewocore/log-encryption/) |

### 4.2 `%APPDATA%\seewo\`（23 个子目录）

```text
Cvte.RemoteProcess  DesktopWindowManager  EasiCamera  EasiNote5  EasiNoteServer
EasiScreenPerception  EasiUpdate  ECGuardian  ENMirrorSIA  LuckyRandom  MultiScreen
PPTService  program_update  ProjectionTool  RollCall  SeewoAbility  SeewoIfpService
Seewoiip  SmartPen  SWIfpService  TouchFix  UploadService  Users
```

- `SeewoAbility\window_block\image\content\*.png`：窗口拦截的截图证据
- **注意**：该目录下的 `.db` / `.db3` 属于 `EasiNote5`（希沃白板）与 `Users\User.db`，不是 SeewoCore 的状态库

### 4.3 结论：SeewoCore 不自带本地数据库

【观测】`ProgramData\Seewo\SeewoCore` 下没有任何 `.db`；上报缓存（`Cache`）在**内存**中，随进程消失。

::: important 推论
"它把历史数据存在本地"这一假设不成立——**数据的归宿是云端，本地只保留临时态**。
:::

## 5. 线程与 IO 模型

| 机制 | 证据 |
|---|---|
| **IOCP 线程（每 watcher 一条）** | `[DirectoryWatcherSystem::IOCPThread] DirectoryWatcher IOCP thread started`，日志中出现多个不同 thread id |
| **线程池** | `ThreadPoolSystem` 在 Core SubSystem 阶段初始化 |
| **定时器** | `TimerSystem`；实际节律由云端 `setPostFrequency` 决定（硬件 120 s / 软件 120 s / 网站 60 s / 硬件使用 60 s） |
| **MQTT 异步回调** | `myMQTTAsync_traceCallback`（paho 内部线程） |
| **WebSocket** | websocketpp + asio SSL（`asio.ssl.stream:1`） |
| **日志 / HTTP 主线程** | 处理业务回调的线程 id 会变化，说明由线程池派发 |

## 6. 自修复与完整性校验

```text
[AutoRepairSystem::AutoRepair] Auto repair policy: 0
[AutoRepairSystem::AutoRepair] Application integrity check passed, no repair needed.
```

- `policy: 0`：修复策略 0（无修复 / 只检查），其它取值的语义【未知】
- `Application integrity check passed`：启动时比对文件完整性（配合 `Verify.json`）
- 配合 `DirectoryWatcherSystem`：文件一变就发现 → 触发校验 → 需要时修复

## 7. 装卸软件的手段

`softwareReport` 采集结果中带有完整的卸载命令，说明它**知道怎么卸载**，也就具备**卸载能力**（`SERVICE+windowsDeviceSoftwareUninstall`）：

```text
"uninstallCmd" : "MsiExec.exe /I{<产品码>}"     ← /I = 交互式安装/修复
"uninstallCmd" : "MsiExec.exe /X{<产品码>}"     ← /X = 卸载
"uninstallCmd" : "C:\Program Files (x86)\Seewo\MiniApps\RollCall\Uninstall.exe"
"installDir"   : "C:\Users\<账号>\AppData\Local\Microsoft\WinGet\Packages\x64dbg.x64dbg_…"
```

- MSI 产品码 + 专用卸载器双路径
- winget 安装的包（示例为 `x64dbg`）也会被一并枚举上报，**软件清单覆盖 winget 与用户级安装**

## 8. 硬件枚举的粒度

`usbview.xml` 是 **UVC/USB 设备树全量导出**，并非摘要：

```xml
<UvcViewAll xmlns="USB">
  <UvcView>
    <MachineInfo>
      <UvcMajorVersion>1</UvcMajorVersion><UvcMinorVersion>5</UvcMinorVersion>
      <UvcMajorSpecVersion>2</UvcMajorSpecVersion><UvcMinorSpecVersion>0</UvcMinorSpecVersion>
    </MachineInfo>
    <UsbTree>
      <UsbController ServiceName="USBXHCI" UsbProtocol="USB 3.0" …HwId="PCI\VEN_15AD&amp;DEV_077A…">
```

控制器、Hub、每个设备的 `HwId`、`ServiceName`、UVC 版本都会被记录。再叠加 `postWebrtcCameraList` / `postMicrophoneList` / `postSpeakerList`，**外设画像非常完整**。

## 9. 仍未覆盖的缺口

按"怎么补"排列：

| 缺口 | 现状 | 补齐方式 |
|---|---|---|
| **报文体是否有 TLS 之上的二次加密 / 签名** | 【未知】日志只到 `param={…}` | 抓 MQTT 流：本机 TLS 拦截 + 证书替换，或 hook `paho` 的 publish |
| **`SeewoZoroWall` 驱动做什么** | 只知道在运行 | 静态分析 `.sys`（需内核逆向环境），或观察它拦截时的系统事件 |
| **IOCTL `0x8000202C` 的设备名与语义** | 只见码值 | `WinObj` / 设备枚举 + 反汇编 `SeewoKeLiteLady_amd64.sys` |
| **`CAP.data` 是什么** | 190 B 二进制 | 按 32 位长度前缀 / 加密头试解；对比多次生成是否变化 |
| **`PASSWORDV3` 的算法** | 64 hex 未知 | 用已知密码做一次 `/api/v1/admin/password/auth` 对拍，判断是 hash 还是可逆 |
| **本地 API 的调用方校验** | 未知是否有 PID / IP 白名单 | 从普通用户上下文直接请求回环端口的 `/api/v1/screenlock/unlockfeedback`，观察是否返回 200 |
| **`websiteReport` 具体字段** | 本机 8 天未触发 | 先下发 `SERVICE+updateBrowseAuditStrategy` 启用审计，再观察 |
| **云端 `cmd` 全表** | 只知道 97 个 | 长周期挂机采集 + 触发各类教学场景（考试、广播、冰点、远程） |
| **静态侧整体（函数级）** | Ghidra 本轮超时；objdump 提供方在 Windows 不可用 | 放宽请求超时，或用已保存的 Ghidra 工程做增量分析 |
| **反调试 / 反虚拟机检测** | 无证据 | 在虚拟机与本机分别对比启动日志差异 |
| **`EasiNote` 等第三方组件与主服务的耦合细节** | 只见转发路由 | 单独分析各组件与其 `Verify.json` |

## 10. 覆盖度自评

| 维度 | 覆盖 | 依据 |
|---|---|---|
| 进程 / 服务 / 驱动拓扑 | 高（约 90%） | 服务与驱动清单实测；ZoroWall 语义缺失 |
| 启动流水线与模块清单 | 高（约 95%） | 每份日志完整重放 |
| 通信协议（topic / 端点） | 高（约 90%） | topic 全表 + 40 个端点；报文体封装缺失 |
| 指令生命周期 | 高（约 90%） | 六步链路逐行实证 |
| 上报数据字段 | 高（约 85%） | 主要字段原文都有；`websiteReport` 缺失 |
| 本地存储 | 高（约 85%） | 落盘清单齐；`CAP.data` 语义缺失 |
| 自保护机制 | 中（约 70%） | 五层都已识别；驱动内部规则未知 |
| 更新 / 安装链 | 中（约 60%） | 手段已见（MSI / winget）；升级流程未细看 |
| 静态函数级细节 | 低（约 35%） | 只有上一轮少量函数存档 |
| 反分析（反调试 / 反虚拟机） | 低（约 10%） | 无证据 |

## 11. 一键复核

```powershell
# 服务链
Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'Seewo|szGuarder' } |
  Select-Object Name,State,StartMode,PathName | Format-List

# 驱动栈
Get-CimInstance Win32_SystemDriver | Where-Object { $_.Name -match 'Seewo|KeLite' } |
  Select-Object Name,State,PathName | Format-List

# 落盘
Get-ChildItem C:\ProgramData\Seewo\SeewoCore -Force
Get-Content C:\ProgramData\Seewo\SeewoCore\SeewoCore.ini

# 本地端点（从已解密日志）
Set-Location <工作目录>\decrypted
Select-String *.log -Pattern '(/api/v1/[A-Za-z0-9_/\-]+|/forward/[A-Za-z0-9_/\-]+)' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Sort-Object -Unique

# 自修复与完整性
Select-String *.log -Pattern 'Auto repair|integrity check' | Select-Object -First 5

# 硬件枚举
Get-Content C:\ProgramData\Seewo\SeewoCore\usbview.xml -TotalCount 30
```

::: warning 声明
本文为民间技术整理，仅供研究与自查参考。清单中的配置值、设备标识与学校代码均已占位符化，不含真实凭据。
:::

本文为民间技术整理，仅供参考。
