/**
 * @see https://theme-plume.vuejs.press/config/navigation/ 查看文档了解配置详情
 *
 * Navbar 配置文件，它在 `.vuepress/plume.config.ts` 中被导入。
 */

import { defineNavbarConfig } from 'vuepress-theme-plume'

export default defineNavbarConfig([
  { text: '首页', link: '/' },
  { text: '希沃管家', link: '/seewo-manager/' },
  { text: '希沃集控', link: '/seewo-control/' },
  { text: '希沃软件', link: '/seewo-software/' },
  { text: '指南', link: '/guide/' },
])
