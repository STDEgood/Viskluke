'use strict';

/**
 * 渲染层：皮肤绘制器（64×64 皮肤 / 64×32 披风的像素画板）
 *
 * 纯 canvas，无第三方依赖。功能：
 *   画笔 / 橡皮 / 油漆桶 / 吸管、左右对称、网格、撤销重做、
 *   「经典 / 纤细打底」标准 UV 模板、保存进皮肤库。
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.viskluke;

  const SIZE = { skin: { w: 64, h: 64 }, cape: { w: 64, h: 32 } };

  // 标准 64×64 皮肤的 UV 分区：[x, y, w, h, 色块]
  const TEMPLATE_CLASSIC = [
    [8, 0, 8, 8, 'hair'], [16, 0, 8, 8, 'hair'], [0, 8, 8, 8, 'hair'],
    [8, 8, 8, 8, 'face'], [16, 8, 8, 8, 'face'], [24, 8, 8, 8, 'hair'],
    [20, 16, 8, 4, 'shirt'], [28, 16, 8, 4, 'shirt'], [16, 20, 4, 12, 'shirt'],
    [20, 20, 8, 12, 'shirt'], [28, 20, 4, 12, 'shirt'], [32, 20, 8, 12, 'shirt'],
    [44, 16, 4, 4, 'skin'], [48, 16, 4, 4, 'skin'], [40, 20, 4, 12, 'skin'],
    [44, 20, 4, 12, 'skin'], [48, 20, 4, 12, 'skin'], [52, 20, 4, 12, 'skin'],
    [4, 16, 4, 4, 'pants'], [8, 16, 4, 4, 'pants'], [0, 20, 4, 12, 'pants'],
    [4, 20, 4, 12, 'pants'], [8, 20, 4, 12, 'pants'], [12, 20, 4, 12, 'pants'],
    [20, 48, 4, 4, 'pants'], [24, 48, 4, 4, 'pants'], [16, 52, 4, 12, 'pants'],
    [20, 52, 4, 12, 'pants'], [24, 52, 4, 12, 'pants'], [28, 52, 4, 12, 'pants'],
    [36, 48, 4, 4, 'skin'], [40, 48, 4, 4, 'skin'], [32, 52, 4, 12, 'skin'],
    [36, 52, 4, 12, 'skin'], [40, 52, 4, 12, 'skin'], [44, 52, 4, 12, 'skin'],
  ];

  // 纤细模型：手臂只有 3 像素宽
  const TEMPLATE_SLIM_ARM = [
    [44, 16, 3, 4, 'skin'], [47, 16, 3, 4, 'skin'], [40, 20, 3, 12, 'skin'],
    [44, 20, 3, 12, 'skin'], [47, 20, 3, 12, 'skin'], [50, 20, 3, 12, 'skin'],
    [36, 48, 3, 4, 'skin'], [39, 48, 3, 4, 'skin'], [32, 52, 3, 12, 'skin'],
    [36, 52, 3, 12, 'skin'], [39, 52, 3, 12, 'skin'], [42, 52, 3, 12, 'skin'],
  ];

  const COLORS = { hair: '#3b2a1a', face: '#e0ac69', skin: '#e0ac69', shirt: '#3b82f6', pants: '#1f2937' };

  const state = {
    kind: 'skin',
    tool: 'pencil',
    color: '#3b82f6',
    mirror: false,
    undo: [],
    redo: [],
    drawing: false,
    lastPoint: null,
  };

  let canvas = null;
  let ctx = null;

  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = $('editor-canvas');
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    return canvas;
  }

  function resizeFor(kind) {
    const size = SIZE[kind] || SIZE.skin;
    const element = ensureCanvas();
    element.width = size.w;
    element.height = size.h;
    element.style.height = `${Math.round((384 * size.h) / size.w)}px`;
    element.classList.toggle('no-grid', !$('editor-grid').checked);
    element.style.backgroundSize = `${384 / size.w}px ${384 / size.w}px`;
    ctx.clearRect(0, 0, size.w, size.h);
    state.undo = [];
    state.redo = [];
  }

  function snapshot() {
    const element = ensureCanvas();
    return ctx.getImageData(0, 0, element.width, element.height);
  }

  function pushUndo() {
    state.undo.push(snapshot());
    if (state.undo.length > 40) state.undo.shift();
    state.redo.length = 0;
    updateUndoButtons();
  }

  function restore(data) {
    if (!data) return;
    ctx.putImageData(data, 0, 0);
  }

  function updateUndoButtons() {
    $('btn-editor-undo').disabled = state.undo.length === 0;
    $('btn-editor-redo').disabled = state.redo.length === 0;
  }

  function drawTemplate(slim) {
    const element = ensureCanvas();
    pushUndo();
    ctx.clearRect(0, 0, element.width, element.height);
    if (state.kind === 'cape') {
      // 披风标准形状（64×32 图里的 10×16 区域 + 一圈边缘）
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(0, 0, 10, 16);
      ctx.fillStyle = '#b91c1c';
      ctx.fillRect(1, 0, 8, 1);
      return;
    }
    const parts = slim
      ? TEMPLATE_CLASSIC.filter(([x, y, w, h, key]) => key !== 'skin').concat(TEMPLATE_SLIM_ARM)
      : TEMPLATE_CLASSIC;
    for (const [x, y, w, h, key] of parts) {
      ctx.fillStyle = COLORS[key] || '#888';
      ctx.fillRect(x, y, w, h);
    }
  }

  function blank() {
    const element = ensureCanvas();
    pushUndo();
    ctx.clearRect(0, 0, element.width, element.height);
  }

  function pointToPixel(event) {
    const element = ensureCanvas();
    const rect = element.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * element.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * element.height);
    if (x < 0 || y < 0 || x >= element.width || y >= element.height) return null;
    return { x, y };
  }

  function pixelColor(x, y) {
    const data = ctx.getImageData(x, y, 1, 1).data;
    if (data[3] === 0) return '';
    const hex = (n) => n.toString(16).padStart(2, '0');
    return `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`;
  }

  function paintPixel(x, y, color) {
    const element = ensureCanvas();
    if (color === null) {
      ctx.clearRect(x, y, 1, 1);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
    if (state.mirror) {
      const mx = element.width - 1 - x;
      if (mx !== x) {
        if (color === null) ctx.clearRect(mx, y, 1, 1);
        else {
          ctx.fillStyle = color;
          ctx.fillRect(mx, y, 1, 1);
        }
      }
    }
  }

  function floodFill(startX, startY, color) {
    const element = ensureCanvas();
    const width = element.width;
    const height = element.height;
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const index = (x, y) => (y * width + x) * 4;
    const target = [data[index(startX, startY)], data[index(startX, startY) + 1], data[index(startX, startY) + 2], data[index(startX, startY) + 3]];
    const hex = color.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (target[0] === r && target[1] === g && target[2] === b && target[3] === 255) return;

    const stack = [[startX, startY]];
    const seen = new Set();
    while (stack.length) {
      const [x, y] = stack.pop();
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = index(x, y);
      if (data[i] !== target[0] || data[i + 1] !== target[1] || data[i + 2] !== target[2] || data[i + 3] !== target[3]) continue;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    ctx.putImageData(image, 0, 0);
  }

  function stroke(from, to, color) {
    if (!from) return paintPixel(to.x, to.y, color);
    let { x: x0, y: y0 } = from;
    const { x: x1, y: y1 } = to;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let error = dx - dy;
    for (;;) {
      paintPixel(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * error;
      if (e2 > -dy) {
        error -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        error += dx;
        y0 += sy;
      }
    }
  }

  // ---------------- 打开 / 关闭 ----------------

  function openEditor(kind = 'skin') {
    state.kind = SIZE[kind] ? kind : 'skin';
    document.querySelectorAll('input[name="editor-kind"]').forEach((radio) => {
      radio.checked = radio.value === state.kind;
    });
    $('editor-title').textContent = state.kind === 'cape' ? '画披风（64×32）' : '画皮肤（64×64）';
    $('editor-modal').classList.remove('hidden');
    ensureCanvas();
    resizeFor(state.kind);
    drawTemplate(false);
    $('editor-name').value = state.kind === 'cape' ? '我画的披风' : '我画的皮肤';
    updateUndoButtons();
  }

  const closeEditor = () => $('editor-modal').classList.add('hidden');

  // ---------------- 事件绑定 ----------------

  function bindCanvas() {
    const element = ensureCanvas();

    element.addEventListener('contextmenu', (event) => event.preventDefault());

    element.addEventListener('pointerdown', (event) => {
      const point = pointToPixel(event);
      if (!point) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      state.drawing = true;
      state.lastPoint = null;

      if (state.tool === 'picker') {
        const picked = pixelColor(point.x, point.y);
        if (picked) {
          state.color = picked;
          $('editor-color').value = picked;
        }
        state.drawing = false;
        return;
      }
      pushUndo();
      if (state.tool === 'fill') {
        floodFill(point.x, point.y, state.color);
        state.drawing = false;
        return;
      }
      const color = state.tool === 'eraser' || event.button === 2 ? null : state.color;
      paintPixel(point.x, point.y, color);
      state.lastPoint = point;
    });

    element.addEventListener('pointermove', (event) => {
      if (!state.drawing) return;
      const point = pointToPixel(event);
      if (!point) return;
      const color = state.tool === 'eraser' || (event.buttons & 2) ? null : state.color;
      if (state.tool === 'fill') return;
      stroke(state.lastPoint, point, color);
      state.lastPoint = point;
    });

    const stop = () => {
      state.drawing = false;
      state.lastPoint = null;
    };
    element.addEventListener('pointerup', stop);
    element.addEventListener('pointercancel', stop);
    element.addEventListener('pointerleave', stop);
  }

  document.querySelectorAll('input[name="editor-kind"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state.kind = radio.value;
      $('editor-title').textContent = state.kind === 'cape' ? '画披风（64×32）' : '画皮肤（64×64）';
      resizeFor(state.kind);
      drawTemplate(false);
      updateUndoButtons();
    });
  });

  document.querySelectorAll('.tool').forEach((button) => {
    button.addEventListener('click', () => {
      state.tool = button.dataset.tool;
      document.querySelectorAll('.tool').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  $('editor-color').addEventListener('input', (event) => {
    state.color = event.target.value;
  });
  $('editor-mirror').addEventListener('change', (event) => {
    state.mirror = event.target.checked;
  });
  $('editor-grid').addEventListener('change', (event) => {
    ensureCanvas().classList.toggle('no-grid', !event.target.checked);
  });
  $('btn-editor-undo').addEventListener('click', () => {
    const previous = state.undo.pop();
    if (!previous) return;
    state.redo.push(snapshot());
    restore(previous);
    updateUndoButtons();
  });
  $('btn-editor-redo').addEventListener('click', () => {
    const next = state.redo.pop();
    if (!next) return;
    state.undo.push(snapshot());
    restore(next);
    updateUndoButtons();
  });
  $('btn-editor-blank').addEventListener('click', blank);
  $('btn-editor-template-classic').addEventListener('click', () => drawTemplate(false));
  $('btn-editor-template-slim').addEventListener('click', () => drawTemplate(true));

  (function buildPalette() {
    const palette = $('editor-palette');
    const colors = [
      '#000000', '#ffffff', '#9ca3af', '#e0ac69', '#3b2a1a', '#b91c1c',
      '#dc2626', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#8b5cf6',
    ];
    for (const color of colors) {
      const button = document.createElement('button');
      button.style.background = color;
      button.title = color;
      button.addEventListener('click', () => {
        state.color = color;
        $('editor-color').value = color;
      });
      palette.appendChild(button);
    }
  })();

  $('btn-editor-save').addEventListener('click', async () => {
    const button = $('btn-editor-save');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      const element = ensureCanvas();
      // 空画布不让存，避免往库里塞透明图
      const data = ctx.getImageData(0, 0, element.width, element.height).data;
      let painted = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) {
          painted = true;
          break;
        }
      }
      if (!painted) {
        window.alert('画布还是空的，先画点东西吧');
        return;
      }
      const result = await api.skinSaveDrawing({
        dataUrl: element.toDataURL('image/png'),
        name: $('editor-name').value.trim() || (state.kind === 'cape' ? '我画的披风' : '我画的皮肤'),
        kind: state.kind,
        model: 'classic',
      });
      if (!result || !result.ok) {
        window.alert(`保存失败：${(result && result.error) || '未知错误'}`);
        return;
      }
      closeEditor();
      window.__visklukeOnSkinSaved && window.__visklukeOnSkinSaved(result.skin);
    } catch (error) {
      window.alert(`保存失败：${error.message || error}`);
    } finally {
      button.disabled = false;
      button.textContent = '保存到皮肤库';
    }
  });

  $('btn-close-editor').addEventListener('click', closeEditor);
  $('editor-modal').addEventListener('click', (event) => {
    if (event.target === $('editor-modal')) closeEditor();
  });

  // 供主界面调用
  window.__visklukeOpenSkinEditor = { open: openEditor, bindCanvas };
})();
