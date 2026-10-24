/**
 * 查看以下文档了解主题配置
 * - @see https://theme-plume.vuejs.press/config/intro/ 配置说明
 * - @see https://theme-plume.vuejs.press/config/theme/ 主题配置项
 *
 * 请注意，对此文件的修改都会重启 vuepress 服务。
 * 部分配置项的更新没有必要重启 vuepress 服务，建议请在 `.vuepress/plume.config.ts` 文件中配置
 *
 * 特别的，请不要在两个配置文件中重复配置相同的项，当前文件的配置项会被覆盖
 */

import { viteBundler } from '@vuepress/bundler-vite'
import { defineUserConfig } from 'vuepress'
import { plumeTheme } from 'vuepress-theme-plume'

export default defineUserConfig({
  // 部署到 https://<USERNAME>.github.io/<REPO>/ 时保持与仓库名一致；
  // 若部署到独立域名或 https://<USERNAME>.github.io/，请改为 '/'
  base: '/Hugo-IndeXed/',
  lang: 'zh-CN',
  title: 'Hugo-IndeXed',
  description: '收集各类和希沃易 + 系列软件相关的技术细节与使用技巧',

  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
  ],

  bundler: viteBundler(),
  shouldPrefetch: false,

  theme: plumeTheme(),
})
