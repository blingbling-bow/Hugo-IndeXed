---
title: 希沃管家
createTime: 2026/10/24 23:40:00
permalink: /seewo-manager/
---

# 希沃管家

<DocProp>
  <template #last-edit>2026.10.24</template>
  <template #est-time>2 分钟</template>
  <template #difficulty>入门</template>
</DocProp>

希沃管家（SeewoService）是希沃易 + 系列的核心服务组件，负责设备管理、策略下发与远程运维。

## 内容范围

- 服务组成与后台进程的行为观察
- 策略下发与设备注册的通信流程
- 常见异常的处理思路

## SeewoCore 分析

- [SeewoCore 分析索引](/seewo-manager/seewocore/)：证据分级、核心结论与阅读路线
- [架构与运行原理](/seewo-manager/seewocore/architecture/)：进程形态、六段式启动流水线、模块划分与自保护机制
- [数据上报与指令执行](/seewo-manager/seewocore/data-and-commands/)：MQTT topic、指令生命周期、上报字段与敏感度评级
- [系统面清单与覆盖缺口](/seewo-manager/seewocore/inventory-and-gaps/)：服务与驱动栈、本地端点、落盘清单及未覆盖项
- [日志加密与解密](/seewo-manager/seewocore/log-encryption/)：`FNTS` 容器、ECDH + HKDF + AES-128-CTR 与密钥提取

## SeewoAbility 分析

- [SeewoAbility 能力分析](/seewo-manager/seewoability/)：19 个能力插件、窗口拦截闭环、本地 API 面与隐私影响

## 即将补充

<UnderConstruction>
  <template #description>
    希沃管家相关的技术细节正在整理中
  </template>
</UnderConstruction>
