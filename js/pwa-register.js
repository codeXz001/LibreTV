// PWA 注册：尽早开始注册，不等待 window.load（图片/字体加载完成后才注册会错过首屏缓存窗口）。
if ('serviceWorker' in navigator) {
    const registerServiceWorker = () => {
        navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
            .catch(() => {});
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', registerServiceWorker, { once: true });
    } else {
        registerServiceWorker();
    }
}
