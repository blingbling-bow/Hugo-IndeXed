---
title: SeewoCore 分析
createTime: 2026/10/25 10:00:00
permalink: /seewo-manager/seewocore/
---

# SeewoCore 分析

<DocProp>
  <template #last-edit>2026.10.25</template>
  <template #est-time>4 分钟</template>
  <template #difficulty>入门</template>
</DocProp>

本分组整理希沃管家（SeewoService / SeewoCore 1.6.7.4018）的运行原理、数据上报与日志加密链路。全部结论基于**解密后的运行日志**（17 份 / 6.5 MB 明文）与二进制静态分析，属于民间逆向整理，不代表厂商公开文档。

## 一句话结论

SeewoCore 是部署在每台教室 PC 上的**远程管控执行端**：以 SYSTEM 权限常驻，配合驱动级自保护，通过一条 MQTT 长连接接收云端 `SERVICE+xxx` 指令，把屏幕、摄像头、文件、软件、会话信息按云端下发的节律持续上报。连"多久报一次"都由云端参数决定。

::: tip 证据分级
后续各页统一使用四类标注，阅读时请留意：

| 标注 | 含义 |
|---|---|
| 【观测】 | 从已解密日志或系统实测中直接读出 |
| 【静态】 | 二进制、文件清单或既有逆向结论 |
| 【推断】 | 由前两类推出，尚未直接验证 |
| 【未知】 | 现有证据无法覆盖 |
:::

## 文档索引

| 文档 | 内容 | 适合谁看 |
|---|---|---|
| [架构与运行原理](/seewo-manager/seewocore/architecture/) | 进程形态、六段式启动流水线、10 个模块、自保护五层、崩溃重启特征、观测指纹 | 想弄清"它是什么、怎么跑起来" |
| [数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/) | MQTT topic、指令生命周期六步、97 条指令分类、上报字段原文、敏感度评级 | 想弄清"它拿走了什么、谁在遥控" |
| [系统面清单与覆盖缺口](/seewo-manager/seewocore/inventory-and-gaps/) | 5 个服务、3 个驱动、40 个本地端点、落盘清单、线程模型、自修复，以及 11 个未覆盖缺口 | 想确认"还有哪里没看到" |
| [日志加密与解密](/seewo-manager/seewocore/log-encryption/) | `FNTS` 容器、ECDH + HKDF + AES-128-CTR、密钥运行时提取、发布包与 UAC 实测 | 想自己解密日志或复核加密结论 |

> 行为改写脚手架 `hook-kit.md` 未随本轮分析一并整理，故未收录；相关工具名在加密页的工具表中仍有提及。

## 核心结论摘要

1. **常驻执行端，不是普通后台服务**。主控进程以 `LocalSystem` 运行在 Session 0，无交互桌面，另有 5 个自启服务与 3 个驱动组成完整链条。
2. **策略在云端**。设备注册、指令编排、上报频率、锁屏与护眼开关均由云端下发；本地只保留临时缓存，没有数据库。
3. **能力面很宽**。日志中出现的去重指令共 97 条，覆盖屏幕展示、抓拍与窗口侦测、软件与磁盘管理、冰点还原、远程协助等。
4. **自保护五层叠加**。驱动级路径保护、启动白名单、组件清单校验、进程守护与配置自修复共同作用，单纯删文件或改配置无法关闭。
5. **日志默认加密且无开关**。每个日志文件独立进行 ECDH 协商，密钥只存在于进程内存，文件关闭即失效。

## 阅读路线建议

::: tip 推荐顺序
1. 先读[架构与运行原理](/seewo-manager/seewocore/architecture/)，建立进程、组件与通信的整体图景；
2. 再读[数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/)，看清数据字段与指令生命周期；
3. 接着读[系统面清单与覆盖缺口](/seewo-manager/seewocore/inventory-and-gaps/)，补齐服务、驱动、端点与落盘；
4. 最后读[日志加密与解密](/seewo-manager/seewocore/log-encryption/)，理解上述证据链是如何被解出来的。
:::

## 复现入口

```powershell
# 解密当前日志（希沃服务在运行的前提下）
$env:SEEWO_PID = (Get-Process SeewoCore).Id
node <工作目录>\seewo_log_dump.js
```

工具与脚本的具体用法见[日志加密与解密](/seewo-manager/seewocore/log-encryption/)。

::: warning 声明
本文档为民间技术整理，所有实测均在自有设备与自有账号环境下完成。文中已对密钥、设备标识、账号与机构信息做占位符化处理，请勿据此对他人设备进行未授权操作。
:::

本文为民间技术整理，仅供参考。
