---
title: SeewoCore 架构与运行原理
createTime: 2026/10/25 10:00:00
permalink: /seewo-manager/seewocore/architecture/
---

# SeewoCore 架构与运行原理

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>20 分钟</template>
  <template #difficulty>进阶</template>
</DocProp>

本文整理 SeewoCore 的进程形态、启动流水线、模块划分、通信架构与自保护机制，并对可观测特征做归纳。

::: tip 证据来源
- 【观测】本轮从已解密日志（17 个文件，6.5 MB 明文）直接读出的运行时行为
- 【静态】既有逆向结论与二进制 / 目录清单
- 【推断】由前两类推出、未直接验证的结论

分析对象为 `SeewoCore.exe`（PE32 i386，2,275,168 字节，SHA-256 前缀 `7a2f8baf…6cf20d6`，产品版本 1.6.7.4018 / Core 1.6.5.1726）。
:::

配套阅读：[数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/) · [系统面清单与覆盖缺口](/seewo-manager/seewocore/inventory-and-gaps/) · [日志加密与解密](/seewo-manager/seewocore/log-encryption/)

## 0. 一句话定位

SeewoCore 是希沃"校园设备管控"体系中**常驻在每一台教室 PC 上的执行端**：

- 本机侧以 SYSTEM 权限运行，配合内核 / 文件过滤驱动与 10 个插件模块，把"看屏幕、抓摄像头、锁屏、广播、清文件、格式化磁盘、装卸软件、远程桌面"等能力做成本地服务；
- 云端侧通过一条 MQTT 长连接下发 `SERVICE+xxx` 指令，指令名与参数均在运行时解密。

::: important 性质判断
它不是普通后台服务，而是一台可被远程遥控的终端。上报什么、多久上报一次、能否锁屏，最终由学校或厂商云端决定。
:::

## 1. 进程与生命周期

### 1.1 服务形态【观测】

每份日志的前四行都是重复的启动横幅：

```text
Launcher Service SeewoCore
Version [1.6.7.4018-1.6.5.1726]
Launcher WorkDir [C:\Windows\system32]
Launcher ExcutePath [...\SeewoCore\SeewoCore.exe]
Launcher Arguments [/winService ]
```

`/winService` 决定它走服务分支；工作目录落在 `system32`，是典型的 SCM 启动服务行为。

服务登记信息（`Win32_Service` 观测）：

| 项 | 值 |
|---|---|
| 服务名 | `SeewoCoreService` |
| 启动账户 | **LocalSystem** |
| 会话 | **Session 0**（无交互桌面） |
| 启动类型 | Automatic |
| 当前 PID | 运行期变化，不固定 |

### 1.2 组件拓扑【观测】

日志中存在一层"组件"加载，每个组件是**独立目录 + 独立 exe + 独立 crashpad**：

```text
Load component: SeewoDriverService
Load component: ProxyLayerService
Load component: SeewoAbility
Load component: SeewoFreeze
Load component: SeewoCore
```

结合目录清单，实际部署形态如下：

| 组件 | 角色（观测 / 推断） |
|---|---|
| `SeewoCore` | 主控：MQTT、指令分发、日志、插件容器 |
| `SeewoAbility` | 能力执行体：窗口侦测 / 拦截、截图、锁屏等（自带 `window_block/image/content/*.png` 截图目录） |
| `SeewoFreeze` | 冰点还原（系统盘还原 / 穿透控制） |
| `SeewoDriverService` | 驱动服务：内核态能力（文件过滤、进程保护） |
| `ProxyLayerService` | 代理层：为同机希沃软件提供本地 HTTPS 代理 |

每个目录下都有 `crashpad_handler.exe`，日志中可见它们被逐个登记：

```text
HugoProcess[11548|...\SeewoCore\crashpad_handler.exe]
HugoProcess[10076|...\SeewoAbility\crashpad_handler.exe]
```

### 1.3 守护与崩溃重启【观测】

日志中有两处直接证据：

```text
[Guard Process]-[SeewoAbility] Run 3018ms, Suspected Crash, Try 5s Later
[Boot Service]|service { serviceName: "SeewoFreezeUpdateAssist" } needGuard: true guardCount: 5
```

含义是：进程守护器（日志中统一称为 `HugoProcess`）监视子进程，**判定崩溃后 5 秒重新拉起**，并带有 `guardCount` 重试计数。

日志文件的存活时间也直接暴露了这一点——同一天里出现一串"只活 1 分钟"的日志：

| 日志 | 首行时间 | 末行时间 | 存活 |
|---|---|---|---|
| `SeewoCore-20261024-1.log` | 00:03 | 00:04 | 约 1 分钟 |
| `SeewoCore-20261024-2.log` | 00:05 | 00:05 | 不足 1 分钟 |
| `SeewoCore-20261024-3.log` | 00:06 | 00:07 | 约 1 分钟 |
| `SeewoCore-20261018-5/6.log` | 09:27 / 09:29 | 09:28 / 09:29 | 约 1 分钟 |

【推断】这些不是正常轮转（正常文件可连续写入 20 分钟至 1.7 小时），而是**进程反复崩溃后被守护器重启**，每崩一次就开一份新日志。Windows 事件日志中的 `1067`（进程意外终止）与此一致。

### 1.4 组件完整性校验【观测】

加载前会校验每个组件目录的 `Verify.json`，**校验文件缺失即拒绝加载**：

```text
[warning] No files listed in verify file: ...\SeewoServiceAssistant\Verify.json
[warning] Load component failed: ...\SeewoServiceAssistant
[warning] Component verify file not found: ...\SeewoCore\toolbox\media_capture\Verify.json
[warning] Load component failed: ...\toolbox\media_capture
```

即"文件清单 + 白名单式自校验"。删除 `Verify.json` 可以让一个组件"加载失败但服务照常运行"，这是本地降低权限最省事的入口。

## 2. 启动流水线（实测顺序）

每份日志都会完整重放一遍，共 6 段，顺序固定。以下以 `SeewoCore-20261024-1.log` 为准。

### 2.1 第一段：DynamicSystem

先加载 5 个 zsystem DLL：

```text
Load DynamicSystem [sentry_zsystem:ZeusSentrySystem] Success
Load DynamicSystem [Apm_zsystem:ApmSystem]         Success
Load DynamicSystem [Friday_zsystem:FridaySystem]   Success
Load DynamicSystem [HttpServer_zsystem:HttpServerSystem] Success
Load DynamicSystem [SystemNotify_zsystem:SystemNotifySystem] Success
System Load Complete
```

### 2.2 第二段：Core SubSystem

```text
[LoggerSystem] ... [ApplicationSingletonSystem] ... [ZeusSentrySystem]
Core SubSystem Init Complete
[ThreadPoolSystem] [TimerSystem] [MessageBusSystem] [RpcDiscoverSystem]
Initialize Apm id : ... version : 1.6.5.1726 sid : ... mid : 00:00:00:00:00:00
Initialize Friday [f1] id : ... version : 1.0.0.0
Initialize HttpsServer-tls [h1] node:SeewoProxyHttp ip:127.0.0.1 port:0 thread:1
[HttpServerSystem] [SystemNotifySystem]
Initialize IotManager node:SeewoProxy group:Remote2 host: port:0
[IotSystem] [GuardClientSystem]
Initialize GuardClient node :  ip :  port : 0 autoConnect : true
[MachineClientSystem] [MediaCaptureClientSystem] [ScreenCaptureClientSystem]
Internal SubSystem Init Complete
```

有三点值得注意：

- `ip:127.0.0.1 port:0`：本地 HTTPS 服务监听**回环地址 + 动态端口**，是给同机组件使用的内部通道，不对局域网开放。
- `mid : 00:00:00:00:00:00`：设备 MAC 缺失（虚拟机或无网卡环境），APM 仍照常初始化。
- `group:Remote2`：IoT 连接的分组名。

### 2.3 第三段：Module Load

加载 10 个插件，各自带版本号：

```text
bind(1.6.5.247)  guard(1.3.6.235)  light_iot(1.5.0.121)  machine(1.6.5.498)
opex(1.6.5.300)  power(1.5.0.130)  proxy(1.5.1.125)      remoteDesktop(1.6.5.169)
remoteSoftware(1.6.5.188)  self_defense(1.5.4.124)
Module Load Complete
```

模块职责从名称即可读出：

| 模块 | 职责 |
|---|---|
| `remoteDesktop` | 远程桌面 |
| `remoteSoftware` | 软件下发 / 安装 |
| `self_defense` | 自保护 |
| `light_iot` | IoT 灯光 / 护眼 |
| `power` | 电源 / 开关机 |
| `proxy` | 本地代理 |
| `machine` | 机器信息 |
| `bind` | 学校绑定与二维码 |
| `guard` | 进程守护 |
| `opex` | 性能 / 散热相关 |

**主 exe 只是壳，能力主要在这 10 个 zmodule 中。**

### 2.4 第四段：组件加载

见 1.2 与 1.4 节。

### 2.5 第五段：SubSystem Init

```text
[AutoRepairSystem] Initialize Susccess cost 15ms
DirectoryWatcher initialized
[DirectoryWatcherSystem] ...   [BindSchoolController] ...   changed
```

`AutoRepairSystem` + `DirectoryWatcherSystem` 构成**自修复 + 目录监视**组合：配置被修改会被发现并修回。

### 2.6 第六段：Controller 层

业务控制器按模块顺序加载：

- `bind` 模块：`BindSchoolController`、`LauncherBindController`、`QrCodeController`、`SeewoPCCheckController`
- `light_iot`：`LightIotController`、`SpaceIotController`
- `machine`：`FileCollectController`、`ScreenshotController`、`RegistryOperateController`、`DumpCollectController`、`DeviceUsageReportController`、`ProcessOperateController`、`SystemTimeController`、`SystemInfoController`

::: warning 权限含义
这一串控制器名称本身就是权限清单：**文件收集、截图、注册表读写、dump 收集、设备使用上报、进程操作、修改系统时间、读取系统信息**。
:::

【观测】启动开销最大的三项为：`self_defense` Start 耗时 44–222 ms、`SystemInfoController` 54 ms、`ZeusSentrySystem` 35 ms。自保护初始化最重，说明它需要安装钩子或驱动接口。

## 3. 通信架构

### 3.1 三条通道

```text
① MQTT/TLS  ──→ iot-broker.seewo.com        云端指令下行 + 属性上报上行（主通道）
② HTTPS     ──→ campus.seewo.com 等         业务 API：绑定、设备注册、配置拉取
③ 本地 TLS  ──→ 127.0.0.1:<动态端口>         同机希沃软件的内部代理（SeewoProxy）
```

底层 DLL 位于 `SeewoCore\` 目录：`iot_mqtt.dll`、`paho-mqtt3as.dll`（Eclipse Paho C，`as` 表示异步 + SSL）、`libcurl.dll`（HTTP）、`HttpClient.dll`、`MachineClient.dll`、`GuardClient.dll`、`jsoncpp.dll`。

### 3.2 MQTT 设备三元组与 topic【观测】

设备身份由 `productKey` 与 `deviceName` 构成，两者均随设备而异，此处以占位符表示：

```text
productKey : <产品Key>
deviceName : <设备ID>
```

topic 全表（`+` 为通配订阅）：

| 方向 | topic | 用途 |
|---|---|---|
| 订阅 | `/sys/{pk}/{dn}/rpc/request/+` | 云端下发服务调用 |
| 订阅 | `/sys/{pk}/{dn}/up/response/+` | 上行请求的回执 |
| 发布 | `/sys/{pk}/{dn}/rpc/response/{uuid}` | 服务调用结果回复 |
| 发布 | `/sys/{pk}/{dn}/thing/post` | 属性 / 事件上报 |
| 发布 | `/sys/{pk}/{dn}/up/request` | 设备主动请求云端 |

一次 RPC 的实际往返（`SeewoCore-20261024-7.log` 12:36:21）：

```text
recv  /sys/{pk}/{dn}/…/rpc/request/{uuid}
      → subscribe success: /sys/…/up/response/+
      → PUBACK msgid: 2
      → recv /sys/…/up/response/1
      → [IOT] GetSubDevice [] Success / GetGatewaySubDeviceList Success
      → send /sys/…/thing/post
      → transfer subscribe & online <--
```

### 3.3 指令载荷格式【观测】

载荷为 JSON，由 `cmd` 与参数字段组成：

```json
{ "cmd": "SERVICE+publishStatus" }
```

实际抓到的一条服务调用（`iot_manager_plugin_impl_base.cpp:345`）：

```text
[IOT] ServerCallService setPostFrequency:param= {
   "lists" : [
      { "type" : "hardwareReport",    "value" : 120 },
      { "type" : "softwareReport",    "value" : 120 },
      { "type" : "websiteReport",     "value" :  60 },
      { "type" : "hardwareUsedReport","value" :  60 }
   ]
}
```

::: important 这条最能说明性质
连"多久上报一次"都是云端下发的参数，客户端只是执行者。
:::

### 3.4 上报节律【观测】

统计 17 份日志：`thing/post` 条数约为 `rpc/request` 条数的 3 倍。即每执行一条云端指令，会伴随约 3 次属性上报。

同时也存在**完全无 MQTT 流量**的日志（如 `SeewoCore-20261018-2.log`、`20261024-1/2/3.log` 全程 `rpcRecv=0, thingPost=0`）。那是未连上 broker 或未绑定学校的时段：**云端能力整体失效，但本地进程照常运行、本地 wss 总线照常通信**。

::: tip 对早期判断的更正
上报失败并非"丢掉不管"，而是**落缓存再补发**：`PostEvent … Fail` → `Event [xxx] Cache`，下次上报前与缓存比对，`Cache no Change` 就跳过。这是"去重 + 节流"，不是丢弃。详见[数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/)的缓存与节流一节。
:::

### 3.5 网络失败的行为特性【观测】

断网时日志会被同一条错误刷屏，**没有退避、没有指数回退**：

```text
curl_easy_perform Fail:Couldn't resolve host name:Could not resolve host: campus.seewo.com
```

同一 URL 会反复重试，日志中出现上百条。类似重试还出现在 `friday.cvte.com/agent/api/app/v2/report`。

【推断】这既是它的弱点（无网教室会持续发起 DNS 查询），也是它的特征（**每轮都会尝试连回云端**）。

### 3.6 埋点三件套

| 组件 | 端点 | 作用 |
|---|---|---|
| Sentry（`sentry_zsystem` + `sentry.dll`） | 无固定业务端点 | 崩溃 / 异常上报 |
| APM（`apm_client.dll`） | 无固定业务端点 | 性能 / 可用性埋点，带 `sid`、`mid` |
| Friday（`Friday.dll`） | `https://friday.cvte.com/agent/api/app/v2/report` | 行为 / 使用统计 |

此外，每个组件目录还各带一份 `crashpad_handler.exe`。

### 3.7 域名清单

从明文日志中提取到的域名如下：

```text
iot-broker.seewo.com / iot-broker-mis.seewo.com   MQTT broker
campus.seewo.com                                  业务 API（/api/v1/device、/bind、/pre_bind、
                                                  seewo-iot-platform-proxy-service）
id.seewo.com                                      扫码登录（OAuth 中转）
school.seewo.com     e.seewo.com                  校园门户
oss1.seewo.com / *.qiniup.com / ali-pro-pub.jikstatic.com   对象存储/静态资源
friday.cvte.com / myou.cvte.com                   CVTE 域埋点/运营
pro-tmp-aliyun-pri.seewo.com                      云侧私有服务
```

## 4. 设备模型与"云—端"职责划分【推断】

```text
        ┌────────────── 学校/厂商云端 ──────────────┐
        │  设备注册 / 绑定 / 策略 / 指令编排 / 报表  │
        └───────────────┬───────────────────────────┘
                        │ MQTT(TLS)  rpc/request ↓   thing/post ↑
        ┌───────────────▼───────────────────────────┐
        │  SeewoCore（本机 SYSTEM）                  │
        │  ├ RpcDiscoverSystem  指令路由             │
        │  ├ MessageBusSystem   模块间总线            │
        │  ├ TimerSystem/ThreadPool 定时与并发        │
        │  └ 10×zmodule         实际执行              │
        └───────────────┬───────────────────────────┘
                        │ 本地 TLS(127.0.0.1:动态端口) / 驱动 IOCTL
        ┌───────────────▼───────────────────────────┐
        │ SeewoAbility / SeewoFreeze / Driver / Proxy│
        └───────────────────────────────────────────┘
```

关键结论：**任何"要不要做、做多少、多久做一次"的策略都在云端**，客户端只有执行权和上报义务。这也解释了为什么修改本地配置文件通常无效——`AutoRepairSystem` + `DirectoryWatcherSystem` 会盯着，而且下一次 RPC 就会覆盖。

## 5. 能力面（指令清单）

以下全部来自明文日志中的 `cmd:` 字段，去重后共 **97 个**指令，分类为本轮归纳。

| 前缀 | 条数 | 语义 |
|---|---:|---|
| `SERVICE+` | 66 | 服务级动作（管控 / 采集 / 展示） |
| `SET_PROPERTY+` | 12 | 策略属性写入（锁屏、护眼、解锁方式等） |
| `lightIot.*` | 7 | 物联网灯光 / 护眼设备 |
| `[MACHINE]-` | 5 | 机器级事件 / 动作 |
| `MONITOR+POST_PROPERTY+` | 3 | 显示器属性上报 |
| `UDI+NOTIFY+` | 2 | 外设（NFC 等）通知 |
| `eye_protection.*` | 2 | 护眼锁屏 / 屏保 |

### 5.1 屏幕与展示控制

`publishStatus`、`programPublish`、`switchImage`、`switchChannel`、`picturePropaganda`、`videoPropaganda`、`audioPropaganda`、`newsBroadcast`、`marqueeControl`（跑马灯）、`countDownControl`、`popupNotice`、`residentNotice`、`ringControl`、`shoutControl`、`broadcastControl`、`setWallpaper`、`lockScreenWallpaper`、`seewoLauncherSetting`、`setSeewoLauncherWallpaper`、`screenSaverSetting`、`setScreenLight`、`setScreenAutoLight`、`switchSoundMode`、`setVoice`、`lockStreamControl` / `unlockStreamControl`（锁屏流密码）。

### 5.2 采集与监控

| 指令 | 实际行为 |
|---|---|
| `getCameraPicture` / `stopGetCameraPicture` | 摄像头抓拍（定时或按需） |
| `startAIScreenMonitorV2` | AI 屏幕内容监控 |
| `aiDetectWindow` / `aiIgnoreWindowDetect` / `windowDetectResultV2` / `collectWindowInfo` | 窗口侦测与上报（判断所开窗口是否属于"违规"） |
| `ScreenshotController` | 截图控制器（SeewoAbility 下 `window_block/image/content/*.png`） |
| `screenCapture.exe`（toolbox） | 独立截图进程，实测输出 2358×1278 JPEG 到 `C:\ProgramData\seewo\screenCapture\temp\` |
| `softwareInfo` / `getLogicDiskInfo` / `loginInfo` / `userProfileScan` / `folderScan` | 软件 / 磁盘 / 登录用户 / 画像 / 目录盘点 |

实测截图产物（日志原样，文件名已打码）：

```text
[Capture Image File]format: FILE_JPEG [Reply]result: true
  path: "C:\ProgramData\seewo\screenCapture\temp\<时间戳>.jpg"
  width: 2358 height: 1278 stride: 2358
```

窗口拦截还会用到图片指纹（`SeewoAbility\window_block\image\content\` 与 `server-adblock/*.png`），说明它带有**内置特征库**用于窗口判定。

### 5.3 系统管控与破坏性操作

`diskFormat`（格式化磁盘）、`folderClean`、`rubbishClean` / `rubbishScan`、`windowsDeviceSoftwareUninstall`（远程卸载软件）、`softwareSpeedLimit` / `softwareSpeedWhiteList`、`deviceSpeedLimit` / `devicePostFrequency`、`addWindowBlockRule` / `deleteWindowBlockRule`（封窗口）、`updateBrowseAuditStrategy`（改浏览器审计策略）、`activateWindows`、`syncTimeControl`（改时钟）、`userProfileControl`、`removeDevice`。

冰点还原一组：`freezeDiskControl`、`freezeBypassControl`、`freezeRepairControl`，以及 `[MACHINE]-FreezeEnlargeStateChange`。

锁屏 / 电源一组（`SET_PROPERTY+` 前缀）：`enablePowerOnLock`、`enablePowerOnLockPeriod`、`smartLockTime`、`unlockMode`、`idlePowerOff`、`finishClassLockStatus`、`lockStreamPassword`、`riskWebsiteMode`、`eyeProtectionMode`、`windowBlockStatus`。

### 5.4 远程协助与其它通道

- `[MACHINE]-` 前缀：`DiscoverWol`（网络唤醒）、`OpenEasiSoft`、`SwitchResolution`、`MarqueeComplete`
- IoT 灯光：`lightIot.thing.property.get/set.*`（speaker、voice_microphone、exceed_share）、`MONITOR+POST_PROPERTY+backlight_state` / `read_mode`
- 护眼：`eye_protection.screen_lock.lock` / `screen_saver.show`
- NFC / 硬件：`UDI+NOTIFY+v1.device.nfc.cardIdSend`

## 6. 自保护与反分析特性

### 6.1 自保护栈【观测】

| 层 | 证据 |
|---|---|
| `self_defense` 模块 | `Load Module [… self_defense(1.5.4.124)]`，`[self_defense] Start cost 44–222ms` |
| 文件过滤驱动 `KeLiteLady` | `[KeLiteLady Filter] AddRegisterProtectedPath [SOFTWARE\WOW6432Node\Seewo\SeewoFreeze] Success` |
| 进程白名单校验 | `Allow [\??\C:\…\crashpad_handler.exe] KeLiteLady Check` |
| 组件完整性 | `Verify.json` 清单校验，缺失即拒绝加载 |
| 进程守护 | `HugoProcess` + `Guard Process … Try 5s Later` + `needGuard/guardCount` |
| 自修复 | `AutoRepairSystem` + `DirectoryWatcherSystem` |

::: important 叠加效应
驱动级路径保护、启动白名单、清单校验、进程拉起、配置修复五层叠加。想靠"删文件 / 改配置 / 杀进程"关掉它，基本都要先过驱动这一关。
:::

### 6.2 静态对抗特性【静态】

- 指令名（`SERVICE+publishStatus`、`getCameraPicture` 等）在 exe 与 36 个模块 DLL 中**都不是明文**，运行时才解密，因此搜字符串必然失败。
- `.rdata` 中混入 6 个随机串伪造的 C++ 类名，与真实 Crypto++ 类描述符交错，干扰 RTTI 识别。
- 日志加密采用 `FNTS` 容器 + ECDH + HKDF + AES-128-CTR，详见[日志加密与解密](/seewo-manager/seewocore/log-encryption/)。
- PE 带 `.reloc`，基址每次不同（实测见过 `0x160000`、`0x380000`、`0x6b0000`、`0x7d0000`、`0xb40000`、`0xff0000`），内存中的 `OptionalHeader.ImageBase` 被改写为实际基址。

### 6.3 驱动通信【观测】

```text
[error] dwIoControlCode:2147491884 ,CreateFileW failed :2
```

`CreateFileW` 打开设备失败（`2` 表示文件不存在）后仍尝试 `DeviceIoControl`，说明存在**设备名 + IOCTL 码**的内核通信通道。IOCTL `0x8000202C`（即 2147491884）固定出现在每次启动。

## 7. 运行时观测特性

| 现象 | 位置 |
|---|---|
| 服务 / PID | `SeewoCoreService` → `SeewoCore.exe`，Session 0，SYSTEM |
| 日志 | `C:\ProgramData\Seewo\SeewoCore\log\SeewoCore-{YYYYMMDD}-{N}.log`，活跃文件为 `SeewoCore-.log` |
| 单文件规模 | 20–138 KB 密文即换文件（明文 140 KB–1.3 MB） |
| 崩溃指纹 | 一天里出现多个存活不足 1 分钟的日志，即反复崩溃重启 |
| 临时产物 | `C:\ProgramData\seewo\screenCapture\temp\*.jpg`；`%APPDATA%\seewo\SeewoAbility\window_block\image\content\*.png` |
| 配置 | `C:\ProgramData\seewo\SeewoCore\lightIot\deviceConfig.json` 等 |
| 线程 | 日志第 4 段方括号内为 thread id，抓拍与 Paho 回调都在独立线程 |
| 长连接状态 | `DoConnect` → `subscribe & online <--` 表示已连上；`Couldn't resolve host` 刷屏表示断网 |

## 8. 与日志加密的关系

日志加密不是孤立设计，它与前述自保护属于同一套思路：**让第三方（包括学校自己的 IT）看不到它在做什么**。

- 加密开关：**没有**。`log.*` 配置里无加密项，加密无条件编译进日志沉槽。
- 算法：`ECDH(P-256)` → `HKDF(salt=info="slp")` → 16 字节 → `AES-128-CTR` → 明文为 zlib deflate 流。
- 密钥：**只存在于进程内存，且只在该文件打开期间存在**，从不落盘。
- 判定解密正确的依据：明文前 7 字节固定为 `78 9c 00 00 00 ff ff`。

因此本文的全部【观测】证据，都是通过运行时取密钥 + 离线解密获得明文后才成立的。**没有这一步，上面的能力表基本无法看到。**

## 9. 明确未解与限制

| 项 | 状态 |
|---|---|
| `cipherSel=1` 时使用哪种算法 | 未验证（实测只遇到 `2`，即 AES-128-CTR） |
| IOCTL `0x8000202C` 对应的设备名与语义 | 未解（设备打开失败，无法静态确认） |
| MQTT payload 是否二次加密 / 签名 | 日志只记 topic 与部分 param 体，报文级证据不足 |
| 云端 `cmd` 全表是否就是 97 个 | 否。只覆盖本机 8 天内的实际下发，云端仍有未触发指令 |
| 对端 ECDH 公钥来源与私钥位置 | 公钥来自运行时（服务端），私钥不在本机 |
| `HugoProcess` 守护器的重启策略细节（退避 / 上限） | 只见 `5s` 与 `guardCount: 5`，完整策略未知 |
| 关闭自保护后服务是否仍完整工作 | 未测（需改动驱动，风险高） |
| Ghidra 静态复核 | 本轮会话不可用：`open_binary` 成功后 `binary_overview` / `list_segments` 均在客户端超时（2.2 MB PE32 i386 的自动分析时长超过请求时限）。静态部分沿用上一轮落盘的 `ghidra_fn_*.json` 与加密报告；`objdump` 提供方在 Windows 上不可用。 |

## 10. 复现这套观测的方法

```powershell
# 1) 解密日志（使用分析工具目录）
$env:SEEWO_PID = (Get-Process SeewoCore).Id
node <工作目录>\seewo_log_dump.js

# 2) 启动流水线（每份日志都会重放）
Select-String -Path <工作目录>\decrypted\*.log -Pattern 'Load DynamicSystem|Load Module|Initialize Susccess'

# 3) 云端下发的全部指令
Select-String -Path <工作目录>\decrypted\*.log -Pattern 'cmd:\s*"[^"]+"' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Sort-Object -Unique

# 4) 上报节律
Select-String -Path <工作目录>\decrypted\SeewoCore-*.log -Pattern 'thing/post' | Measure-Object

# 5) 崩溃指纹：找存活不足 2 分钟的日志
Get-ChildItem <工作目录>\decrypted\*.log | ForEach-Object {
  $l = Get-Content $_
  "{0} {1} -> {2}" -f $_.Name, $l[0].Substring(1,17), $l[-1].Substring(1,17)
}
```

静态侧（可选，需 Ghidra）可复核加密链路：`0x4da840`（ECDH + HKDF）、`0x4d9f10`（deflate → 回调）、`0x4dc143`（实际加密点）。

::: warning 声明
本文为民间技术整理，仅供研究与自查参考，与希沃官方无关。请勿将文中方法用于未授权设备。
:::

本文为民间技术整理，仅供参考。
