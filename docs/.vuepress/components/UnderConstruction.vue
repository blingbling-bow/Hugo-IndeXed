<template>
  <div class="under-construction-notify">
    <svg class="under-construction-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M12 38 22 12h4l10 26" stroke="currentColor" stroke-width="3" stroke-linejoin="round" />
      <path d="M17 29h14" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
      <path d="M6 38h36" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
    <p class="under-construction-notify-title">此页面正在施工中</p>
    <p class="under-construction-notify-desc">
      <slot name="description" />
    </p>
  </div>
</template>

<style scoped>
.under-construction-notify {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin-top: 1rem;
  opacity: 0.75;
}

.under-construction-notify .under-construction-icon {
  width: 3rem;
  height: 3rem;
  margin-bottom: 0.5rem;
}

.under-construction-notify .under-construction-notify-title {
  font-size: x-large;
  font-weight: 400;
}

.under-construction-notify .under-construction-notify-desc {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  text-align: center;
  opacity: 0.8;
}
</style>
