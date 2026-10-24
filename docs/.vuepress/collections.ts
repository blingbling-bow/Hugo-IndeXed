/**
 * @see https://theme-plume.vuejs.press/guide/collection/ 查看文档了解配置详情。
 *
 * Collections 配置文件，它在 `.vuepress/plume.config.ts` 中被导入。
 *
 * 请注意，你应该先在这里配置好 Collections，然后再启动 vuepress，主题会在启动 vuepress 时，
 * 读取这里配置的 Collections，然后在与 Collection 相关的 Markdown 文件中，自动生成 permalink。
 *
 * collection 的 type 为 `doc` 时，表示为文档类型（即有侧边导航栏），
 * 可用于实现如 笔记、知识库、文档等以侧边导航栏形式的文档集合。
 */

import { defineCollection, defineCollections } from 'vuepress-theme-plume'

const guide = defineCollection({
  type: 'doc',
  dir: 'guide',
  linkPrefix: '/guide',
  title: '指南',
  sidebar: 'auto',
})

const seewoManager = defineCollection({
  type: 'doc',
  dir: 'seewo-manager',
  linkPrefix: '/seewo-manager',
  title: '希沃管家',
  sidebar: 'auto',
})

const seewoControl = defineCollection({
  type: 'doc',
  dir: 'seewo-control',
  linkPrefix: '/seewo-control',
  title: '希沃集控',
  sidebar: 'auto',
})

const seewoSoftware = defineCollection({
  type: 'doc',
  dir: 'seewo-software',
  linkPrefix: '/seewo-software',
  title: '希沃软件',
  sidebar: 'auto',
})

export default defineCollections([
  guide,
  seewoManager,
  seewoControl,
  seewoSoftware,
])
