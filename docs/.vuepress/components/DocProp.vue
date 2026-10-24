<template>
  <div class="doc-props-area">
    <div class="sub-prop">
      <svg class="doc-props-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <span><span class="doc-props-desc">最后编辑 | </span><slot name="last-edit" /></span>
    </div>
    <div class="sub-prop">
      <svg class="doc-props-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" />
        <path d="M12 7.5V12l3 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <span><span class="doc-props-desc">预估时间 | </span><slot name="est-time" /></span>
    </div>
    <div class="sub-prop">
      <svg class="doc-props-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 19.5h16M7 16V9M12 16V5M17 16v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <span><span class="doc-props-desc">阅读难度 | </span><slot name="difficulty" /></span>
    </div>
  </div>
</template>

<style scoped>
.doc-props-area {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  margin-top: 0.75rem;
  margin-bottom: 0.75rem;
  opacity: 0.6;
}

.doc-props-area .sub-prop {
  display: flex;
  align-items: center;
}

.doc-props-area span {
  font-size: 14px;
}

.doc-props-icon {
  width: 16px;
  height: 16px;
  margin-right: 0.375rem;
  color: currentColor;
}

@media (max-width: 768px) {
  .doc-props-area .doc-props-desc {
    display: none;
  }
}
</style>
