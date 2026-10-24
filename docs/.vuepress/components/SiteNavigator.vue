<script setup lang="ts">
const items = [
  {
    title: '开始阅读',
    desc: '浏览希沃易 + 系列软件的技术细节与使用技巧。',
    link: '/guide/',
    external: false,
    icon: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" stroke="currentColor" stroke-width="1.8"/><path d="M8 7.5h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  },
  {
    title: 'GitHub 仓库',
    desc: '查看站点源码、提交记录与历史版本。',
    link: 'https://github.com/blingbling-bow/Hugo-IndeXed',
    external: true,
    icon: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 19c-4 1.5-4-2.5-6-3m12 6v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  },
  {
    title: '问题反馈',
    desc: '提交 Issue 或 Pull Request，补充与勘误内容。',
    link: 'https://github.com/blingbling-bow/Hugo-IndeXed/issues',
    external: true,
    icon: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12a9 9 0 1 1-4.5-7.8L21 3l-.8 4.5A8.9 8.9 0 0 1 21 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  },
]
</script>

<template>
  <div class="site-navigator">
    <a
      v-for="item in items"
      :key="item.link"
      class="site-navigator-item"
      :href="item.link"
      :target="item.external ? '_blank' : undefined"
      :rel="item.external ? 'noreferrer' : undefined"
    >
      <span class="site-navigator-icon" v-html="item.icon" />
      <span class="site-navigator-body">
        <span class="site-navigator-title">{{ item.title }}</span>
        <span class="site-navigator-desc">{{ item.desc }}</span>
      </span>
    </a>
  </div>
</template>

<style scoped>
.site-navigator {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  max-width: 1152px;
  margin: 0 auto;
}

@media (min-width: 768px) {
  .site-navigator {
    grid-template-columns: repeat(3, 1fr);
  }
}

.site-navigator-item {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 20px;
  color: var(--vp-c-text-1);
  text-decoration: none;
  background-color: var(--vp-c-bg-soft);
  border: 1px solid transparent;
  border-radius: 12px;
  transition:
    border-color 0.25s,
    background-color 0.25s;
}

.site-navigator-item:hover {
  border-color: var(--vp-c-brand-1);
}

.site-navigator-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--vp-c-brand-1);
  background-color: var(--vp-c-default-soft);
  border-radius: 8px;
}

.site-navigator-icon :deep(svg) {
  width: 20px;
  height: 20px;
}

.site-navigator-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.site-navigator-title {
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
}

.site-navigator-desc {
  font-size: 14px;
  line-height: 22px;
  color: var(--vp-c-text-2);
}
</style>
