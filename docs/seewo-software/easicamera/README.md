---
title: EasiCamera 逆向与安全分析
createTime: 2026/10/25 20:00:00
permalink: /seewo-software/easicamera/
---

# EasiCamera 逆向与安全分析

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>18 分钟</template>
  <template #difficulty>进阶</template>
</DocProp>

::: tip 概述
EasiCamera（希沃视频展台）是希沃交互智能平板 / 白板生态中的实物展台客户端，负责 USB 展台相机、无线展台、侧边 MCU 按键、拍照批注、图像增强与云端资源。它与希沃白板 5（EasiNote）在同一台教师机上并行运行，通过多条进程间通道交换数据。本文基于 REA 托管元数据取证、ILSpy 反编译与本机运行态观测，还原其模块结构、五条通信通道与十项安全发现，并给出风险总表与可排期的加固清单。
:::

::: note 分析对象
- 主程序：`C:\Program Files (x86)\Seewo\EasiCamera\EasiCamera_2.1.0.4410\Main\EasiCamera.exe`
- 版本：2.1.0.4410；构建 buildkit 5.14.0.865，源码修订 `1f58370e`，2026-07-28
- SHA-256：`96124645801171b8bfdeecf29c5836b36d25f02bb622cf5b5b893c6235d97695`
- 方法：REA 托管元数据取证 + ILSpy 9.1 反编译交叉验证 + 本机运行态观测（管道 / 注册表 / ACL）
:::

::: important 一句话结论
这是一套工程质量相当高、模块化做得非常干净的课堂视频展台软件；但它的**进程间与局域网信任模型基本是"默认全信"**：TLS 证书校验在进程级被整体关掉，两个本地 RPC 端点（`0.0.0.0:55319` 的 TCP 总线、固定名字的 .NET Remoting 管道）没有任何认证，更新与云资源是"下载即执行"。对攻击者而言，最省力的路径不是打主程序，而是打它周围这些没有门锁的通道。
:::

相关阅读：[SeewoCore 架构与运行原理](/seewo-manager/seewocore/architecture/) · [SeewoAbility 能力分析](/seewo-manager/seewoability/)

## 1. 为什么要拆它

希沃视频展台（EasiCamera）是希沃交互智能平板 / 白板生态里的"实物展台"客户端：USB 展台相机、无线展台（自带 Wi-Fi AP）、侧边 MCU 按键、拍照 / 批注 / 投屏、图像增强（去手指、梯形校正）、扫码登录、云端资源与 AI 识别。它和希沃白板 5（EasiNote）在同一台教师机上并肩运行，靠一堆进程间通道互相喂数据。

这类"教室里的常驻软件"有几个特点，决定了它值得认真看：

1. 它跑在教师账号下，能拍照、能读文件、能发网络请求、能拉起安装包。
2. 它长期和"不可信输入"打交道：U 盘、摄像头固件、局域网里的无线展台、各种云端下发的资源包。
3. 它周围总是围着好几个同厂进程（守护、升级、白板、投屏），而这些进程之间的通道通常比主程序本身更松。

下面所有内容都是对**本机已安装副本**的静态 / 被动分析，没有向任何外部目标发包。

## 2. 目标画像

| 项目 | 实测值 |
|---|---|
| 主程序 | `EasiCamera.exe`，1,493,048 字节，PE32 / .NET Framework 4.5 / CIL |
| 托管架构 | `anycpu-prefer-32`，MVID `6b345e0c-6477-44d8-9d4c-4cf5f9471d0f` |
| 元数据 | `v4.0.30319`，67 个 TypeDef、359 个方法、187 条 `ldstr` 字面量 |
| 应用清单 | `requestedExecutionLevel level="asInvoker"`（不申请提权） |
| 安装体量 | 276 个文件 / **276.9 MB**，其中 183 个 DLL |
| 原生组件 | ffmpeg 4.x（avcodec-58 等）、ffdshow.ax、libtensorflowlite、libda_cropper（18 MB）、zxing、DirectShow 封装 |
| 注册表 | HKLM `WOW6432Node\Seewo\EasiCamera`（`admin=0`）、HKCU `Software\Seewo\EasiCamera\ServerPort=55319` |
| 用户数据 | `%APPDATA%\Seewo\EasiCamera\`（配置、日志、依赖、照片） |
| 安装目录 ACL | `BUILTIN\Users`：只读 + 执行（无写入） |
| 常驻进程 | `EasiCameraGuardian.exe`（本机采样时正在运行，属主为当前登录用户） |

顺带一提，安装目录里躺着不少"工程遗迹"：0 字节的 `null` 文件、`CrashRpt.exe`、`Vmr9Test`、`Sc08FixTool`、`vclog.txt`、K-Lite 11.9.6 安装包、2015 年的 ffdshow。这类残留通常不直接构成漏洞，但会扩大攻击面，也让"这软件到底在跑什么"变得难以回答。

## 3. 结构还原：一个被 Shell 串起来的模块化 WPF 应用

主程序本身很薄（67 个类型），真正的功能在 14 个 `EasiCamera.*` 程序集里。启动流程是典型的"扩展点组合"：

```text
EasiCamera.exe (EasiCamera.Shell.App)
 ├─ LogExtension            日志与启动耗时统计
 ├─ ExceptionExtension      全局异常 / CrashSDK
 ├─ BugExtension            缺陷反馈
 ├─ CultureExtension        多语言（YAML 语言包）
 ├─ ImageEnhanceExtension   图像增强（libda_cropper + TFLite）
 ├─ CommunicationExtension  通信（本机总线 / 无线展台 / 守护进程）
 ├─ ECApiExtension          EasiCamera.Api（UI 外壳、配置、云服务）
 ├─ MyouExtension           希沃"我的"账号 / 云资源 / 升级
 ├─ AutoUpdateExtension     自动更新
 └─ SingletonShowWindow     单实例唤起
```

各程序集的职责边界很清楚，这对二次开发是好事：

| 程序集 | 职责 | 值得记的名字 |
|---|---|---|
| `EasiCamera.Shell` | 组合根、窗口、诊断 UI、本地化 | `App`、`CultureUtils`、`YamlLanguageReader` |
| `EasiCamera.Api` | UI 外壳 + 相机控制门面 + 配置 + 云主机 | `CameraController`、`ECAppInfo`、`EasiCamera.xml` |
| `EasiCamera.Business` | 业务：拍照 / 图片、上传、账号、AI、云资源、升级 | `MYouConfig`、`EC.CloudResource`、`CStoreUploadService` |
| `EasiCamera.Communication` | 本机 Action 服务、无线展台 TCP / UDP、HID / MCU、.NET Remoting | `CommunicationService`、`TcpCommunication`、`UdpCommunication` |
| `EasiCamera.Server.Protocol` | Action 消息协议与处理器 | `MessageServer`、`ActionMessageSession`、`InsertPicturesHandler` |
| `EasiNote.Server.Protocol` | 与希沃白板对话的镜像协议 | `ActionMessageClient`、`RequestNoteInfo2Message` |
| `EasiCameraGuardian` | 展台硬件守护（HID / MCU、按键、触摸灯） | `Form1 : IGuardian`、`SeewoCamService(8183, pid)` |
| `Cvte.*` / `dotnetCampus.*` | 视睿公共库：日志、网络、IPC、存储、绘图 | `Cvte.Net.HttpsUtility`、`IpcProvider` |

图片链路值得一提：拍照后图像增强走 `WindowCropperWrapper.EnhancePaper/EnhancePhoto`（原生 `libda_cropper.dll` + `models\dexined_mbv4-100-tf265.tflite`），这条链路会把**外部来源的位图**交给 C/C++ 与 TFLite 解析，见 5.5 节。

## 4. 五条通信通道

| # | 通道 | 端点 | 协议 | 认证 |
|---|---|---|---|---|
| 1 | Action 总线 | **0.0.0.0:55319**（冲突时退化为随机端口，写 HKCU） | TCP，长度前缀 + 消息号 + JSON | **无** |
| 2 | 白板客户端 | `127.0.0.1:3123`（出向） | 同上（镜像协议） | 自报 `AppName` |
| 3 | 无线展台发现 | **0.0.0.0:7877**（UDP） | 自定义广播，目标为展台内网地址 | **无** |
| 4 | 无线展台控制 | 相机侧 TCP 8183（守护进程持有多组 PID） | 魔数 `AA BB CC` + 序号 + CRC16 + 指令 | **无** |
| 5 | 本机 RPC | `\\.\pipe\<固定GUID>` ×2、`EasiCamera-<GUID>` | .NET Remoting（BinaryFormatter）/ dotnetCampus.Ipc | 见 5.3、5.4 节 |

### 4.1 Action 总线的线格式

`Cvte.Pipe.Protocol` 的封包很朴素，但足够清楚：

```text
┌──────────────┬──────────────┬───────────────────────────┐
│ int32 长度 L │ int32 消息号 │ 负载（L-4 字节，通常 JSON）│
└──────────────┴──────────────┴───────────────────────────┘
```

发送侧：`BytesBuilder.AppendWithLength(id + payload)`；接收侧 `MessageReader.Read` 按长度切帧；`BasicMessageParser.ParseMessage` 取前 4 字节作为消息号，查 `MessageLoader` 里注册的类型，`Activator.CreateInstance` 后 `FromBinary(payload)`。

现有消息号（来自 `MessageIds` 常量）：`1` 握手、`2` 服务器回连、`11/12` 白板信息、`20/21` 请求与响应（`Paras` 字符串数组）、`50/51` 插图与结果。

分派方式很"反射"：

```csharp
if (ActionHandlerLoader.TryGetHandler(message, out var handler))
    handler.GetType().GetMethod("Handle").Invoke(handler, new object[4] { message, session, this, sender });
```

消息号来自对端，处理器来自本进程注册表——**没有签名、没有会话令牌、没有来源校验**。`AppHandshake` 只是把客户端自称的 `AppName`（`EasiCamera` / `SeewoLink`）解析成枚举，然后把它当作身份。

### 4.2 无线展台的 UDP 发现

```csharp
udpClient.Client.Bind(new IPEndPoint(ip, 7877));      // 展台内网地址
await udpClient.SendAsync(_buffer, _buffer.Length, BroadcastEndPoint);
```

接收线程 `Bind(IPAddress.Any, 7877)`，每 1–5 秒重播一次发现包。任何在同网段的主机都能应答，也能看到这些包。

## 5. 安全发现

### 5.1 【严重】进程级关闭 HTTPS 证书校验

`Cvte.Net`（视睿公共网络库）里有一段非常"省事"的代码：

```csharp
internal static class HttpsUtility {
    internal static void SetSecurity(string url) {
        if (url.StartsWith("https", StringComparison.OrdinalIgnoreCase)) {
            ServicePointManager.ServerCertificateValidationCallback = CheckValidationResult; // 全局
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        }
    }
    internal static bool CheckValidationResult(object sender, X509Certificate certificate,
                                               X509Chain chain, SslPolicyErrors errors) {
        return true;   // 永远通过
    }
}
```

`SetSecurity` 出现在通用请求、文件上传（两套实现）、分块上传、文件下载、cookie 初始化等 7 处调用点。关键在于 `ServicePointManager` 是**进程级静态**：只要 EasiCamera 里发出过任意一次 https 请求，之后整个进程里所有 https 连接（账号、云存储、资源、事件上报）都接受任意证书。

::: warning 利用路径
同网段 / 同 Wi-Fi（教室、校园网、教师热点）→ ARP / AP 侧中间人 → 截获账号域登录 Token，或篡改资源域下发的资源包；后者会被 `InstallResource()` 直接以 `/S` 安装执行（见 5.6）→ 教师机上以用户权限执行任意代码。
:::

**修复**：删掉全局回调；确需自签场景时改为"每请求校验 + 对白名单域做 SPKI pinning"。

### 5.2 【高】无认证的 TCP 消息总线监听 0.0.0.0:55319

证据链完整：

- `MessageServer.ActionPort = 55319`（默认值）；
- `new AsyncSocketListener(ActionPort, 9999)`；
- `AsyncSocketListener.Start()` → `new TcpListener(IPAddress.Any, Port)`；
- 实际端口写入 `HKCU\Software\Seewo\EasiCamera\ServerPort`（本机实测 55319）；
- `CommunicationService.StartCameraServer()` 里 `IsHeartbeat = true, HeartbeatInterval = 500`，心跳就是每 500 ms 往所有会话写 4 个零字节。

也就是说：**这台机器上任何进程**（不受防火墙约束），以及**任何能到达该端口的局域网主机**（本机未发现 `EasiCamera` 的防火墙规则，实际是否放行取决于系统默认入站策略和用户点击）都能：

1. 握手冒充 `SeewoLink` / `EasiCamera` 会话；
2. 收到被 `DistributeMessage` 广播的消息（白板版本、插图事件、文件路径）；
3. 发消息号 `50`，让服务端把**任意已存在文件**（`FilePaths.All(File.Exists)` 是唯一校验）转发给白板端插入；
4. 发 `21` / `11` 探测、驱动对端；
5. 疯狂建连（backlog 9999，每连接 32 KB 读缓冲 + 线程 / 心跳）做低成本资源耗尽。

调用骨架（长度 = 4 + 负载；`Version` 字段的 JSON 形态需按 `DataContractJsonSerializer` 实测确认，这一步未对运行中的实例发包）：

```python
import json, socket, struct

def frame(mid, obj):
    body = struct.pack('<i', mid) + json.dumps(obj).encode()
    return struct.pack('<i', len(body)) + body

s = socket.create_connection(('127.0.0.1', 55319), timeout=3)
s.sendall(frame(1,  {"AppName": "SeewoLink", "AppVersion": {"Major": 3, "Minor": 0, "Build": 4, "Revision": 0}}))
s.sendall(frame(11, {}))                                        # RequestNoteInfo
print(s.recv(4096))
s.sendall(frame(50, {"FilePaths": ["<任意已存在文件>"]}))        # 交给白板端插入
print(s.recv(4096))
```

**修复**：`IPAddress.Loopback` 绑定 + 握手 nonce / HMAC + 插图路径限制在应用自有目录；若确实需要局域网能力，改成显式开关并配配对密钥。

### 5.3 【高】固定名字的 .NET Remoting + `ensureSecurity: false`（本机反序列化面）

`EasiCamera.Communication` 里有两处 .NET Remoting IPC 服务端，管道名是**写死的 GUID**：

```csharp
public static class RemotingCameraServer {
    public const string RemotingCameraPort = "<Remoting管道GUID>";
    public static void Start() {
        RemotingServices.Marshal(new RemotingNotifyCamera(), "RemotingNotifyCamera");
        _channel = new IpcChannel("<Remoting管道GUID>");
        ChannelServices.RegisterChannel(_channel, ensureSecurity: false);   // 关闭通道安全
    }
    public static T GetObject<T>() =>
        (T)Activator.GetObject(typeof(T), "Ipc://<Remoting管道GUID>/" + typeof(T).Name);
}

public static class RemotingGuardianServer { /* <守护管道GUID>，同构 */ }
```

暴露的方法：

- `RemotingNotifyCamera.Notify(int pid, int vid, string message)`
- `RemotingNotifyGuardian.Notify()`（点亮展台触摸灯）
- `RemotingNotifyGuardian.RestartEasiCamera()`（重启主程序）

运行态可确认：本机采样时 `<守护管道GUID>` 对应的命名管道**真实存在**，因为 `EasiCameraGuardian.exe` 正在运行并以相同用户身份承载该端点。

风险有三层：

1. 名字可预测（GUID 写死在二进制里），任何本机进程可直接连接；
2. `ensureSecurity: false` 关掉通道安全栈，且未设置 `authorizedGroup`——按 .NET Framework `IpcServerChannel` 的默认行为，管道 ACL 面向所有已认证用户（此条为文档级推断，未直接读取 DACL）；
3. .NET Remoting 的负载序列化基于 **BinaryFormatter**。对这类端点做参数投递是公开的"反序列化即执行"套路（`TypeConfuseDelegate`、`ObjectDataProvider`、`TextFormattingRunProperties` 等 gadget 链）；即使不追求 RCE，`RestartEasiCamera()` 也是现成的拒绝服务。

调用骨架（未对活进程执行）：

```csharp
ChannelServices.RegisterChannel(new IpcChannel(), false);
var g = (RemotingNotifyGuardian)Activator.GetObject(
    typeof(RemotingNotifyGuardian),
    "Ipc://<守护管道GUID>/RemotingNotifyGuardian");
g.RestartEasiCamera();   // 或 Notify()
```

**修复**：优先用"命名管道 + JSON / gRPC"替掉 Remoting；短期至少 `RegisterChannel(ch, ensureSecurity: true)`、设置 `authorizedGroup` 为当前用户 SID、`TypeFilterLevel.Low`，并把对象名与调用方身份绑定。

### 5.4 【中高】dotnetCampus.Ipc 管道对"所有已认证用户"开放

`CheckDenoiseSupported()` 会拉起 `ImageRectificationRemoting.exe --pipe-name EasiCamera-<GUID>`，然后 `IpcProvider.StartServer()` + `CreateIpcProxy<IRectificationSdk>`。管道 ACL 如下：

```csharp
SecurityIdentifier id = new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null);
PipeSecurity ps = new PipeSecurity();
ps.AddAccessRule(new PipeAccessRule(id, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, Allow));
new NamedPipeServerStream(PipeName, PipeDirection.In, 250, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, ps);
```

GUID 名字确实降低了猜中概率，但 `\\.\pipe\` 对所有本机用户**可枚举**，因此"随机名字"不构成访问控制。在快切用户、RDP 多会话、共享教室机上，这构成跨会话调用与 DoS 面。

**修复**：`PipeOptions.CurrentUserOnly`（或显式用当前用户 SID 建 ACL）。

### 5.5 【中高】无线展台协议零认证，且帧数据直通原生解析器

`TcpCommunication` 的指令帧：`AA BB CC | 长度 | 序号 | 指令码 | 参数 | CRC16`（`Crc16.ComputeChecksum`）。命令集对应 `MessageType`：`0` 心跳、`1` 分辨率、`2/3` 对焦、`4` 旋转、`7` 投屏开关、`8` 码率、`9` 缩放、`10` 状态、`12` 拍照、`14` 模式切换。

这里没有任何身份概念：谁在展台内网段应答 UDP 7877、谁的 TCP 8183 讲这套魔数，就会被当成展台。后果：

- 伪造"展台"把教师端拉过来，注入指令（远程拍照、停投屏、切模式）；
- 在被信任的连接上投递畸形 MJPEG / H.264 帧，进入 ffmpeg / ffdshow / TFLite 等 C/C++ 解析路径（配合 5.1 的"任意资源包可执行"，这条链的上限不止是画面异常）；
- 把抓到的本地图片路径经 5.2 的通道推进白板。

**修复**：配对密钥 + 指令签名（或 DTLS）、设备 ID / MAC 绑定、媒体帧的严格长度与格式校验。

### 5.6 【高】更新与云资源的信任链："http 下载 → /S 执行"

- 版本检查是**明文 HTTP**：`http://myou.cvte.com/api/v1/update?appKey=<硬编码>&versionCode=…&policyId=…&deviceMac=<MAC>`。appKey 写在二进制里，设备 MAC 随请求外发。
- 桌面放一个 `UpdateTest.txt`（内容写版本号）就能覆盖升级查询的 `versionCode`，这是典型的测试钩子遗留。
- 云资源（如 `EasiScreenPerception_Win64`）下载后直接：

```csharp
Process p = new Process();
p.StartInfo.FileName = filePath;      // 下载落地的安装包
p.StartInfo.Arguments = arguments;    // "/S"
p.StartInfo.UseShellExecute = true;
p.Start();
```

在这条链上，**没有观察到更新包签名或内容哈希的强制校验**（`LibEasiUpdate.dll` 暴露的是 `EU_*` C API 与 protobuf，未定位到校验点；此点列为未确认项）。叠加 5.1 的 TLS 失效，它等价于"远程代码执行"。

**修复**：全链路 HTTPS + 发布清单签名（Authenticode / Ed25519）并**在执行前**校验；`Update.config` 里换公钥而不是共享 AppKey；删掉 `UpdateTest.txt` 后门；安装包落到不可写目录再执行。

### 5.7 【中】用户可写配置决定服务端点和反馈 URL

本机实测存在 `%APPDATA%\Seewo\EasiCamera\Configurations\EasiCamera.xml`：

```xml
<FeedBackUrl>http://service.seewo.com/m/feedback?an={0}&amp;id=7&amp;v={1}&amp;hp=0&amp;d={2}</FeedBackUrl>
<PolicyId><策略ID></PolicyId>
```

代码里同一层配置还能覆盖 `EduHost`、`IdHost`、`AccountHost`、`CstoreHost`、`SheHost`、`MetaHost`、`GlobalConfigHost`。同用户的任意进程改这份文件，就能把登录 / 反馈 / 资源指向攻击者主机；再叠加 5.1，就是标准的"改配置即钓鱼"链。

**修复**：端点类配置只接受 HKLM 或签名策略文件；URL 做 scheme / 域白名单。

### 5.8 【中】系统级编解码器注册与陈旧组件

`After.bat` 会：

- 把 `ffdshow.ax`、`ffmpeg.dll`、`EVRPresenter32.dll`、`librectification.dll`、`TrapezoidAdjustFilter*.dll` 复制进 `System32` 与 `SysWOW64`；
- `regsvr32 /s` 注册 ffdshow 与两个梯形校正滤镜；
- 改 `HKCU\Software\GNU\ffdshow` 的黑白名单与 mjpg 开关；
- 顺带运行 `UsbEthernet\registerCer.cmd`、`AmbaUsbDriver\register.cmd`。

等于给整机装了一个 2015 年的 DirectShow 滤镜攻击面：任何进程都可能加载 `ffdshow.ax`。安装目录本身是 Users 只读（无就地 DLL 劫持），但"系统级注册"这件事本身就是设计缺陷。

**修复**：私有 codec（应用内 DirectShow / Media Foundation 或自带解码器），不要往系统目录注册。

### 5.9 【中】硬编码密钥清单

| 用途 | 值 | 位置 |
|---|---|---|
| IWB appKey（与 `Update.config` 相同） | `<密钥>` | `MYouConfig.IwbAppKey` |
| PC appKey | `<密钥>` | `MYouConfig.PcAppKey` |
| 反馈服务 `fbp.cvte.com/api`（appId / 两把 51 字符 secret） | `<应用ID>` / `<密钥>` / `<密钥>` | `FeedbackWebService` 构造 |
| 荔枝服务 key | `<密钥>` | `LycheeService("http://lizhi.seewo.com", …)` |
| IoT 资源 key | `<密钥>` | `CloudResource` |

配合 `deviceMac` 参数，第三方可直接伪造反馈 / 更新 / 资源请求。**修复**：改为按实例下发的一次性凭据，并轮换已泄漏的 key。

### 5.10 【低】工程卫生与信息泄漏

`Main\null`（0 字节垃圾文件）、`CrashRpt.exe`、`Vmr9Test`、`Sc08FixTool`、`vclog.txt`；日志目录 `EasiCameraLogs` 明文记录设备 IP、本地文件路径、协议原文；`wifi.xml` 里带明文 PSK 模板（`keyMaterial <密钥>`）。这些不影响主流程，但会显著降低攻击者的侦察成本。

## 6. 风险总表

| # | 问题 | 类型 | 可达性 | 影响上限 | 置信度 |
|---|---|---|---|---|---|
| 5.1 | 全局 TLS 校验失效 | CWE-295 | 网络相邻 | 账号 / Token 泄漏、资源投递 → RCE | 已观察（代码） |
| 5.2 | 0.0.0.0:55319 无认证总线 | CWE-306/441 | 本机必然，局域网视防火墙 | 消息注入、任意文件推给白板、DoS | 已观察（代码 + 注册表） |
| 5.3 | Remoting 固定管道 + `ensureSecurity:false` | CWE-306/502 | 本机任意用户 | 反序列化 RCE、进程控制 | 代码已观察；管道存在已实测；ACL 为文档级推断 |
| 5.4 | IPC 管道 Authenticated Users | CWE-732 | 本机任意用户 | 跨会话调用、DoS | 代码已观察 |
| 5.5 | 无线展台协议无认证 | CWE-306 | 同网段 | 指令注入、原生解析器攻击面 | 代码已观察；设备端未测 |
| 5.6 | http 更新 + 下载即执行 | CWE-494/319 | 网络相邻 | 以用户权限执行任意代码 | 代码已观察；包签名校验未定位 |
| 5.7 | 用户可写配置改端点 | CWE-15 | 本机同用户 | 钓鱼 / 凭据劫持 | 已观察（文件 + 代码） |
| 5.8 | 系统级 ffdshow 注册 | CWE-1104 | 系统级 | 攻击面扩大、第三方加载 | 已观察（脚本 + 文件） |
| 5.9 | 硬编码密钥 | CWE-798 | 远程 | 接口滥用、策略伪造 | 已观察 |
| 5.10 | 工程残留与日志 | CWE-200 | 本机 | 侦察辅助 | 已观察 |

## 7. 可扩展性：这软件其实很好接

逆向的另一个目的是判断"能不能在上面做东西"。结论是：**能，而且路径很干净。**

1. **消息协议可插拔**。新增一条业务消息 = 一个 `[Message(id)]` 类 + 一个 `IChannelMessageHandler<TMsg, ActionMessageSession>` 实现；`MessageServer.InitHanlderLoader()` 用 `Assembly.GetExecutingAssembly().GetTypes()` 全量扫描自动装载，不需要改分派器。第三方白板想对接，照抄 `EasiNote.Server.Protocol.ActionMessageClient`（`Init()` → `Connect(ip, port)` → `SendMessage()`）即可。
2. **Shell 扩展点**。想加功能就加一个 `*Extension`；安装目录预留了 `Extensions` 与 `CultureResource` 目录。
3. **UI 可编排**。`UiItemKeys` + `DisplayToolBarItem` + `Lang.DisplayToolBar.*` 驱动整套工具栏（`Menu/Minimize/RichScan/Login/Select/Annotate/Eraser/Undo/ScreenShot/TakePhoto/TimeLapsePhoto/ImageEnhance/IntelligentIdentification/ImageView/Light/PictureSetting/Setting/Medal/ShowSidebar/SaveImage/ContrastView/InsertToEn/ScreenProjection`）。加按钮 = 注册 key + 图标 + 多语言条目。
4. **相机型号适配层**。`CameraController` / `CameraInfo` / `ResolutionAdapter` 按型号分支（`SC01/02/03/03C/05/06/07/07E/07F/08/13`、`F2/F3/F6`；`SC07F` 必须显式指定分辨率）。接新硬件 = 新增型号类 + 适配器，配置里可用 `CustomMainCamera` 指定主相机。
5. **进程外算法模块**。`dotnetCampus.Ipc` + `CreateIpcProxy<T>` + `--pipe-name` 已经是现成的"重算法拆进程"框架（`ImageRectificationRemoting.exe`、`HexinRemoting.exe`、`Cvte.RemoteProcess.exe`）。把新的去噪 / 校正 / 识别模块塞进去，主程序侧只多一个接口定义。
6. **云端资源框架**。`EC.CloudResource` 以 key + version 管理下载、安装、固件版本（`GetResourceInfoAsync` / `DownloadAsync` / `GetUpdateInfo` / `SetFirmwareVersion`），新 AI 模型、驱动、外部安装包都能走这条路（`models\dexined_mbv4-100-tf265.tflite` 就是这么来的）。
7. **私有化部署开关**。七个云主机全部可在 `EasiCamera.xml` 覆盖，天然支持内网 / 专有云。
8. **外部服务集成**。CStore 上传（OSS 表单直传）、Lychee、Myou 升级、SeewoAI WebSocket、有道词典、FTP、zxing 扫码登录、ManagedWifi 热点。

::: tip 二次开发建议
优先走"消息协议 + 扩展点 + 进程外模块"这三条路，不要去动 `Cvte.*` 公共库——那是全公司共用的，改动风险和回归成本都不划算。
:::

## 8. 加固清单

### P0（单点收益最大）

1. 删除 `HttpsUtility.CheckValidationResult` 的 `return true`；改默认校验或对白名单域做 SPKI pinning。
2. `AsyncSocketListener` 增加 `IPAddress address` 参数，Action 总线默认 `IPAddress.Loopback`；需要局域网时显式开启 + 配对。
3. 更新 / 资源：执行前强制校验签名 / 哈希；`Update.config` 改公钥；删 `UpdateTest.txt` 钩子；全链路 HTTPS。

### P1

4. .NET Remoting：优先换协议；短期 `ensureSecurity: true` + `authorizedGroup` = 当前用户 + `TypeFilterLevel.Low`。
5. `dotnetCampus.Ipc` 全部改用 `PipeOptions.CurrentUserOnly`。
6. `InsertPictures` 的文件路径限制在 `%APPDATA%\Seewo\EasiCamera` 下，禁止任意路径。
7. 端点类配置只从 HKLM / 签名策略读取，`FeedBackUrl` 做白名单。

### P2

8. 停止系统级 ffdshow / ffmpeg 注册，改私有解码；清理 K-Lite、`Vmr9Test`、`CrashRpt`、`null` 等残留。
9. 无线展台协议加配对与指令签名，媒体帧严格校验长度 / 格式后再进原生解析。
10. 日志脱敏（路径、IP、协议原文），泄漏密钥全部轮换。

## 9. 没搞清楚的部分

- 更新包内部是否还有独立的签名 / 哈希校验（`Updater.exe` / `LibEasiUpdate.dll` 为原生 + 托管混合，需要动态跟踪下载落盘点）。
- 相机侧固件升级的校验流程（`CanUpdate` / `CurrentFirmwareState` / `DownloadProgress`）与 HID / MCU 指令的设备端实现。
- 希沃白板侧 `127.0.0.1:3123` 服务的处理逻辑（不在本次范围内），它决定 5.2 转发链的最终危害上限。
- `libda_cropper.dll` / `libtensorflowlite` 的输入边界（需要针对具体 C++ 符号做崩溃复现）。
- Remoting 管道的实际 DACL（未直接读取，结论基于 .NET Framework 默认行为）。

## 10. 附录：证据与产物

### 10.1 关键哈希

| 文件 | SHA-256 |
|---|---|
| `EasiCamera.exe` | `96124645801171b8bfdeecf29c5836b36d25f02bb622cf5b5b893c6235d97695` |
| `EasiCamera.Api.dll` | `0c47f8a0c577f982dd7b60eaa48534130b8015cacb2228555b6e6768a13d93ae` |
| `EasiCamera.Communication.dll` | `6eb7f557d3e27345ca37a42c1303879320045ef79ec43e5ce1259ed03ec1db12` |
| `EasiCamera.Server.Protocol.dll` | `9922fe3b4d763beea49dccc267705b551768fffd9f3ec23368373067df88999f` |
| `Cvte.Pipe.dll` | `f2f1d20336f85208a1b90c8878fdf655e0eccba22d7897d9b70db0dd7311ced2` |

### 10.2 取证记录（REA Evidence）

- 主程序托管身份（CLI 头 / 元数据 / MVID）
- PE 资源与内嵌清单（`asInvoker`）
- `EasiCamera.Server.Protocol` 成员与字面量
- `EasiCamera.Communication` 成员与字面量
- `EasiCamera.Api` 成员与字面量
- `Cvte.Pipe.Protocol`（帧格式与解析器）
- `Cvte.Pipe`（`IPAddress.Any` 监听）

### 10.3 反编译工作区

`<工作目录>\ec-src\`，包含 `EasiCamera.Server.Protocol`、`EasiCamera.Communication`、`EasiCamera.Business`、`EasiCamera.Api`、`EasiCameraGuardian`、`Cvte.Net`、`Cvte.Pipe*`、`dotnetCampus.Ipc`。

### 10.4 可复现的观测点

```powershell
# 1) 端口与注册表
Get-ItemProperty HKCU:\SOFTWARE\Seewo\EasiCamera -Name ServerPort

# 2) Remoting 端点（守护进程运行时可见）
Get-ChildItem \\.\pipe\ | Where-Object Name -match '<Remoting管道GUID>|<守护管道GUID>'

# 3) 安装目录权限（应为 Users 只读）
(Get-Acl "C:\Program Files (x86)\Seewo\EasiCamera\EasiCamera_2.1.0.4410\Main").Access |
  Where-Object IdentityReference -match 'Users'
```

## 收尾

这套软件的"骨架"值得学习：模块化、协议分层、扩展点、进程外算法、云端资源都能讲清楚；但它的"门锁"几乎是空的——**进程级 TLS 放行、无认证总线、固定名字的 Remoting、下载即执行**，每一条单看都能解释成"内网、同机、可信"，叠在一起就构成了从同一 Wi-Fi 到教师机代码执行的完整路径。

::: important 加固重点
重点不在功能，而在**把"默认信任"换成"显式信任"**：能只监听回环就别监听 0.0.0.0，能给管道设 SID 就别用 Everyone，能校验签名就别"下载即执行"。
:::

::: warning 声明
本文为民间技术整理，所有分析均针对本机已安装副本的静态与被动观测，未向外部目标发包，也未对运行中的实例执行文中示意代码。文中密钥、GUID、设备标识与私有路径均已占位符化，仅供研究与自查参考。
:::

本文为民间技术整理，仅供参考。
