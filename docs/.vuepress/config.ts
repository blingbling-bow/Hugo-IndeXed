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
import { getDirname, path } from 'vuepress/utils'
import { plumeTheme } from 'vuepress-theme-plume'

const __dirname = getDirname(import.meta.url)

export default defineUserConfig({
  // 站点部署在 Cloudflare Workers 的根路径
  base: '/',
  lang: 'zh-CN',
  title: 'Hugo-IndeXed',
  description: '收集各类和希沃易 + 系列软件相关的技术细节与使用技巧',

  head: [
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['link', { rel: 'icon', href: '/images/indexed.png' }],
  ],

  bundler: viteBundler(),
  shouldPrefetch: false,

  // 静态资源目录（默认是 .vuepress/public）
  public: path.resolve(__dirname, '../public'),

  plugins: [
    {
      name: 'hugo-indexed-client-config',
      clientConfigFile: path.resolve(__dirname, 'client.ts'),
    },
  ],

  theme: plumeTheme(),
})
