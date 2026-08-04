// tailwind.config.js —— 静态构建配置
// 替代 Play CDN 运行时(407KB JS + MutationObserver 动态扫描)：
// 扫描 HTML + JS 中的类名,构建为静态 CSS,首屏样式随文档解析即生效。
// 自定义类(.episode-active/.api-adult 等)在 css/*.css 中定义,不受影响。

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './player.html',
    './watch.html',
    './about.html',
    './js/**/*.js',
  ],
  // 动态拼接/运行时插入的类无法被静态扫描捕获,显式 safelist:
  // - toast 类型配色(ui.js bgColors 映射)
  // - 剧集倒序箭头(rotate-180)
  // - 自定义源文字色(textColorClass)
  // - 剧集按钮激活/非激活态(player.js 三元拼接)
  // - 有/无封面分支(app.js hasCover 三元)
  safelist: [
    'bg-red-500',
    'bg-green-500',
    'bg-blue-500',
    'bg-yellow-500',
    'rotate-180',
    'text-pink-400',
    'text-white',
    '!bg-[#222]',
    'hover:!bg-[#333]',
    'hover:!shadow-none',
    '!border',
    '!border-blue-500',
    '!border-[#333]',
    'text-center',
    'justify-center',
  ],
  theme: {
    extend: {},
  },
  corePlugins: {
    // 与 Play CDN 默认一致：保留 preflight(重置)
    preflight: true,
  },
};
