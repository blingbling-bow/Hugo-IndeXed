/**
 * 查看以下文档了解主题配置
 * - @see https://theme-plume.vuejs.press/config/intro/ 配置说明
 * - @see https://theme-plume.vuejs.press/config/theme/ 主题配置项
 *
 * 请注意，对此文件的修改不会重启 vuepress 服务，而是通过热更新的方式生效
 * 但同时部分配置项不支持热更新，请查看文档说明
 * 对于不支持热更新的配置项，请在 `.vuepress/config.ts` 文件中配置
 *
 * 特别的，请不要在两个配置文件中重复配置相同的项，当前文件的配置项会覆盖 `.vuepress/config.ts` 文件中的配置
 */

import { defineThemeConfig } from 'vuepress-theme-plume'
import collections from './collections'
import navbar from './navbar'

/**
 * @see https://theme-plume.vuejs.press/config/theme/
 */
export default defineThemeConfig({
  social: [
    { icon: 'github', link: 'https://github.com/blingbling-bow/Hugo-IndeXed' },
  ],

  /**
   * @see https://theme-plume.vuejs.press/config/theme/#profile
   */
  profile: {
    name: 'Hugo-IndeXed',
    description: '希沃易 + 系列软件技术档案',
  },

  navbar,
  collections,

  footer: {
    message: '基于 VuePress 与 vuepress-theme-plume 构建',
    copyright: 'Copyright © 2026-present Hugo-IndeXed',
  },

  docsRepo: 'https://github.com/blingbling-bow/Hugo-IndeXed',
  docsBranch: 'main',
  docsDir: 'docs',
})
