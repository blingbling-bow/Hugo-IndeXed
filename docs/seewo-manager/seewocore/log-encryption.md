---
title: 日志加密与解密
createTime: 2026/10/25 10:00:00
permalink: /seewo-manager/seewocore/log-encryption/
---

# 日志加密与解密

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>30 分钟</template>
  <template #difficulty>困难</template>
</DocProp>

本文整理 SeewoCore 日志的加密链路与解密工具：`FNTS` 容器格式、ECDH + HKDF + AES-128-CTR 的密钥派生、运行时密钥提取方法，以及发布包与 UAC 实测记录。

::: tip 范围说明
本文只负责"日志加密链路与解密工具"。整体运行原理见[架构与运行原理](/seewo-manager/seewocore/architecture/)，上报数据与指令见[数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/)。
:::

分析对象为 `SeewoCore.exe`，厂商为广州视睿电子（Guangzhou Shirui Electronics）。文中所有密钥、IV、公钥坐标与设备标识均已替换为占位符。

## 0. TL;DR

| 问题 | 答案 |
|---|---|
| 日志加密有开关吗？ | **没有**。`log.*` 全部配置键中无加密项，加密无条件编译进日志沉槽 |
| 什么算法？ | **AES-128-CTR**，密钥来自 `ECDH(P-256)` → `HKDF(salt=info="slp")` → 16 字节 |
| 密文是什么的加密？ | **zlib deflate 之后的日志文本**（不是先加密再压缩） |
| 能解吗？ | **能**。运行时从内存取回每文件 16 字节密钥，离线 AES-128-CTR 解开 + inflate |
| 已归档的旧日志？ | 密钥随 envelope 对象销毁，**不可恢复**；但**当前正在写的文件**可以完整解出（含挂载之前的历史） |
| 需要改二进制吗？ | **不需要**。只读内存 + 离线解密，服务零改动 |

实测样本：179,725 字节密文 → 1,301,656 字节明文 / 23,886 行（压缩比约 7.24）。

## 1. 分析对象

| 项 | 值 |
|---|---|
| 文件 | `SeewoCore.exe` |
| 大小 | 2,275,168 字节 |
| SHA-256 | `7a2f8baf…6cf20d6` |
| 格式 | PE32 **i386**（`machine 0x014c`），**非 .NET**（`cli: null`） |
| ImageBase | `0x400000` |
| 段 | `.text` 0x401000 / `.rdata` 0x553000 / `.data` 0x5fd000 / `.rsrc` 0x617000 / `.reloc` 0x61c000 |
| 服务 | `SeewoCoreService`，SYSTEM，加载基址每次不同（实测见过 `0x6b0000` 等） |
| 版本 | 产品 `1.6.7.4018`，SeewoCore `1.6.5.1726.c1bf0e7` |

**运行期地址换算**：`runtime = module.base + (static_va - 0x400000)`

### 1.1 静态依赖

| 组件 | 证据 |
|---|---|
| spdlog | 等级名表 `trace/debug/info/warning/error/critical/off` @ `0x590c90`、`0x590d10` |
| zlib **1.2.11** | 字符串 `"1.2.11"` @ `0x590d0c`，被 `deflateInit_` @ `0x4d9be0` 引用；`__crc32` 表 |
| Crypto++（静态链接） | `StreamTransformation: ... random access` @ `0x58e2c8`、`HKDF: derivedLen ...` @ `0x5918f8`、`CryptoMaterial: ...` @ `0x590e74`、`GeneratableCryptoMaterial: ...` @ `0x590ee8` |
| 类名混淆 | 6 个随机串类名混在真实 Crypto++ 名之间 @ `0x600bf0` |

## 2. 日志文件格式

路径：`C:\ProgramData\Seewo\SeewoCore\log\SeewoCore-*.log`，20/20 文件逐项验证通过。

### 2.1 容器 FNTS

大端 TLV，`total = 5 + Σ(len + 6)`。序列化器位于 `0x4d9cb0`：

```asm
004d9cf9  ba 05000000              mov edx, 5                 ; total = 5
004d9d15  8b41 08 / 2b41 04        mov eax,[ecx+8] - [ecx+4]  ; entry len = end - begin
004d9d1b  83c0 06 / 03d0           add eax,6 ; add edx,eax   ; total += len+6
004d9d65  bf c80c5900              mov edi, 0x590cc8          ; "FNTS"
004d9d92  47 81ff cc0c5900        inc edi / cmp edi,0x590ccc ; 逐字节追加 4 字节 magic
004d9da0  c1f9 04                  sar ecx,4                  ; count = bytes/16
004d9da3  884d0c                   mov [ebp+0xc], cl          ; count 写成一个字节
```

每个 entry 结构占 16 字节：`{u16 type; u16 pad; u8* begin; u8* end; u8* cap}`。

### 2.2 头部（109 字节）

```text
FNTS  02
  ├─ entry type=2  len=2   →  01 44                                   常量标记
  └─ entry type=1  len=90  →  ECIES 信封
```

`type=1` 的 90 字节精确布局：

| 偏移 | 长度 | 值（实例） | 含义 | 来源代码 |
|---:|---:|---|---|---|
| 0 | 1 | `01` | version | `0x4dac17 mov byte [ebp-0xa8], 1` |
| 1 | 1 | `e4` | mode（`0x95` = arg1:1，`0x3c` = arg1:2，`0xe4` = 其他） | `0x4dac30 / 0x4dac34 / 0x4dac38` |
| 2 | 1 | `ce` | flagA（`impl+0x24==1` 时 `0xce`，否则 `0x71`） | `0x4dac7a cmp / cmove` |
| 3 | 1 | `b6` | 编码方向（`impl+0x28!=0` 时 `0xb6`，否则 `0x2d`） | `0x4dacd1 cmovne` |
| 4 | 1 | `02` | cipher selector（= `enc()` 的 arg2） | `0x4dad74 mov dl,[ecx+0x2c]` |
| 5–8 | 4 | `00 00 00 41` | BE u32 = **65** = EC 点编码长度 | — |
| 9 | 1 | `04` | 未压缩 EC 点标记 | — |
| 10–73 | 64 | `<公钥X‖Y>` | **P-256 公钥 X‖Y，大端** | — |
| 74–89 | 16 | `<IV>` | **IV** | `0x4da3ec` / `0x4dabf0` |
| | **90** | | `1+1+1+1+1+4+1+64+16 = 90` | |

::: note 为什么搜不到常量
那 10 字节常量之所以在整个二进制里搜不到连续立即数 `e4 ce b6 02`，是因为它们由**逐字节 `mov` / `cmove` 拼出来**。
:::

### 2.3 主体

109 字节之后是**一整条连续密文流**，没有任何分帧：

```text
FNTS 出现次数           : 每个文件恰好 1 次（都在 offset 0）
body 熵                 : 7.9989 bits/byte
body 字节直方图         : min 617 / max 800 / mean 687.81  ← 与均匀分布期望值完全相等
16 字节全零块（对齐）   : 0
```

熵接近 8 且直方图与均匀分布一致，说明主体是真加密而非压缩数据。

## 3. 加密链路（代码级）

### 3.1 写入路径

`0x4d9f10`（FNTS vtable slot `+0x10`，反编译）：

```c
void FUN_004d9f10(int plaintext_ptr, int len, int sink)
{
  impl->total += len;
  strm->next_in  = plaintext_ptr;          /* 明文直接进 deflate，此函数内无加密 */
  strm->avail_in = len;
  flush = need_flush ? 2 : 0;              /* Z_SYNC_FLUSH */
  do {
    strm->next_out  = impl->next_out;
    strm->avail_out = impl->avail_out;
    rc = deflate(strm, flush);             /* 0x4e5920 */
    produced = impl->avail_out - strm->avail_out;
    if (produced) (*(sink->[0x24]->vtable[8]))(&out_ptr, &out_len);   /* 交给回调 */
  } while ((rc != 0 && rc != -5) || strm->avail_in != 0);
}
```

回调 `sink+0x24` 指向自身（自引用），vtable 为 `0x590e20`，slot `+8` = `0x4dc510`——一个 36 字节转发 thunk：

```c
void FUN_004dc510(void** p1, void** p2)          /* (&buf, &len) */
{
  (*(code**)(this+4))( *p1, *p2, this->[0x10], this->[0xc], *(this->[8]) );
}
```

运行时实测：`worker = 0x78d060` → 静态 `0x4dd060`（通用跳板）：

```text
push [ebp+0x18]; mov ecx,[ebp+0x14]; push [ebp+0xc]; push [ebp+8]; call [ebp+0x10]
```

其中 `[ebp+0x10] = 0x78c143` → 静态 **`0x4dc143`**，即真正的加密调用点（位于 `0x4dc110` 函数体内）。

### 3.2 密钥派生

`0x4da840(impl)`（506 字节）：

```c
FUN_004e1600(local_4c, impl->[0x2c], cookie);      /* 构造上下文 */
FUN_004e23c0(local_48);                            /* 构造器 */
uVar2 = FUN_0049b600();                            /* 取 RNG */
FUN_004e0750(local_54, uVar2, impl+0x30);          /* >>> ECDH Agree(out, rng, 对端公钥) */
if (local_50 == 0) throw "ECC shared secret agreement failed";
FUN_004e1ff0(local_2c, 0x10, "slp", 3, "slp", 3);  /* >>> HKDF：输出 16 字节，salt/info = "slp" */
memcpy(impl->[0xc], local_2c, local_1c);           /* 密钥存入 impl+0x0c */
impl->[4] = 0xffffffff;
FUN_004e3f80(); FUN_004e4430(local_44); FUN_0040b530(uVar2);
```

`"slp"` 是 NUL 结尾字符串 @ `0x590da0`，紧跟 `"ECC shared secret agreement failed"` @ `0x590da4`。

### 3.3 envelope 数据结构（32 位）

| 偏移 | 类型 | 含义 |
|---:|---|---|
| `+0x08` | u32 | keyLen（=16） |
| `+0x0c` | u8* | **keyPtr** |
| `+0x18` | u32 | ivLen（=16） |
| `+0x1c` | u8* | **ivPtr** |
| `+0x20` | u32 | modeArg（决定头部字节 1） |
| `+0x24` | u32 | flagA（=1，决定头部字节 2） |
| `+0x28` | u8 | 编码方向（=1，决定头部字节 3） |
| `+0x2c` | u32 | cipherSel（=2，写进头部字节 4） |
| `+0x30` | — | 对端公钥对象（Crypto++） |
| `+0x38` | std::string | raw 公钥字节（MSVC SSO：`+0x10` = size，`+0x14` = cap，cap < 16 用内联缓冲） |
| `+0x48` | u32 | extraLen |

### 3.4 头部组装 `0x4dab60`

```asm
004dabac  cmp byte [eax+0x28], 0        ; 需要生成 IV 时
004dabb8  call 0x514880                 ; RNG 构造
004dabbd  push 0x20 / call 0x513a80     ; 生成 32 字节随机
004dabf0  push [eax+0x1c] / push [eax+0x18] / call 0x4f7450   ; IV(ptr,16)
004dad48  mov edx,[ecx+0x48] / add edx,5 ; 内层长度
004dadc1  add eax,0x38 / call 0x4daa40   ; 追加公钥 std::string
```

### 3.5 链路总览

```text
日志文本
  └─ 0x4d9f10  strm->next_in = 明文
       └─ 0x4e5920  deflate(strm, Z_SYNC_FLUSH)      zlib 1.2.11
            └─ sink->[0x24]->vtable[8] = 0x4dc510 → 0x4dd060 → 0x4dc143
                 └─ AES-128-CTR（key = HKDF(ECDH), iv = 头部 16 字节）
                      └─ fwrite → WriteFile  →  FNTS 头之后追加
```

## 4. 加密模式确认

拿到 key 与 IV 后对 body 做整条流解密，首部立刻出现合法 zlib 结构：

```text
78 9c          zlib 头
00 00 00 ff ff Z_SYNC_FLUSH 空存储块
8a ...         BFINAL=0 BTYPE=01（固长 Huffman）
```

| 模式 | 首块 | 整体 |
|---|---|---|
| `aes-128-ctr` | `78 9c` 匹配 | **inflate 成功** |
| `aes-128-cfb` / `aes-128-ofb` | `78 9c`（首块 keystream 同为 `AES(IV)`） | inflate 失败 |
| `aes-128-cbc` / `-ecb` / `sm4-*` | 不匹配 | 失败 |

::: warning 一个容易误判的细节
`inflateSync` 默认 `finishFlush=Z_FINISH`，对**正在写入**的日志必然抛出 "unexpected end of file"。必须使用 `{ finishFlush: zlib.constants.Z_SYNC_FLUSH }` 才能容忍被截断的尾部。这是最初误判"解密失败"的原因。
:::

## 5. 密钥恢复

### 5.1 思路

密钥只存在于 envelope 对象中，而 envelope 随日志文件打开而创建、随文件关闭而销毁。文件头里存了 IV 的**明文字节**，而 `impl+0x1c` 指向同一段 IV 缓冲，于是一路可以反查：

```text
文件头 IV(16B)
  → 在进程内存里搜这 16 字节           → 得到 IV 缓冲地址 A
  → 搜任何 dword == A                  → 命中处即 impl+0x1c
  → impl = 命中地址 - 0x1c
  → 校验 impl+0x18 == 16 且 impl+0x1c→A 且 impl+0x08 ≤ 64
  → key = [impl+0x0c] 的 keyLen 字节
```

### 5.2 实测结果

以下为一次运行的内存猎取输出，密钥与 IV 已替换为占位符：

```text
[hunt] IV pattern hits = 6
  addrs: 0x117acd0 0x117b65a 0x117b792 0x117d1cd 0x1186d38 0x1193a0d

[hunt_impl] addr=0x117ce28  modeArg=0  flagA=1  encFlag=1  cipherSel=2
  keyLen=16  key = <密钥>
  ivLen=16   iv  = <IV>                                ← 与文件头逐字节一致
  pubkey = 04 || <公钥X‖Y>                             ← 65 字节，独立印证头部格式

[write] sink=0x1f441f8  cb=0x1f441f8  vtable=0x840e20
  worker=0x78d060  cb+8=0x117d154  cb+c=0x1f3ef2c  cb+10=0x78c143
```

侧证：内存里存的是 `04 || X || Y`（65 字节），而文件头存 `00 00 00 41 || 04 || X || Y`——长度前缀 + 标记 + 同一对坐标，完全自洽。

### 5.3 解密结果

```text
日志: SeewoCore-.log
密文 body : 179,725 字节
明文      : 1,301,656 字节 / 23,886 行        （约 7.24 : 1）

[26-10-17 22:18:33.837][info][application.cpp:1368-Zeus::Application::LogBasicInfo][2276]Launcher Service SeewoCore
[26-10-17 22:18:33.837][info][application.cpp:1369-Zeus::Application::LogBasicInfo][2276]Version [1.6.7.4018-1.6.5.1726]
[26-10-17 22:18:33.837][info][application.cpp:1372-Zeus::Application::LogBasicInfo][2276]Launcher WorkDir [C:\Windows\system32]
...
[26-10-17 23:59:44.543][info][iot_mqtt_impl.cpp:665-IoTMqttImpl::PublishTopic][14652][E5461C07…] PublishMessage success | send topic:/sys/{pk}/{dn}/rpc/response/{uuid}
```

首行时间戳 `22:18:33` 是该文件创建时刻，早于挂载时刻（约 23:36）。**即当前打开文件的全部历史内容都可解**，不只是挂载之后的部分。

## 6. 工具与用法

工具体系分两层：**发布包**（面向最终使用者，自带运行时）与**工作目录脚本**（逆向 / 诊断用）。

### 6.1 发布包

| 文件 | 作用 |
|---|---|
| `<工作目录>\希沃日志解密器\解密日志.cmd` | 双击启动（普通权限） |
| `<工作目录>\希沃日志解密器\管理员运行.cmd` | 同上，自动请求 UAC 提权（实测见第 13 节） |
| `…\app\seewo_decrypt_cli.js` | **主力程序**：轮询 → 取密钥 → 解密 → 交互命令（`stop/status/files/keys/help`） |
| `…\app\frida_log_key_agent.js` | 注入 agent：`0x4da840` / `0x4e1ff0` 钩子 + `rpc.exports.hunt(iv)` |
| `…\runtime\node.exe` | 自带 Node.js（24.20.0），使用者不必安装环境 |
| `…\使用说明.txt` / `实现原理.md` | 面向使用者的说明与原理 |
| `…\app\keys.json` | 运行时生成：IV 到 key 的缓存（**发布包中不含**） |

::: warning 关于 keys.json
`keys.json` 保存的是**可解密的真实密钥**。如果它存在于工作目录中，请勿外传、勿提交到版本库，也不要在截图或日志中展示其内容。
:::

### 6.2 工作目录脚本

| 文件 | 作用 |
|---|---|
| `seewo_decrypt_cli.js` | 发布版主程序的源码副本（同上） |
| `seewo_log_dump.js` | 早期**一键工具**：取密钥 → 解密当前日志 → 写明文 |
| `seewo_log_watch.js` | 常驻监视器：自动抓新文件密钥并持续刷新明文（见第 12 节） |
| `seewo_hook_kit.js` + `run_hook_kit.js` | 通用行为改写脚手架：按字符串 / 导出 / VA 挂钩，观察、固定返回值、改字节（文档未收录） |
| `seewo_record_cli.js` / `seewo_record_server.js` / `seewo_record.html` | 函数调用事件采集（CLI + 网页版） |
| `test_hookkit_offline.js` | 不依赖 Frida 的离线自检 |
| `frida_log_key_agent.js` / `frida_extract_log_key.js` | 取密钥 agent（前者常驻、后者单次猎取） |
| `run_key_capture.js` | 只取密钥的独立运行器 |
| `try_log_decrypt.js` / `try_blocked_decrypt.js` | 模式识别诊断；分块重置假设的暴力验证（结论：不成立） |
| `run_watch.cmd` / `run_watch_hidden.vbs` / `解密日志.cmd` / `开始采集.cmd` | 启动包装 |

### 6.3 一键解密

```powershell
$env:SEEWO_PID = (Get-Process SeewoCore).Id
node <工作目录>\seewo_log_dump.js
```

输出：`decrypted\SeewoCore-.log.<key前8位>.log`

参数：`node seewo_log_dump.js <日志文件路径>` 可指定文件；`SEEWO_PID` 用于 SYSTEM 进程（Frida 的进程名枚举看不到服务名，必须显式给出 PID 或使用管理员上下文）。

### 6.4 依赖

- Node.js（使用内置 `crypto` 的 `aes-128-ctr` 与 `zlib`）
- `frida` Node 绑定：`C:\Users\<账号>\AppData\Roaming\npm\node_modules\rea-agents\node_modules\frida`
- 服务处于运行状态（密钥只在文件打开期间存在）

## 7. 实验时间线

| 阶段 | 手段 | 结论 |
|---|---|---|
| 1 | 文件格式识别 | `FNTS` 容器，`total = 5 + Σ(len+6)`；头部 109 字节 |
| 2 | 熵 / 直方图 | body 熵 7.9989，直方图与均匀分布完全相同，说明是真加密而非压缩 |
| 3 | 反编译 `0x4d9f10` | 只做 deflate + 回调，**加密不在内层** |
| 4 | 反编译 `0x4d9cb0` | 序列化器逐字节写 `FNTS` 与单字节 count |
| 5 | 疑似常量搜索 | `e4 ce b6 02` 全文件 **0 命中**，说明是运行时拼出的 |
| 6 | `.rdata` 类区扫描 | FNTS vtable `0x590cf0`；邻居是 `"slp"` / `"ECC shared secret agreement failed"` / Crypto++ 类描述符 |
| 7 | 字符串 + 立即数 xref | 定位 `0x4daa20`（ECDH 报错）、`0x4e1fb3`（HKDF）、`0x4f84a3`（IV length）等锚点 |
| 8 | 反编译 `0x4da840` | `ECDH Agree` → `HKDF(16B, salt/info="slp")` → 密钥存 `impl+0x0c` |
| 9 | 反汇编 `0x4dab60` | 头部逐字节组装；`00 00 00 41` + `04` = 65 字节未压缩点 |
| 10 | 曲线方程验证 | 头部 80 字节按 `X‖Y` 大端解释，**20/20 都是合法 P-256 点**（其他布局全部失败） |
| 11 | 密钥材料普查 | 二进制 / 注册表 / `ProgramData` 中 P-256 点数量均为 **0**，说明无私钥材料 |
| 12 | Frida 内存猎取 | 由文件头 IV 反查 envelope impl，取回 16 字节密钥 |
| 13 | 离线解密 | AES-128-CTR → inflate → 1,301,656 字节明文 |

### 7.1 关键地址表

| 地址 | 符号 / 作用 |
|---|---|
| `0x4d9f10` | FNTS write：deflate + 回调（vtable `0x590cf0` slot +0x10） |
| `0x4d9cb0` | FNTS 序列化器 |
| `0x4d9580` | entry 追加器 |
| `0x4d9a20` | 头部常量 `01 44` 的静态单例初始化 |
| `0x4da340` | envelope 编码器入口（vtable `0x590d54`） |
| `0x4da800` | envelope 构造器 |
| `0x4da840` | ECDH + HKDF，密钥写入 `impl+0x0c` |
| `0x4dab60` | 头部逐字节组装 + 生成 IV + 追加公钥 |
| `0x4dc143` | **实际加密调用点**（位于 `0x4dc110`） |
| `0x4dc510` | 转发 thunk（vtable `0x590e20` slot +8） |
| `0x4dd060` | 通用跳板 |
| `0x4e0750` | ECDH Agree |
| `0x4e1ff0` | HKDF 派生（16 字节） |
| `0x4e5920` | zlib `deflate(strm, flush)` |
| `0x4e3790` | 解析 raw ECC 公钥 |
| `0x590cc8` | `"FNTS"` |
| `0x590cf0` | FNTS vtable |
| `0x590d54` | envelope vtable |
| `0x590da0` | `"slp"` |
| `0x590da4` | `"ECC shared secret agreement failed"` |
| `0x590e20` | binder vtable |

## 8. 走过的弯路与修正

诚实记录，避免后来者重踩：

1. **错误结论：`6f dd 59 65` 处 `BTYPE=0b11` 证明是密文。**
   这是无效论证——从任意中间偏移解 deflate 本来就可能得到 `BTYPE=3`。已改用"密文与明文无重叠 + 文件中 Z_SYNC_FLUSH 标记计数为 0"替换。
2. **错误结论：`00 01 00 00 00 5a` 与 `00 02 00 00 00 02` 是头部模板常量。**
   属于假阳性：前者落在 RTTI / 异常表（周围全是 `ff ff ff ff` 与代码指针），后者落在 `00 01/00 01/…/00 05/00 05` 递增常量表。
3. **错误结论：`inflateSync` 失败说明解密模式不对。**
   真因是默认 `finishFlush=Z_FINISH` 不容忍截断。改用 `Z_SYNC_FLUSH` 后一次成功。
4. **一度认为"已存在的日志全部不可恢复"。**
   需要精确化：**已关闭文件**的密钥随 envelope 销毁，不可恢复；**当前打开的文件**密钥仍在内存，连同其创建以来的全部历史都可解。
5. **`toMatchPattern()` 在 Frida 中不存在。**
   改为按数值手工拆成 4 个 LE 字节构造 `Memory.scan` 的 pattern。
6. **Frida `enumerateProcesses()` 看不到 SYSTEM 服务名。**
   必须显式传入 PID。

## 9. 局限与未解

| 项 | 状态 |
|---|---|
| 已关闭 / 已轮转的日志 | **不可解**。每文件独立 ECDH，密钥不落盘，envelope 销毁后无迹可寻 |
| 多文件同时打开时 | 本工具按 IV 精确匹配单个 impl；理论上可扩展为"扫描所有 envelope 结构"以一次取出多个文件密钥（未实现） |
| 对端公钥来源 | `enc()` 的 arg3 以 `std::string` 传入（`0x4e3790` 解析）。二进制 / 注册表 / `ProgramData` 内均无静态 EC 点，说明**来自运行时（服务端）**，其私钥不在本机 |
| `cipherSel` 语义 | 实测 `=2` 对应 AES-128-CTR；`1` 应为另一算法（未验证） |
| 头部字节 1/2/3 的语义 | 已确认由 `modeArg` / `flagA` / `encFlag` 决定取值，但命名含义未进一步考证 |
| 静态补丁方案 | 加密调用点已定位到 `0x4dc143`，但**未实施**。对 SYSTEM 服务做未验证的字节补丁有崩溃循环风险 |

## 10. 复现步骤

```powershell
# 0) 前置：Ghidra 12.1.4 + JDK 21（静态部分），Node + frida 绑定（动态部分）
$env:JAVA_HOME          = '<工具目录>\jdk-21'
$env:GHIDRA_INSTALL_DIR = '<工具目录>\ghidra_12.1.4_PUBLIC'

# 1) 观察格式（无需任何工具）
#    头部前 4 字节 = "FNTS"；offset 29..92 = X||Y；93..108 = IV

# 2) 验证公钥确实是 P-256 点
#    Y^2 mod p == (X^3 - 3X + b) mod p      p, b 见 NIST secp256r1

# 3) 取密钥并解密
$env:SEEWO_PID = (Get-Process SeewoCore).Id
node <工作目录>\seewo_log_dump.js

# 4) 结果
#    decrypted\SeewoCore-.log.<key前8位>.log
```

### 10.1 静态复核（可选）

```powershell
$rea = 'C:\Users\<账号>\AppData\Roaming\npm\node_modules\rea-agents\scripts\rea.mjs'
node $rea function "<SeewoCore.exe>" 0x4da840 --format json   # ECDH + HKDF
node $rea function "<SeewoCore.exe>" 0x4d9f10 --format json   # deflate + 回调
```

## 11. 本次采集到的实例值

```text
日志文件   SeewoCore-.log
大小       179,834 字节（body 179,725）
version    1
mode       0xe4 (228)
flagA      0xce (206)
encFlag    0xb6 (182)
cipherSel  2
point      len=65 tag=0x04

X   <公钥X>
Y   <公钥Y>
IV  <IV>
KEY <密钥>            ← 每文件唯一，随进程重启/文件轮转变化

明文 1,301,656 字节 / 23,886 行
```

## 12. 自动化：让日志持续可读

### 12.1 要解决的问题

密钥是**瞬态**的：只在某个日志文件被打开期间存在于 envelope 对象中。文件一旦轮转、服务一旦重启，旧密钥永久消失，那个文件就再也解不开。因此"手动跑一次"不够，必须在**每个文件还活着的时候**就把密钥留下。

### 12.2 三层取密钥

| 层 | 时机 | 覆盖场景 | 代价 |
|---|---|---|---|
| **hook** | `0x4e1ff0`（HKDF）返回的瞬间 | 监视器运行期间创建的**所有**新文件，零竞争 | 常驻一个 Frida 会话 |
| **hunt** | 需要时按文件头 IV 反查内存 | 监视器启动前**已经打开**的文件 | 单次全内存扫描，约 1–3 秒 |
| **cache** | 每次拿到密钥后写 `keys.json` | 已捕获过的文件，**永久**可解（进程重启也不丢） | 一个 JSON 文件 |

`keys.json` 以 **IV 到 key** 为键。IV 是文件头里明文存的（offset 93..108），所以"这个文件该用哪把钥匙"永远不需要猜。

### 12.3 组件

```text
frida_log_key_agent.js   agent：0x4da840 / 0x4e1ff0 钩子 + rpc.exports.hunt(iv)
seewo_log_watch.js       宿主：tick 扫描目录 → 配对密钥 → 解密 → 写 decrypted/
run_watch.cmd            启动器（输出到 watch.log，超过 2 MB 自动截断）
run_watch_hidden.vbs     wscript 隐藏窗口启动
```

宿主行为：

- 每 `--interval`（默认 5 秒）扫描一次 `C:\ProgramData\Seewo\SeewoCore\log`
- 只对 **mtime 最新**（即正在写）的文件做 hunt，且限速 15 秒一次，避免与 agent 抢 CPU
- 文件大小没变就跳过，不重复解密
- 服务重启导致会话断开时自动重连，并**重新解析 PID**（PID 会变，环境变量中的旧值不可信）
- `watch.pid` 单实例锁：开机自启与手动双击不会启动两份

### 12.4 实测

```text
[01:40:56] agent ready  base=0x7d0000  arch=ia32  pid=3976
[01:40:56] decrypted  SeewoCore-.log  41193 -> 274670 B  2726 lines  key=<密钥>
[01:41:01] decrypted  SeewoCore-.log  41213 -> 274853 B  2727 lines  key=<密钥>
[01:41:06] files=19 keyed=1 active=SeewoCore-.log (+41213B) refreshed=0
[01:41:16] decrypted  SeewoCore-.log  41235 -> 275036 B  2728 lines  key=<密钥>
```

- 明文落后源文件约 **5–10 秒**（约一个扫描间隔）
- 无变化时 `refreshed=0`，空转不消耗 CPU
- 日志增长时自动重解，无需干预

### 12.5 开机自启与移除

启动项：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SeewoLogWatch.lnk`
→ `wscript.exe "<工作目录>\run_watch_hidden.vbs"`（窗口样式 7，完全隐藏）

移除方式（任选）：

```powershell
# 只停自动启动
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\SeewoLogWatch.lnk"

# 再停当前进程
Stop-Process -Id (Get-Content "<工作目录>\watch.pid")
```

::: note 兼容性提醒
WSH 在测试机器上可用；若某台机器组策略禁用了 Windows Script Host，`run_watch_hidden.vbs` 会静默失败，此时改用 `run_watch.cmd` 直接放进启动项（会有一个最小化的控制台窗口）。
:::

### 12.6 当前状态

| 文件 | 状态 |
|---|---|
| `SeewoCore-.log`（活跃） | 持续解密中，输出到 `decrypted\SeewoCore-.log` |
| `SeewoCore-20261017-10.log`（179,834 B） | 轮转前的旧文件；密钥已随进程重启消失，早前抓到的明文是**唯一可读副本** |
| 其余 17 个历史文件 | 无密钥，**不可解** |

## 13. 发布版实测记录

上一版留下的唯一未验证点是"`管理员运行.cmd` 的 UAC 路径没能实测"。本节把它补完，并顺带纠正一条旧结论。测试时间为 2026-10-24 23:18–23:30。

### 13.1 环境

| 项 | 值 |
|---|---|
| 账户 / 完整性 | `<主机名>\<账号>`，**Medium**（Administrators 为 deny-only，令牌已过滤） |
| UAC | `EnableLUA=1`，`ConsentPromptBehaviorAdmin=0`（静默提权，不弹窗），`PromptOnSecureDesktop=0` |
| 目标进程 | `SeewoCoreService` → `SeewoCore.exe`，**Session 0**，服务账户 **LocalSystem** |
| 内置运行时 | `runtime\node.exe` = **v24.20.0** |

### 13.2 测试一：不提权直接运行

用发布包自带的 node 直接运行 `seewo_decrypt_cli.js`（stdin 关闭，进入单轮自检模式）：

```text
正在连接 SeewoCore…
反查拿到密钥 (hunt)  iv=<IV>  key=<密钥>
解密 SeewoCore-.log  79.9KB -> 480.5KB  7903 行  key=<密钥前8位>
密钥来源  已连接 pid=<PID> base=<模块基址>
```

**结论：在 Medium 完整性下也能附加到 LocalSystem / 会话 0 的进程并读到密钥。**

这推翻了 `实现原理.md` 中"服务身份必须提权"的表述。机制未解（可能该进程的 DACL 较宽松，或 frida helper 走通了），但观测事实明确：**先试普通启动，失败再提权**，这是正确顺序。

::: tip 一个实用技巧
`... < NUL` 让 stdin 立刻 EOF，CLI 在 ready 后会走 `finish('输入结束')`，于是**只解一轮就退出**，适合无人值守自检。
:::

### 13.3 测试二：自提权链路（含中文路径）

用一个**与 `管理员运行.cmd` 同构**的探针（同样以 `net session` 判定 + 同样使用 `powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"`），放在含中文的目录 `<工作目录>\…\中文测试目录\uplift.cmd` 下运行：

```text
==== instance start ====
f0=<工作目录>\…\中文测试目录\uplift.cmd
phase=non-elevated errlv=2           ← net session 非 0，判定未提权
phase=relaunch-sent                  ← 已发出提权重启
==== instance start ====
Mandatory Label\High Mandatory Level S-1-16-12288   ← 高完整性，提权成功
phase=elevated-reached-run           ← 提权实例真的进入业务分支
```

**结论：自提权重启链路可用，且路径含中文不影响。**

### 13.4 测试三：真实 `管理员运行.cmd` 端到端

直接启动 `希沃日志解密器\管理员运行.cmd`（非提权），等它自行提权并跑完一轮：

| 检查点 | 结果 |
|---|---|
| 提权窗口标题 | `<账号>:  Seewo Log Decryptor (Admin)` 符合 |
| `app\keys.json` | 已写入，含 1 条 IV 到 key 记录 |
| `decrypted\SeewoCore-.log` | **516,730 字节 / 8,652 行** 符合 |
| 明文首行 | `[26-10-24 23:04:58.791][info][application.cpp:1368-Zeus::Application::LogBasicInfo][5968]Launcher Service SeewoCore` 符合 |

明文内容与 5.3 节一致（`Launcher WorkDir [C:\Windows\system32]`、`Launcher Arguments [/winService]`、`Load DynamicSystem [sentry_zsystem:…]`），说明**这是真实的希沃日志，不是缓存或测试残留**。

跑完后已用提权 `taskkill /F /T` 清掉残留进程树，并删除 `keys.json` 与 `decrypted\*`，发布包恢复为干净状态。

### 13.5 这一轮踩到的两个坑

**坑 1：`.cmd` 正文不能含非 ASCII 字符。**

cmd.exe 按 **OEM 代码页（936 / GBK）** 读取批处理文件，不认 UTF-8。第一版探针把中文路径写成字面量，提权实例立刻报乱码错误（原文为"系统找不到指定的路径。"），`cli exit=3`。

即路径被按 GBK 解成乱码，`runtime\node.exe` 找不到。`解密日志.cmd` 与 `管理员运行.cmd` 的正文是纯 ASCII（路径一律走 `%~dp0`），因此不受影响；**以后任何改动都必须保持这一点**，中文只允许出现在 `echo` 的输出里（控制台已 `chcp 65001`）。

**坑 2：提权 / 服务进程的 `CommandLine`、`Owner` 读不到。**

```text
Get-CimInstance Win32_Process -Filter 'ProcessId=<PID>'
→ Owner : (空)   CommandLine : (空)
```

因此"按命令行 grep 找残留进程"会**静默漏掉提权进程**；清理必须按**窗口标题**（`<账号>:  Seewo Log Decryptor (Admin)`）或 `Path` 定位，而且清理动作本身也必须提权，否则 `Stop-Process` 会静默失败（返回成功但进程仍在）。

### 13.6 状态更新

| 项 | 状态 |
|---|---|
| 解密工具（普通启动） | 实测可用 |
| 解密工具（UAC 提权启动） | **实测可用** |
| 中文路径 | 实测可用 |
| 启动器正文编码约束 | 已确认并记录 |
| 残留进程清理 | 需提权 + 按窗口标题 / 路径定位 |
| 发布包是否干净 | 已还原（无 `keys.json`，`decrypted\` 为空） |

::: warning 声明
本文为民间技术整理，仅供研究与自查参考。文中密钥、IV、公钥坐标与账号信息均为占位符，请勿在真实环境中外传解密产物或 `keys.json`。
:::

本文为民间技术整理，仅供参考。
