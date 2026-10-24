---
title: SeewoAbility 能力分析
createTime: 2026/10/25 16:00:00
permalink: /seewo-manager/seewoability/
---

# SeewoAbility 能力分析

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>16 分钟</template>
  <template #difficulty>进阶</template>
</DocProp>

::: tip 概述
SeewoAbility 是希沃管家体系中的**能力执行端**，文件描述为「希沃业务服务」，以登录用户身份运行在 Session 1。它由 SeewoCore 拉起并接受本地转发调用，负责真正看窗口、点屏幕、拦弹窗、读取浏览器记录、抓包、杀毒、推流与锁屏。本文覆盖它的资产构成、19 个能力插件、启动与插件模型、窗口拦截闭环、上报事件、模块本地 API 面以及隐私影响，并给出未解项与复现命令。
:::

::: note 对象信息
- 进程：`SeewoAbility.exe`，1,695,088 字节，PE32 i386，版本 `1.6.5.3003.a153d2c`（产品 1.6.7.4018），SHA-256 前缀 `5c0721f4…7c1b7a0`
- 发布者：广州视睿电子
- 安装目录：`C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.7.4018\SeewoAbility\`，242 个文件 / 106.4 MB
- 证据标注：【观测】系统实测或已解密日志；【静态】文件 / 配置清单；【推断】由前两类推出；【未知】无证据
:::

相关阅读：[SeewoCore 架构与运行原理](/seewo-manager/seewocore/architecture/) · [SeewoCore 数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/)

## 0. 一句话定位

**SeewoCore 是"大脑"，SeewoAbility 是"手和眼睛"。**

- SeewoCore：SYSTEM / Session 0，只负责**长连接、指令编排、上报**。
- SeewoAbility：**Session 1（交互用户会话）**，19 个能力插件，负责真正**看窗口、点屏幕、拦弹窗、抓包、杀毒、推流、锁屏**。

::: important 为什么必须分两个会话
Session 0 看不到用户桌面。要看窗口、截屏、注入窗口、抓摄像头，必须运行在登录用户的会话里。这是整个架构设计的根本原因。
:::

| 关键事实 | 值 |
|---|---|
| 进程 | `SeewoAbility.exe`，**Session 1**（PID 随运行变化） |
| 父进程 | SeewoCore（SYSTEM，Session 0）拉起，`needGuard: true` |
| 插件 | `module\` 下 **19 个 `_zmodule.dll`** + 3 个 toolbox 独立进程 |
| 框架 | `PluginFrame.dll` + `IotPluginModule.dll` + `IotPlugin.dll` |
| 内核组件 | `module\window_block\win{7,10}\MiniHacker{amd64,x86}.sys`（**当前未安装**，服务名 `minihacker` 不存在） |
| 内置引擎 | **ClamAV**（`libclamav.dll` 8.5 MB）、**Npcap**（`wpcap.dll` / `Packet.dll`）、**FFmpeg**（`libav_*`）、**Qt5**、**ZeroMQ**、**zlib / libzippp**、tinyxml2、jsoncpp |

## 1. 资产构成

```text
SeewoAbility\
  SeewoAbility.exe            主宿主（插件容器 + 总线客户端）
  PluginFrame.dll             插件框架
  IotPluginModule.dll         IoT 插件模型（PostEvent/CallService/SetProperty 的底座）
  IotPlugin.dll               插件接口
  GuardClient.dll             守护客户端（向 HugoProcess 报告存活）
  HttpClient.dll   libcurl.dll        出网
  MachineClient.dll  media_capture_client.dll  screen_capture_client.dll
  window_capture.dll          窗口截图
  lib_ble.dll  hidapi.dll  lib_hid.dll   蓝牙 / HID（智能笔、外设）
  sentry.dll  apm_client.dll  Friday.dll  crashpad_handler.exe   崩溃/埋点四件套
  Verify.json                 25,292 B —— 全目录 CRC32 清单（防篡改）
  Firewall.json               防火墙放行名单（见 3.1）
  BootConfig.json             启动顺序 + needGuard
  active.bat / uninstall.bat  安装与卸载脚本（见 3.2）
  coreSystem\  internalSystem\   5 个 zsystem（sentry/apm/friday/httpserver/systemnotify）
  module\                     19 个能力插件
  toolbox\                    3 个独立工具进程
```

## 2. 十九个能力模块

下表回答"它能实现什么功能"。

| 模块 | 关键文件 | 能力 | 对应云端指令 |
|---|---|---|---|
| `window_block` | `window_block_zmodule.dll` + `globalRule.json`（52 KB）+ `win10\MiniHacker*.sys` | **弹窗 / 广告拦截**（云端协同识别） | `SERVICE+addWindowBlockRule` `collectWindowInfo` `windowDetectResultV2` `SET_PROPERTY+windowBlockStatus` |
| `virus` | `libclamav.dll` **8.5 MB** + `mspack.dll` + `virus.json` | **本地杀毒引擎**（ClamAV，病毒库 7 天过期） | `SERVICE+getAIRiskProduct` |
| `pcCleaner` | `pcCleaner_zmodule.dll` + `libzippp.dll` | 垃圾清理 / 目录扫描 | `SERVICE+rubbishScan` `rubbishClean` `folderScan` `folderClean` |
| `processaccel` | `processAccel_zmodule.dll` + 3 个白名单 json | 进程加速 + **逐进程流量统计 / 限速** | `SERVICE+deviceSpeedLimit` `softwareSpeedLimit` `devicePostFrequency` |
| `networkControl` | `SWZoroHttpsUser.dll` **2.88 MB** + `libcurl` + **`ESEDatabaseView.exe`** | **上网行为审计**：读浏览器 ESE 数据库（历史 / 缓存 / URL） | `SERVICE+updateBrowseAuditStrategy` `SET_PROPERTY+riskWebsiteMode` |
| `lock` | `lock_zmodule.dll` | 锁屏（含二维码解锁、锁屏流） | `SERVICE+lockScreenWallpaper` `lockStreamControl` `pushLockUrl` `SET_PROPERTY+unlockMode` `smartLockTime` |
| `propaganda` | `propaganda_zmodule.dll` + `libcurl` | **校园宣传 / 节目单**（UIPS），0 点定时、随机延迟同步 | `SERVICE+programPublish` `publishStatus` `picturePropaganda` `videoPropaganda` `audioPropaganda` `newsBroadcast` `marqueeControl` `countDownControl` `popupNotice` |
| `device` | `display_adapter_info*.dll` + `libdshowcapture.dll` + `libav_camera_capture.dll` + `easi_agent_client.dll` | 显示器 EDID / 适配器信息、**DirectShow / AV 摄像头采集**、希沃助教联动 | `SERVICE+getLogicDiskInfo` `setScreenLight` `setScreenAutoLight` |
| `light_audio` | `light_audio_zmodule.dll` + `libav_render.dll` | 灯光 / 音频联动（课堂氛围） | `lightIot.thing.*` `MONITOR+POST_PROPERTY+backlight_state` |
| `smartpen` | `smartpen_zmodule.dll` + `lib_hid` | 智能笔输入 | `SERVICE+switchChannel` |
| `voice` | `voice_zmodule.dll` + `rtmq_base.dll` | 语音（麦克风 / 喇叭控制、语音消息） | `SERVICE+setVoice` `switchSoundMode` `shoutControl` `SERVICE+setEasiAssistantStatus` |
| `wakeup` | `wakeup_zmodule.dll` + `UdpAssistant.dll` | 局域网**唤醒 / 发现**（WOL） | `[MACHINE]-DiscoverWol` `SERVICE+wakeupCheck` |
| `freeze` | `freeze_zmodule.dll` | 冰点还原控制 | `SERVICE+freezeDiskControl` `freezeBypassControl` `freezeRepairControl` |
| `machineOperate` | `machineoperate_zmodule.dll` | 机器级操作（分辨率、开软件） | `[MACHINE]-SwitchResolution` `OpenEasiSoft` |
| `exceed_share` | `exceed_share_zmodule.dll` + `ZMQTcpSubscribe.dll` | **超享 / 多屏同步**（ZeroMQ 订阅） | `lightIot.thing.property.get.exceed_share` `lightIot.thing.service.ctrl.exceed_share` |
| `liveclient` | `liveclient_zmodule.dll` | 直播 / 巡课客户端（配 `toolbox\liveClient`） | 无（本地拉起） |
| `visual-presenter` | `visual-presenter_zmodule.dll` + **`wpcap.dll` + `Packet.dll`** | 实物展台 + **网络抓包能力**（Npcap） | 无 |
| `wisdomPlatform` | `wisdomPlatform_zmodule.dll` | 智慧平台对接 | 无（本地 `/forward/SeewoHugoHttp/wisdomPlatform`） |
| `assistant` | `assistant_zmodule.dll` + `default.json` `yundie.json` + `tinyxml2.dll` | **应用推荐 / 入口**（EasiCare / EasiNet / SeewoLink 列表，带 md5 与图标） | 无（本地 `/forward/.../assistant`） |

### 2.1 三个独立工具进程（`toolbox\`）

| 工具 | 组成 | 用途 |
|---|---|---|
| `toolbox\liveClient\liveClient.exe`（2.5 MB） | Qt5 + **avcodec / avformat 级 FFmpeg** + `libav_rtmp_client.dll` + `libav_rtp_client.dll` + `libav_wk_rtp.dll` + `stream_core.dll` + `libGLESv2` + `libfaad2` | **音视频推流（RTMP / RTP）**：直播、巡课、录播 |
| `toolbox\read_mode\read_mode.exe`（**14 MB**） | Qt5 + 多媒体 | 阅读模式 / 护眼（全屏阅读器） |
| `toolbox\resolution\resolution.exe` | `MsOffice.dll` | 分辨率切换（授课软件兼容） |

`Firewall.json` 列出了它们的出网白名单：

```json
[ "SeewoAbility.exe", "CrashRpt.exe",
  "toolbox\\liveClient\\liveClient.exe", "toolbox\\resolution\\resolution.exe",
  "toolbox\\rtcRemoteDesktop\\rtcRemoteDesktop.exe",
  "toolbox\\avAcquisitionPush\\avAcquisitionPush.exe" ]
```

::: warning 注意最后两项
`rtcRemoteDesktop.exe`（远程桌面）与 `avAcquisitionPush.exe`（音视频采集推流）在本机该目录下不存在，说明它们是**按需下发 / 按场景安装**的组件。能力已经预留。
:::

## 3. 运行原理

### 3.1 启动与生存

```json
{ "default": { "launcher": "SeewoAbility.exe", "order": 1, "needGuard": true } }
```

- 由 SeewoCore 的组件加载器启动（`Load component: SeewoAbility`）。
- `needGuard: true` 表示被 `HugoProcess` 守护；日志中可见 `[Guard Process]-[SeewoAbility] Run 3018ms, Suspected Crash, Try 5s Later`。
- **跨会话**：SeewoCore（Session 0）→ SeewoAbility（Session 1）。这不是普通 `CreateProcess`，需要用户会话令牌。【未知】具体使用 `WTSQueryUserToken` 还是计划任务 / 服务触发，未取证。
- `Firewall.json` 是它的出网白名单（哪些 exe 允许联网）。【推断】由网络管控模块或防火墙策略读取。

### 3.2 安装 / 卸载脚本

`active.bat`（激活 / 安装后置动作）：

```bat
echo Yes | reg ADD HKLM\...\Uninstall\{<产品码>} /v SystemComponent /t REG_DWORD /d 1 /reg:32
rd /S /Q "%seewo_menu%\希沃零度"
wusa "...\Windows6.1-KB2999226-x64.msu" /quiet /norestart
msiexec /i "...\vc_runtimeMinimum_x86.msi" /qn
```

- 写 `SystemComponent=1`，在"程序和功能"中隐藏自身（不再显示为已安装程序）。
- 静默安装 VC 运行时。

`uninstall.bat`（卸载时）：

```bat
taskkill /IM SeewoAbility.exe /F
sc stop minihacker
sc delete minihacker
```

::: note 脚本透露的两点
`taskkill` 连续执行 4 次，是为了对抗守护进程的重启；`sc delete minihacker` 反证了**窗口拦截依赖一个名为 minihacker 的内核驱动**。
:::

### 3.3 插件模型

- 每个模块是一个 `xxx_zmodule.dll`，由 `PluginFrame.dll` 载入。
- 模块间 / 与宿主使用 `IotPluginBaseImpl` 那套 API：`PostEvent` / `SetProperty` / `CallService` / `PostGrailLog`。
- 对外暴露的本地路由已在 SeewoCore 侧看全：

```text
/forward/SeewoHugoHttp/  →  SeewoWindowBlock · virus · systemcleaner ·
                           wisdomPlatform · processAcceleration · visual-presenter
                           · lightAudio · SeewoVoiceService · SeewoSmartPen …
```

即：**云端指令 → SeewoCore 翻译成本地 HTTP / WS 调用 → SeewoAbility 的具体模块执行**。

### 3.4 一条能力闭环：窗口拦截

这是整个软件最能说明"如何实现管理能力"的例子，四步全部在日志中。

#### 步骤一：本地枚举 + 规则匹配

规则库有两份，位于 `%APPDATA%\seewo\SeewoAbility\window_block\`：

| 文件 | 大小 | 内容 |
|---|---:|---|
| `globalRule.json` | 46 KB | 云端下发的全局规则，`version: 34` |
| `adminRule.json` | 41 KB | 管理员规则 |
| `record.json` | 5 KB | 命中记录 |
| `window_block.ini` | 39 B | `[windowblock] blockcount=3 / state=no`（**当前总开关关闭**） |

规则结构（GBK 原文，乱码还原后）：

```json
{ "version": 34, "list": [
  { "type": 0, "action": 0, "tag": "360浏览器热点资讯", "prior": 10000,
    "conditions": [
      { "mode": 2, "property": 0, "value": "热点资讯" },
      { "mode": 4, "property": 2, "value": "sesvc.exe" } ] },
  { "tag": "搜狗拼音推荐搜狗浏览器", "prior": 10000,
    "conditions": [ { "mode": 4, "property": 2, "value": "SogouCloud.exe" } ] }
] }
```

第一条按窗口标题关键词匹配，第二条按进程名匹配。

#### 步骤二：命中就拦，并记档

`record.json` 实测条目（文件名与图标哈希已打码）：

```json
{ "processName": "SunloginClient.exe", "isBlock": true,  "isAdmin": true,
  "blockCount": 2, "ruleId": "<规则ID>",
  "icon": "https://ali-pro-pub.jikstatic.com/server-adblock/<资源哈希>.ico" }
{ "processName": "inArt_PC.exe", "productName": "inArtBoard 小晗看班",
  "title": "系统设置", "isBlock": false,
  "screenshot": "…\\window_block\\image\\content\\<UUID>.png" }
```

由此可知：向日葵（远程控制）被标记 `isBlock=true`；连**非白名单的授课 / 看班软件**也会被截图留档。

#### 步骤三：未命中规则的窗口 → 截图 + 取图标 → 上传云端识别

日志原文（`upload_cstore_task.cpp:243`）：

```text
Upload CSTORE …\window_block\image\content\<UUID>.png(13881)
   server-adblock/<资源哈希>.png
   |https://ali-pro-pub.jikstatic.com/server-adblock/<资源哈希>.png Success
Upload CSTORE …\window_block\image\icon\<UUID>.ico(72567)   server-adblock/<资源哈希>.ico Success
```

#### 步骤四：上报识别结果

```json
[IOT] PostEvent windowReportDetectionV2 param={
  "process": { "digitalSign": "北京火绒网络科技有限公司",
               "icon": "server-adblock/<资源哈希>.ico",
               "processName": "HrASMain.exe", "productName": "火绒应用商店" },
  "schoolCode": "<学校代码>",
  "window": { "className": "hr_pcm_h5_msg", "id": "<UUID>",
              "screenshot": "server-adblock/<资源哈希>.png",
              "title": "hr_pcm_h5_msg" }
} Success.
```

::: important 闭环总结
本地按规则库拦截 → 未识别的窗口**截图上传**到 `ali-pro-pub.jikstatic.com`（对象存储 / CDN）→ 云端把图变成 `server-adblock/<hash>` 规则资源 → 通过 `globalRule.json` 版本迭代下发 → 下次同一弹窗直接被拦。
:::

这就是"云端协同的弹窗识别"：用户的屏幕内容会被**逐窗口截图上传**，作为规则库的训练 / 匹配素材。灰度窗口、广告、第三方软件界面都在采集范围内。

::: warning 未知项
上传是否只限"可疑窗口"、云端是否长期保存、是否存在整屏截图上传，目前均无证据（本机未见整屏上传证据）。
:::

#### 步骤五：内核驱动那一路（当前未装）

`win10\MiniHackeramd64.sys` / `win7\MiniHacker*.sys` 四个驱动位于模块目录中，但服务名 `minihacker` **当前不存在**（`sc query minihacker` 返回 1060）。这说明：

- 用户态（枚举窗口 + 规则匹配）已经够用，`state=no` 时驱动不安装。
- 只有在更强的管控（`windowBlockStatus` 开启）下才会安装内核过滤驱动，用于**进程级窗口创建拦截**。

【未知】驱动的 IOCTL 接口与拦截点。

## 4. SeewoAbility 侧独有的上报事件

SeewoCore 侧的上报清单见[数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/)，SeewoAbility 额外产生以下四类：

| 事件 | 载荷实质 |
|---|---|
| `windowReportDetectionV2` | 窗口类名 / 标题 / ID、截图路径、进程名、产品名、**数字签名主体**、学校编码 |
| `softwareUsedReport` | **逐软件使用时长**（`duration`）、`cstoreAppId`、进程列表 |
| `softwareFlowReport` | 逐软件**上下行流量**，区分 `netTag: inner/outer`（内网 / 外网） |
| `softwareSpeedReport` | 逐软件**实时速率**（限速依据） |

`softwareUsedReport` 实测样例（图标哈希已打码）：

```json
{ "lists": [ { "cstoreAppId": "<应用ID>", "duration": 2293,
               "icon": "hugo/<资源哈希>.ico", "name": "DeepSeek Harness",
               "processList": [ ] } ] }
```

::: important 粒度
它知道这台机器上每个软件开了多久、用了多少流量、走的是内网还是外网。
:::

## 5. 技术手段对应表

| 能力 | 实现手段（文件即证据） |
|---|---|
| 窗口 / 弹窗检测 | 用户态枚举 + `globalRule` / `adminRule` 规则引擎（标题关键词、进程名、属性，带 `prior` 优先级）；内核辅助靠 `MiniHacker*.sys` |
| 截图 | `window_capture.dll`（窗口级）+ `screen_capture_client.dll`（整屏，配套 `toolbox\screenCapture`） |
| 摄像头 | `libdshowcapture.dll`（DirectShow）+ `libav_camera_capture.dll`（FFmpeg） |
| 显示器信息 | `display_adapter_info(_64).dll`，读取 EDID / 适配器 |
| 上网审计 | `SWZoroHttpsUser.dll` + **`ESEDatabaseView.exe`**：直接读浏览器 ESE 数据库（历史 / 缓存） |
| 网络抓包 | `wpcap.dll` + `Packet.dll`（Npcap 用户态库） |
| 流量统计 / 限速 | 逐进程 flow 采样（`softwareFlowReport` / `softwareSpeedReport`），配合 `process_name_whitelist.json` 豁免 |
| 杀毒 | **ClamAV**（`libclamav.dll` 8.5 MB + `mspack` 解包），`virus.json` 病毒库 7 天过期 |
| 清理 | `pcCleaner_zmodule` + `libzippp` |
| 直播 / 录播 | `toolbox\liveClient`：FFmpeg 编解码 + **RTMP / RTP 推流** |
| 多屏 / 超享 | `ZMQTcpSubscribe.dll`（ZeroMQ 订阅） |
| 蓝牙 / 智能笔 | `lib_ble.dll` + `hidapi` / `lib_hid`；`sp20e_watcher.cpp` 中可见 BLE 扫描日志（`ADV_IND` / `SCAN_RSP` / `discovered peripherals`） |
| 局域网唤醒 | `UdpAssistant.dll`（UDP 广播） |
| 空闲 / 使用统计 | `device_idle_system.cpp`：`[Device Idle]0s | Input Idle:0s | Screen Idle:3270s | Use Idle:2539s` |
| 宣传节目单 | `propaganda_uips.cpp` + `schedule_manager.cpp`：`zero o'clock trigger`、`RandomDelayUpdatePrograms after 6 minutes`（**随机延迟**避免全网点同时拉取） |
| 应用推荐 | `assistant\default.json`：应用名 / `target` / 图标 URL / **md5**，`yundie.json` 是另一套环境配置 |
| 身份探测 | 反复探测本地 SSO 端口段 `http://local.id.seewo.com:24300…24304/getData/SSOLOGIN` |

## 6. 日志：同一套加密

- 路径：`%APPDATA%\seewo\SeewoAbility\log\`，文件名 `SeewoAbility-{YYYYMMDD}-{N}.log`。
- 格式：**与 SeewoCore 完全相同**，即 `109 字节 FNTS 头 + 连续 AES-128-CTR 密文（zlib）`，详见[日志加密与解密](/seewo-manager/seewocore/log-encryption/)。
- 归档：43 个 `*.log.zip`（旧的加密日志，密钥已随进程销毁）。
- `glog.ini`：`LogSeverity=1`、**`LogMaxSize=0`（不限制日志大小）**。

本轮使用的工具为 `seewo_ability_log_dump.js`，与发布包同一套方案，但**不需要 hook 静态地址**，改用基址无关的 IV 反查（同一套 envelope 结构：`+0x08 keyLen`、`+0x0c keyPtr`、`+0x18 ivLen`、`+0x1c ivPtr`）。

实跑结果（IV 与密钥已替换为占位符）：

```text
候选日志 3 个
  SeewoAbility-.log            body=17781  iv=<IV>
  SeewoAbility-20261024-1.log  body=72357  iv=<IV>
  SeewoAbility-20261024-2.log  body=62363  iv=<IV>
附加 pid <PID>   agent ready {"arch":"ia32"}
解密 SeewoAbility-.log   17781 -> 111301 B  1532 行  key=<密钥>
无密钥（信封已销毁） SeewoAbility-20261024-1.log
无密钥（信封已销毁） SeewoAbility-20261024-2.log
```

结论：**活跃文件可解，已关闭的不可解**，与 SeewoCore 的规律一致（ECDH 逐文件、密钥不落盘）。

## 7. SeewoCore 与 SeewoAbility 的分工

| 维度 | SeewoCore | SeewoAbility |
|---|---|---|
| 会话 / 权限 | **Session 0 / LocalSystem** | **Session 1 / 登录用户** |
| 角色 | 连接、编排、上报、策略 | 真正动手：看屏幕 / 拦窗口 / 抓流 / 推流 |
| 上行 | MQTT → `iot-broker.seewo.com` | 经 SeewoCore 或本地 wss 汇总；**图片直传 `ali-pro-pub.jikstatic.com`** |
| 下行 | 订阅 `rpc/request/+` | 接收本地 `/forward/SeewoHugoHttp/<module>` 调用 |
| 自保护 | `Verify.json` + KeLiteLady 驱动 + 守护 | `Verify.json` + `Firewall.json` + **`MiniHacker*.sys`**（按需） |
| 日志 | `ProgramData\Seewo\SeewoCore\log` | `%APPDATA%\seewo\SeewoAbility\log` |

## 8. 隐私影响

1. **窗口截图会被上传到云端 CDN**（`ali-pro-pub.jikstatic.com/server-adblock/…`），文件名是云端分配的 hash，不以明文暴露标题。触发点是"窗口不在规则库内"。
2. **逐软件使用时长 + 流量**（含内外网区分）持续上报，粒度到单个进程。
3. **读取浏览器 ESE 数据库**（`ESEDatabaseView.exe`）是上网审计的实现方式，意味着历史记录 / URL 可被本地读取。
4. **摄像头 / 麦克风链路齐备**（DirectShow + FFmpeg + 推流组件），是否启用取决于云端指令与策略。
5. 安装时写入 `SystemComponent=1`，隐藏卸载入口。

::: warning 判断边界
合规判断不在本文范围。但"截图上传 + 逐进程计时 + 流量分类"三项叠加，事实上构成了对教室终端的持续行为观测。
:::

## 9. 未解与下一步

| 项 | 状态 / 补齐方式 |
|---|---|
| 跨会话启动机制（0→1 使用什么 API） | 未知；需在 SeewoCore 侧查找 `WTSQueryUserToken` / `CreateProcessAsUser` 相关调用 |
| `MiniHacker*.sys` 的拦截点与 IOCTL | 未安装；需装驱动后逆向（内核环境） |
| `SWZoroHttpsUser.dll`（2.88 MB）具体做了什么 | 只有依赖证据；建议单独逆向 |
| `ESEDatabaseView.exe` 是否被实际调用 | 本机日志未见调用记录（可能审计策略未开启） |
| 截图上传的触发条件与频率 | 只见一次（00:05:03）；需长跑统计 |
| `window_block.ini state=no` 是谁关闭的 | 未知（策略下发或本地开关） |
| 43 个 `*.log.zip` 的历史内容 | 密钥已销毁，**不可解** |
| `avAcquisitionPush.exe` / `rtcRemoteDesktop.exe` | 目录中不存在，属按需下发组件，能力未知 |
| 静态函数级分析 | 本会话 Ghidra 请求超时；可先用同一套 hunt / strings 方案做行为侧 |

## 10. 复现命令

```powershell
# 1) 解开 SeewoAbility 自身的日志
Set-Location <工作目录>
$env:SEEWO_ABILITY_PID = (Get-Process SeewoAbility).Id
node .\seewo_ability_log_dump.js
# 输出 -> <工作目录>\decrypted-ability\<原日志名>

# 2) 查看模块清单
Get-ChildItem "C:\Program Files (x86)\Seewo\SeewoService\SeewoService_1.6.7.4018\SeewoAbility\module" -Directory

# 3) 查看窗口拦截状态与记录
Get-Content "$env:APPDATA\seewo\SeewoAbility\window_block\window_block.ini"
Get-Content "$env:APPDATA\seewo\SeewoAbility\window_block\record.json" -Encoding Default

# 4) 驱动是否已安装
sc query minihacker          # 1060 表示未安装

# 5) 从解密日志中查找上传动作
Select-String <工作目录>\decrypted-ability\*.log -Pattern 'Upload CSTORE' -Context 0,1
```

## 11. 静态补齐：每个模块的本地 API 面

行为日志只覆盖了当时在运行的那几个模块（`propaganda` / `device_idle` / `window_block` / `sp20e` / `upload`）。为把"每个模块到底能干什么"补到可验证程度，对 19 个 `_zmodule.dll` 做了字符串级提取（ASCII 端点 + 特权 API 符号）。

| 模块 | 本地 API 面（`/api/v1/...`） | 特权 / 敏感符号 | 结论 |
|---|---|---|---|
| `device` | `device/{camera,cpu,disk/hard,displayCard,keyboard,memory,monitor,networkAdapter/ipv4,os}/info` · `device/behaviorAudit` · `disk` · `login/info` · `network/openpanel` · `screenSaver/{close,reset}` | `DeviceIoControl` `NtQuerySystemInformation` `DuplicateTokenEx` `TerminateProcess` | **硬件画像采集总入口**，一个模块即囊括 CPU / 内存 / 磁盘 / 显卡 / 显示器 / 网卡 / 摄像头 / OS / 登录信息 |
| `window_block` | `windowBlock/{switch,block/enable,block/disable,window/block,window/info,tip/confirm,super/software,super/switch}` | `DeviceIoControl` `DuplicateTokenEx` `NtQuerySystemInformation` `TerminateProcess` | 拦截开关 + **超管（super）通道** + 窗口信息上报 |
| `virus` | `virus/scan/{start,stop,pause,resume}` · `virus/database/load` · `virus/backup/{backup,restore,list,delete}` | `DeviceIoControl` `TerminateProcess` | 完整杀毒 + **隔离区备份 / 恢复**（被删文件可回滚） |
| `pcCleaner` | `systemcleaner/{scan,clean,cancelScan,cancelClean,diskInfo,systemDiskInfo,openRecycleBin}` | `DeviceIoControl` `NtQuerySystemInformation` | 清理扫描 + 磁盘信息 + 打开回收站 |
| `processaccel` | `processAcceleration/getProcessesInfo` · **`processAcceleration/killProcesses`** | `NtQuerySystemInformation` `TerminateProcess` | 不只是"加速"，**能按名单杀进程** |
| `networkControl` | 端点未在字符串中暴露，由 `SWZoroHttpsUser` 承载 | `DeviceIoControl` `NtQuerySystemInformation` | 上网审计；`UrlRecord` 类 + cstore 上传 |
| `lock` | 走 cstore 上传回调 | `DuplicateTokenEx` `TerminateProcess` | 锁屏 + 上传（锁屏画面 / 二维码） |
| `propaganda` | `uips/{feedback,property,service}` · `newsBroadcast/feedback` · `propaganda/feedback` · `serverInfo` | `TerminateProcess` | 校园宣传 UIPS 完整闭环 |
| `assistant` | `assistant/clickapp` · `eye_protection/timer/{pausing,resume,finishing}` · `{marquee,popupNotice,residentNotice,cancelResidentNotice}/feedback` · `{ring,shout}/stop` | `DuplicateTokenEx` `TerminateProcess` | 应用推荐 + **护眼计时器** + 各类通知的停止控制 |
| `machineOperate` | `read_mode` · `read_mode_param` · **`update`** | `NtQuerySystemInformation` `DuplicateTokenEx` | 阅读模式参数 + **可触发更新** |
| `light_audio` | `lightAudio/{info,device,discover,pair}` | `TerminateProcess` | 灯光设备的发现与配对 |
| `smartpen` | `button/set` · `cursor/user` · `match` | **`SetWindowsHookEx`** `NtQuerySystemInformation` | 智能笔 → **全局钩子**捕获笔 / 键事件 |
| `voice` | `voice/stop` | **`BitBlt`** `SendInput` `AdjustTokenPrivileges` | 截屏（BitBlt）+ **模拟输入** + 提权 |
| `wisdomPlatform` | `wisdom_platform/{custom_aciton_list,is_support_close_screen,set_current_action}` | **`AdjustTokenPrivileges`** `DeviceIoControl` `SendInput` `TerminateProcess` | 智慧平台动作联动 + 提权 + 模拟输入；附带 `easirecorder` |
| `freeze` | — | `AdjustTokenPrivileges` `NtQuerySystemInformation` `TerminateProcess` | 冰点控制，需提权 |
| `visual-presenter` | — | `NtQuerySystemInformation` `DuplicateTokenEx` `TerminateProcess` | 展台 + `wpcap` 抓包 |
| `exceed_share` / `liveclient` / `wakeup` | — | `TerminateProcess` | 仅框架符号；能力靠各自依赖 DLL（ZMQ / FFmpeg / UDP） |

### 11.1 三个值得单独说明的发现

1. **`processaccel` 的 `killProcesses`**：云端可以通过"进程加速"这条看上去无害的路径**远程杀进程**。
2. **`smartpen` 的 `SetWindowsHookEx`**：智能笔模块挂了**全局钩子**，能收到全系统的输入事件（键盘 / 笔事件级观测的典型实现）。
3. **`voice` / `wisdomPlatform` 同时出现 `BitBlt` + `SendInput` + `AdjustTokenPrivileges`**：屏幕抓取 + 模拟鼠标键盘 + 自我提权三件套齐备。

::: warning 证据边界
以上符号属于**静态字符串证据**，证明能力存在，不等于"正在使用"。实际调用要看行为日志或动态跟踪。
:::

## 12. 覆盖度自评

| 维度 | 覆盖 | 说明 |
|---|---|---|
| 资产构成（文件 / DLL / 驱动 / 配置） | 高（约 95%） | 242 个文件逐个过，配置全读到 |
| 19 个模块的**能力存在性** | 高（约 90%） | 文件 + 本地 API 面 + 特权符号三重证据 |
| **能力落实的行为轨迹** | 中（约 45%） | 只有 1 份活跃日志（1532 增至 3059 行），覆盖 `propaganda` `device_idle` `window_block` `sp20e` `upload` `http` 六个主题 |
| 窗口拦截闭环 | 高（约 90%） | 规则库 / 记录 / 截图上传 / 上报四步全有原文 |
| 上报字段 | 高（约 85%） | 四类事件都有真实载荷 |
| 跨会话启动机制 | 低（约 5%） | 完全没证据 |
| `MiniHacker*.sys` 内核拦截点 | 低（0%） | 驱动未安装 |
| `SWZoroHttpsUser.dll`（2.88 MB）内部逻辑 | 低（约 10%） | 只有依赖与 `UrlRecord` 类名 |
| 各模块的**具体判定规则**（病毒扫描策略、清理白名单等） | 中（约 30%） | 有白名单 / 规则文件，未逐条解读 |
| 43 份历史加密日志 | 低（0%） | 密钥已销毁，不可解 |
| 静态函数级（反编译） | 低（约 5%） | 本会话 Ghidra 超时，已用字符串级替代 |

::: important 结论
能力面（"能做什么"）基本查清；**行为面（"什么时候真的做"）目前只覆盖了当前这一小时**。要继续补齐，只有两条路：

1. **持续解密**：工具已支持 SeewoAbility，挂着运行即可积累。
2. **触发场景**：让云端下发锁屏 / 杀毒 / 清理 / 广播 / 限速等指令，再对日志取证。
:::

### 12.1 仍未做的具体项

- 各 `adminRule.json` / `process_name_whitelist.json` / `virus.json` 的**逐条语义**（规模分别为 46 KB / 1.8 KB / 77 B）
- `superIcon`（78 个图标）与 `server-adblock` 命名规则的对应关系
- `toolbox\liveClient` 的推流目标（RTMP URL 由谁下发），目前只有 `libav_rtmp_client` 证据
- `read_mode.exe`（14 MB）的实际用途（是否为护眼阅读器）
- `sp20e` 是什么设备（BLE 扫描对象）
- `local.id.seewo.com:24300–24304` 这几个端口的本地 SSO 服务由谁监听

::: warning 声明
本文为民间技术整理，所有实测均在自有设备与自有账号环境下完成。文中密钥、IV、设备标识、账号与机构信息均已占位符化处理，请勿据此对他人设备进行未授权操作。
:::

本文为民间技术整理，仅供参考。
