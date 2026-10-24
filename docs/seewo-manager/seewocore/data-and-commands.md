---
title: 数据上报与指令执行
createTime: 2026/10/25 10:00:00
permalink: /seewo-manager/seewocore/data-and-commands/
---

# 数据上报与指令执行

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>22 分钟</template>
  <template #difficulty>进阶</template>
</DocProp>

本文整理 SeewoCore 上报哪些数据、指令如何下发与执行、数据最终流向何处。载荷片段均取自解密后的日志原文，其中的密钥、设备标识、账号与机构信息已做占位符化处理。

::: tip 证据标注
【观测】表示日志中直接出现；【推断】表示由观测推出的机制；【未知】表示日志未覆盖。配套阅读：[架构与运行原理](/seewo-manager/seewocore/architecture/) · [日志加密与解密](/seewo-manager/seewocore/log-encryption/)
:::

## 0. 摘要：三个问题一次答完

| 问题 | 答案 |
|---|---|
| **它上传哪些数据？** | 硬件与系统指纹、外设清单（麦克风 / 扬声器 / 摄像头 / 显示器 / 音量）、存储与内存条序列号、Windows 登录会话与账号、**全部已安装软件及安装路径**、指令执行审计、窗口 / 屏幕截图、摄像头抓拍、文件与 dump 收集 |
| **怎么上传？** | 主要通过 MQTT over TLS 的 `thing/post` 一条通道；本地另有 wss 服务总线供同机希沃软件调用 |
| **指令怎么进来、怎么执行？** | 云端发 `rpc/request/{uuid}` → `IotManagerPluginImplBase::OnServiceCall` → 按 `cmd` 分发给 10 个 zmodule 之一 → 本地执行（必要时经回环地址的 wss 分发给 `SeewoHugoService` / `SeewoAbility`）→ `rpc/response/{同名 uuid}` 回执 → 附一条 `behaviorAudit` 审计上报 |

## 1. 通道与设备身份

```text
productKey : <产品Key>
deviceName : <设备ID>          （设备唯一 ID，出现在每条 topic 中）
broker     : iot-broker.seewo.com      （TLS，paho-mqtt3as 异步客户端）
```

| topic | 方向 | 作用 |
|---|---|---|
| `/sys/{pk}/{dn}/rpc/request/{uuid}` | 订阅 | **云端下发指令** |
| `/sys/{pk}/{dn}/rpc/response/{uuid}` | 发布 | 指令执行回执 |
| `/sys/{pk}/{dn}/thing/post` | 发布 | 属性 / 事件上报（即"上传数据"） |
| `/sys/{pk}/{dn}/up/request` | 发布 | 设备主动向云端要数据（如 `GetProperty`） |
| `/sys/{pk}/{dn}/up/response/{n}` | 订阅 | 上面那条的应答 |

## 2. 一条指令的完整生命周期

`SeewoCore-20261024-7.log` 12:36:16–12:36:21 记录了一次完整的锁屏解锁链路：

```text
① 云端下发
[recv topic]/sys/{pk}/{dn}/…/rpc/request/{uuid}

② 分发给业务插件（iot_manager_plugin_impl_base.cpp:345）
[IOT] ServerCallService setPostFrequency:param= { "lists":[ … ] }

③ 执行中需要读本地策略 → 转成"设备主动问云端"（up/request）
[send topic]/sys/…/up/request/18
[recv topic]/sys/…/up/response/18
[IOT] GetProperty lockStreamPassword: Success: data=******** code=000000 message=success
[IOT] GetProperty finishClassLockStatus: Success: data={ "finishClassLockStatus" : true } code=000000

④ 需要让同机组件真正动作 → 走本地 wss 总线
wss://127.0.0.1:49405/SeewoHugoService send message [{
   "data" : { "finishClassLockStatus" : true, "visible" : true },
   "messageType" : 1213,
   "traceId" : "<TRACE_ID>"
}] to /forward/SeewoHugoHttp/SeewoHugoService

⑤ 回执给云端
[send topic]/sys/…/rpc/response/{uuid}

⑥ 执行审计上报（每次动作都留痕）
[IOT] PostEvent behaviorAudit: param={ "actionCode":"command_unlock", "des":"指令解锁",
                                       "funCode":"unlock", "userId":"" }
[send topic]/sys/…/thing/post
```

::: important 指令原理的全貌
MQTT 下行 → 插件分发 → 本地策略查询 → 本地 wss 执行 → MQTT 回执 → 审计上报。每一步都有独立 traceId。
:::

### 2.1 指令分发表

日志中可见云端下发的**指令配置表**，带优先级字段：

```text
cmds {
  cmd: "SERVICE+loginInfo"
  prior: 0
}
cmds {
  cmd: "lightIot.thing.property.get.exceed_share"
  prior: 0
}
```

这说明 `cmd` 不是硬编码常量表，而是**云端可配的指令集合 + 优先级**。端侧只负责按 `cmd` 前缀路由：

| 前缀 | 路由目标（推断自命名与日志） |
|---|---|
| `SERVICE+` | `IotManagerPlugin` → 对应 zmodule 的服务实现 |
| `SET_PROPERTY+` | 策略属性写入（`PolicyController` / 各 Controller） |
| `[MACHINE]-` | `machine` 模块事件回调 |
| `MONITOR+POST_PROPERTY+` | 显示器 / IoT 属性上报 |
| `lightIot.thing.*` | `light_iot` 模块 |
| `UDI+NOTIFY+` | 外设通知（NFC 等） |
| `eye_protection.*` | 护眼控制器 |

::: note 静态结论
这些 `cmd` 字符串在 exe 与 36 个模块 DLL 中都**不是明文**，运行时才解密，所以"搜字符串找不到指令"是设计使然。
:::

### 2.2 回执约定

| 字段 | 观测值 |
|---|---|
| `code` | `000000` 表示成功（6 位零） |
| `message` | `success` 或空 |
| 需求响应 | `ServerCallService xxx:param= {...}` |
| 失败表现 | `… Fail`，随后 `Event [xxx] Cache` |

### 2.3 缓存与节流机制

早期判断认为"离线就不缓存、不补传"，实测**并非如此**，实际存在 Cache：

```text
[IOT] PostEvent hardDiskReport param={…} Fail.     ← 上报失败
[IOT] Event [hardDiskReport] Cache                  ← 落缓存
[IOT] SetProperty {"memory":{…}} Fail.
[IOT] Property [memory] Cache
……
[IOT] Event displayReport Cache no Change.          ← 再次上报时与缓存比对，无变化就跳过
[IOT] Property [hardDisk] Cache no Change.
```

机制可归纳为：**失败 → 进缓存 → 下次有机会再发；内容没变 → 直接跳过**。这是"去重 + 节流"，也解释了为什么"每次指令伴随约 3 条 `thing/post`"——其中一部分是缓存命中的补发。

同类机制还有 `AddGrail [http.forward] Buffer`：本地 API 调用日志也会进入缓冲。

### 2.4 本地服务总线

除 MQTT 外，还有一条**纯本机**通道：

```text
Initialize HttpsServer-tls [h1] node:SeewoProxyHttp ip:127.0.0.1 port:0 thread:1
find node SeewoHugoHttp port 49405
Websocket Connect 127.0.0.1:65374 /forward/SeewoHugoHttp/SeewoSmartPen
websocket proxy wss://127.0.0.1:49405/SeewoSmartPen connect success
```

- 监听**回环地址 + 动态端口**（本次为 49405），外部不可达
- 协议为 HTTPS / WebSocket，带 `messageType` 数字码（如 `1213`）
- 节点名包括 `SeewoHugoHttp`、`SeewoHugoService`、`SeewoSmartPen`
- 也承载 IoT 连接：`Initialize IotManager node:SeewoProxy group:Remote2`

【推断】`Hugo` 是这套本地服务框架的内部代号（进程守护日志中也叫 `HugoProcess`），SeewoCore 是它的服务端宿主。

### 2.5 云端配置下发

日志中可见 `CLOUD-CONFIG` 段：

```text
CLOUD-CONFIG.rtspConfig:[{
   "password" : "<密钥>",      ← RTSP 摄像头口令，明文存在配置里
   ...
}]
"host" : "upload.qiniup.com"     ← 上传通道
[{ "detectType" : "HTTP_HEAD", "host" : "oss1.seewo.com" }]   ← 用 HTTP HEAD 探测可达性
```

::: warning 注意
上传地址、探测方式，甚至摄像头 RTSP 口令，都是由云端配置驱动的，端侧不写死。口令在配置中以明文存在，这是设计上的风险点。
:::

## 3. 它上传哪些数据

以下是日志中**真实出现过**的上报事件，按类别整理。载荷为日志原文，省略号表示略去的重复项，真实业务数据已打码。

### 3.1 硬件与系统指纹

`PostEvent hardwareReport`：

```json
{ "lists" : [
   { "name":"osName",            "value":"Windows 10" },
   { "name":"osBits",            "value":"64" },
   { "name":"osVersion",         "value":"10.0.19045.6466" },
   { "name":"cpu",               "value":"13th Gen Intel(R) Core(TM) i7-13790F" },
   { "name":"cpuPhysicalCores",  "value":8 },
   { "name":"cpuLogicalCores",   "value":8 }
] }
```

### 3.2 存储与内存（含型号与序列号）

`PostEvent hardDiskReport`、`SetProperty memory`：

```json
{ "hardDiskList" : [ { "capacity":104856255, "name":"VMware Virtual NVMe Disk", "ssd":false } ] }

{ "memory":{ "blanks":[ { "capcity":8388608, "colokSpeed":0, "dataWidth":64,
                          "product":"VMW-8192MB", "serial":"<序列号>" } ],
             "totalPageCapcity":8388608, "totalPhysicalCapcity":8388608 } }
```

由此可知，磁盘型号与容量、内存条型号与**序列号**都会上报。

### 3.3 外设清单

去重后的事件名如下：

| 事件名 | 含义 |
|---|---|
| `postMicrophoneList` | 麦克风清单 |
| `postSpeakerList` | 扬声器清单 |
| `postWebrtcCameraList` | 摄像头清单 |
| `postScreenList` | 显示器清单 |
| `volumeReport` | 音量 |
| `displayReport` | 显示器（displayList） |
| `hardDiskReport` | 磁盘 |

### 3.4 会话与账号

`SetProperty winSession` 记录**谁在这台机器上、什么时候登录**：

```json
{ "winSession":[
  { "connectTime":"2026-10-24 12:35:08", "domain":"<主机名>", "id":1,
    "loginTime":"2026-10-24 12:35:27", "state":"Active",
    "username":"<账号>", "winStationName":"Console" },
  { "winStationName":"RDP-Tcp" } ] }
```

`PostEvent loginStatus` 记录登录 / 登出事件（字段含 token，实测日志中为空）：

```json
{ "nickName":"", "operation":"logout", "photoUrl":"", "token":"", "userId":"", "userName":"" }
```

扫码绑定走希沃账号体系：

```text
https://id.seewo.com/scan/middle?uid=<TOKEN>&oriSys=SeewoRemote
   &redirect_url=…campus.seewo.com%2Fhugo-mobile%2F…%2Fqrcode-auth
"lastBindSchoolCode" : "<学校代码>"
```

### 3.5 软件清单（全部已安装软件 + 安装路径）

`PostEvent softwareReport`：

```json
{ "lists" : [
  { "installDir":"C:\\ProgramData\\LightAppRendersResources\\lightapp-self-study",
    "name":"", "production":"Seewo", "version":"1.1.0.28" },
  { "installDir":"C:\\Program Files (x86)\\360\\360zip",
    "name":"360压缩", "production":"360安全中心", "version":"4.0.0.1680" },
  { "installDir":"C:\\Users\\<账号>\\AppData\\Roaming\\<软件目录>" }
] }
```

::: important 覆盖范围
不只希沃自家软件，**第三方软件、用户目录下的安装路径也一并上报**。
:::

### 3.6 使用行为与审计

| 事件 | 内容 |
|---|---|
| `hardwareUsedReport` / `softwareReport` / `websiteReport` | 使用时长 / 频次类上报（间隔由云端 `setPostFrequency` 决定：硬件 120 s、软件 120 s、网站 60 s、硬件使用 60 s） |
| `behaviorAudit` | **指令执行审计**：`{"actionCode":"command_unlock","des":"指令解锁","funCode":"unlock","userId":""}` |
| `PostGrailLog http.forward` | 本地 HTTP 转发调用自身也会留审计日志（`AddGrail` → Buffer） |

### 3.7 状态与版本

```json
PostEvent seewoLauncherInfo : {"boot":false,"install":true,
                               "installDir":"C:\\Program Files\\Seewo\\SeewoLauncher",
                               "version":"2.1.2.1120"}
PostEvent openSdkVersion    : {"version":""}
PostProperty freezeRestoreInfo : {"freezeRestoreInfo":[{"name":"SeewoFreeze","status":false}]}
"hasCache" : true    /    "propagandaCacheSize" : …
```

### 3.8 图像与文件类采集

| 类型 | 落点（本机证据） |
|---|---|
| 屏幕截图 | `C:\ProgramData\seewo\screenCapture\temp\<时间戳>.jpg`（2358×1278 JPEG） |
| 窗口拦截记录图 | `%APPDATA%\seewo\SeewoAbility\window_block\image\content\*.png` |
| 特征库图 | `server-adblock/*.png`（内置窗口判定特征） |
| 摄像头抓拍 | 指令 `SERVICE+getCameraPicture` / `stopGetCameraPicture`；上传通道 `upload.qiniup.com` |
| 文件 / dump 收集 | 控制器 `FileCollectController`、`DumpCollectController` |

::: warning 未知项
抓拍得到的**图片内容**本身不在日志中记录，只记录落盘路径与上传域名。因此"图片最终是否上传成功、上传到哪个 bucket"无法从日志确证，只能以配置中的 `upload.qiniup.com`、`oss1.seewo.com` 作为通道证据。
:::

## 4. 数据流向

| 目的地 | 承载内容 | 证据 |
|---|---|---|
| `iot-broker.seewo.com`（MQTT/TLS） | 全部 `thing/post` 属性与事件、指令回执 | topic 与 `PublishMessage success` |
| `campus.seewo.com`（HTTPS） | 设备注册 / 绑定 / 预绑定、策略拉取 | `/api/v1/device/registry`、`/api/v1/bind/info`、`/api/v1/pre_bind/device` |
| `id.seewo.com` | 扫码登录中转 | 二维码 URL |
| `friday.cvte.com` | 行为 / 使用统计埋点 | `/agent/api/app/v2/report` |
| `upload.qiniup.com` / `oss1.seewo.com` | 上传通道（配置指定） | `CLOUD-CONFIG` |
| `127.0.0.1:49405`（本地 wss/HTTPS） | 同机组件间指令与事件 | `Websocket Connect …` |
| Sentry / APM | 崩溃与性能埋点（`sid` / `mid`） | 启动日志 |

## 5. 敏感度评级

| 数据 | 敏感度 | 说明 |
|---|---|---|
| `winSession`（用户名 / 域 / 登录时间 / RDP 会话） | 高 | 直接暴露"谁在用、什么时候用" |
| 全部已安装软件 + **用户级安装路径** | 高 | 含个人目录路径 |
| 内存条**序列号**、磁盘型号 | 中高 | 可做硬件指纹与跨设备关联 |
| 外设清单（麦克风 / 摄像头 / 显示器 / 音量） | 中高 | 可判断是否具备录音 / 录像条件 |
| 屏幕截图 / 摄像头抓拍 | 高 | 内容级隐私 |
| `behaviorAudit`（解锁 / 管控动作留痕） | 中 | 证明管控行为发生过 |
| `loginStatus`（含 token 字段） | 中高 | 实测为空 / 未填充，但字段通道存在 |
| 硬件 / OS / CPU 指纹 | 中 | 常规资产管理级别 |
| `freezeRestoreInfo` / `seewoLauncherInfo` | 低 | 组件状态与版本 |

## 6. 日志中看到的"脱敏"行为

```text
[IOT] GetProperty lockStreamPassword: Success: data=******** code=000000 message=success
```

锁屏流密码作为属性被读出，但在**日志中被替换为 `********`**。同样，`loginStatus` 的 `token`、`userName`、`userId` 在实测那次上报中为空串。

::: important 推断
敏感字段有专门的日志脱敏，**不能因为日志里是空值就判断它没有上报这些字段**。只有报文级抓取（MQTT / TLS 流）才可能确认。
:::

## 7. 可以验证与尚不可验证

| 结论 | 状态 |
|---|---|
| topic 结构、指令生命周期、审计上报 | 已证实，日志直接可见 |
| 上报数据字段清单 | 已证实，日志直接可见 |
| 失败 → 缓存 → 再次上报的去重节流 | 已证实（`Cache` / `Cache no Change`） |
| 报文体是否整体加密或签名 | 未知，日志只到 `param={…}` 层，未见 TLS 之上的二次封装 |
| 抓拍图片最终上传目的地 | 未知，只有配置中的通道域名 |
| `websiteReport` 具体字段 | 未知，本机 8 天未触发（可能需启用浏览器审计策略） |
| 云端 `cmd` 全表 | 未知，只知道本机触发过的 97 个 |

## 8. 复核命令

```powershell
Set-Location <工作目录>\decrypted

# 1) 全部上报事件名
Select-String *.log -Pattern 'PostEvent ([A-Za-z]+)' -AllMatches |
  ForEach-Object { $_.Matches.Groups[1].Value } | Sort-Object -Unique

# 2) 全部上报属性名
Select-String *.log -Pattern 'Property \[([A-Za-z]+)\]' -AllMatches |
  ForEach-Object { $_.Matches.Groups[1].Value } | Sort-Object -Unique

# 3) 看某一条事件的完整载荷
Select-String *.log -Pattern 'PostEvent softwareReport' -Context 0,30 | Select-Object -First 1

# 4) 指令生命周期（按 traceId 串起来，traceId 需替换为实际值）
Select-String *.log -Pattern '<TRACE_ID>' -Context 1,2

# 5) 云端下发的上报频率
Select-String *.log -Pattern 'setPostFrequency' -Context 0,20 | Select-Object -First 1

# 6) 缓存与去重
Select-String *.log -Pattern 'Cache no Change' | Measure-Object
```

::: warning 声明
本文为民间技术整理，仅供研究与自查参考，与希沃官方无关。文中不含任何可用凭据或真实设备标识。
:::

本文为民间技术整理，仅供参考。
