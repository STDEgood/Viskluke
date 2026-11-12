'use strict';

/**
 * i18n.js —— 界面多语言（默认中文，英文为翻译层）
 *
 * 做法：以「中文原文」为 key，启动时把 DOM 里能精确匹配到的文本 / placeholder / title
 * 换成目标语言，并用 MutationObserver 覆盖后续动态生成的节点。
 * 好处：不侵入现有 HTML/JS（中文仍是源文案），自定义主题也能吃到翻译；
 * 代价：带变量的句子（如「已导入：xxx」）匹配不到，会保持中文——属于可接受的兜底。
 *
 * 语言存在 localStorage（viskluke.lang），设置页切换后会 reload 一次。
 */

(function () {
  const LANG_KEY = 'viskluke.lang';
  const current = (() => {
    try {
      return localStorage.getItem(LANG_KEY) || 'zh-CN';
    } catch {
      return 'zh-CN';
    }
  })();

  const EN = {
    '游戏': 'Play',
    '下载': 'Downloads',
    '服务器': 'Servers',
    '浏览器': 'Browser',
    '设置': 'Settings',
    '未登录': 'Not signed in',
    '点击登录': 'Click to sign in',
    '离线账号': 'Offline account',
    '微软正版': 'Microsoft account',
    '关闭': 'Close',
    '保存': 'Save',
    '取消': 'Cancel',
    '导入': 'Import',
    '刷新': 'Refresh',
    '清空': 'Clear',
    '删除': 'Delete',
    '复制': 'Copy',
    '打开': 'Open',
    '停止': 'Stop',
    '启动': 'Start',
    '返回': 'Back',
    '全部': 'All',
    '加载中…': 'Loading…',
    '检测中…': 'Checking…',
    '保存中…': 'Saving…',
    '导入中…': 'Importing…',

    '选择一个实例开始游戏': 'Pick an instance to start',
    '还没有实例': 'No instances yet',
    '去挑版本': 'Browse versions',
    '启动游戏': 'Launch game',
    '打开游戏目录': 'Open game folder',
    '皮肤': 'Skin',
    '删除实例': 'Delete instance',
    '版本': 'Version',
    '最大内存': 'Max memory',
    '最小内存': 'Min memory',
    'Java 路径': 'Java path',
    '自动检测': 'Auto-detect',
    '启动日志': 'Launch log',
    '启动后日志会显示在这里': 'The launch log will appear here',

    '游戏版本': 'Game versions',
    'Mod': 'Mods',
    '资源包': 'Resource packs',
    '光影': 'Shaders',
    '整合包': 'Modpacks',
    '搜索名称…': 'Search by name…',
    '全部加载器': 'All loaders',
    '正式版': 'Releases',
    '快照': 'Snapshots',
    '下载任务': 'Download tasks',
    '下载日志': 'Download log',
    '没有匹配的版本': 'No matching versions',
    '下载源': 'Download source',
    '官方 Mojang（默认）': 'Official Mojang (default)',
    'BMCLAPI 镜像（国内推荐）': 'BMCLAPI mirror (China)',
    '自定义镜像': 'Custom mirror',
    '镜像根地址': 'Mirror base URL',
    '保存并测速': 'Save and test',

    '一键开服': 'Start server',
    '高级设置': 'Advanced',
    '设置公网域名': 'Set up domain',
    '检查我能不能被别人连': 'Check reachability',
    '测一下外面能不能连进来': 'Probe from outside',
    '自动映射端口': 'Auto port map',
    '取消映射': 'Remove mapping',
    '联机方式': 'Connection mode',
    'Cloudflare 中继（消耗额度）': 'Cloudflare relay (uses quota)',
    '自建中继（免费）': 'Self-hosted relay (free)',
    '怎么自建？': 'How to self-host?',
    '房间号（自动生成）': 'Room (auto-generated)',
    '房间口令（可选，建议填）': 'Room key (optional, recommended)',
    '开隧道': 'Start tunnel',
    '停隧道': 'Stop tunnel',
    '我是玩家，加入房间': 'Join room as player',
    '停代理': 'Stop proxy',
    '中继地址（默认 wss://relay.stde.eu.cc）': 'Relay URL (default wss://relay.stde.eu.cc)',
    '控制台': 'Console',
    '自动滚动': 'Auto-scroll',

    '官方源慢就换镜像。改完会立刻生效，游戏文件从镜像下载。':
      'Switch to a mirror if the official source is slow. Takes effect immediately.',
    'Java 环境': 'Java runtime',
    '重新检测': 'Re-detect',
    '自动下载缺失的 Java': 'Auto-download missing Java',
    '打开 Java 目录': 'Open Java folder',
    '界面与语言': 'Appearance & language',
    '界面语言': 'Language',
    '简体中文': '简体中文',
    'English': 'English',
    '界面自定义': 'Appearance',
    '导入主题（zip）': 'Import theme (zip)',
    '导入主题（文件夹）': 'Import theme (folder)',
    '导出当前主题': 'Export current theme',
    '重新加载界面': 'Reload UI',
    '打开界面目录': 'Open UI folder',
    '恢复默认界面': 'Reset to default UI',
    '正版登录': 'Microsoft sign-in',
    'Client ID': 'Client ID',

    '登录': 'Sign in',
    '离线登录': 'Offline',
    '玩家名': 'Player name',
    '离线 UUID': 'Offline UUID',
    '以离线身份登录': 'Sign in offline',
    '开始微软登录': 'Sign in with Microsoft',
    '点击下方按钮，浏览器会打开微软授权页。': 'Click the button below; the browser will open Microsoft sign-in.',

    '输入网址，或输入关键词用 Bing 搜索…': 'Enter a URL, or search with Bing…',
    '后退': 'Back',
    '前进': 'Forward',
    '首页': 'Home',
    '用系统浏览器打开': 'Open in system browser',
    '打开下载目录': 'Open downloads folder',
    '输入网址，或直接搜索': 'Enter a URL, or just search',
    '下载的 .jar / .zip / .mrpack 会问你要装进哪个实例。':
      'Downloaded .jar / .zip / .mrpack files can be imported into an instance.',
    '下载会存到「下载目录」，完成后可一键导入实例':
      'Downloads go to the downloads folder; import them into an instance when done',

    '导入下载的文件': 'Import downloaded file',
    '装到哪个实例': 'Target instance',
    '文件类型': 'File type',
    'Mod（.jar）': 'Mod (.jar)',
    '资源包（.zip）': 'Resource pack (.zip)',
    '光影（.zip）': 'Shader (.zip)',
    '整合包（.mrpack）': 'Modpack (.mrpack)',
  };

  const TEXT = new Map(Object.entries(EN));

  function translateString(value) {
    if (!value || current === 'zh-CN') return null;
    const key = value.trim();
    if (!key) return null;
    const hit = TEXT.get(key);
    if (hit == null) return null;
    return value.replace(key, hit);
  }

  const observed = new WeakSet();

  function walk(root) {
    if (!root || current === 'zh-CN') return;
    if (root.nodeType === Node.TEXT_NODE) {
      const next = translateString(root.nodeValue);
      if (next != null) root.nodeValue = next;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) {
      const tag = root.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      const ph = root.getAttribute && root.getAttribute('placeholder');
      if (ph) {
        const next = translateString(ph);
        if (next != null) root.setAttribute('placeholder', next);
      }
      const title = root.getAttribute && root.getAttribute('title');
      if (title) {
        const next = translateString(title);
        if (next != null) root.setAttribute('title', next);
      }
    }
    const children = root.childNodes;
    for (let i = 0; i < children.length; i += 1) walk(children[i]);
  }

  function startObserver() {
    if (current === 'zh-CN' || !document.body) return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (observed.has(node)) continue;
            observed.add(node);
            walk(node);
          }
        } else if (mutation.type === 'characterData') {
          walk(mutation.target);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.__visklukeLang = current;
  window.__t = (zh) => (current === 'zh-CN' ? zh : TEXT.get(String(zh).trim()) || zh);

  function apply() {
    if (current === 'zh-CN') return;
    walk(document.body);
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
