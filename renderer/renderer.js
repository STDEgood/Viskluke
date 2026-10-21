'use strict';

/**
 * renderer.js —— 极简白 UI
 * 页面：游戏（实例）/ 下载（版本、Mod、资源包、光影、整合包）/ 服务器
 */

(() => {
  const api = window.viskluke;
  const $ = (id) => document.getElementById(id);

  if (!api) {
    document.body.innerHTML =
      '<div style="padding:32px;font-family:system-ui;color:#18181b">preload 未加载：请用 npm start 启动，不要直接用浏览器打开。</div>';
    return;
  }

  // =========================================================================
  // 基础工具
  // =========================================================================

  function toast(text, type = 'info', timeout = 4200) {
    const box = document.createElement('div');
    box.className = `toast toast-${type}`;
    box.textContent = String(text);
    $('toasts').appendChild(box);
    setTimeout(() => {
      box.classList.add('out');
      setTimeout(() => box.remove(), 200);
    }, timeout);
  }

  const fmtNum = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v);
  };

  const shortDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const normalizePrefix = (value) =>
    String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制：${text}`, 'success');
    } catch {
      toast('复制失败，请手动选择', 'error');
    }
  }

  // ---- 下载任务面板 / 下载日志 / 右键菜单 ----

  const tasks = [];

  function appendDlLog(text) {
    const el = $('dl-log');
    if (!el) return;
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    const line = document.createElement('div');
    line.className = 'log-line log-info';
    line.textContent = text;
    el.appendChild(line);
    while (el.childElementCount > 400) el.removeChild(el.firstChild);
    if (stick) el.scrollTop = el.scrollHeight;
  }

  function renderTasks() {
    const ul = $('dl-tasks');
    if (!ul) return;
    const running = tasks.filter((t) => t.status === 'run').length;
    $('dl-task-count').textContent = String(running || tasks.length);
    ul.innerHTML = '';
    if (!tasks.length) {
      const li = document.createElement('li');
      li.className = 'task-empty';
      li.textContent = '暂无任务';
      ul.appendChild(li);
      return;
    }
    tasks.slice(-8).reverse().forEach((task) => {
      const li = document.createElement('li');
      li.className = 'task';

      const head = document.createElement('div');
      head.className = 'task-title';
      const name = document.createElement('span');
      name.textContent = task.title;
      name.title = task.title;
      const state = document.createElement('span');
      state.className = `task-state${task.status === 'done' ? ' ok' : task.status === 'error' ? ' err' : ''}`;
      state.textContent = task.status === 'done'
        ? '完成'
        : task.status === 'error'
          ? '失败'
          : task.percent == null ? '进行中' : `${task.percent}%`;
      head.append(name, state);

      const bar = document.createElement('div');
      bar.className = 'progress';
      const track = document.createElement('div');
      track.className = 'progress-bar';
      if (task.percent == null) track.classList.add('indeterminate');
      else track.style.setProperty('--p', `${task.percent}%`);
      bar.appendChild(track);

      li.append(head, bar);
      ul.appendChild(li);
    });
  }

  function taskAdd(title) {
    const task = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, title, percent: null, status: 'run' };
    tasks.push(task);
    renderTasks();
    appendDlLog(`▶ ${title}`);
    return task;
  }

  function taskUpdate(task, patch = {}) {
    if (!task) return;
    Object.assign(task, patch);
    renderTasks();
  }

  function closeCtx() {
    const menu = $('ctx-menu');
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }

  function openCtx(x, y, items) {
    const menu = $('ctx-menu');
    menu.innerHTML = '';
    items.forEach((item) => {
      if (item.sep) {
        menu.appendChild(document.createElement('hr'));
        return;
      }
      const button = document.createElement('button');
      button.textContent = item.label;
      if (item.danger) button.className = 'danger';
      button.addEventListener('click', () => {
        closeCtx();
        item.action();
      });
      menu.appendChild(button);
    });
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  }

  document.addEventListener('click', closeCtx);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCtx();
  });

  const ACCOUNT_KEY = 'viskluke.account';

  const state = {
    account: null,
    instances: [],
    currentInstanceId: null,
    servers: [],
    selectedServerId: null,
    cf: null,
    suffixes: ['yistarline.eu.cc', 'stde.eu.cc', 'ys2video.eu.cc'],
    page: 'instances',
    dlTab: 'versions',
    dlBusy: false,
    lastRoot: '',
  };

  // =========================================================================
  // 导航
  // =========================================================================

  const PAGE_META = {
    instances: ['游戏', '选择一个实例开始游戏'],
    downloads: ['下载', '游戏版本、Mod、资源包、光影、整合包'],
    servers: ['服务器', '一键开服 + Viskluke Address 自定义域名'],
  };

  function showPage(page, options = {}) {
    state.page = page;
    document.querySelectorAll('.page').forEach((el) => el.classList.add('hidden'));
    $(`page-${page}`).classList.remove('hidden');

    const [title, sub] = PAGE_META[page] || ['', ''];
    $('page-title').textContent = title;
    $('page-sub').textContent = sub;

    document.querySelectorAll('.menu-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.page === page);
    });
    document.querySelectorAll('.menu-group').forEach((group) => {
      const active = group.querySelector(`.menu-item[data-page="${page}"]`);
      group.classList.toggle('collapsed', !active && group.dataset.group !== page);
    });

    if (page === 'downloads') {
      setDownloadTab(options.tab || state.dlTab);
    }
    $('cf-badge').classList.toggle('hidden', page === 'servers');
    if (page === 'servers') {
      refreshServers();
      updateAddressPreview();
      updateLanTag();
      updatePublicTag();
      fillWhitelistFromAccount();
    }
    if (page === 'instances') renderInstance();
  }

  document.querySelectorAll('.menu-item').forEach((btn) => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  document.querySelectorAll('.sub-item[data-page="downloads"]').forEach((btn) => {
    btn.addEventListener('click', () => showPage('downloads', { tab: btn.dataset.tab }));
  });

  $('btn-go-versions').addEventListener('click', () => showPage('downloads', { tab: 'versions' }));
  $('btn-go-servers').addEventListener('click', () => showPage('servers'));

  // =========================================================================
  // 账号
  // =========================================================================

  function renderAccount() {
    const account = state.account;
    const avatar = $('account-avatar');
    if (!account) {
      $('account-name').textContent = '未登录';
      $('account-type').textContent = '点击登录';
      avatar.textContent = '?';
      avatar.classList.remove('online');
      return;
    }
    $('account-name').textContent = account.name;
    $('account-type').textContent = account.type === 'offline' ? '离线账号' : '微软正版';
    avatar.textContent = account.name.slice(0, 1);
    avatar.classList.add('online');
  }

  function setAccount(account) {
    state.account = account;
    renderAccount();
    if (account && account.name) fillWhitelistFromAccount();
    if (account && account.type === 'offline') {
      try {
        localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ name: account.name, uuid: account.uuid, type: 'offline' }));
      } catch {
        /* ignore */
      }
    }
  }

  function openAuth(tab = 'offline') {
    $('auth-modal').classList.remove('hidden');
    switchAuthTab(tab);
    if (tab === 'offline') {
      $('offline-name').focus();
      previewUuid($('offline-name').value);
    }
  }
  const closeAuth = () => $('auth-modal').classList.add('hidden');

  function switchAuthTab(tab) {
    document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.authTab === tab);
    });
    $('auth-offline').classList.toggle('hidden', tab !== 'offline');
    $('auth-microsoft').classList.toggle('hidden', tab !== 'microsoft');
  }

  $('account-card').addEventListener('click', () => openAuth('offline'));
  $('btn-close-auth').addEventListener('click', closeAuth);
  $('auth-modal').addEventListener('click', (e) => {
    if (e.target === $('auth-modal')) closeAuth();
  });
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
  });

  let uuidTimer = null;
  async function previewUuid(name) {
    const value = String(name || '').trim();
    if (!value) {
      $('offline-uuid').textContent = '—';
      return;
    }
    const result = await api.authOffline(value);
    $('offline-uuid').textContent = result && result.ok ? result.minecraft.uuid : '用户名不合法';
  }

  $('offline-name').addEventListener('input', (event) => {
    const cleaned = event.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    if (cleaned !== event.target.value) event.target.value = cleaned;
    clearTimeout(uuidTimer);
    uuidTimer = setTimeout(() => previewUuid(cleaned), 140);
  });
  $('offline-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('btn-offline-login').click();
  });

  $('btn-offline-login').addEventListener('click', async () => {
    const name = $('offline-name').value.trim();
    if (!name) return toast('请输入玩家名', 'error');
    const result = await api.authOffline(name);
    if (!result || !result.ok) return toast(`离线登录失败：${(result && result.error) || '未知错误'}`, 'error');
    setAccount(result.minecraft);
    closeAuth();
    toast(`已登录：${result.minecraft.name}（离线）`, 'success');
  });

  api.onDeviceCode(({ userCode }) => {
    switchAuthTab('microsoft');
    $('auth-modal').classList.remove('hidden');
    $('user-code').textContent = userCode;
    $('auth-status').textContent = '请在浏览器中完成授权…';
  });

  $('btn-ms-login').addEventListener('click', async () => {
    $('auth-status').textContent = '正在请求设备代码…';
    try {
      const result = await api.authStart();
      if (result && result.ok) {
        setAccount({ ...result.minecraft, type: 'msa' });
        closeAuth();
        toast(`已登录：${result.minecraft.name}`, 'success');
      } else {
        $('auth-status').textContent = `登录失败：${(result && result.error) || '未知错误'}`;
      }
    } catch (error) {
      $('auth-status').textContent = `登录失败：${error.message || error}`;
    }
  });

  (function restoreAccount() {
    try {
      const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
      if (saved && saved.type === 'offline' && saved.name) {
        api.authOffline(saved.name).then((result) => {
          if (result && result.ok) setAccount(result.minecraft);
        });
      }
    } catch {
      /* ignore */
    }
  })();

  // =========================================================================
  // 游戏 / 实例
  // =========================================================================

  const currentInstance = () => state.instances.find((i) => i.id === state.currentInstanceId) || null;

  const LOADER_LABEL = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
  const loaderName = (type) => LOADER_LABEL[String(type || '').toLowerCase()] || String(type || '');
  /** 启动器能自动处理这四种客户端加载器（Fabric/Quilt 生成版本 JSON，Forge/NeoForge 走官方 installer） */
  const loaderAutoSupported = (type) =>
    ['fabric', 'quilt', 'forge', 'neoforge'].includes(String(type || '').toLowerCase());
  /** Forge 系首次启动要下载安装器（约 6MB），提示一下 */
  const loaderNeedsInstaller = (type) => ['forge', 'neoforge'].includes(String(type || '').toLowerCase());

  function renderInstanceMenu() {
    const box = $('sub-instances');
    box.innerHTML = '';
    if (!state.instances.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '暂无实例';
      box.appendChild(hint);
      return;
    }
    state.instances.forEach((instance) => {
      const btn = document.createElement('button');
      btn.className = `sub-item${instance.id === state.currentInstanceId ? ' active' : ''}`;
      const name = document.createElement('span');
      name.textContent = instance.name || instance.id;
      btn.appendChild(name);
      if (instance.modpack) {
        const badge = document.createElement('span');
        badge.className = 'tag';
        badge.textContent = '整合包';
        badge.title = `${instance.modpack.name || ''} ${instance.modpack.versionId || ''}`.trim();
        btn.appendChild(badge);
      }
      btn.title = [instance.version || '', instance.loader ? loaderName(instance.loader) : ''].filter(Boolean).join(' · ');
      btn.addEventListener('click', () => selectInstance(instance.id));
      btn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const items = [
          { label: '启动游戏', action: () => { selectInstance(instance.id); $('btn-launch').click(); } },
          { label: '打开游戏目录', action: () => api.openGameRoot({ id: instance.id, name: instance.name }) },
        ];
        if (instance.modpack) {
          items.push({
            label: '重新安装整合包',
            action: () => {
              showPage('downloads', { tab: 'modpacks' });
              $('dl-search').value = instance.modpack.name || '';
              loadDownloads();
              toast('搜索框已填入整合包名，点「安装整合包」可续传修复', 'info', 7000);
            },
          });
        }
        items.push({ sep: true });
        items.push({
          label: '删除实例',
          danger: true,
          action: () => { selectInstance(instance.id); $('btn-delete-instance').click(); },
        });
        openCtx(event.clientX, event.clientY, items);
      });
      box.appendChild(btn);
    });
  }

  async function refreshInstances() {
    try {
      const list = await api.listInstances();
      state.instances = Array.isArray(list) ? list : [];
      if (!state.instances.some((i) => i.id === state.currentInstanceId)) {
        state.currentInstanceId = state.instances.length ? state.instances[0].id : null;
      }
      renderInstanceMenu();
      renderInstance();
    } catch (error) {
      toast(`读取实例失败：${error.message || error}`, 'error');
    }
  }

  function selectInstance(id) {
    state.currentInstanceId = id;
    renderInstanceMenu();
    renderInstance();
    showPage('instances');
    if (!$('skin-modal').classList.contains('hidden')) refreshSkin();
  }

  function renderInstance() {
    const instance = currentInstance();
    $('instance-empty').classList.toggle('hidden', Boolean(instance));
    $('instance-detail').classList.toggle('hidden', !instance);
    if (!instance) return;

    $('inst-name').value = instance.name || '';
    $('inst-version').value = instance.version || '';
    $('inst-max-mem').value = instance.maxMemory || '4G';
    $('inst-min-mem').value = instance.minMemory || '2G';
    $('inst-java').value = instance.javaPath || '';

    $('inst-meta').innerHTML = '';
    const pack = instance.modpack || null;
    const parts = [
      { text: `版本 ${instance.version || '—'}` },
      instance.loader ? { text: `${loaderName(instance.loader)} ${instance.loaderVersion || ''}`.trim() } : null,
      { text: `内存 ${instance.maxMemory || '4G'}` },
      pack
        ? {
            text: `整合包 ${[pack.name, pack.versionId].filter(Boolean).join(' ')}${
              pack.files ? ` · ${pack.files} 文件` : ''
            }${pack.status === 'partial' ? ' · 部分文件缺失' : ''}${pack.status === 'failed' ? ' · 安装失败' : ''}`.trim(),
          }
        : null,
      state.lastRoot ? { text: `目录 ${state.lastRoot}`, code: true } : null,
    ].filter(Boolean);

    parts.forEach((part) => {
      const node = document.createElement(part.code ? 'code' : 'span');
      node.textContent = part.text;
      $('inst-meta').appendChild(node);
    });

    // 加载器不支持的实例，提前把话说清楚，别等点了启动才炸
    const hintId = 'inst-loader-hint';
    let hint = document.getElementById(hintId);
    if (instance.loader && !loaderAutoSupported(instance.loader)) {
      if (!hint) {
        hint = document.createElement('p');
        hint.id = hintId;
        hint.className = 'hint-text err-text';
        $('inst-meta').after(hint);
      }
      hint.textContent = loaderNeedsInstaller(instance.loader)
        ? `${loaderName(instance.loader)} 加载器会在首次启动时自动下载官方安装器（约 6MB），需要能访问 maven.minecraftforge.net。`
        : `这个整合包需要 ${loaderName(instance.loader)} 加载器，本启动器只支持 Fabric / Quilt / Forge / NeoForge。`;
    } else if (hint) {
      hint.remove();
    }
  }

  async function saveCurrentInstance(patch = {}) {
    const instance = currentInstance();
    if (!instance) return null;
    const next = {
      ...instance,
      name: $('inst-name').value.trim() || '未命名实例',
      version: $('inst-version').value.trim(),
      maxMemory: $('inst-max-mem').value.trim() || '4G',
      minMemory: $('inst-min-mem').value.trim() || '2G',
      javaPath: $('inst-java').value.trim(),
      ...patch,
    };
    const saved = await api.saveInstance(next);
    await refreshInstances();
    state.currentInstanceId = next.id || state.currentInstanceId;
    if (saved) renderInstanceMenu();
    return next;
  }

  $('btn-save-instance').addEventListener('click', async () => {
    try {
      await saveCurrentInstance();
      toast('已保存', 'success');
    } catch (error) {
      toast(`保存失败：${error.message || error}`, 'error');
    }
  });

  $('btn-launch').addEventListener('click', async () => {
    if (!state.account) return openAuth('offline');
    const instance = currentInstance();
    if (!instance) return toast('请先选择实例', 'error');

    const version = $('inst-version').value.trim();
    if (!version) return toast('请填写游戏版本', 'error');
    if (instance.loader && !loaderAutoSupported(instance.loader)) {
      return toast(
        `这个实例需要 ${loaderName(instance.loader)} 加载器，本启动器只自动处理 Fabric / Quilt / Forge / NeoForge。` +
          '可以把这个整合包导入 Prism / Modrinth 客户端。',
        'error',
        12000
      );
    }

    toast('正在启动…');
    try {
      const result = await api.launch({
        minecraft: state.account,
        version,
        maxMemory: $('inst-max-mem').value.trim() || '4G',
        minMemory: $('inst-min-mem').value.trim() || '2G',
        javaPath: $('inst-java').value.trim(),
        instanceId: instance.id,
        instanceName: instance.name,
      });
      if (result && result.ok) {
        state.lastRoot = result.root || '';
        renderInstance();
        const extra = result.loader ? `（${loaderName(result.loader.type)} ${result.loader.version}）` : '';
        toast(`已启动${extra}${result.root ? `（目录 ${result.root}）` : ''}`, 'success', 6000);
      } else {
        toast(`启动失败：${(result && result.error) || '未知错误'}`, 'error', 9000);
      }
    } catch (error) {
      toast(`启动失败：${error.message || error}`, 'error', 9000);
    }
  });

  $('btn-open-root').addEventListener('click', async () => {
    const instance = currentInstance();
    if (!instance) return;
    try {
      const result = await api.openGameRoot({ id: instance.id, name: instance.name });
      if (result && result.ok) {
        state.lastRoot = result.root;
        renderInstance();
      } else {
        toast(`打开失败：${(result && result.error) || '未知错误'}`, 'error');
      }
    } catch (error) {
      toast(`打开失败：${error.message || error}`, 'error');
    }
  });

  $('btn-delete-instance').addEventListener('click', async () => {
    const instance = currentInstance();
    if (!instance) return;
    if (!window.confirm(`删除实例「${instance.name || instance.id}」？\n只删除记录，不会删除游戏文件。`)) return;
    try {
      await api.removeInstance(instance.id);
      state.currentInstanceId = null;
      await refreshInstances();
      toast('实例已删除', 'success');
    } catch (error) {
      toast(`删除失败：${error.message || error}`, 'error');
    }
  });

  $('btn-clear-game-log').addEventListener('click', () => {
    $('log').textContent = '';
  });

  api.onLog((msg) => {
    const log = $('log');
    log.textContent += `${msg}\n`;
    if (log.textContent.length > 150000) log.textContent = log.textContent.slice(-100000);
    log.scrollTop = log.scrollHeight;
  });

  // =========================================================================
  // 皮肤（离线皮肤 / CustomSkinLoader）
  // =========================================================================

  const skinState = { status: null, selectedId: '', busy: false };

  const openSkinModal = () => $('skin-modal').classList.remove('hidden');
  const closeSkinModal = () => $('skin-modal').classList.add('hidden');

  async function openSkin() {
    const instance = currentInstance();
    if (!instance) return toast('请先选择实例', 'error');
    openSkinModal();
    if (!skinState.status || !skinState.status.instance || skinState.status.instance.id !== instance.id) {
      skinState.selectedId = '';
    }
    const account = state.account;
    if (account && account.name && !$('skin-player').value) $('skin-player').value = account.name;
    await refreshSkin();
  }

  async function refreshSkin() {
    const instance = currentInstance();
    if (!instance) return;
    try {
      const result = await api.skinStatus({ instanceId: instance.id });
      skinState.status = result;
      const library = (result && result.library) || [];
      if (!library.some((item) => item.id === skinState.selectedId)) {
        skinState.selectedId = library.length ? library[0].id : '';
      }
      renderSkin();
    } catch (error) {
      toast(`读取皮肤失败：${error.message || error}`, 'error');
    }
  }

  function renderSkin() {
    const status = skinState.status;
    if (!status) return;
    const instance = status.instance || {};

    const stateTag = $('skin-csl-state');
    stateTag.textContent = instance.modInstalled ? 'CSL 已安装' : 'CSL 未安装';
    stateTag.className = `tag ${instance.modInstalled ? 'ok' : 'warn'}`;

    const modelText = !instance.configExists
      ? 'CSL 配置还没生成（首次启动游戏后才有），模型设置会先写进 ExtraList'
      : instance.model === 'slim'
        ? '当前模型：纤细'
        : instance.model === 'classic'
          ? '当前模型：经典'
          : instance.model === 'auto'
            ? '当前模型：自动（CSL 默认＝经典）'
            : 'CSL 配置里没读到 LocalSkin 模型（可能被手改过）';
    const applied = (status.applied || []).length;
    $('skin-tip').textContent = [
      `皮肤会写进 ${instance.cslDir || ''}\\LocalSkin\\skins\\<玩家名>.png`,
      modelText,
      applied ? `该实例已有 ${applied} 个本地皮肤` : '该实例还没有本地皮肤',
    ].filter(Boolean).join(' · ');

    const list = $('skin-list');
    list.innerHTML = '';
    const library = status.library || [];
    if (!library.length) {
      list.innerHTML = '<div class="rows-empty">皮肤库是空的。点「导入 PNG…」添加（64×64 或 64×32）</div>';
      return;
    }

    library.forEach((item) => {
      const row = document.createElement('div');
      row.className = `skin-row${item.id === skinState.selectedId ? ' active' : ''}`;
      row.addEventListener('click', () => {
        skinState.selectedId = item.id;
        renderSkin();
      });

      const thumb = document.createElement('img');
      thumb.className = 'skin-thumb';
      thumb.alt = '';
      if (item.preview) thumb.src = item.preview;

      const main = document.createElement('div');
      main.className = 'skin-main';
      const name = document.createElement('div');
      name.className = 'skin-name';
      name.textContent = item.missing ? `${item.name}（文件丢失）` : item.name;
      name.title = '双击改名';
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const input = document.createElement('input');
        input.className = 'skin-name-input';
        input.value = item.name;
        input.maxLength = 60;
        const commit = async () => {
          const next = input.value.trim();
          input.replaceWith(name);
          if (!next || next === item.name) return;
          const result = await api.skinRename(item.id, next);
          if (result && result.ok) {
            toast(`已改名：${next}`, 'success');
            await refreshSkin();
          } else {
            toast(`改名失败：${(result && result.error) || '未知错误'}`, 'error');
          }
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') input.replaceWith(name);
        });
        input.addEventListener('blur', commit);
        input.addEventListener('click', (e) => e.stopPropagation());
        name.replaceWith(input);
        input.focus();
        input.select();
      });
      const meta = document.createElement('div');
      meta.className = 'row-desc';
      meta.textContent = [
        `${item.width}×${item.height}`,
        item.kind === 'cape' ? '披风' : '皮肤',
        item.kind === 'cape' ? '' : item.model === 'slim' ? '纤细' : '经典',
        item.source === 'draw' ? '自绘' : '',
        item.boundPlayer ? `已用于 ${item.boundPlayer}` : '',
      ].filter(Boolean).join(' · ');
      main.append(name, meta);

      const side = document.createElement('div');
      side.className = 'row-side';
      if (item.kind !== 'cape') {
        const modelBtn = document.createElement('button');
        modelBtn.className = 'btn subtle';
        modelBtn.textContent = item.model === 'slim' ? '切到经典' : '切到纤细';
        modelBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const next = item.model === 'slim' ? 'classic' : 'slim';
          const result = await api.skinSetModel(item.id, next);
          if (result && result.ok) {
            toast(`已切换为${next === 'slim' ? '纤细' : '经典'}模型`, 'success');
            await refreshSkin();
          } else {
            toast(`切换失败：${(result && result.error) || '未知错误'}`, 'error');
          }
        });
        side.appendChild(modelBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'btn subtle danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!window.confirm(`从皮肤库删除「${item.name}」？\n（已写进实例的文件不会删）`)) return;
        const result = await api.skinRemove(item.id);
        if (result && result.ok) {
          if (skinState.selectedId === item.id) skinState.selectedId = '';
          toast('已从皮肤库删除', 'success');
          await refreshSkin();
        } else {
          toast(`删除失败：${(result && result.error) || '未知错误'}`, 'error');
        }
      });
      side.append(delBtn);

      row.append(thumb, main, side);
      list.appendChild(row);
    });
  }

  function skinPlayerName() {
    const raw = $('skin-player').value.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(raw)) {
      toast('玩家名不合法：3~16 位字母、数字或下划线', 'error');
      return '';
    }
    return raw;
  }

  $('btn-skin').addEventListener('click', openSkin);
  $('btn-close-skin').addEventListener('click', closeSkinModal);

  // 绘制器：主界面只负责打开它，画布逻辑在 renderer/skin-editor.js
  $('btn-skin-draw').addEventListener('click', () => {
    const editor = window.__visklukeOpenSkinEditor;
    if (!editor) return toast('绘制器没加载成功（检查 skin-editor.js）', 'error');
    editor.bindCanvas();
    editor.open('skin');
  });
  $('btn-skin-import-cape').addEventListener('click', async () => {
    const button = $('btn-skin-import-cape');
    button.disabled = true;
    button.textContent = '导入中…';
    try {
      const result = await api.skinImport({ kind: 'cape' });
      if (!result || result.canceled) return;
      if (!result.ok) return toast(`导入失败：${result.error || '未知错误'}`, 'error', 9000);
      skinState.selectedId = result.skin.id;
      toast(`已导入披风 ${result.skin.name}（${result.skin.width}×${result.skin.height}）`, 'success');
      await refreshSkin();
    } catch (error) {
      toast(`导入失败：${error.message || error}`, 'error', 9000);
    } finally {
      button.disabled = false;
      button.textContent = '导入披风…';
    }
  });

  // 绘制器保存后回到主界面：自动选中新素材
  window.__visklukeOnSkinSaved = async (entry) => {
    if (!entry) return;
    skinState.selectedId = entry.id;
    toast(`已保存「${entry.name}」，可以点「应用到实例」了`, 'success', 7000);
    await refreshSkin();
  };

  $('skin-modal').addEventListener('click', (event) => {
    if (event.target === $('skin-modal')) closeSkinModal();
  });
  $('skin-player').addEventListener('input', (event) => {
    const cleaned = event.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    if (cleaned !== event.target.value) event.target.value = cleaned;
  });

  $('btn-skin-import').addEventListener('click', async () => {
    const button = $('btn-skin-import');
    button.disabled = true;
    button.textContent = '导入中…';
    try {
      const result = await api.skinImport({ model: 'classic' });
      if (!result || result.canceled) return;
      if (!result.ok) return toast(`导入失败：${result.error || '未知错误'}`, 'error', 9000);
      skinState.selectedId = result.skin.id;
      toast(
        result.duplicated
          ? `这张皮肤库里已经有了：${result.skin.name}`
          : `已导入 ${result.skin.name}（${result.skin.width}×${result.skin.height}）`,
        'success'
      );
      await refreshSkin();
    } catch (error) {
      toast(`导入失败：${error.message || error}`, 'error', 9000);
    } finally {
      button.disabled = false;
      button.textContent = '导入皮肤…';
    }
  });

  $('btn-skin-apply').addEventListener('click', async () => {
    const instance = currentInstance();
    if (!instance) return toast('请先选择实例', 'error');
    if (!skinState.selectedId) return toast('先在列表里选一张皮肤', 'error');
    const playerName = skinPlayerName();
    if (!playerName) return;

    const button = $('btn-skin-apply');
    button.disabled = true;
    button.textContent = '写入中…';
    try {
      const result = await api.skinApply({
        instanceId: instance.id,
        skinId: skinState.selectedId,
        playerName,
      });
      if (!result || !result.ok) return toast(`应用失败：${(result && result.error) || '未知错误'}`, 'error', 9000);
      toast(
        result.kind === 'cape'
          ? `已写入披风 ${result.playerName}.png（同时写了鞘翅）`
          : `已写入 ${result.playerName}.png（${result.model === 'slim' ? '纤细' : '经典'}模型）`,
        'success',
        7000
      );
      if (result.note) toast(result.note, 'warn', 10000);
      await refreshSkin();
    } catch (error) {
      toast(`应用失败：${error.message || error}`, 'error', 9000);
    } finally {
      button.disabled = false;
      button.textContent = '应用到实例';
    }
  });

  $('btn-skin-clear').addEventListener('click', async () => {
    const instance = currentInstance();
    if (!instance) return toast('请先选择实例', 'error');
    const playerName = skinPlayerName();
    if (!playerName) return;
    if (!window.confirm(`删除实例里 ${playerName}.png 这张本地皮肤？`)) return;
    try {
      const result = await api.skinClear({ instanceId: instance.id, playerName });
      if (result && result.ok) {
        toast(result.removed ? `已删除 ${playerName}.png` : `${playerName}.png 本来就不存在`, 'success');
        await refreshSkin();
      } else {
        toast(`清除失败：${(result && result.error) || '未知错误'}`, 'error');
      }
    } catch (error) {
      toast(`清除失败：${error.message || error}`, 'error', 9000);
    }
  });

  $('btn-skin-install-csl').addEventListener('click', async () => {
    const instance = currentInstance();
    if (!instance) return toast('请先选择实例', 'error');
    const button = $('btn-skin-install-csl');
    button.disabled = true;
    button.textContent = '安装中…';
    try {
      const result = await api.skinInstallCsl({ instanceId: instance.id });
      if (result && result.ok) {
        toast(`已安装 ${result.file} → ${result.dir}`, 'success', 8000);
        await refreshSkin();
      } else {
        toast(`安装失败：${(result && result.error) || '未知错误'}`, 'error', 12000);
      }
    } catch (error) {
      toast(`安装失败：${error.message || error}`, 'error', 12000);
    } finally {
      button.disabled = false;
      button.textContent = '安装 CSL 模组';
    }
  });

  $('btn-skin-open-folder').addEventListener('click', async () => {
    const instance = currentInstance();
    if (!instance) return;
    const result = await api.skinOpenFolder({ instanceId: instance.id });
    if (result && !result.ok) toast(`打开失败：${result.error || ''}`, 'error');
  });

  // =========================================================================
  // 下载
  // =========================================================================

  const DL_TABS = {
    versions: { label: '游戏版本', projectType: null },
    mods: { label: 'Mod', projectType: 'mod', dir: 'mods' },
    resourcepacks: { label: '资源包', projectType: 'resourcepack', dir: 'resourcepacks' },
    shaders: { label: '光影', projectType: 'shader', dir: 'shaderpacks' },
    modpacks: { label: '整合包', projectType: 'modpack', dir: 'modpacks' },
  };

  function setDownloadTab(tab) {
    state.dlTab = tab;
    document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.sub-item[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab && state.page === 'downloads');
    });

    const isVersions = tab === 'versions';
    const isModLike = tab === 'mods' || tab === 'modpacks';
    $('dl-kind').classList.toggle('hidden', !isVersions);
    $('dl-loader').classList.toggle('hidden', !isModLike);
    $('dl-version').classList.toggle('hidden', isVersions);
    $('dl-search').placeholder = isVersions ? '按版本号筛选，如 1.20' : '搜索名称…';

    if (isVersions) {
      $('dl-tip').textContent =
        '选好版本点「创建实例」，会自动跳到「游戏」页 —— 在右上角点「启动游戏」，首次启动会自动下载该版本的全部文件。';
    } else if (tab === 'modpacks') {
      $('dl-tip').textContent =
        '整合包会自动建一个专属实例：mods / config / resourcepacks 全部就位，Fabric / Quilt 加载器首次启动时自动装好。同一个整合包再点一次「安装整合包」等于续传修复。';
    } else {
      $('dl-tip').textContent = `下载的文件会装进当前实例的 ${
        { mods: 'mods/', resourcepacks: 'resourcepacks/', shaders: 'shaderpacks/' }[tab] || ''
      } 目录；请先在「游戏」里选中实例。`;
    }

    loadDownloads();
  }

  async function loadDownloads() {
    const tab = state.dlTab;
    if (tab === 'versions') return loadVersions();
    return loadProjects(tab);
  }

  async function loadVersions() {
    const list = $('dl-list');
    list.innerHTML = '<div class="rows-empty">读取 Mojang 版本清单…</div>';
    try {
      const result = await api.storeVersions({
        type: $('dl-kind').value || 'release',
        query: $('dl-search').value.trim(),
        limit: 60,
      });
      const rows = (result && result.versions) || [];
      list.innerHTML = '';
      if (!rows.length) {
        list.innerHTML = '<div class="rows-empty">没有匹配的版本</div>';
        return;
      }
      rows.forEach((version) => {
        const row = document.createElement('div');
        row.className = 'row';

        const icon = document.createElement('div');
        icon.className = 'row-icon';
        icon.textContent = version.type === 'release' ? 'R' : version.type === 'snapshot' ? 'S' : 'O';

        const main = document.createElement('div');
        main.className = 'row-main';
        const title = document.createElement('div');
        title.className = 'row-title';
        title.textContent = version.id;
        const desc = document.createElement('div');
        desc.className = 'row-desc';
        const hasInstance = state.instances.some((instance) => instance.version === version.id && !instance.modpack);
        desc.textContent = [
          version.type,
          shortDate(version.releaseTime),
          version.installed ? '已安装' : '',
          hasInstance ? '已有实例' : '',
        ].filter(Boolean).join(' · ');
        main.append(title, desc);

        const side = document.createElement('div');
        side.className = 'row-side';
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = hasInstance ? '打开' : '创建实例';
        btn.addEventListener('click', () => createInstanceFromVersion(version.id, btn));
        side.appendChild(btn);

        row.append(icon, main, side);
        list.appendChild(row);
      });
    } catch (error) {
      list.innerHTML = `<div class="rows-empty">读取失败：${error.message || error}</div>`;
    }
  }

  async function createInstanceFromVersion(versionId, button) {
    // 已存在同版本实例 → 直接跳过去，绝不重复创建（整合包实例不算，它有自己的包）
    const existing = state.instances.find((instance) => instance.version === versionId && !instance.modpack);
    if (existing) {
      await openInstanceById(existing.id);
      toast(`「${existing.name || existing.id}」已存在，已为你打开`, 'info');
      return;
    }

    button.disabled = true;
    button.textContent = '创建中…';
    try {
      const saved = await api.saveInstance({
        name: versionId,
        version: versionId,
        maxMemory: '4G',
        minMemory: '2G',
        javaPath: '',
      });
      const list = Array.isArray(saved) ? saved : [];
      const created = list.find((i) => i.version === versionId && i.name === versionId) || list[list.length - 1];

      // 保存失败时不要再静默跳走 —— 之前就是这样"点了没反应"，用户只能反复点
      if (!Array.isArray(saved) || list.length === 0) {
        const reason = (saved && saved.error) || '实例列表写入失败（没有返回数据）';
        setCfError('');
        toast(`创建失败：${reason}`, 'error', 12000);
        return;
      }

      await refreshInstances();
      // refreshInstances 可能把选中项重置成第一个，这里再锁定到刚创建的实例
      if (created && created.id) {
        state.currentInstanceId = created.id;
        renderInstanceMenu();
        renderInstance();
      }

      // 关键：直接跳到「游戏」页，让用户看到「启动游戏」按钮
      showPage('instances');
      $('dl-version').value = versionId;
      toast(`已创建实例「${versionId}」，点右上角「启动游戏」开始下载并启动`, 'success', 7000);
    } catch (error) {
      toast(`创建失败：${error.message || error}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '创建实例';
    }
  }

  /** 选中并打开某个实例（会切到游戏页） */
  async function openInstanceById(id) {
    state.currentInstanceId = id;
    if (!state.instances.length) await refreshInstances();
    renderInstanceMenu();
    renderInstance();
    showPage('instances');
  }

  async function loadProjects(tab) {
    const meta = DL_TABS[tab];
    const list = $('dl-list');
    const instance = currentInstance();
    list.innerHTML = '<div class="rows-empty">搜索 Modrinth…</div>';
    try {
      const result = await api.storeSearch({
        query: $('dl-search').value.trim(),
        projectType: meta.projectType,
        gameVersion: $('dl-version').value.trim(),
        loader: $('dl-loader').value || '',
        limit: 20,
      });
      const hits = (result && result.hits) || [];
      list.innerHTML = '';
      if (!hits.length) {
        list.innerHTML = '<div class="rows-empty">没有找到结果，换个关键词或去掉版本筛选</div>';
        return;
      }
      hits.forEach((hit) => {
        const row = document.createElement('div');
        row.className = 'row';

        let icon;
        if (hit.icon) {
          icon = document.createElement('img');
          icon.className = 'row-icon-img';
          icon.src = hit.icon;
          icon.referrerPolicy = 'no-referrer';
          icon.alt = '';
          icon.addEventListener('error', () => {
            const fallback = document.createElement('div');
            fallback.className = 'row-icon';
            fallback.textContent = (hit.title || '?').slice(0, 1);
            icon.replaceWith(fallback);
          });
        } else {
          icon = document.createElement('div');
          icon.className = 'row-icon';
          icon.textContent = (hit.title || '?').slice(0, 1);
        }

        const main = document.createElement('div');
        main.className = 'row-main';
        const title = document.createElement('div');
        title.className = 'row-title';
        title.textContent = hit.title;
        const desc = document.createElement('div');
        desc.className = 'row-desc';
        const loaders = (hit.categories || [])
          .filter((category) => LOADER_LABEL[String(category).toLowerCase()])
          .map((category) => loaderName(category));
        desc.textContent = [hit.description || '', loaders.length ? `加载器：${loaders.join(' / ')}` : '']
          .filter(Boolean)
          .join(' · ');
        main.append(title, desc);

        const side = document.createElement('div');
        side.className = 'row-side';
        const installedHere =
          instance && instance.installed && Array.isArray(instance.installed[meta.projectType])
            ? instance.installed[meta.projectType].includes(hit.id)
            : false;
        if (installedHere) {
          const done = document.createElement('span');
          done.className = 'tag ok';
          done.textContent = '已安装';
          side.appendChild(done);
        }
        const count = document.createElement('span');
        count.className = 'row-count';
        count.textContent = `${fmtNum(hit.downloads)} 次下载`;
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = installedHere ? '重新安装' : meta.projectType === 'modpack' ? '安装整合包' : '安装';
        btn.addEventListener('click', () => installProject(hit, btn));
        side.append(count, btn);

        row.append(icon, main, side);
        list.appendChild(row);
      });
    } catch (error) {
      list.innerHTML = `<div class="rows-empty">搜索失败：${error.message || error}</div>`;
    }
  }

  async function installProject(hit, button) {
    const tab = state.dlTab;
    const meta = DL_TABS[tab];
    const isModpack = meta.projectType === 'modpack';
    const label = isModpack ? '安装整合包' : '安装';
    const instance = currentInstance();

    // 整合包会自己建实例，不需要先选实例
    if (!isModpack && !instance) {
      toast('请先在「游戏」里选择一个实例，文件会装到它的目录里', 'error', 6000);
      return;
    }

    button.disabled = true;
    button.textContent = '安装中…';
    showDownloadProgress(null, isModpack ? `正在安装整合包 ${hit.title}…` : `正在安装 ${hit.title}…`);
    activeTask = taskAdd(`${isModpack ? '整合包 ' : '安装 '}${hit.title}`);

    try {
      const result = await api.storeInstall({
        projectId: hit.id,
        projectType: meta.projectType,
        projectTitle: hit.title,
        gameVersion: $('dl-version').value.trim(),
        loader: $('dl-loader').value || '',
        instanceId: instance ? instance.id : '',
        instance: instance ? { id: instance.id, name: instance.name } : null,
      });

      if (!result || !result.ok) {
        toast(`安装失败：${(result && result.error) || '未知错误'}`, 'error', 12000);
        if (activeTask) taskUpdate(activeTask, { status: 'error' });
        return;
      }

      if (isModpack) {
        if (activeTask) taskUpdate(activeTask, { percent: 100, status: 'done' });
        const stats = result.stats || {};
        const packName = (result.pack && result.pack.name) || hit.title;
        appendDlLog(`✔ 整合包「${packName}」解包完成 → ${result.root}`);
        await refreshInstances();
        if (result.instance && result.instance.id) await openInstanceById(result.instance.id);
        toast(
          `整合包「${packName}」已就绪：${stats.downloaded || 0} 个新文件、${stats.overrides || 0} 个配置${
            stats.skipped ? `、${stats.skipped} 个已存在` : ''
          }`,
          'success',
          8000
        );
        if (result.note) toast(result.note, 'warn', 9000);
        const packLoader = String((result.pack && result.pack.loader) || '');
        if (packLoader && !loaderAutoSupported(packLoader)) {
          toast(`该整合包需要 ${loaderName(packLoader)} 加载器，本启动器不支持，需要手动安装后再启动。`, 'warn', 12000);
        } else if (packLoader && loaderNeedsInstaller(packLoader)) {
          toast(`${loaderName(packLoader)} 加载器会在首次启动时自动下载官方安装器（约 6MB）。`, 'info', 9000);
        }
        return;
      }

      toast(`已安装 ${result.file} → ${result.dir}`, 'success', 7000);
      if (result.note) toast(result.note, 'warn', 9000);
      // 刷新「已安装」标记
      await refreshInstances();
      await loadProjects(tab);
    } catch (error) {
      toast(`安装失败：${error.message || error}`, 'error', 9000);
      if (activeTask) taskUpdate(activeTask, { status: 'error' });
    } finally {
      button.disabled = false;
      button.textContent = label;
      hideDownloadProgress();
      activeTask = null;
    }
  }

  function showDownloadProgress(percent, text) {
    $('dl-progress').classList.remove('hidden');
    const bar = $('dl-progress-bar');
    if (typeof percent !== 'number') {
      bar.classList.add('indeterminate');
    } else {
      bar.classList.remove('indeterminate');
      bar.style.setProperty('--p', `${Math.max(1, Math.min(100, percent))}%`);
    }
    $('dl-progress-text').textContent = text || '';
  }
  function hideDownloadProgress() {
    $('dl-progress').classList.add('hidden');
    $('dl-progress-bar').classList.remove('indeterminate');
    $('dl-progress-bar').style.setProperty('--p', '0%');
    $('dl-progress-text').textContent = '';
  }

  let activeTask = null;
  let lastLoggedPercent = -1;
  let lastProgressStage = '';

  api.onStoreProgress((payload = {}) => {
    const { percent = null, received = 0, message = '', stage = '', detail = '' } = payload;
    const megabytes = received ? `${(received / 1048576).toFixed(1)} MB` : '';
    const text = message
      ? [message, detail, percent == null ? megabytes : `${percent}%`].filter(Boolean).join(' · ')
      : `${megabytes}${percent == null ? '' : ` · ${percent}%`}`;

    showDownloadProgress(percent, text);

    if (activeTask) {
      if (stage === 'done') taskUpdate(activeTask, { percent: 100, status: 'done' });
      else taskUpdate(activeTask, { percent: percent == null ? null : percent });
    }

    // 只在阶段切换或每 20% 时写日志，避免刷屏
    if (stage && stage !== lastProgressStage) {
      lastProgressStage = stage;
      if (['pack', 'read', 'extract', 'done'].includes(stage) && message) appendDlLog(`  ${message}`);
    } else if (percent != null && percent !== lastLoggedPercent && percent % 20 === 0) {
      lastLoggedPercent = percent;
      appendDlLog(`  ${message || '下载'} · ${percent}%${megabytes ? ` · ${megabytes}` : ''}`);
    }

    if (percent === 100) setTimeout(hideDownloadProgress, 700);
  });

  document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setDownloadTab(btn.dataset.tab));
  });
  $('dl-refresh').addEventListener('click', () => loadDownloads());
  $('dl-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadDownloads();
  });
  $('dl-kind').addEventListener('change', () => loadDownloads());
  $('dl-loader').addEventListener('change', () => loadDownloads());
  $('dl-version').addEventListener('change', () => {
    if (state.dlTab !== 'versions') loadDownloads();
  });

  // =========================================================================
  // 服务器
  // =========================================================================

  function renderServerMenu() {
    const box = $('sub-servers');
    box.innerHTML = '';
    if (!state.servers.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = '暂无服务器';
      box.appendChild(hint);
      return;
    }
    state.servers.forEach((server) => {
      const btn = document.createElement('button');
      btn.className = `sub-item${server.id === state.selectedServerId ? ' active' : ''}`;
      const dot = document.createElement('span');
      dot.className = `dot${server.running ? ' online' : ''}`;
      const label = document.createElement('span');
      label.textContent = server.name || server.id;
      btn.append(dot, label);
      btn.addEventListener('click', () => selectServer(server.id));
      btn.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openCtx(event.clientX, event.clientY, [
          server.running
            ? { label: '停止服务器', action: () => { selectServer(server.id); stopServer(); } }
            : { label: '启动服务器', action: () => { selectServer(server.id); $('det-start').click(); } },
          { label: '打开服务器目录', action: () => api.serverOpenFolder(server.id) },
          { label: '复制连接地址', action: () => copyText(server.address || '') },
          { sep: true },
          { label: '删除服务器', danger: true, action: () => { selectServer(server.id); $('det-delete').click(); } },
        ]);
      });
      box.appendChild(btn);
    });
  }

  async function selectServer(id) {
    state.selectedServerId = id;
    renderServerMenu();
    renderServerDetail();
    showPage('servers');
    await loadServerLogs(id);
  }

  const selectedServer = () => state.servers.find((s) => s.id === state.selectedServerId) || null;
  const statusOf = (server) => server.status || (server.running ? 'online' : 'stopped');
  const STATUS_TEXT = { starting: '启动中', online: '运行中', stopping: '停止中', stopped: '已停止' };

  function renderServerDetail() {
    const server = selectedServer();
    $('server-detail').classList.toggle('hidden', !server);
    $('btn-stop-server').disabled = !(server && server.running);
    if (!server) return;

    const status = statusOf(server);
    $('det-name').textContent = server.name || server.id;
    $('det-status').textContent = STATUS_TEXT[status] || status;
    $('det-status').className = `tag ${status === 'online' ? 'ok' : status === 'starting' || status === 'stopping' ? 'warn' : ''}`;
    $('det-core').textContent = server.core;
    $('det-version').textContent = server.version;
    $('det-memory').textContent = server.maxMemory;
    $('det-port').textContent = String(server.port || '');
    $('det-address').textContent = server.address || '未绑定域名';

    const dns = server.dns || {};
    const dnsParts = [];
    if (dns.targetIpv6) dnsParts.push(`AAAA ${dns.targetIpv6}`);
    if (dns.targetIp) dnsParts.push(`A ${dns.targetIp}`);
    if (dns.targetHost) dnsParts.push(`CNAME ${dns.targetHost}`);
    if (dns.enabled && dnsParts.length) dnsParts.push(`SRV ${dns.port || server.port}`);
    $('det-dns').textContent = dns.manual
      ? '手动解析：需在你的 DNS 后台加 A/AAAA 记录'
      : dns.enabled && dnsParts.length
        ? dnsParts.join(' · ')
        : server.address
          ? '未创建解析'
          : '';
    $('det-dns').className = dns.manual ? 'tag warn' : '';

    const lan = server.lanAddress || '';
    $('det-lan').textContent = lan ? `${lan}:${server.port || ''}` : '未检测到';
    $('det-copy-lan').disabled = !lan;

    const players = Array.isArray(server.whitelistPlayers) ? server.whitelistPlayers : [];
    if (server.whitelist === false) {
      $('det-whitelist').textContent = server.onlineMode ? '白名单：关' : '白名单：关 · 离线模式，注意安全';
      $('det-whitelist').className = 'tag warn';
    } else {
      $('det-whitelist').textContent = players.length ? `白名单：${players.length} 人` : '白名单：开（名单为空）';
      $('det-whitelist').className = `tag ${players.length ? 'ok' : 'err'}`;
    }
    if (document.activeElement !== $('det-whitelist-players')) {
      $('det-whitelist-players').value = players.join(' ');
    }
    $('det-whitelist-enabled').checked = server.whitelist !== false;

    $('det-start').disabled = Boolean(server.running);
    $('det-stop').disabled = !server.running;
    $('det-dns-sync').disabled = !server.address;
    $('det-dns-remove').disabled = !(server.dns && server.dns.enabled);
  }

  async function refreshServers() {
    try {
      const list = await api.serverList();
      state.servers = Array.isArray(list) ? list : [];
      if (state.selectedServerId && !state.servers.some((s) => s.id === state.selectedServerId)) {
        state.selectedServerId = null;
        $('server-log').innerHTML = '';
      }
      renderServerMenu();
      renderServerDetail();
    } catch (error) {
      toast(`读取服务器失败：${error.message || error}`, 'error');
    }
  }

  // ---- Cloudflare ----

  function renderCf() {
    const cf = state.cf;
    const badge = $('cf-badge');
    const pill = $('cf-state');
    const zones = $('cf-zones');
    zones.innerHTML = '';
    if (!cf) return;

    const proxy = cf.transport === 'proxy';

    if (cf.configured) {
      const label = proxy ? 'Viskluke 代理就绪' : 'Cloudflare 已连接';
      badge.textContent = label;
      badge.className = 'tag ok';
      pill.textContent = label;
      pill.className = 'tag ok';
      $('btn-cf-verify').classList.remove('hidden');
    } else {
      badge.textContent = cf.hasToken ? 'Token 已保存，Zone 缺失' : 'Cloudflare 未连接';
      badge.className = 'tag warn';
      pill.textContent = cf.hasToken ? '待识别 Zone' : '未连接（可用代理）';
      pill.className = 'tag warn';
      $('btn-cf-verify').classList.add('hidden');
    }

    const transports = cf.transports || {};
    (cf.suffixes || state.suffixes).forEach((suffix) => {
      const chip = document.createElement('span');
      const transport = transports[suffix] || ((cf.zones || {})[suffix] ? 'direct' : 'none');
      const ok = transport === 'proxy' || transport === 'direct';
      chip.className = `tag ${ok ? 'ok' : transport === 'no-token' ? 'warn' : ''}`;
      chip.textContent = `${ok ? '✓' : transport === 'no-token' ? '⚠' : '✕'} ${suffix}`;
      chip.title =
        transport === 'proxy'
          ? '由 Viskluke Worker 代理负责，不需要本机 Token'
          : transport === 'direct'
            ? `直连 Cloudflare（Zone ID: ${(cf.zones || {})[suffix] || '—'}）`
            : transport === 'no-token'
              ? '有 Zone ID 但没有 Token，无法建记录'
              : '还没有绑定这个后缀';
      zones.appendChild(chip);
    });

    renderSuffixOptions();
    renderDomainList();

    const dnsToggle = $('srv-enable-dns');
    dnsToggle.disabled = !cf.configured;
    if (!cf.configured) dnsToggle.checked = false;
    else if (!dnsToggle.dataset.touched) dnsToggle.checked = true;

    // 顶部那一行状态（不用展开也知道现在能不能用域名）
    const inline = $('cf-inline-state');
    inline.textContent = cf.configured
      ? proxy
        ? '公网域名：Worker 代理就绪'
        : '公网域名：已就绪'
      : '公网域名：未连接';
    inline.className = `tag ${cf.configured ? 'ok' : 'warn'}`;

    // 第一次进服务器页还没配好 → 自动展开一次设置区，省得找不到入口
    if (!cf.configured && !cfAutoExpanded) {
      cfAutoExpanded = true;
      $('cf-advanced').classList.remove('hidden');
      $('btn-toggle-cf').dataset.label = '设置公网域名';
      $('btn-toggle-cf').textContent = '设置公网域名（收起）';
    }

    updateExposeWarning();
  }

  let cfAutoExpanded = false;

  async function refreshCf() {
    try {
      const status = await api.cfStatus();
      state.cf = status;
      applyRelayUrl(status && status.relayUrl);
      if (status && Array.isArray(status.suffixes) && status.suffixes.length) state.suffixes = status.suffixes;
      renderCf();

      // 状态刷新时给一句常驻提示（不覆盖连接时更具体的错误）
      const cfError = $('cf-error');
      if (!cfError.textContent) {
        if (!status.configured && status.hasToken) {
          setCfError(
            'Token 已保存，但没有识别到 Zone：点「连接」重新识别；还是不行就是 Token 缺「Zone → Zone → Read」权限 —— ' +
              '点「改 Token 权限」加上一条即可（不用重建 Token）。'
          );
        } else if (!status.configured) {
          setCfError('');
        }
      }

      updateAddressPreview();
    } catch (error) {
      toast(`Cloudflare 状态读取失败：${error.message || error}`, 'error');
    }
  }

  $('cf-state').addEventListener('click', () => {
    if (!(state.cf && state.cf.configured)) {
      api.cfRevealConfig().then((r) => {
        if (r && r.file) toast(`配置文件：${r.file}`, 'info', 6000);
      });
    }
  });

  $('btn-cf-token-page').addEventListener('click', async () => {
    await api.cfOpenTokenPage();
    toast('已在浏览器打开 Token 创建页（权限已预填）', 'info', 6000);
    $('cf-token').focus();
  });

  $('btn-cf-edit-token').addEventListener('click', async () => {
    // 不用新建 Token，直接在已有 Token 上加一条 Zone → Zone → Read 就行
    await api.openExternal('https://dash.cloudflare.com/profile/api-tokens');
    toast('在浏览器里点开这个 Token → Edit → 加一条「Zone → Zone → Read」→ 保存，回来点「连接」', 'info', 12000);
  });

  async function connectCf() {
    const token = $('cf-token').value.trim();
    if (!token) return toast('请粘贴 API Token', 'error');
    const btn = $('btn-cf-connect');
    btn.disabled = true;
    btn.textContent = '连接中…';
    setCfError('');
    try {
      const result = await api.cfConnect(token);

      if (!result || !result.ok) {
        const raw = (result && result.error) || '未知错误';
        const needRestart = /No handler registered|not registered/i.test(raw);
        setCfError(
          needRestart
            ? '主进程代码已更新，请完全退出启动器（结束 electron 进程）后重新 npm start，再试一次。'
            : `连接失败：${raw}`
        );
        toast(needRestart ? '请先重启启动器' : `连接失败：${raw}`, 'error', 9000);
        return;
      }

      $('cf-token').value = '';
      const missing = result.missingZones || [];

      if (result.listError) {
        setCfError(
          `Token 有效，但读取 Zone 列表失败：${result.listError}\n` +
            '原因通常是 Token 只有 DNS 权限。把权限补上就行（不用重建）：点「改 Token 权限」→ Edit → 加一条「Zone → Zone → Read」→ 保存。'
        );
        toast('Token 有效，但缺少 Zone 读取权限', 'warn', 9000);
      } else if (missing.length && result.zoneCount === 0) {
        // 三个后缀一个都没识别到：十有八九就是缺 Zone:Read
        setCfError(
          `Token 有效，但一个 Zone 都没识别到（${missing.join('、')}）。\n` +
            '最常见的原因：这个 Token 只给了「DNS 编辑」，没给「Zone 读取」——Cloudflare 不允许它列出域名。\n' +
            '修法（30 秒）：点「改 Token 权限」→ 找到这个 Token → Edit → 加一条「Zone → Zone → Read」→ 保存 → 回来点「连接」。\n' +
            '实在不想改 Token，也可以把三个域名的 Zone ID 填进 config.json 的 CF_ZONES（Zone ID 不是密钥）。'
        );
        toast('Token 缺少 Zone 读取权限（这是最安全选项的副作用）', 'warn', 12000);
      } else if (missing.length) {
        setCfError(
          `Token 有效，但这些后缀没找到对应的 Zone：${missing.join('、')}\n` +
            '请确认域名已添加到当前 Cloudflare 账号并处于 Active 状态；分属不同账号时可换对应账号的 Token 再连接一次（会合并）。'
        );
        toast(`已连接，但缺少 Zone：${missing.join('、')}`, 'warn', 9000);
      } else {
        setCfError('');
        toast('Cloudflare 连接成功，三个后缀就绪', 'success', 6000);
      }

      await refreshCf();
      await refreshServers();
    } catch (error) {
      const raw = error.message || String(error);
      setCfError(`连接失败：${raw}`);
      toast(`连接失败：${raw}`, 'error', 9000);
    } finally {
      btn.disabled = false;
      btn.textContent = '连接';
    }
  }

  function setCfError(text) {
    const el = $('cf-error');
    el.textContent = text || '';
    el.classList.toggle('err-text', Boolean(text));
  }

  $('btn-cf-connect').addEventListener('click', connectCf);
  $('cf-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connectCf();
  });
  $('btn-cf-verify').addEventListener('click', async () => {
    const result = await api.cfVerify();
    if (result && result.ok) {
      toast(`Token 有效（${result.tokenStatus}）`, 'success');
      refreshCf();
    } else {
      toast(`检测失败：${(result && result.error) || '未知错误'}`, 'error');
    }
  });

  // ---- 地址 ----

  // ---- 折叠 / 展开 ----

  function toggleSection(boxId, button) {
    const box = $(boxId);
    const hidden = box.classList.toggle('hidden');
    if (button) button.textContent = `${button.dataset.label}${hidden ? '' : '（收起）'}`;
    return !hidden;
  }

  $('btn-toggle-advanced').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.dataset.label = button.dataset.label || '高级设置';
    toggleSection('srv-advanced', button);
  });
  $('btn-toggle-cf').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.dataset.label = button.dataset.label || '设置公网域名';
    const shown = toggleSection('cf-advanced', button);
    if (shown) $('cf-token').focus();
  });
  $('btn-toggle-domains').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.dataset.label = button.dataset.label || '管理域名（绑定我自己的域名）';
    toggleSection('cf-domains', button);
  });

  // ---- 域名管理 ----

  /** 后缀下拉：内置三个 + 用户自己的域名，按需重建（保留当前选择） */
  function renderSuffixOptions() {
    const select = $('srv-suffix');
    const list = Array.isArray(state.suffixes) && state.suffixes.length ? state.suffixes : ['stde.eu.cc'];
    const current = select.value;
    select.innerHTML = '';
    for (const suffix of list) {
      const option = document.createElement('option');
      option.value = suffix;
      option.textContent = suffix;
      select.appendChild(option);
    }
    select.value = list.includes(current) ? current : list[0];
  }

  function renderDomainList() {
    const box = $('cf-domain-list');
    box.innerHTML = '';
    const cf = state.cf || {};
    const builtin = cf.builtinSuffixes || state.suffixes || [];
    const custom = cf.customSuffixes || [];
    for (const suffix of builtin) {
      const chip = document.createElement('span');
      chip.className = 'domain-chip internal';
      chip.textContent = `${suffix}（内置）`;
      box.appendChild(chip);
    }
    for (const suffix of custom) {
      const chip = document.createElement('span');
      chip.className = 'domain-chip';
      const label = document.createElement('span');
      label.textContent = suffix;
      const del = document.createElement('button');
      del.textContent = '解绑';
      del.title = '只删本地绑定，不动 Cloudflare 上的解析记录';
      del.addEventListener('click', async () => {
        if (!window.confirm(`解绑 ${suffix}？\n只会从本机配置里移除，Cloudflare 上的记录不动。`)) return;
        const result = await api.cfRemoveZone(suffix);
        if (result && result.ok) {
          toast(`已解绑 ${suffix}`, 'success');
          await refreshCf();
        } else {
          toast(`解绑失败：${(result && result.error) || '未知错误'}`, 'error');
        }
      });
      chip.append(label, del);
      box.appendChild(chip);
    }

    // 手动解析的域名（DNS 不在 Cloudflare）
    for (const suffix of cf.manualSuffixes || []) {
      const chip = document.createElement('span');
      chip.className = 'domain-chip';
      const label = document.createElement('span');
      label.textContent = `${suffix}（手动解析）`;
      label.title = '开服时启动器会告诉你要在 DNS 后台加哪条 A / SRV 记录';
      const del = document.createElement('button');
      del.textContent = '取消';
      del.addEventListener('click', async () => {
        const result = await api.cfRemoveManualZone(suffix);
        if (result && result.ok) {
          toast(`已取消手动解析登记：${suffix}`, 'success');
          await refreshCf();
        } else {
          toast(`取消失败：${(result && result.error) || '未知错误'}`, 'error');
        }
      });
      chip.append(label, del);
      box.appendChild(chip);
    }
  }

  $('btn-cf-add-manual').addEventListener('click', async () => {
    const suffix = $('cf-manual-input').value.trim();
    if (!suffix) return toast('请填写域名，例如 mydomain.com', 'error');
    const button = $('btn-cf-add-manual');
    button.disabled = true;
    button.textContent = '登记中…';
    try {
      const result = await api.cfAddManualZone(suffix);
      if (!result || !result.ok) {
        toast(`登记失败：${(result && result.error) || '未知错误'}`, 'error', 12000);
        return;
      }
      $('cf-manual-input').value = '';
      toast(`已登记 ${result.suffix}：开服时会在控制台给出要填的 A / SRV 记录`, 'success', 8000);
      await refreshCf();
      $('srv-suffix').value = result.suffix;
    } catch (error) {
      toast(`登记失败：${error.message || error}`, 'error', 12000);
    } finally {
      button.disabled = false;
      button.textContent = '登记手动解析';
    }
  });

  $('btn-cf-add-domain').addEventListener('click', async () => {
    const suffix = $('cf-domain-input').value.trim();
    const zoneId = $('cf-domain-zone').value.trim();
    if (!suffix) return toast('请填写域名，例如 mydomain.com', 'error');
    const button = $('btn-cf-add-domain');
    button.disabled = true;
    button.textContent = '绑定中…';
    try {
      const result = await api.cfAddZone({ suffix, zoneId });
      if (!result || !result.ok) {
        toast(`绑定失败：${(result && result.error) || '未知错误'}`, 'error', 12000);
        return;
      }
      toast(`已绑定 ${result.suffix}`, 'success');
      if (result.warning) toast(result.warning, 'warn', 12000);
      $('cf-domain-input').value = '';
      $('cf-domain-zone').value = '';
      await refreshCf();
      $('srv-suffix').value = result.suffix;
    } catch (error) {
      toast(`绑定失败：${error.message || error}`, 'error', 12000);
    } finally {
      button.disabled = false;
      button.textContent = '添加';
    }
  });

  // ---- 地址 / 公网暴露提示 ----

  function composeAddress() {
    const prefix = normalizePrefix($('srv-prefix').value);
    const suffix = $('srv-suffix').value || state.suffixes[0];
    return prefix ? `${prefix}.${suffix}` : '';
  }
  function updateAddressPreview() {
    $('srv-address').textContent = composeAddress() || '填写前缀后自动生成';
    updateExposeWarning();
  }

  /** 勾了「创建解析」= 这个服务器会上公网，把风险讲清楚（不拦着，只提醒） */
  function updateExposeWarning() {
    const el = $('srv-expose-warn');
    const address = composeAddress();
    const wantsDns = $('srv-enable-dns').checked && Boolean(address);
    if (!wantsDns) {
      el.textContent = address
        ? '没有勾「创建解析」：这台服务器只在局域网可见，同一个 WiFi 下的朋友用「局域网地址」就能进。'
        : '';
      el.classList.remove('err-text');
      return;
    }
    const online = $('srv-online-mode').checked;
    const whitelist = $('srv-whitelist').checked;
    const risks = [];
    if (!online) risks.push('正版验证已关（任何人可以冒用别人的名字）');
    if (!whitelist) risks.push('白名单已关（知道域名的人都能进）');
    el.textContent = risks.length
      ? `创建解析后 ${address} 会暴露到公网 —— 当前${risks.join('，')}。建议至少开一个。`
      : `创建解析后 ${address} 会暴露到公网：已开启正版验证 + 白名单，只有名单上的正版玩家能进。`;
    el.classList.toggle('err-text', risks.length > 0);
  }

  function updateLanTag() {
    const el = $('srv-lan-tag');
    api.serverLan()
      .then((result) => {
        const ip = result && result.ok ? result.ip : '';
        el.textContent = ip ? `局域网地址：${ip}:${$('srv-port').value || '25565'}` : '没检测到局域网地址';
        el.title = ip ? '同一个 WiFi 下的朋友可以直接用这个地址连（点一下复制）' : '';
        el.className = `tag ${ip ? 'ok' : ''}`;
        el.style.cursor = ip ? 'pointer' : '';
        el.onclick = ip ? () => copyText(`${
          (result && result.ok ? result.ip : '')
        }:${$('srv-port').value || '25565'}`) : null;
      })
      .catch(() => {
        el.textContent = '局域网地址未知';
      });
  }

  // ---- 联机可达性（新手引导） ----

  const NAT_LABEL = {
    public: '有公网 IP',
    'double-nat': '两层 NAT',
    cgnat: '运营商大内网',
    ipv6: '有公网 IPv6',
    unknown: '情况不明',
  };

  function renderNet(report) {
    if (!report) return;
    const badge = $('net-verdict');
    const mapped = report.mapping && report.mapping.ok;
    badge.textContent = `联机检查：${NAT_LABEL[report.nat] || report.nat}${mapped ? ` · 端口 ${report.port} 已自动映射` : ''}`;
    badge.className = `tag ${report.nat === 'public' || report.nat === 'ipv6' ? 'ok' : report.nat === 'unknown' ? 'warn' : 'err'}`;
    badge.title = report.reason || '';

    const list = $('net-advice');
    list.innerHTML = '';
    for (const line of report.advice || []) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
    list.classList.remove('hidden');

    // 只有"有公网 IP / 情况不明 / 两层 NAT"才值得试 UPnP 自动映射
    $('btn-net-map').classList.toggle('hidden', !['public', 'unknown', 'double-nat'].includes(report.nat));
    $('btn-net-unmap').classList.toggle('hidden', !mapped);
    if (report.mapping && report.mapping.error) {
      toast(`自动映射失败：${report.mapping.error}`, 'warn', 10000);
    }
  }

  $('btn-net-check').addEventListener('click', async () => {
    const button = $('btn-net-check');
    button.disabled = true;
    button.textContent = '检查中…';
    try {
      const report = await api.netReport({ port: Number($('srv-port').value) || 25565 });
      renderNet(report);
      if (report && report.mapping && report.mapping.ok) {
        toast(`端口 ${report.port} 已自动映射到 ${report.lanIp}`, 'success', 8000);
      }
    } catch (error) {
      toast(`联机检查失败：${error.message || error}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '检查我能不能被别人连';
    }
  });

  $('btn-net-probe').addEventListener('click', async () => {
    const button = $('btn-net-probe');
    const line = $('net-probe-result');
    const port = Number($('srv-port').value) || 25565;
    button.disabled = true;
    button.textContent = '探测中…';
    try {
      const result = await api.netProbe({ port });
      const parts = (result.attempts || []).map((item) => {
        const where = item.label || item.host;
        const state =
          item.state === 'open'
            ? `✅ ${item.ms}ms`
            : item.state === 'closed'
              ? '❌ 连不上'
              : item.state === 'timeout'
                ? '⏱ 超时'
                : `❌ ${item.code || '失败'}`;
        return `${where} ${state}`;
      });
      line.textContent = [result.summary, parts.join(' · ')].filter(Boolean).join('　｜　');
      line.classList.remove('hidden');
      line.classList.toggle('err-text', result.verdict === 'blocked' || result.verdict === 'down');
      if (!result.hasExternal) {
        toast('没配 Worker 时只能本机自测；想拿到「外部视角」需要在 worker/wrangler.toml 里部署后填 PROXY_URL', 'info', 10000);
      }
      if (result.verdict === 'reachable') toast('公网可达：外面已经能连进来了 🎉', 'success', 8000);
      if (result.verdict === 'blocked') toast('外面连不进来：端口映射没生效，或被防火墙/运营商拦了', 'warn', 10000);
    } catch (error) {
      line.textContent = `探测失败：${error.message || error}`;
      line.classList.remove('hidden');
      line.classList.add('err-text');
    } finally {
      button.disabled = false;
      button.textContent = '测一下外面能不能连进来';
    }
  });

  // ---- 自建中继（内网穿透）----
  const RELAY_LABEL = { off: '未开启', host: '隧道已开', guest: '代理已开', error: '出错' };

  // 中继地址由主进程按「config.json → 内置默认值」给出来；用户改过就不再覆盖
  let relayUrlTouched = false;

  function applyRelayUrl(value) {
    const input = $('relay-url');
    if (!input || relayUrlTouched) return;
    const next = String(value || '').trim();
    if (next && !input.value.trim()) input.value = next;
  }

  $('relay-url').addEventListener('input', () => {
    relayUrlTouched = true;
  });

  function renderRelay(status) {
    const tag = $('relay-state');
    const parts = [];
    if (status && status.host) parts.push(`隧道 ${status.host.room}${status.host.key ? '·口令' : ''}`);
    if (status && status.guest) parts.push(`本地代理 ${status.guest.address}`);
    tag.textContent = `内网穿透：${parts.length ? parts.join(' · ') : RELAY_LABEL.off}`;
    tag.className = `tag ${status && (status.host || status.guest) ? 'ok' : ''}`;
    $('btn-relay-host').classList.toggle('hidden', Boolean(status && status.host));
    $('btn-relay-host-stop').classList.toggle('hidden', !(status && status.host));
    $('btn-relay-join').classList.toggle('hidden', Boolean(status && status.guest));
    $('btn-relay-join-stop').classList.toggle('hidden', !(status && status.guest));
  }

  async function refreshRelay() {
    try {
      renderRelay(await api.relayStatus());
    } catch {
      /* 忽略 */
    }
  }

  $('btn-relay-host').addEventListener('click', async () => {
    const button = $('btn-relay-host');
    const room = $('relay-room').value.trim() || (await api.relaySuggestRoom($('srv-prefix').value || 'mc')).room;
    $('relay-room').value = room;
    const relayUrl = $('relay-url').value.trim();
    button.disabled = true;
    button.textContent = '连接中…';
    try {
      const result = await api.relayHostStart({
        room,
        key: $('relay-key').value.trim(),
        relayUrl,
        port: Number($('srv-port').value) || 25565,
      });
      if (!result || !result.ok) return toast(`开隧道失败：${(result && result.error) || '未知错误'}`, 'error', 12000);
      toast(`隧道已开：房间「${result.room}」，把房间号和口令一起发给朋友`, 'success', 10000);
      await refreshRelay();
    } catch (error) {
      toast(`开隧道失败：${error.message || error}`, 'error', 12000);
    } finally {
      button.disabled = false;
      button.textContent = '开隧道';
    }
  });

  $('btn-relay-host-stop').addEventListener('click', async () => {
    await api.relayHostStop();
    toast('隧道已关闭', 'success');
    await refreshRelay();
  });

  $('btn-relay-join').addEventListener('click', async () => {
    const room = $('relay-room').value.trim();
    if (!room) return toast('先填房间号（朋友开隧道时给你的）', 'error');
    const button = $('btn-relay-join');
    button.disabled = true;
    button.textContent = '连接中…';
    try {
      const result = await api.relayGuestStart({
        room,
        key: $('relay-key').value.trim(),
        relayUrl: $('relay-url').value.trim(),
      });
      if (!result || !result.ok) return toast(`加入失败：${(result && result.error) || '未知错误'}`, 'error', 12000);
      toast(`已加入房间「${result.room}」，MC 里连 ${result.address}`, 'success', 15000);
      await refreshRelay();
    } catch (error) {
      toast(`加入失败：${error.message || error}`, 'error', 12000);
    } finally {
      button.disabled = false;
      button.textContent = '我是玩家，加入房间';
    }
  });

  $('btn-relay-join-stop').addEventListener('click', async () => {
    await api.relayGuestStop();
    toast('本地代理已关闭', 'success');
    await refreshRelay();
  });

  $('btn-net-map').addEventListener('click', async () => {    const button = $('btn-net-map');
    button.disabled = true;
    button.textContent = '映射中…';
    try {
      const report = await api.netReport({ port: Number($('srv-port').value) || 25565, tryMap: true });
      renderNet(report);
      if (report && report.mapping && report.mapping.ok) {
        toast(`已把 TCP ${report.port} 映射到 ${report.mapping.internalIp}，朋友现在能连 ${report.publicIp || '你的公网 IP'}:${report.port}`, 'success', 10000);
      } else if (report && report.mapping) {
        toast(`自动映射没成功：${report.mapping.error || '路由器拒绝'}`, 'warn', 12000);
      }
    } catch (error) {
      toast(`映射失败：${error.message || error}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '自动映射端口';
    }
  });

  $('btn-net-unmap').addEventListener('click', async () => {
    const result = await api.netUnmap(Number($('srv-port').value) || 25565);
    if (result && result.ok) toast('已取消端口映射', 'success');
    else toast(`取消失败：${(result && result.error) || '路由器没响应'}`, 'warn');
    $('btn-net-unmap').classList.add('hidden');
  });

  /**
   * 公网直连地址：没有任何 Cloudflare 账号的人，用「公网 IP:端口」也能让别人进（要端口映射）。
   * 这也是"普通用户没有 Token"时最省事的公网方案。
   */
  async function updatePublicTag() {    const el = $('srv-public-tag');
    const port = $('srv-port').value || '25565';
    el.textContent = '公网直连：检测中…';
    el.className = 'tag';
    el.onclick = null;
    el.style.cursor = '';
    try {
      const result = await api.serverPublicIp();
      const ip = result && result.ok ? result.ip : '';
      if (!ip) {
        el.textContent = '公网直连：探测失败';
        el.title = (result && result.error) || '暂时探测不到你的公网 IP';
        el.className = 'tag warn';
        return;
      }
      if (result.private) {
        el.textContent = '公网直连：你在 NAT 后面';
        el.title = `探测到 ${ip}，属于内网/CGNAT 地址：外面的人连不进来。需要在路由器上做端口映射，或者用 frp/隧道 + PUBLIC_HOST。`;
        el.className = 'tag warn';
        return;
      }
      const address = `${ip}:${port}`;
      el.textContent = `公网直连：${address}`;
      el.title = '把该端口映射/放行到本机后，任何网络的玩家都能用这个地址连（点一下复制）';
      el.className = 'tag ok';
      el.style.cursor = 'pointer';
      el.onclick = () => copyText(address);
    } catch {
      el.textContent = '公网直连：探测失败';
      el.className = 'tag warn';
    }
  }

  $('srv-prefix').addEventListener('input', (event) => {
    const cleaned = normalizePrefix(event.target.value);
    if (event.target.value !== cleaned) event.target.value = cleaned;
    // 白名单默认跟随"是否有域名"：纯局域网默认关，给域名默认开
    const whitelistBox = $('srv-whitelist');
    if (!whitelistBox.dataset.touched) whitelistBox.checked = Boolean(cleaned);
    updateAddressPreview();
  });
  $('srv-suffix').addEventListener('change', updateAddressPreview);
  $('srv-enable-dns').addEventListener('change', (e) => {
    e.target.dataset.touched = '1';
    updateExposeWarning();
  });
  $('srv-online-mode').addEventListener('change', (event) => {
    // 关掉正版验证是危险操作，明确确认一次（正版验证默认开启）
    if (!event.target.checked) {
      const ok = window.confirm(
        '关闭正版验证（online-mode=false）后：\n\n' +
          '· 任何人都可以用任意名字进入服务器，包括冒用别人的名字\n' +
          '· 需要给服务器装 AuthMe 之类的登录插件才安全\n\n确定要关闭吗？'
      );
      if (!ok) {
        event.target.checked = true;
        return;
      }
    }
    updateExposeWarning();
  });
  $('srv-whitelist').addEventListener('change', (event) => {
    event.target.dataset.touched = '1';
    $('srv-whitelist-players').disabled = !$('srv-whitelist').checked;
    updateExposeWarning();
  });
  $('srv-whitelist-players').addEventListener('focus', () => {
    if (!$('srv-whitelist-players').value && state.account && state.account.name) {
      $('srv-whitelist-players').value = state.account.name;
    }
  });

  /** 白名单默认填当前登录的账号名（自己先能进） */
  function fillWhitelistFromAccount() {
    const input = $('srv-whitelist-players');
    if (input.value.trim()) return;
    if (state.account && state.account.name) input.value = state.account.name;
  }
  $('srv-port').addEventListener('change', () => {
    updateLanTag();
    updatePublicTag();
  });
  $('btn-copy-address').addEventListener('click', () => {
    const server = selectedServer();
    copyText((server && server.address) || composeAddress());
  });

  // ---- 启动 / 停止 / 日志 ----

  function showServerProgress(percent, text) {
    $('srv-progress').classList.remove('hidden');
    const bar = $('srv-progress-bar');
    if (typeof percent !== 'number') bar.classList.add('indeterminate');
    else {
      bar.classList.remove('indeterminate');
      bar.style.setProperty('--p', `${Math.max(2, Math.min(100, percent))}%`);
    }
    $('srv-progress-text').textContent = text || '';
  }
  function hideServerProgress() {
    $('srv-progress').classList.add('hidden');
    $('srv-progress-bar').classList.remove('indeterminate');
    $('srv-progress-bar').style.setProperty('--p', '0%');
    $('srv-progress-text').textContent = '';
  }

  $('btn-start-server').addEventListener('click', async () => {
    const core = $('srv-core').value;
    const version = $('srv-version').value.trim();
    const maxMemory = $('srv-memory').value.trim().toUpperCase();
    const port = Number($('srv-port').value);
    const prefix = normalizePrefix($('srv-prefix').value);
    const enableDns = $('srv-enable-dns').checked && Boolean(prefix);
    const onlineMode = $('srv-online-mode').checked;
    const whitelist = $('srv-whitelist').checked;
    const whitelistPlayers = $('srv-whitelist-players').value;

    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) return toast('版本格式不正确，例如 1.20.4', 'error');
    if (!/^\d{1,5}[MG]$/.test(maxMemory)) return toast('内存格式不正确，例如 2G', 'error');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('端口不合法', 'error');
    if (enableDns && !(state.cf && state.cf.configured)) return toast('Cloudflare 未连接（也没有配置 Worker 代理）', 'error');

    // 白名单开了但没人 → 自己也进不去，先问一次
    if (whitelist && !String(whitelistPlayers).trim()) {
      const ok = window.confirm(
        '白名单已开启，但名单是空的 —— 这样你自己也进不去。\n\n' +
          '建议先在「白名单玩家」里填上自己的游戏名（空格或逗号分隔可填多个）。\n\n' +
          '要继续以空名单启动吗？'
      );
      if (!ok) {
        $('srv-whitelist-players').focus();
        return;
      }
    }
    // 公网 + 既不验证正版又不设白名单 → 最危险组合，再确认一次
    if (enableDns && !onlineMode && !whitelist) {
      const ok = window.confirm(
        `即将把服务器暴露到公网（${prefix}.${$('srv-suffix').value}），\n` +
          '但你同时关掉了正版验证和白名单 —— 任何人都能进，还能冒用别人的名字。\n\n确定继续吗？'
      );
      if (!ok) return;
    }

    showServerProgress(null, '准备中…');
    $('server-log').innerHTML = '';
    try {
      const result = await api.serverStart({
        core,
        version,
        maxMemory,
        port,
        prefix,
        suffix: $('srv-suffix').value,
        enableDns,
        onlineMode,
        whitelist,
        whitelistPlayers,
        removeDnsOnStop: $('srv-remove-dns').checked,
      });
      if (result && result.ok) {
        state.selectedServerId = result.server.id;
        toast(`服务器已启动：${result.server.address || result.server.id}`, 'success', 6000);
        await refreshServers();
        renderServerMenu();
        await loadServerLogs(state.selectedServerId);
      } else {
        toast(`启动失败：${(result && result.error) || '未知错误'}`, 'error', 9000);
      }
    } catch (error) {
      toast(`启动失败：${error.message || error}`, 'error', 9000);
    } finally {
      hideServerProgress();
      await refreshServers();
    }
  });

  async function stopServer() {
    if (!state.selectedServerId) return toast('请先选择服务器', 'error');
    showServerProgress(null, '正在停止…');
    try {
      const result = await api.serverStop(state.selectedServerId);
      if (result && result.ok) toast('已停止', 'success');
      else toast(`停止失败：${(result && result.error) || '未知错误'}`, 'error');
    } finally {
      hideServerProgress();
      await refreshServers();
    }
  }
  $('btn-stop-server').addEventListener('click', stopServer);
  $('det-stop').addEventListener('click', stopServer);

  $('det-start').addEventListener('click', async () => {
    const server = selectedServer();
    if (!server) return;
    showServerProgress(null, '正在启动…');
    try {
      const result = await api.serverStart({ id: server.id });
      if (result && result.ok) toast('服务器已启动', 'success');
      else toast(`启动失败：${(result && result.error) || '未知错误'}`, 'error', 9000);
    } finally {
      hideServerProgress();
      await refreshServers();
    }
  });

  $('det-delete').addEventListener('click', async () => {
    const server = selectedServer();
    if (!server) return;
    if (!window.confirm(`删除服务器「${server.name || server.id}」？\n会删除本地存档与 DNS 记录。`)) return;
    const result = await api.serverDelete(server.id, { deleteFiles: true, removeDns: true });
    if (result && result.ok) {
      state.selectedServerId = null;
      $('server-log').innerHTML = '';
      toast('已删除', 'success');
    } else {
      toast(`删除失败：${(result && result.error) || '未知错误'}`, 'error');
    }
    await refreshServers();
  });

  $('det-dns-sync').addEventListener('click', async () => {
    if (!state.selectedServerId) return;
    const result = await api.serverSyncDns(state.selectedServerId);
    if (result && result.ok) toast(`解析已生效：${result.dns.address}`, 'success');
    else toast(`解析失败：${(result && result.error) || '未知错误'}`, 'error', 9000);
    await refreshServers();
  });

  $('det-dns-remove').addEventListener('click', async () => {
    if (!state.selectedServerId) return;
    if (!window.confirm('删除该服务器的 DNS 解析？')) return;
    const result = await api.serverRemoveDns(state.selectedServerId);
    if (result && result.ok) toast('解析已删除', 'success');
    else toast(`删除失败：${(result && result.error) || '未知错误'}`, 'error');
    await refreshServers();
  });

  $('det-folder').addEventListener('click', async () => {
    if (!state.selectedServerId) return;
    const result = await api.serverOpenFolder(state.selectedServerId);
    if (result && !result.ok) toast(`打开失败：${result.error}`, 'error');
  });

  $('det-copy-lan').addEventListener('click', () => {
    const server = selectedServer();
    const lan = server && server.lanAddress;
    if (!lan) return toast('没有检测到局域网地址', 'error');
    copyText(`${lan}:${server.port || ''}`);
  });

  $('det-whitelist-save').addEventListener('click', async () => {
    const server = selectedServer();
    if (!server) return;
    const button = $('det-whitelist-save');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      const players = $('det-whitelist-players').value;
      const enabled = $('det-whitelist-enabled').checked;
      if (enabled && !String(players).trim()) {
        const ok = window.confirm('白名单会开启但名单为空，谁都进不来。确定保存吗？');
        if (!ok) return;
      }
      const result = await api.serverWhitelist(server.id, { players, whitelist: enabled });
      if (!result || !result.ok) {
        toast(`保存失败：${(result && result.error) || '未知错误'}`, 'error', 9000);
        return;
      }
      if (result.skipped && result.skipped.length) {
        toast(`忽略了不合法的名字：${result.skipped.slice(0, 3).join('、')}`, 'warn', 8000);
      }
      toast(
        `白名单已保存：${result.players.length} 人（${result.applied === 'live' ? '已立即生效' : '下次开服生效'}）`,
        'success',
        7000
      );
      for (const warning of result.warnings || []) toast(warning, 'warn', 10000);
      await refreshServers();
    } catch (error) {
      toast(`保存失败：${error.message || error}`, 'error', 9000);
    } finally {
      button.disabled = false;
      button.textContent = '保存白名单';
    }
  });

  function appendLogLine(entry) {
    const log = $('server-log');
    const line = document.createElement('div');
    line.className = `log-line log-${entry.level || 'info'}`;
    const time = new Date(entry.ts || Date.now());
    const stamp = [time.getHours(), time.getMinutes(), time.getSeconds()]
      .map((n) => String(n).padStart(2, '0')).join(':');
    line.textContent = `[${stamp}] ${entry.line}`;
    log.appendChild(line);
    while (log.childElementCount > 1200) log.removeChild(log.firstChild);
    if ($('srv-autoscroll').checked) log.scrollTop = log.scrollHeight;
  }

  async function loadServerLogs(id) {
    $('server-log').innerHTML = '';
    try {
      const entries = await api.serverLogs(id);
      (Array.isArray(entries) ? entries : []).forEach(appendLogLine);
      $('server-log').scrollTop = $('server-log').scrollHeight;
    } catch {
      /* ignore */
    }
  }

  $('btn-clear-log').addEventListener('click', () => {
    $('server-log').innerHTML = '';
  });

  async function sendCommand() {
    const input = $('srv-command');
    const command = input.value.trim();
    if (!state.selectedServerId) return toast('请先选择服务器', 'error');
    if (!command) return;
    const result = await api.serverCommand(state.selectedServerId, command);
    if (result && result.ok) input.value = '';
    else toast((result && result.error) || '发送失败', 'error');
  }
  $('btn-send-command').addEventListener('click', sendCommand);
  $('srv-command').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
    }
  });

  // =========================================================================
  // 事件
  // =========================================================================

  api.onServerLog((payload) => {
    if (!payload || payload.serverId !== state.selectedServerId) return;
    appendLogLine(payload);
  });

  api.onServerStatus(({ serverId, status }) => {
    const server = state.servers.find((s) => s.id === serverId);
    if (server) {
      server.status = status;
      server.running = ['starting', 'online', 'stopping'].includes(status);
    }
    renderServerMenu();
    if (serverId === state.selectedServerId) renderServerDetail();
    if (status === 'stopped' || status === 'deleted') refreshServers();
  });

  api.onServerProgress((payload) => {
    if (!payload) return;
    if (payload.stage === 'error') return showServerProgress(100, `失败：${payload.message || ''}`);
    if (payload.stage === 'done') return hideServerProgress();
    if (!state.selectedServerId && payload.serverId !== state.selectedServerId && !payload.percent) {
      /* 启动早期还没有 serverId 关联，仍然展示进度 */
    }
    const detail = payload.detail ? ` ${payload.detail}` : '';
    showServerProgress(typeof payload.percent === 'number' ? payload.percent : null, `${payload.message || '处理中…'}${detail}`);
  });

  api.onServerReady(({ serverId, address, port }) => {
    if (serverId === state.selectedServerId) toast(`服务器已就绪${address ? `：${address}` : ''}（${port}）`, 'success', 6000);
    refreshServers();
  });

  api.onServerDns((payload) => {
    if (payload && payload.ok === false) toast(`域名解析失败：${payload.error || ''}`, 'error', 8000);
    if (payload && payload.ok && payload.manual) {
      toast(`手动解析：${payload.dns.address} 需要在 DNS 后台加 ${payload.dns.records.length} 条记录（见控制台）`, 'warn', 12000);
    } else if (payload && payload.ok && payload.dns) {
      toast(`解析已创建：${payload.dns.address}`, 'success');
    }
    refreshServers();
  });

  // =========================================================================
  // 初始化
  // =========================================================================

  async function loadJavaInfo() {
    try {
      const info = await api.serverJava();
      $('java-info').textContent = info && info.exe
        ? `Java ${info.version ? info.version.major : '?'} · ${info.exe.split(/[\\/]/).pop()}`
        : '未检测到 Java';
      $('java-info').title = (info && info.exe) || '';
    } catch {
      $('java-info').textContent = 'Java 检测失败';
    }
  }

  async function loadAppInfo() {
    try {
      const info = await api.appInfo();
      $('app-meta').textContent = `v${info.version} · Electron ${info.electron || '?'}`;
      $('app-meta').title = info.logFile || '';
    } catch {
      $('app-meta').textContent = 'Viskluke';
    }
  }

  $('btn-open-log').addEventListener('click', async () => {
    const result = await api.openLog();
    if (result && result.ok) toast(`日志：${result.file}`, 'info', 6000);
    else toast(`打开失败：${(result && result.error) || ''}`, 'error');
  });

  async function bootstrap() {
    renderAccount();
    showPage('instances');
    await Promise.allSettled([refreshInstances(), refreshCf(), refreshServers()]);
    if (state.instances.length && state.instances[0].version) $('dl-version').value = state.instances[0].version;
    loadJavaInfo();
    loadAppInfo();
  }

  bootstrap();
})();
