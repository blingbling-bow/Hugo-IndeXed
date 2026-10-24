import { defineClientConfig } from 'vuepress/client'
import DocProp from './components/DocProp.vue'
import SiteNavigator from './components/SiteNavigator.vue'
import UnderConstruction from './components/UnderConstruction.vue'
import '../styles/index.css'

export default defineClientConfig({
  enhance({ app }) {
    // 避免插件被重复加载时产生重复注册警告
    if (!app.component('DocProp'))
      app.component('DocProp', DocProp)
    if (!app.component('SiteNavigator'))
      app.component('SiteNavigator', SiteNavigator)
    if (!app.component('UnderConstruction'))
      app.component('UnderConstruction', UnderConstruction)
  },
})
