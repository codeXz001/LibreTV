const CUSTOMER_SITES = {
    qiqi: {
        api: 'https://www.qiqidys.com/api.php/provide/vod',
        name: '七七资源（CF Worker 访问受限，建议作为备选）',
    },
    maota: {
        api: 'https://caiji.maotaa.com/api.php/provide/vod',
        name: '茅台资源',
    },
    bfzy: {
        api: 'https://bfzy.tv/api.php/provide/vod',
        name: '暴风资源（CF Worker 直连超时，可能需要 VPN）',
    },
};

// 调用全局方法合并
if (window.extendAPISites) {
    window.extendAPISites(CUSTOMER_SITES);
} else {
    console.error("错误：请先加载 config.js！");
}
