// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LucasHe1015
/* ==========================================================================
   S.P.E.C. 7 // STATION FOR PROMPT EDITING & COMPOSITION — front-end controller
   Vanilla JS. Talks to server.py for LLM / NMT engines, uses Chrome's
   built-in Translator API or the offline glossary when asked to.
   ========================================================================== */

(() => {
  'use strict';

  /* ----------------------------------------------------------------------- */
  /* state & elements                                                        */
  /* ----------------------------------------------------------------------- */

  const state = {
    view: 'translate',
    config: null,
    health: null,
    chromeAvailability: null, // null | available | downloadable | downloading | unavailable | unsupported
    chromeTranslators: {},
    glossary: null,
    glossaryPromise: null,
    glossaryDirty: false,
    glossaryRendered: false,
    glossaryRows: [],                 // [{ en, zh }] 编辑真源，顺序即词条库顺序
    glossaryView: [],                 // 过滤后行的索引，滚动窗口按它取行
    glossaryReverse: null,            // Map<归一化中文, { en, zh }> 反向查表
    glossaryWindow: { start: -1, end: -1 },
    glossaryScrollTop: 0,             // 切走再切回时恢复滚动位置
    glossaryRowH: 0,                  // 实测行高（0 = 尚未测量）
    glossaryEntered: false,           // 首次进入是否已播过 stagger
    historyRecords: null,
    favoriteRecords: null,
    recordMode: null,
    characters: null,
    galleryWorks: null,
    galleryPreviewData: null,
    galleryEditingId: null,
    activeCharacterId: null,
    characterDirty: false,
    characterPortraitData: null,
    characterCreating: false,
    characterMode: 'gallery',
    wardrobe: null,
    wardrobeEditingId: null,
    wardrobePreviewData: null,
    wardrobeInlineEditId: null,
    wardrobeInlinePreviewData: null,
    wardrobeInlineDraft: null,
    wardrobeInlineDirty: false,
    wardrobeDirty: false,
    characterDragId: null,
    characterGroups: [],
    characterCombo: [],
    characterComboTags: [],
    characterComboWardrobe: [],
    selectedCharacterTags: new Set(),
    characterGroupEditingId: null,
    presets: null,
    blocks: null,
    translations: {},
    text: '',
    translatedText: '',
    phase: 'idle', // idle | translating | done | error
    progressText: '',
    lastEngine: '',
    warnings: [],
    error: null,
    favoriteSourceId: null,
    settingsOpen: false,
    toastTimer: null,
    draftTimer: null,
    editing: null,
    selectedBlockId: null,            // 单击选中的词块/句块，Backspace · Delete 删除
    pendingIds: new Set(),
    syncingIds: new Set(),
    docVersion: 0,
    glossaryAdd: {                   // 「添加入词库」：选择态 / 确认浮窗
      picking: false,
      picks: new Set(),              // 已勾选的词块 bid
      open: false,
      rows: [],                      // 浮窗中待写入的行 { bid, en, zh }
      busy: false,
      dragArmed: false,              // 正在拖动词块 → 按钮显示“在此释放以添加”
      returnFocus: null,
    },
  };

  const history = {
    stack: [],
    restoring: false,
    last: null,
    textBurst: null,
    max: 40,
    programmaticUndo: false,
    programmaticTarget: null,
  };

  const sessions = {
    list: [],
    activeId: null,
    max: 10,
  };
  const sessionSignatures = new Map();
  const HISTORY_LIMIT = 25;

  let dragBlockId = null;

  /* 拖拽兜底：某些情况下 dragBlockId 会被提前清空（dragend 抢先、跨面板/跨窗口），
     此时从 dataTransfer 里读回词块 id，保证「拖到按钮上松手」仍能进确认浮窗。 */
  /* 拖拽落点的 dropEffect 必须与拖拽源的 effectAllowed 匹配，否则浏览器会拒绝 drop
     （松手后既不派发 drop 也没有任何反馈）。这里按源允许的操作挑一个合法值。 */
  function pickDropEffect(event) {
    try {
      const allowed = event.dataTransfer && event.dataTransfer.effectAllowed;
      if (!allowed || allowed === 'uninitialized' || allowed === 'all') return 'move';
      if (allowed === 'move' || allowed === 'copyMove' || allowed === 'linkMove') return 'move';
      if (allowed === 'copy' || allowed === 'copyLink') return 'copy';
      if (allowed === 'link') return 'link';
      return 'move';
    } catch { return 'move'; }
  }

  function readDraggedBid(event) {
    try {
      const raw = event.dataTransfer && event.dataTransfer.getData('text/plain');
      if (raw && findBlock(raw)) return raw;
    } catch { /* ignore */ }
    return null;
  }

  let unloadInFlight = false;
  let translateAbortController = null;
  let translateRunId = 0;
  let hoveredExampleId = null;
  let recordEditingId = null;
  let suppressRecordOpenUntil = 0;
  let hardwareBusy = false;
  let hoveredCharacterPortrait = false;
  let hoveredGalleryPreview = false;
  let sourceSyncTimer = null;
  let sourceSyncRunning = false;
  let sourceSyncSeq = 0;
  const SOURCE_SYNC_DELAY = 5000;
  let sessionRenameId = null;
  let sessionTabIds = [];          /* 上一轮渲染的会话 id：只给新出现的标签播 pop */
  let suppressSessionClickUntil = 0;
  let characterTagPointer = null;
  let suppressCharacterTagClickUntil = 0;
  let characterComboPointer = null;
  let wardrobeReturnMode = 'gallery';
  let wardrobeDragId = null;
  let suppressWardrobeClickUntil = 0;
  let hoveredWardrobePreview = false;
  let pendingPreviewImageClick = null;
  let imageViewerReturnFocus = null;
  let wardrobeInlineImageTargetId = null;
  let hoveredWardrobeInlinePreviewId = null;
  let characterPresetEditing = false;
  let presetEditingId = null;
  let confirmResolver = null;
  let confirmPreviousFocus = null;
  const actionUndoStack = [];
  const ACTION_UNDO_MAX = 30;
  let actionUndoRunning = false;

  const el = {};
  const IDS = [
    'engineChip', 'engineLed', 'engineChipText', 'engineChipSub', 'engineBayBtn', 'helpBtn',
    'bayCode', 'bayName', 'bayCn',
    'viewTranslate', 'viewCard', 'viewGlossary', 'viewGallery', 'galleryHome', 'galleryAddView', 'galleryList', 'galleryMeta',
    'galleryAddBtnTop', 'galleryBackBtn', 'gallerySaveBtn',
    'galleryPreviewFrame', 'galleryPreviewImg', 'galleryPreviewEmpty',
    'galleryPreviewDimensions', 'galleryPreviewInput', 'galleryTitle', 'galleryCharacter', 'gallerySource',
    'galleryAddTitle', 'galleryAddTitleEn',
    'gallerySeed', 'galleryArtist', 'gallerySubject', 'galleryQuality', 'galleryLoras', 'workspace', 'panels',
    'sessionBar', 'sessionTabs', 'sessionCount',
    'historyBtn', 'favoriteBtn', 'historyCount', 'favoriteCount',
    'hwStrip', 'hwCpuRing', 'hwCpuVal', 'hwRamRing', 'hwRamVal',
    'hwGpuRing', 'hwGpuVal', 'hwVramRing', 'hwVramVal', 'hwLive', 'hwLiveText', 'hwUnloadBtn',
    'viewHistory', 'viewFavorite', 'historyList', 'favoriteList',
    'historyMeta', 'favoriteMeta', 'historyList', 'favoriteList',
    'glossaryMeta', 'glossarySearch', 'glossaryNewEn', 'glossaryNewZh', 'glossaryAddBtn',
    'glossarySaveBtn', 'glossaryReloadBtn', 'glossaryDirty', 'glossaryList',
    'glossaryVisibleMeta', 'glossaryFormCount',
    'characterSelect', 'characterNewBtn', 'characterDeleteBtn', 'characterMeta',
    'characterPicker', 'characterPickerTrigger',
    'characterPickerName', 'characterPickerSource', 'characterPickerPanel',
    'characterPickerCount', 'characterPickerList',
    'characterPortrait', 'characterPortraitImg', 'characterPortraitEmpty',
    'characterPortraitInput', 'characterName', 'characterSource',
    'characterTags', 'characterTagPreview', 'characterNotes',
    'characterDirty', 'characterStatus', 'characterApplyBtn', 'characterSaveBtn',
    'characterEditBody', 'characterEditFoot', 'characterCreateMode',
    'characterGallery', 'characterGalleryGrid', 'characterBackBtn', 'characterShell',
    'characterWardrobeBtn', 'characterWardrobe', 'wardrobeBackBtn', 'wardrobeNewBtn',
    'wardrobeMeta', 'wardrobeGrid', 'wardrobeEditor', 'wardrobeEditorTitle',
    'wardrobeName', 'wardrobeTags', 'wardrobeNotes', 'wardrobeDirty',
    'wardrobeSaveBtn', 'wardrobeCancelBtn', 'wardrobePasteBtn',
    'wardrobePreviewFrame', 'wardrobePreviewImg', 'wardrobePreviewEmpty',
    'wardrobePreviewInput',
    'characterCopyTagsBtn', 'characterGroupAddBtn', 'characterGroups',
    'characterTagsWardrobeBtn', 'characterTagsWardrobeFold', 'characterTagsWardrobeList',
    'characterSavePresetBtn', 'characterComboCopyBtn', 'characterComboList',
    'characterComboWardrobeBtn', 'characterComboWardrobePop', 'characterComboWardrobeCount',
    'characterComboWardrobeList',
    'characterComboAddBtn', 'characterComboAdd', 'characterComboAddInput',
    'characterComboAddSave', 'characterComboAddCancel',
    'characterPresetPrompt', 'characterPresetNameInput',
    'characterFold', 'characterFoldToggle', 'characterFoldBody',
    'characterFoldCount', 'characterFoldList',
    'presetFold', 'presetFoldToggle', 'presetFoldBody', 'presetFoldCount', 'presetList',
    'wardrobeFold', 'wardrobeFoldToggle', 'wardrobeFoldBody', 'wardrobeFoldCount', 'wardrobeFoldList',
    'presetHoverPop', 'characterHoverPop', 'wardrobeHoverPop',
    'confirmBackdrop', 'confirmTitle', 'confirmMessage', 'confirmCancel', 'confirmOk',
    'glossaryAddTrigger', 'glossaryAddLabel', 'glossaryAddCount', 'glossaryAddBackdrop',
    'glossaryAddList', 'glossaryAddMeta', 'glossaryAddNote', 'glossaryAddOk',
    'glossaryAddCancel', 'glossaryAddClose',
    'characterCreateInput', 'characterCreateMeter', 'characterCreateClear',
    'characterCreatePaste', 'characterCreateBtn',
    'sourceMeta', 'sourceText',
    'sourceCharacterFold', 'sourceCharacterFoldToggle', 'sourceCharacterFoldBody',
    'sourceCharacterFoldCount', 'sourceCharacterFoldList',
    'sourcePresetFold', 'sourcePresetFoldToggle', 'sourcePresetFoldBody',
    'sourcePresetFoldCount', 'sourcePresetFoldList',
    'sourceWardrobeFold', 'sourceWardrobeFoldToggle', 'sourceWardrobeFoldBody',
    'sourceWardrobeFoldCount', 'sourceWardrobeFoldList', 'dirtyFlag', 'backToInput', 'retranslateBtn',
    'segmentMeta', 'tagCountB', 'sentCountB', 'tagChips', 'sentenceBlocks',
    'segmentsBody', 'targetBody',
    'targetMeta', 'targetStatus', 'targetStatusText', 'tagCountC', 'sentCountC',
    'tagChipsZh', 'sentenceBlocksZh', 'engineUsed', 'panelC',
    'alert', 'alertTitle', 'alertMsg', 'alertAction', 'alertClose',
    'composer', 'charMeter', 'composerInput', 'clearBtn', 'pasteBtn', 'translateBtn',
    'copySourceBtn',
    'saveFavoriteBtn', 'favoriteCurrentBtn',
    'helpPop', 'helpClose', 'helpScope', 'helpList',
    'imageViewer', 'imageViewerStage', 'imageViewerImg', 'imageViewerClose', 'imageViewerCaption',
    'imageViewerSize',
    'modalBackdrop', 'modalClose', 'ollamaUrl', 'ollamaModel', 'ollamaModelList',
    'refreshOllamaBtn', 'ollamaHint', 'openaiUrl', 'openaiModel', 'openaiModelList',
    'openaiKey', 'refreshOpenaiBtn', 'openaiHint', 'libreUrl', 'libreKey',
    'useGlossary', 'healthReadout', 'testBtn', 'modalCancel', 'modalSave',
    'toast', 'bootError',
  ];

  const DEFAULT_CONFIG = {
    engine: 'auto',
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: '' },
    openai: { baseUrl: 'http://127.0.0.1:1234/v1', model: '', apiKey: '', hasApiKey: false },
    libretranslate: { baseUrl: 'http://127.0.0.1:5000', apiKey: '', hasApiKey: false },
    options: { useGlossary: true },
  };

  class UiError extends Error {
    constructor(title, message, hint = '') {
      super(message);
      this.title = title;
      this.hint = hint;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* utilities                                                               */
  /* ----------------------------------------------------------------------- */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  /* ----------------------------------------------------------------------- */
  /* motion helpers                                                          */
  /* ----------------------------------------------------------------------- */

  /* window.SPECMotion comes from motion.js, which loads before app.js. Every
     hook goes through these guards so a missing / failed motion.js can never
     break the console: the wrappers fall back to the exact legacy behaviour. */
  const motion = () => window.SPECMotion || null;

  function mPlay(node, anim, opts) {
    const m = motion();
    if (m) m.play(node, anim, opts);
  }

  function mShow(node, opts) {
    const m = motion();
    if (m) return m.show(node, opts);
    if (node) node.hidden = false;
    return node;
  }

  function mHide(node, opts) {
    const m = motion();
    if (m) return m.hide(node, opts);
    if (node) node.hidden = true;
    return Promise.resolve();
  }

  function mFold(body, open) {
    const m = motion();
    if (m) { m.fold(body, open); return; }
    if (body) body.hidden = !open;
  }

  /* Mutually exclusive in-flow panels: the entering one fades in, the leaving
     one is hidden synchronously (two flex panels sharing space for the length
     of a leave animation would make the layout jump). */
  function mSwapIn(node, visible, enter = 'fade') {
    if (!node) return;
    if (!visible) { node.hidden = true; return; }
    if (node.hidden) mShow(node, { enter });
  }

  function mStagger(container, opts) {
    const m = motion();
    if (m) m.stagger(container, opts);
  }

  function mFlip(node) {
    const m = motion();
    if (m) m.flip(node);
  }

  function mPress(node) {
    const m = motion();
    if (m) m.press(node);
  }

  function toast(message, kind = 'info', ms = 3400) {
    if (!el.toast) return;
    clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.classList.toggle('is-error', kind === 'error');
    el.toast.classList.add('is-visible');
    /* toast 用 CSS transform: translate(-50%) 居中，位移动画会把居中覆盖掉；
       motion-overlays.css 会把这里的 m-enter 中和掉并自行做 16px 滑入 + 错误抖动 */
    mPlay(el.toast, 'fade', { fast: true });
    state.toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), ms);
  }

  function prettyError(err) {
    return err && err.message ? err.message : String(err || 'unknown error');
  }

  /* ----------------------------------------------------------------------- */
  /* undo history                                                            */
  /* ----------------------------------------------------------------------- */

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function snapshotState() {
    return {
      view: state.view,
      phase: state.phase,
      text: state.text || '',
      translatedText: state.translatedText || '',
      blocks: cloneJson(state.blocks),
      translations: cloneJson(state.translations || {}),
      lastEngine: state.lastEngine || '',
      warnings: (state.warnings || []).slice(),
      favoriteSourceId: state.favoriteSourceId || null,
      error: state.error
        ? { title: state.error.title, message: state.error.message, hint: state.error.hint }
        : null,
    };
  }

  function statesEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function pushHistory(snapshot) {
    if (history.restoring) return;
    const snap = snapshot || history.last;
    if (!snap) return;
    if (history.stack.length && statesEqual(history.stack[history.stack.length - 1], snap)) return;
    history.stack.push(snap);
    if (history.stack.length > history.max) history.stack.shift();
  }

  function commitHistory() {
    if (history.restoring) return;
    history.last = snapshotState();
  }

  function flushTextBurst() {
    if (!history.textBurst) return;
    clearTimeout(history.textBurst.timer);
    const snap = history.textBurst.snap;
    history.textBurst = null;
    pushHistory(snap);
    commitHistory();
  }

  function noteTextChange() {
    if (history.restoring) return;
    if (!history.textBurst) {
      history.textBurst = { snap: history.last || snapshotState(), timer: null };
    }
    clearTimeout(history.textBurst.timer);
    history.textBurst.timer = setTimeout(() => {
      if (!history.textBurst) return;
      const snap = history.textBurst.snap;
      history.textBurst = null;
      pushHistory(snap);
      commitHistory();
    }, 700);
  }

  function pushActionUndo(label, undo, kind = 'action') {
    if (typeof undo !== 'function') return;
    const active = document.activeElement;
    const guard = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')
      ? { id: active.id, tag: active.tagName, value: active.value }
      : null;
    actionUndoStack.push({ label, undo, kind, time: Date.now(), guard });
    while (actionUndoStack.length > ACTION_UNDO_MAX) actionUndoStack.shift();
  }

  async function restoreServerDeletion(token) {
    if (!token) throw new Error('撤销凭据缺失');
    const res = await fetch('/api/undo/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || '撤回失败');
    return data;
  }

  async function undoLastAction() {
    if (actionUndoRunning) return false;
    const action = actionUndoStack.pop();
    if (!action) return false;
    actionUndoRunning = true;
    try {
      await action.undo();
      toast(`已撤回：${action.label}`, 'info', 2000);
      return true;
    } catch (err) {
      toast(`撤回失败：${prettyError(err)}`, 'error', 3800);
      return false;
    } finally {
      actionUndoRunning = false;
    }
  }

  function applySnapshot(snap) {
    clearSourceSyncTimer();
    history.restoring = true;
    history.textBurst = null;
    state.docVersion += 1;
    try {
      hideAlert();
      hideHelp();
      if (state.view !== 'translate') switchView('translate');
      state.phase = snap.phase === 'translating' ? 'done' : snap.phase;
      state.text = snap.text || '';
      state.translatedText = snap.translatedText || '';
      state.blocks = cloneJson(snap.blocks);
      state.translations = cloneJson(snap.translations) || {};
      state.lastEngine = snap.lastEngine || '';
      state.warnings = (snap.warnings || []).slice();
      state.favoriteSourceId = snap.favoriteSourceId || null;
      state.error = snap.error || null;
      state.progressText = '';
      state.editing = null;
      state.pendingIds = new Set();
      state.syncingIds = new Set();
      el.composerInput.value = state.text;
      el.composerInput.scrollTop = 0;
      updateMeter();

      if (state.blocks && state.phase !== 'idle') {
        el.sourceText.value = state.text;
        el.sourceText.scrollTop = 0;
        el.panels.hidden = false;
        el.viewTranslate.classList.add('has-results');
        renderSegments();
        renderTarget();
        updateMeta();
        updateDirty();
        setPhaseUI();
        if (state.error) {
          showAlert(state.error.title || '翻译失败',
            [state.error.message, state.error.hint].filter(Boolean).join(' '));
        }
      } else {
        state.phase = 'idle';
        state.blocks = null;
        state.translations = {};
        state.lastEngine = '';
        state.error = null;
        el.panels.hidden = true;
        el.targetStatus.hidden = true;
        el.sourceText.value = '';
        el.viewTranslate.classList.remove('has-results');
        updateMeta();
        setPhaseUI();
      }
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } finally {
      history.restoring = false;
      history.programmaticUndo = false;
      history.programmaticTarget = null;
      history.last = snapshotState();
    }
  }

  function undoLast() {
    if (state.phase === 'translating') {
      toast('正在翻译，稍候再撤回');
      return;
    }
    flushTextBurst();
    if (!history.stack.length) {
      toast('没有可撤回的操作', 'info', 1800);
      return;
    }
    const snap = history.stack.pop();
    applySnapshot(snap);
    toast('已撤回上一步', 'info', 1600);
  }

  /* ----------------------------------------------------------------------- */
  /* multi-open translation sessions                                         */
  /* ----------------------------------------------------------------------- */

  function sessionPreview(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'EMPTY';
    const first = cleaned.split(/[,，\n]/)[0].trim();
    return (first || cleaned).slice(0, 16).toUpperCase();
  }

  function formatSessionName(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}_${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function activeSessionName() {
    const session = sessions.list.find((item) => item.id === sessions.activeId);
    return session?.name || formatSessionName();
  }

  function sessionBusy() {
    return state.phase === 'translating' || state.pendingIds.size > 0 || state.syncingIds.size > 0;
  }

  function renderSessionBar() {
    if (!el.sessionTabs || !sessions.list.length) return;
    const atMaxSessions = sessions.list.length >= sessions.max;
    const addButton = atMaxSessions ? '' :
      `<button type="button" class="session-add" data-session-add title="新建翻译会话"${sessionBusy() ? ' disabled' : ''}>+ NEW</button>`;
    el.sessionTabs.innerHTML = sessions.list.map((session, index) => {
      const active = session.id === sessions.activeId;
      const phase = active ? state.phase : (session.doc?.phase || 'idle');
      const status = phase === 'translating' ? ' is-working' : (phase === 'done' ? ' is-done' : '');
      const editing = sessionRenameId === session.id;
      const cls = 'session-tab' + (active ? ' is-active' : '') + status + (editing ? ' is-renaming' : '');
      const name = session.name || formatSessionName(session.createdAt || Date.now());
      const close = sessions.list.length > 1
        ? `<button type="button" class="st-close" data-close="${session.id}" title="关闭会话">×</button>`
        : '';
      if (editing) {
        return `<div class="${cls}" data-id="${session.id}">` +
          `<span class="st-index">${String(index + 1).padStart(2, '0')}</span>` +
          `<input class="st-rename-input" data-session-rename-input value="${esc(name)}" maxlength="60" spellcheck="false">` +
          `<span class="st-led"></span>${close}</div>`;
      }
      const tab = `<div class="${cls}" data-id="${session.id}" title="拖动排序 · 双击重命名">` +
        `<button type="button" class="st-switch" data-switch="${session.id}" title="${esc(name)} · 双击重命名 · 拖动排序">` +
        `<span class="st-index">${String(index + 1).padStart(2, '0')}</span>` +
        `<span class="st-title">${esc(name)}</span>` +
        `<span class="st-led"></span></button>${close}</div>`;
      return tab;
    }).join('') + addButton;
    el.sessionCount.textContent = `${sessions.list.length} / ${sessions.max}`;
    /* 只给「新出现」的会话标签播 pop；整表 stagger 会在每次状态刷新时重播。
       renderSessionBar 在一次操作里可能连续调用多次（每次都会重建 innerHTML），
       所以延后一帧再播，避免刚加的 class 被下一次渲染替换掉。 */
    const tabIds = sessions.list.map((session) => session.id);
    const previousIds = new Set(sessionTabIds);
    const hadTabs = sessionTabIds.length > 0;
    sessionTabIds = tabIds;
    if (!hadTabs) return;
    const newIds = tabIds.filter((id) => !previousIds.has(id));
    if (!newIds.length) return;
    requestAnimationFrame(() => {
      newIds.forEach((id) => {
        const tab = el.sessionTabs?.querySelector(`.session-tab[data-id="${id}"]`);
        if (tab) mPlay(tab, 'pop', { fast: true });
      });
    });
  }

  function startSessionRename(id) {
    const session = sessions.list.find((item) => item.id === id);
    if (!session) return;
    if (sessionRenameId && sessionRenameId !== id) {
      const previous = el.sessionTabs.querySelector('[data-session-rename-input]');
      if (previous) commitSessionRename(sessionRenameId, previous.value);
    }
    sessionRenameId = id;
    renderSessionBar();
    requestAnimationFrame(() => {
      const input = el.sessionTabs.querySelector('[data-session-rename-input]');
      if (!input) return;
      input.focus();
      input.select();
    });
  }

  function commitSessionRename(id, value) {
    if (sessionRenameId !== id) return;
    const session = sessions.list.find((item) => item.id === id);
    const oldName = session?.name || '';
    const name = String(value || '').trim().slice(0, 60);
    if (session && name) session.name = name;
    sessionRenameId = null;
    renderSessionBar();
    if (session && name && name !== oldName) {
      pushActionUndo('重命名会话', () => {
        const target = sessions.list.find((item) => item.id === id);
        if (!target || target.name !== name) throw new Error('会话名称已再次变化');
        target.name = oldName;
        renderSessionBar();
      });
      toast('会话已重命名', 'info', 1800);
    }
  }

  function cancelSessionRename() {
    if (sessionRenameId == null) return;
    sessionRenameId = null;
    renderSessionBar();
  }

  function startSessionDrag(tab, event) {
    if (!tab || (event.button !== undefined && event.button !== 0)) return;
    if (event.target.closest('.st-close, [data-session-rename-input]')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        tab.classList.add('is-dragging');
        document.body.classList.add('is-session-dragging');
      }
      moveEvent.preventDefault();
      const container = el.sessionTabs;
      const rect = container.getBoundingClientRect();
      if (moveEvent.clientX < rect.left + 24) container.scrollLeft -= 12;
      else if (moveEvent.clientX > rect.right - 24) container.scrollLeft += 12;
      const tabs = [...container.querySelectorAll('.session-tab')].filter((item) => item !== tab);
      if (!tabs.length) return;
      let target = tabs.find((item) => {
        const itemRect = item.getBoundingClientRect();
        return moveEvent.clientX >= itemRect.left && moveEvent.clientX <= itemRect.right;
      });
      if (!target) {
        target = tabs.reduce((best, item) => {
          const itemRect = item.getBoundingClientRect();
          const center = itemRect.left + itemRect.width / 2;
          const distance = Math.abs(center - moveEvent.clientX);
          return !best || distance < best.distance ? { item, distance } : best;
        }, null)?.item;
      }
      if (!target) return;
      const targetRect = target.getBoundingClientRect();
      const after = moveEvent.clientX > targetRect.left + targetRect.width / 2;
      const reference = after ? target.nextSibling : target;
      if (reference !== tab) container.insertBefore(tab, reference);
    };
    const finish = () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', finish, true);
      tab.classList.remove('is-dragging');
      document.body.classList.remove('is-session-dragging');
      if (!moved) return;
      suppressSessionClickUntil = Date.now() + 320;
      const ids = [...el.sessionTabs.querySelectorAll('.session-tab')].map((item) => item.dataset.id);
      const byId = new Map(sessions.list.map((session) => [session.id, session]));
      sessions.list = ids.map((id) => byId.get(id)).filter(Boolean);
      renderSessionBar();
      toast('会话顺序已调整', 'info', 1500);
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', finish, true);
  }

  function saveActiveSession() {
    if (!sessions.activeId) return;
    const session = sessions.list.find((item) => item.id === sessions.activeId);
    if (!session) return;
    state.editing = null;
    flushTextBurst();
    session.doc = snapshotState();
    session.historyStack = history.stack.slice();
    session.historyLast = history.last;
  }

  function restoreSession(session) {
    clearSourceSyncTimer();
    state.docVersion += 1;
    const doc = session.doc;
    state.view = 'translate';
    state.phase = doc?.phase === 'translating' ? 'done' : (doc?.phase || 'idle');
    state.text = doc?.text || '';
    state.translatedText = doc?.translatedText || '';
    state.blocks = doc?.blocks ? cloneJson(doc.blocks) : null;
    state.translations = doc?.translations ? cloneJson(doc.translations) : {};
    state.lastEngine = doc?.lastEngine || '';
    state.warnings = doc?.warnings ? [...doc.warnings] : [];
    state.error = doc?.error || null;
    state.favoriteSourceId = doc?.favoriteSourceId || null;
    state.progressText = '';
    state.editing = null;
    state.pendingIds = new Set();
    state.syncingIds = new Set();
    history.stack = session.historyStack ? session.historyStack.slice() : [];
    history.last = session.historyLast || null;
    history.textBurst = null;
    history.restoring = false;
    history.programmaticUndo = false;
    history.programmaticTarget = null;

    hideAlert();
    el.sourceText.value = '';
    el.sourceText.scrollTop = 0;
    el.composerInput.value = state.text;
    el.composerInput.scrollTop = 0;
    updateMeter();
    el.panels.hidden = true;
    el.targetStatus.hidden = true;
    el.viewTranslate.classList.remove('has-results');

    if (state.blocks && state.phase !== 'idle') {
      el.sourceText.value = state.text;
      el.panels.hidden = false;
      renderSegments();
      renderTarget();
      updateMeta();
      updateDirty();
      setPhaseUI();
      if (state.error) {
        showAlert(state.error.title || '翻译失败',
          [state.error.message, state.error.hint].filter(Boolean).join(' '));
      }
    } else {
      state.phase = 'idle';
      state.blocks = null;
      state.translations = {};
      state.lastEngine = '';
      state.error = null;
      updateMeta();
      setPhaseUI();
    }
    if (!history.last) history.last = snapshotState();
    renderSessionBar();
    if (state.phase === 'idle') el.composerInput.focus();
  }

  function switchSession(id) {
    if (state.recordMode) closeRecordSession();
    if (id === sessions.activeId) return;
    if (sessionBusy()) {
      toast('当前会话正在翻译或同步，请完成后再切换', 'info', 2400);
      return;
    }
    if (state.editing) cancelInlineEdit();
    saveActiveSession();
    sessions.activeId = id;
    const session = sessions.list.find((item) => item.id === id);
    if (!session) return;
    restoreSession(session);
  }

  function newSession() {
    if (state.recordMode) closeRecordSession();
    if (sessionBusy()) {
      toast('当前会话正在翻译或同步，请完成后再新建', 'info', 2400);
      return;
    }
    if (sessions.list.length >= sessions.max) {
      toast(`最多同时打开 ${sessions.max} 个会话`, 'info', 2200);
      return;
    }
    saveActiveSession();
    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const session = {
      id,
      name: formatSessionName(),
      createdAt: Date.now(),
      doc: null,
      historyStack: [],
      historyLast: null,
    };
    sessions.list.push(session);
    sessions.activeId = id;
    restoreSession(session);
    toast('已新建翻译会话', 'info', 1600);
  }

  function closeSession(id) {
    if (sessions.list.length <= 1) return;
    if (sessionBusy()) {
      toast('当前会话正在翻译或同步，请完成后再关闭', 'info', 2400);
      return;
    }
    const index = sessions.list.findIndex((item) => item.id === id);
    if (index < 0) return;
    const wasActive = id === sessions.activeId;
    const snapshot = cloneJson(sessions.list[index]);
    sessions.list.splice(index, 1);
    if (wasActive) {
      const next = sessions.list[Math.min(index, sessions.list.length - 1)];
      sessions.activeId = next.id;
      restoreSession(next);
    } else {
      renderSessionBar();
    }
    pushActionUndo('关闭会话', () => {
      if (sessions.list.length >= sessions.max) throw new Error('会话数量已达上限');
      const restored = cloneJson(snapshot);
      sessions.list.splice(Math.min(index, sessions.list.length), 0, restored);
      if (wasActive) {
        if (state.view !== 'translate') switchView('translate');
        sessions.activeId = restored.id;
        restoreSession(restored);
      } else {
        renderSessionBar();
      }
    });
    toast('已关闭会话', 'info', 1800);
  }

  function initSessions() {
    sessions.list = [{
      id: 'sess-1',
      name: formatSessionName(),
      createdAt: Date.now(),
      doc: null,
      historyStack: [],
      historyLast: null,
    }];
    sessions.activeId = 'sess-1';
    renderSessionBar();
  }

  /* ----------------------------------------------------------------------- */
  /* history / favorite records                                              */
  /* ----------------------------------------------------------------------- */

  function formatRecordTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return date.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function recordChipHtml(block, translation, translated, index) {
    const cls = 'blk' + (translated ? ' blk-zh' : '') + (translated && !translation ? ' is-missing' : '');
    const content = translated
      ? (translation?.text ? esc(translation.text) : '<span class="missing">未翻译</span>')
      : (block.text ? esc(block.text) : '<span class="blk-placeholder">…</span>');
    return `<span class="${cls}" data-bid="${esc(block.id)}" tabindex="0" title="${esc(block.text)}">` +
      `<span class="idx"><span class="idx-num">${pad2(index)}</span></span>${content}</span>`;
  }

  function recordSentenceHtml(block, translation, translated, index) {
    const cls = 'sent' + (translated ? ' sent-zh' : '') + (translated && !translation ? ' is-missing' : '');
    const body = translated
      ? (translation?.text
        ? `<div class="txt txt-zh">${esc(translation.text)}</div>`
        : '<div class="txt txt-zh"><span class="missing">未翻译</span></div>')
      : `<div class="txt">${block.text ? esc(block.text) : '<span class="blk-placeholder">…</span>'}</div>`;
    return `<div class="${cls}" data-bid="${esc(block.id)}" tabindex="0" title="${translated ? esc(block.text) : ''}">` +
      `<span class="idx"><span class="idx-num">${pad2(index)}</span></span>${body}</div>`;
  }

  function recordGroupHtml(record, translated, key) {
    const blocks = record.blocks?.[key] || [];
    const translations = record.translations || {};
    const label = key === 'tags' ? 'TAGS' : 'DESCRIPTION';
    const sub = key === 'tags' ? '// 词条' : '// 自然语言描述';
    const empty = key === 'tags' ? 'NO TAGS / 无词条' : 'NO DESCRIPTION / 无描述';
    const count = translated
      ? `${blocks.filter((block) => translations[block.id]).length}/${blocks.length}`
      : String(blocks.length);
    const content = blocks.length
      ? blocks.map((block, index) => (key === 'tags'
        ? recordChipHtml(block, translations[block.id], translated, index + 1)
        : recordSentenceHtml(block, translations[block.id], translated, index + 1))).join('')
      : `<span class="blk-empty">${empty}</span>`;
    return `<div class="record-group">` +
      `<div class="group-head"><span class="group-label">${label}</span><span class="group-sub">${sub}</span>` +
      `<span class="group-count">${count}</span></div>` +
      `<div class="${key === 'tags' ? 'chips' : 'sentences'}">${content}</div>` +
      `</div>`;
  }

  function recordColumnHtml(record, translated) {
    const tags = record.blocks?.tags?.length || 0;
    const sentences = record.blocks?.sentences?.length || 0;
    return `<section class="record-column${translated ? ' is-target' : ''}">` +
      `<header class="record-column-head"><span class="rc-code">${translated ? 'C' : 'B'}</span>` +
      `<span>${translated ? '译文 / TRANSLATION' : '词块 / SEGMENTS'}</span>` +
      `<span class="rc-count">${tags} TAGS · ${sentences} SENT</span></header>` +
      recordGroupHtml(record, translated, 'tags') +
      recordGroupHtml(record, translated, 'sentences') +
      `</section>`;
  }

  function recordExampleHtml(record) {
    const id = String(record.id || '');
    const example = record.example || '';
    const version = encodeURIComponent(record.updatedAt || example || '');
    const frame = example
      ? `<img src="/api/favorite/example/${encodeURIComponent(id)}?v=${version}" alt="示例图">` +
        '<span class="record-example-hint">点击更换 · CTRL+V 粘贴</span>'
      : '<span class="record-example-empty"><b>NO EXAMPLE / 暂无示例图</b><span>点击选择图片</span></span>';
    return `<section class="record-example">` +
      `<header class="record-example-head"><span>示例图 / EXAMPLE</span><span>${example ? '已上传' : '未上传'}</span></header>` +
      `<button type="button" class="record-example-frame${example ? ' has-image' : ''}" data-record-example-upload="${esc(id)}" data-record-example-id="${esc(id)}" title="点击选择图片，或悬停后 Ctrl+V 粘贴">${frame}</button>` +
      `<input type="file" class="record-example-input" data-record-example-input="${esc(id)}" accept="image/png,image/jpeg,image/webp,image/gif" hidden>` +
      `</section>`;
  }

  function recordCardHtml(record, kind) {
    const id = String(record.id || '');
    const tags = record.blocks?.tags?.length || 0;
    const sentences = record.blocks?.sentences?.length || 0;
    const title = record.title || sessionPreview(record.text);
    const favorite = kind === 'favorite';
    const star = kind === 'history'
      ? `<button type="button" class="record-star" data-record-star="${esc(id)}" title="加入收藏夹"><svg class="icon"><use href="#ico-star"/></svg></button>`
      : '';
    const editingTitle = favorite && recordEditingId === id;
    const titleBlock = editingTitle
      ? `<input class="record-title-input" data-record-title-input="${esc(id)}" value="${esc(title)}" spellcheck="false">`
      : `<span class="record-title"${favorite ? ` data-record-title="${esc(id)}" title="双击重命名收藏"` : ''}>${esc(title)}</span>`;
    const pencil = favorite
      ? `<button type="button" class="record-rename-icon" data-record-rename-icon="${esc(id)}" title="重命名收藏"><svg class="icon"><use href="#ico-pencil"/></svg></button>`
      : '';
    const headActions = favorite
      ? `<button type="button" class="record-action compact" data-record-copy="${esc(id)}" data-record-kind="${kind}">复制到剪贴板</button>` +
        `<button type="button" class="record-action primary compact" data-record-open="${esc(id)}" data-record-kind="${kind}">进入翻译台编辑</button>`
      : '';
    return `<article class="record-card" data-record-id="${esc(id)}" data-record-kind="${kind}">` +
      `<header class="record-card-head"><div class="record-card-heading">` +
      `<div class="record-title-row">${titleBlock}${pencil}</div>` +
      `<span class="record-meta">${esc(formatRecordTime(record.createdAt))} · ${tags} TAGS · ${sentences} SENT · ${esc(record.lastEngine || '—')}</span>` +
      `</div><div class="record-actions">${headActions}${star}` +
      `<button type="button" class="record-del" data-record-del="${esc(id)}" data-record-kind="${kind}" title="删除">×</button>` +
      `</div></header>` +
      `<div class="record-columns${favorite ? ' has-example' : ''}">` +
      (favorite ? recordExampleHtml(record) : '') +
      recordColumnHtml(record, false) + recordColumnHtml(record, true) +
      `</div>` +
      (favorite ? '' :
        `<footer class="record-card-foot">` +
        `<button type="button" class="record-action" data-record-copy="${esc(id)}" data-record-kind="${kind}">复制到剪贴板</button>` +
        `<button type="button" class="record-action primary" data-record-open="${esc(id)}" data-record-kind="${kind}">进入翻译台编辑</button>` +
        `</footer>`) +
      `</article>`;
  }

  function renderRecordList(kind) {
    const list = kind === 'history' ? el.historyList : el.favoriteList;
    const records = kind === 'history' ? state.historyRecords : state.favoriteRecords;
    if (!list) return;
    if (kind === 'favorite') hoveredExampleId = null;
    if (records === null) {
      list.innerHTML = '<div class="record-empty">LOADING RECORDS…</div>';
      return;
    }
    if (!records.length) {
      list.innerHTML = `<div class="record-empty">${kind === 'history'
        ? 'NO HISTORY / 暂无历史记录'
        : 'NO FAVORITES / 暂无收藏'}</div>`;
      return;
    }
    list.innerHTML = records.map((record) => recordCardHtml(record, kind)).join('');
    mStagger(list, { step: 24 });
  }

  function updateRecordCounts() {
    const historyCount = state.historyRecords?.length || 0;
    const favoriteCount = state.favoriteRecords?.length || 0;
    if (el.historyCount) el.historyCount.textContent = String(historyCount);
    if (el.favoriteCount) el.favoriteCount.textContent = String(favoriteCount);
    /* 计数变化时让徽标闪一次；motion-nav.css 把 m-enter 映射为单次 mMeterBlink */
    const blinkBadge = (node, value) => {
      if (!node) return;
      const next = String(value);
      if (node.dataset.motionCount !== undefined && node.dataset.motionCount !== next) {
        mPlay(node, 'fade', { fast: true });
      }
      node.dataset.motionCount = next;
    };
    blinkBadge(el.historyCount, historyCount);
    blinkBadge(el.favoriteCount, favoriteCount);
    if (el.historyMeta) el.historyMeta.textContent = `${historyCount} / ${HISTORY_LIMIT}`;
    if (el.favoriteMeta) el.favoriteMeta.textContent = `${favoriteCount} RECORDS`;
  }

  async function loadRecordLists() {
    try {
      const [historyRes, favoriteRes] = await Promise.all([
        fetch('/api/history', { cache: 'no-store' }),
        fetch('/api/favorite', { cache: 'no-store' }),
      ]);
      if (!historyRes.ok || !favoriteRes.ok) throw new Error('record list request failed');
      const historyData = await historyRes.json();
      const favoriteData = await favoriteRes.json();
      state.historyRecords = Array.isArray(historyData.records) ? historyData.records : [];
      state.favoriteRecords = Array.isArray(favoriteData.records) ? favoriteData.records : [];
    } catch {
      if (state.historyRecords === null) state.historyRecords = [];
      if (state.favoriteRecords === null) state.favoriteRecords = [];
    }
    updateRecordCounts();
    renderRecordList('history');
    renderRecordList('favorite');
  }

  function openHistoryPage() {
    openRecordSession('history');
  }

  function openFavoritePage() {
    openRecordSession('favorite');
  }

  function openRecordSession(kind) {
    if (state.recordMode === kind) {
      closeRecordSession();
      return;
    }
    if (state.view !== 'translate') switchView('translate');
    state.recordMode = kind;
    el.viewTranslate.classList.add('is-record-mode');
    if (kind === 'history') {
      mShow(el.viewHistory, { enter: 'rise' });
      el.viewFavorite.hidden = true;
    } else {
      el.viewHistory.hidden = true;
      mShow(el.viewFavorite, { enter: 'rise' });
    }
    el.historyBtn.classList.toggle('is-active', kind === 'history');
    el.favoriteBtn.classList.toggle('is-active', kind === 'favorite');
    renderRecordList(kind);
    loadRecordLists();
    hideHelp();
  }

  function closeRecordSession() {
    if (!state.recordMode) return;
    state.recordMode = null;
    el.viewTranslate.classList.remove('is-record-mode');
    /* 记录视图是 in-flow 的 flex:1 区块：退场时若继续占位会和 workspace
       互相挤压，所以关闭保持同步 hidden（进场动画由 openRecordSession 负责） */
    el.viewHistory.hidden = true;
    el.viewFavorite.hidden = true;
    el.historyBtn.classList.remove('is-active');
    el.favoriteBtn.classList.remove('is-active');
  }

  function openRecordInSession(recordId, kind) {
    const records = kind === 'history' ? state.historyRecords : state.favoriteRecords;
    const record = (records || []).find((item) => String(item.id) === String(recordId));
    if (!record) return;
    if (sessionBusy()) {
      toast('当前会话正在翻译或同步，请完成后再打开记录', 'info', 2400);
      return;
    }
    if (sessions.list.length >= sessions.max) {
      toast(`最多同时打开 ${sessions.max} 个会话`, 'info', 2200);
      return;
    }
    saveActiveSession();
    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const doc = {
      view: 'translate',
      phase: 'done',
      text: record.text || '',
      translatedText: record.translatedText || record.text || '',
      blocks: cloneJson(record.blocks || { tags: [], sentences: [] }),
      translations: cloneJson(record.translations || {}),
      lastEngine: record.lastEngine || '',
      warnings: [],
      error: null,
      favoriteSourceId: kind === 'favorite' ? record.id : null,
    };
    const session = {
      id,
      name: record.title || formatSessionName(),
      createdAt: Date.now(),
      doc,
      historyStack: [],
      historyLast: null,
    };
    sessions.list.push(session);
    sessions.activeId = id;
    switchView('translate');
    restoreSession(session);
    sessionSignatures.set(id, historySignature());
    toast('已在新的会话中打开记录', 'info', 2000);
  }

  async function starHistoryRecord(recordId) {
    try {
      const res = await fetch('/api/history/star', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recordId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '收藏失败');
      await loadRecordLists();
      toast('已加入收藏', 'info', 1800);
    } catch (err) {
      toast('收藏失败：' + prettyError(err), 'error', 3600);
    }
  }

  function openConfirmDialog({ title = '删除确认', message = '', confirmText = '删除', danger = true } = {}) {
    if (confirmResolver) {
      closeConfirmDialog(false);
    }
    confirmPreviousFocus = document.activeElement;
    el.confirmTitle.textContent = title;
    el.confirmMessage.textContent = message;
    el.confirmOk.textContent = confirmText;
    el.confirmOk.classList.toggle('is-neutral', !danger);
    mShow(el.confirmBackdrop, { enter: 'fade' });
    return new Promise((resolve) => {
      confirmResolver = resolve;
      requestAnimationFrame(() => el.confirmCancel.focus());
    });
  }

  function closeConfirmDialog(result) {
    if (el.confirmBackdrop.hidden) return;
    mHide(el.confirmBackdrop, { leave: 'fade' });
    const resolve = confirmResolver;
    confirmResolver = null;
    if (confirmPreviousFocus && typeof confirmPreviousFocus.focus === 'function' && confirmPreviousFocus.isConnected) {
      confirmPreviousFocus.focus();
    }
    confirmPreviousFocus = null;
    if (resolve) resolve(Boolean(result));
  }

  function confirmDeleteAction(message, title = '删除确认') {
    return openConfirmDialog({ title, message, confirmText: '删除' });
  }

  function confirmDiscardAction(message, title = '放弃修改') {
    return openConfirmDialog({ title, message, confirmText: '确定', danger: false });
  }

  async function deleteRecord(kind, recordId) {
    const label = kind === 'history' ? '历史记录' : '收藏记录';
    if (!(await confirmDeleteAction(`删除这条${label}？`, `删除${label}`))) return;
    try {
      const res = await fetch(`/api/${kind}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recordId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '删除失败');
      await loadRecordLists();
      if (data?.undoToken) {
        pushActionUndo(`删除${label}`, async () => {
          await restoreServerDeletion(data.undoToken);
          await loadRecordLists();
          renderRecordList(kind);
        });
      }
      toast(`已删除${label}`, 'info', 2000);
    } catch (err) {
      toast('删除失败：' + prettyError(err), 'error', 3600);
    }
  }

  function historySignature() {
    return [
      state.text || '',
      state.lastEngine || '',
      JSON.stringify(state.blocks || null),
      JSON.stringify(state.translations || {}),
    ].join('|');
  }

  function currentRecordPayload() {
    return {
      title: activeSessionName().slice(0, 120),
      text: state.text,
      translatedText: state.translatedText || state.text,
      blocks: cloneJson(state.blocks),
      translations: cloneJson(state.translations || {}),
      lastEngine: state.lastEngine || '',
    };
  }

  function updateFavoriteSaveButton() {
    if (!el.saveFavoriteBtn) return;
    el.saveFavoriteBtn.hidden = !(state.favoriteSourceId && state.blocks && state.phase !== 'idle');
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      helper.remove();
      return ok;
    }
  }

  async function copyRecordPrompt(record) {
    const text = String(record?.text || '');
    if (!text.trim()) {
      toast('这条记录没有英文提示词', 'info', 1800);
      return;
    }
    const ok = await copyTextToClipboard(text);
    if (ok) toast('英文提示词已复制到剪贴板', 'info', 1800);
    else toast('复制失败，请手动选择英文提示词复制', 'error', 3200);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function fetchImageDataUrl(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('image request failed');
    const blob = await res.blob();
    return readFileAsDataUrl(blob);
  }

  async function uploadFavoriteExample(recordId, file) {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
      toast('示例图只支持 PNG / JPEG / WebP / GIF', 'error', 3200);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('示例图不能超过 8 MB', 'error', 3200);
      return;
    }
    const record = (state.favoriteRecords || []).find((item) => String(item.id) === String(recordId));
    const oldExample = record?.example || '';
    let oldDataUrl = '';
    if (oldExample) {
      try {
        oldDataUrl = await fetchImageDataUrl(
          `/api/favorite/example/${encodeURIComponent(recordId)}?v=${encodeURIComponent(record.updatedAt || oldExample)}`,
        );
      } catch {
        oldDataUrl = '';
      }
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await fetch('/api/favorite/example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recordId, dataUrl }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '上传失败');
      await loadRecordLists();
      if (!oldExample) {
        pushActionUndo('上传示例图', async () => {
          const undoRes = await fetch('/api/favorite/example/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: recordId }),
          });
          if (!undoRes.ok) throw new Error('撤回示例图失败');
          await loadRecordLists();
        });
      } else if (oldDataUrl) {
        pushActionUndo('更换示例图', async () => {
          const undoRes = await fetch('/api/favorite/example', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: recordId, dataUrl: oldDataUrl }),
          });
          if (!undoRes.ok) throw new Error('撤回示例图失败');
          await loadRecordLists();
        });
      }
      toast('示例图已更新', 'info', 2400);
    } catch (err) {
      toast('上传示例图失败：' + prettyError(err), 'error', 4200);
    }
  }

  function startFavoriteTitleEdit(recordId) {
    if (state.recordMode !== 'favorite') return;
    recordEditingId = recordId;
    renderRecordList('favorite');
    const input = document.querySelector('.record-title-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function cancelFavoriteTitleEdit() {
    if (!recordEditingId) return;
    recordEditingId = null;
    renderRecordList('favorite');
  }

  async function commitFavoriteTitleEdit(recordId, value) {
    if (recordEditingId !== recordId) return;
    recordEditingId = null;
    suppressRecordOpenUntil = Date.now() + 400;
    const clean = String(value || '').trim();
    if (!clean) {
      toast('收藏名称不能为空', 'info', 2200);
      renderRecordList('favorite');
      return;
    }
    const record = (state.favoriteRecords || []).find((item) => String(item.id) === String(recordId));
    if (record && record.title === clean) {
      renderRecordList('favorite');
      return;
    }
    const oldTitle = record?.title || '';
    try {
      const res = await fetch('/api/favorite/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: recordId, title: clean }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '重命名失败');
      sessions.list.forEach((session) => {
        const linked = session.id === sessions.activeId
          ? state.favoriteSourceId === recordId
          : session.doc?.favoriteSourceId === recordId;
        if (linked) session.name = clean;
      });
      renderSessionBar();
      await loadRecordLists();
      if (oldTitle) {
        pushActionUndo('重命名收藏', async () => {
          const undoRes = await fetch('/api/favorite/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: recordId, title: oldTitle }),
          });
          const undoData = await undoRes.json().catch(() => null);
          if (!undoRes.ok) throw new Error(undoData?.error?.message || '重命名失败');
          sessions.list.forEach((session) => {
            const linked = session.id === sessions.activeId
              ? state.favoriteSourceId === recordId
              : session.doc?.favoriteSourceId === recordId;
            if (linked) session.name = oldTitle;
          });
          renderSessionBar();
          await loadRecordLists();
        });
      }
      toast('收藏名称已修改', 'info', 2000);
    } catch (err) {
      toast('重命名失败：' + prettyError(err), 'error', 3600);
      renderRecordList('favorite');
    }
  }

  async function addCurrentToFavorite() {
    if (sessionBusy()) {
      toast('当前会话正在翻译或同步，请完成后再收藏', 'info', 2400);
      return;
    }
    if (!state.blocks || state.phase !== 'done') {
      toast('请先完成翻译再收藏当前会话', 'info', 2200);
      return;
    }
    if (state.favoriteSourceId) {
      await saveFavoriteChanges();
      return;
    }
    try {
      const res = await fetch('/api/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: currentRecordPayload() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '收藏失败');
      state.favoriteSourceId = data.record?.id || state.favoriteSourceId;
      updateFavoriteSaveButton();
      await loadRecordLists();
      toast('当前会话已加入收藏夹', 'info', 2200);
    } catch (err) {
      toast('收藏当前会话失败：' + prettyError(err), 'error', 4000);
    }
  }

  async function saveFavoriteChanges() {
    if (!state.favoriteSourceId) return;
    if (sessionBusy()) {
      toast('当前会话正在翻译或同步，请完成后再保存', 'info', 2400);
      return;
    }
    try {
      const res = await fetch('/api/favorite/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.favoriteSourceId, record: currentRecordPayload() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      await loadRecordLists();
      toast('当前更改已保存到收藏夹', 'info', 2200);
    } catch (err) {
      toast('保存到收藏夹失败：' + prettyError(err), 'error', 4200);
    }
  }

  function maybeSaveHistory() {
    if (state.phase !== 'done' || !String(state.text || '').trim() || !state.blocks) return;
    const sessionId = sessions.activeId;
    if (!sessionId) return;
    const signature = historySignature();
    if (sessionSignatures.get(sessionId) === signature) return;
    sessionSignatures.set(sessionId, signature);
    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: currentRecordPayload() }),
    }).then((res) => {
      if (!res.ok) throw new Error('history save failed');
      return res.json();
    }).then(() => {
      state.historyRecords = null;
      loadRecordLists();
    }).catch(() => {
      sessionSignatures.delete(sessionId);
    });
  }

  /* ----------------------------------------------------------------------- */
  /* hardware monitor                                                        */
  /* ----------------------------------------------------------------------- */

  const HW_CIRCUMFERENCE = 2 * Math.PI * 15;

  function formatGB(bytes) {
    if (bytes == null || !Number.isFinite(Number(bytes))) return '--';
    return `${(Number(bytes) / (1024 ** 3)).toFixed(1)} GB`;
  }

  function setHardwareGauge(ringId, valueId, percent, title) {
    const ring = el[ringId];
    const value = el[valueId];
    if (!ring || !value) return;
    const pct = (typeof percent === 'number' && Number.isFinite(percent))
      ? Math.max(0, Math.min(100, percent))
      : null;
    ring.style.strokeDashoffset = String(HW_CIRCUMFERENCE * (1 - (pct == null ? 0 : pct) / 100));
    value.textContent = pct == null ? '--' : `${Math.round(pct)}%`;
    const gauge = ring.closest('.hw-gauge');
    if (gauge) {
      gauge.classList.toggle('is-na', pct == null);
      if (title) gauge.setAttribute('title', title);
    }
  }

  async function updateHardware() {
    if (hardwareBusy) return;
    hardwareBusy = true;
    try {
      const res = await fetch('/api/hardware', { cache: 'no-store' });
      if (!res.ok) throw new Error('hardware unavailable');
      const data = await res.json();
      setHardwareGauge('hwCpuRing', 'hwCpuVal', data.cpu,
        data.cpu == null ? 'CPU 不可用' : `CPU 占用 ${Number(data.cpu).toFixed(1)}%`);
      setHardwareGauge('hwRamRing', 'hwRamVal', data.ram,
        data.ram == null ? 'RAM 不可用' : `RAM 占用 ${Number(data.ram).toFixed(1)}% · ${formatGB(data.ramUsed)} / ${formatGB(data.ramTotal)}`);
      setHardwareGauge('hwGpuRing', 'hwGpuVal', data.gpu,
        data.gpu == null ? 'GPU 不可用' : `GPU 利用率 ${Number(data.gpu).toFixed(1)}% · ${data.gpuName || ''}`);
      const vramTitle = data.vram == null
        ? 'VRAM 不可用'
        : `VRAM 占用 ${Number(data.vram).toFixed(1)}% · ${(Number(data.vramUsed) / 1024).toFixed(1)} / ${(Number(data.vramTotal) / 1024).toFixed(1)} GB`;
      setHardwareGauge('hwVramRing', 'hwVramVal', data.vram, vramTitle);
      el.hwLive?.classList.remove('is-error');
      if (el.hwLiveText) el.hwLiveText.textContent = 'LIVE';
    } catch {
      setHardwareGauge('hwCpuRing', 'hwCpuVal', null, 'CPU 数据不可用');
      setHardwareGauge('hwRamRing', 'hwRamVal', null, 'RAM 数据不可用');
      setHardwareGauge('hwGpuRing', 'hwGpuVal', null, 'GPU 数据不可用');
      setHardwareGauge('hwVramRing', 'hwVramVal', null, 'VRAM 数据不可用');
      el.hwLive?.classList.add('is-error');
      if (el.hwLiveText) el.hwLiveText.textContent = 'OFFLINE';
    } finally {
      hardwareBusy = false;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* parsing                                                                 */
  /* ----------------------------------------------------------------------- */

  function stripWeights(paragraph) {
    return String(paragraph || '')
      .replace(/\([^()]*\)/g, ' ')
      .replace(/\d+\.\d+/g, ' ');
  }

  function looksLikeProse(paragraph) {
    const p = paragraph.trim();
    if (!p) return false;
    const cleaned = stripWeights(p);
    const marks = (cleaned.match(/[!?。！？]|\.(?=\s|$)/g) || []).length;
    if (marks === 0) return false;
    const commas = (cleaned.match(/[,，]/g) || []).length;
    if (marks >= 2) return true;
    if (commas >= 4) return false;
    return p.split(/\s+/).length > 8;
  }

  function looksLikeTagList(paragraph) {
    const p = paragraph.trim();
    if (!p) return false;
    const cleaned = stripWeights(p);
    const marks = (cleaned.match(/[!?。！？]|\.(?=\s|$)/g) || []).length;
    const commas = (cleaned.match(/[,，]/g) || []).length;
    if (marks >= 2 && commas < 3) return false;
    return commas > 0 || p.includes('\n');
  }

  function splitTags(raw) {
    const out = [];
    let buf = '';
    let depth = 0;
    const push = () => {
      const value = buf.trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
      if (value) out.push(value);
      buf = '';
    };
    for (const ch of String(raw || '')) {
      if (ch === '(' || ch === '[' || ch === '{') { depth += 1; buf += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); buf += ch; continue; }
      if (depth === 0 && (ch === ',' || ch === '，' || ch === '\n' || ch === ';')) { push(); continue; }
      buf += ch;
    }
    push();
    return out;
  }

  const ABBREV_RE = /(?:^|[\s("'“‘])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|u\.s|a\.m|p\.m|no|fig|approx|inc|ltd|co)\.$/i;

  function splitSentences(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const out = [];
    const terminator = (ch) => /[.!?…。！？]/.test(ch);
    const closingQuote = (ch) => ch === '”' || ch === '’';
    const boundaryAfter = (index) => index + 1 >= text.length || /\s/.test(text[index + 1]);
    const endsWithTerm = (slice) => {
      const trimmed = slice.trim();
      return trimmed.length > 0 && terminator(trimmed.slice(-1));
    };
    let start = 0;
    let i = 0;
    let depth = 0;
    let quoteOpen = false;

    const pushTo = (end) => {
      const piece = text.slice(start, end).trim();
      if (piece) out.push(piece);
      start = end;
    };

    while (i < text.length) {
      const ch = text[i];

      if (ch === '“') {
        quoteOpen = true;
        i += 1;
        continue;
      }
      if (closingQuote(ch)) {
        if (quoteOpen) quoteOpen = false;
        if (endsWithTerm(text.slice(start, i)) && boundaryAfter(i)) {
          pushTo(i + 1);
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '"') {
        if (quoteOpen) {
          quoteOpen = false;
          if (endsWithTerm(text.slice(start, i)) && boundaryAfter(i)) {
            pushTo(i + 1);
            i += 1;
            continue;
          }
        } else {
          quoteOpen = true;
        }
        i += 1;
        continue;
      }

      if (!quoteOpen) {
        if (ch === '(' || ch === '[') depth += 1;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      }

      if (!quoteOpen && depth === 0 && terminator(ch)) {
        let j = i + 1;
        while (j < text.length && /[.!?…。！？"'”’]/.test(text[j])) j += 1;
        const next = text[j];
        const chunk = text.slice(start, j);
        const decimal = ch === '.' && /\d$/.test(text.slice(0, i)) && /\d/.test(next || '');
        const trimmed = chunk.trim();
        const abbrev = ch === '.' && (ABBREV_RE.test(trimmed)
          || /^[A-Z]\.$/.test(trimmed)
          || /(?:^|\s)[A-Z]\.$/.test(trimmed));
        if (!decimal && !abbrev && (j >= text.length || /\s/.test(next))) {
          out.push(chunk.trim());
          start = j;
          i = j;
          continue;
        }
        i = j;
        continue;
      }
      i += 1;
    }
    const tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  function looksLikeTagLine(line) {
    const p = String(line || '').trim();
    if (!p) return false;
    const cleaned = stripWeights(p);
    // tag lines never contain real sentence punctuation; weight decimals are stripped
    if (/[!?。！？]|\.(?=\s|$)/.test(cleaned)) return false;
    const commas = (cleaned.match(/[,，]/g) || []).length;
    if (commas >= 1) return true;
    // a single tag per line, e.g. "blue hair" or "looking at viewer"
    const words = p.split(/\s+/);
    if (words.length > 4) return false;
    if (!/^[a-z0-9(]/i.test(p)) return false;
    return !/^(a|an|the|his|her|he|she|it|is|are|was|were|with|and|of)\b/i.test(p);
  }

  function parsePrompt(raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return { tags: [], sentences: [] };

    let tagText = '';
    let descText = '';
    const paragraphs = text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);

    if (paragraphs.length >= 2 && !looksLikeProse(paragraphs[0])) {
      tagText = paragraphs[0];
      descText = paragraphs.slice(1).join('\n');
    } else if (paragraphs.length === 1) {
      // No blank line: scan leading lines that look like tags, then treat the
      // rest as the natural-language description.
      const lines = paragraphs[0].split('\n').map((line) => line.trim()).filter(Boolean);
      const tagLines = [];
      let cursor = 0;
      while (cursor < lines.length && looksLikeTagLine(lines[cursor])) {
        tagLines.push(lines[cursor]);
        cursor += 1;
      }
      if (tagLines.length) {
        tagText = tagLines.join('\n');
        descText = lines.slice(cursor).join(' ');
      } else {
        descText = paragraphs[0];
      }
    } else {
      descText = text;
    }

    const tags = splitTags(tagText).map((value, index) => ({
      id: 't' + index, kind: 'tag', text: value,
    }));

    const description = descText.replace(/\s*\n\s*/g, ' ').trim();
    const sentences = splitSentences(description).map((value, index) => ({
      id: 's' + index, kind: 'sentence', text: value,
    }));

    return { tags, sentences };
  }

  /* ----------------------------------------------------------------------- */
  /* glossary                                                                */
  /* ----------------------------------------------------------------------- */

  function loadGlossary() {
    if (state.glossaryPromise) return state.glossaryPromise;
    state.glossaryPromise = (async () => {
      try {
        const res = await fetch('/api/glossary', { cache: 'no-store' });
        if (!res.ok) throw new Error('glossary unavailable');
        const data = await res.json();
        state.glossary = data.entries || {};
        resetGlossaryRows(state.glossary);
        rebuildGlossaryReverse();
        if (el.glossaryFormCount) el.glossaryFormCount.textContent = String(state.glossaryRows.length);
      } catch {
        state.glossary = {};
        state.glossaryRows = [];
        state.glossaryReverse = new Map();
      }
      return state.glossary;
    })();
    return state.glossaryPromise;
  }

  function normTagKey(text) {
    return String(text || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function lookupGlossary(text) {
    const entries = state.glossary || {};
    let key = normTagKey(text);
    if (!key) return '';
    if (entries[key]) return entries[key];
    const weighted = key.match(/^\((.*):\d+(?:\.\d+)?\)$/);
    if (weighted) {
      key = weighted[1].trim();
      if (entries[key]) return entries[key];
    }
    if (key.startsWith('(') && key.endsWith(')')) {
      key = key.slice(1, -1).trim();
      if (entries[key]) return entries[key];
    }
    return '';
  }

  function normalizeGlossaryZh(value) {
    return String(value || '')
      .trim()
      .replace(/[，,。.!！?？、；;：:]+$/g, '')
      .replace(/\s+/g, '');
  }

  /* 反查走预建索引（词条上万后逐条归一化太慢）；索引缺失时退回线性扫描。 */
  function lookupGlossaryReverse(text) {
    if (state.config?.options?.useGlossary === false) return null;
    const target = normalizeGlossaryZh(text);
    if (!target) return null;
    if (state.glossaryReverse) return state.glossaryReverse.get(target) || null;
    for (const [en, zh] of Object.entries(state.glossary || {})) {
      if (normalizeGlossaryZh(zh) === target) {
        return { en, zh: String(zh).trim() };
      }
    }
    return null;
  }

  function rebuildGlossaryReverse() {
    const map = new Map();
    for (const [en, zh] of Object.entries(state.glossary || {})) {
      const key = normalizeGlossaryZh(zh);
      if (key && !map.has(key)) map.set(key, { en, zh: String(zh).trim() });
    }
    state.glossaryReverse = map;
  }

  /* ----------------------------------------------------------------------- */
  /* 词块编辑 · 词库相近 tag 浮窗                                             */
  /* ----------------------------------------------------------------------- */

  const TAG_SUGGEST_LIMIT = 10;
  const TAG_SUGGEST_MIN_CHARS = 1;
  let tagSuggestEl = null;
  let tagSuggestItems = [];
  let tagSuggestActive = 0;
  let tagIndexCache = { src: null, list: [] };

  /* 词库可能上万条：把 [en, zh] 拍平成小写数组缓存，键按 state.glossary 的引用判断，
     词条保存/重载换了对象就自动重建。 */
  function glossaryTagIndex() {
    if (tagIndexCache.src === state.glossary) return tagIndexCache.list;
    const list = [];
    for (const [en, zh] of Object.entries(state.glossary || {})) {
      if (!en) continue;
      list.push({
        en,
        zh: String(zh || '').trim(),
        enLower: String(en).toLowerCase(),
        zhLower: String(zh || '').toLowerCase(),
      });
    }
    tagIndexCache = { src: state.glossary, list };
    return list;
  }

  /* 子序列匹配：查询字符按顺序出现在 tag 里（"blsh" → "blue shirt"） */
  function subsequenceScore(text, query) {
    let at = -1;
    let gaps = 0;
    for (const ch of query) {
      const next = text.indexOf(ch, at + 1);
      if (next < 0) return 0;
      gaps += next - at - 1;
      at = next;
    }
    return Math.max(80, 260 - Math.min(140, gaps * 6) - Math.min(60, text.length - query.length));
  }

  function scoreTagSuggestion(entry, query) {
    const en = entry.enLower;
    let score = 0;
    const extra = Math.min(90, en.length - query.length);
    const at = en.indexOf(query);
    if (at === 0) {
      score = en === query ? 1200 : 980 - extra;
    } else if (at > 0) {
      const prev = en[at - 1];
      const atWord = prev === ' ' || prev === '_' || prev === '-' || prev === '(' || prev === '/';
      score = (atWord ? 800 : 620) - Math.min(120, at * 4) - extra;
    } else {
      score = subsequenceScore(en, query);
    }
    /* 中文输入（或者在中文侧编辑）也要能命中：中文命中优先于弱子序列 */
    const zhAt = entry.zhLower.indexOf(query);
    if (zhAt === 0) {
      score = Math.max(score, 900 - Math.min(90, entry.zhLower.length - query.length));
    } else if (zhAt > 0) {
      score = Math.max(score, 560 - Math.min(120, zhAt * 4));
    }
    return score;
  }

  function suggestTags(query, limit = TAG_SUGGEST_LIMIT) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < TAG_SUGGEST_MIN_CHARS || q.length > 60) return [];
    const scored = [];
    for (const entry of glossaryTagIndex()) {
      const score = scoreTagSuggestion(entry, q);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score
      || a.entry.en.length - b.entry.en.length
      || (a.entry.en < b.entry.en ? -1 : a.entry.en > b.entry.en ? 1 : 0));
    return scored.slice(0, limit).map((hit) => hit.entry);
  }

  function ensureTagSuggestEl() {
    if (tagSuggestEl) return tagSuggestEl;
    const node = document.createElement('div');
    node.className = 'tag-suggest';
    node.id = 'tagSuggest';
    node.hidden = true;
    node.setAttribute('role', 'listbox');
    node.setAttribute('aria-label', '词库相近词条');
    /* mousedown 就接管：点击浮窗不能先把输入框的 focus 抢走，否则会触发取消编辑 */
    node.addEventListener('mousedown', (event) => {
      const item = event.target.closest?.('.tag-suggest-item');
      if (!item) return;
      event.preventDefault();
      const index = Number(item.dataset.i);
      if (Number.isInteger(index) && tagSuggestItems[index]) applyTagSuggestion(tagSuggestItems[index]);
    });
    node.addEventListener('mouseover', (event) => {
      const item = event.target.closest?.('.tag-suggest-item');
      if (!item) return;
      setTagSuggestActive(Number(item.dataset.i));
    });
    document.body.appendChild(node);
    tagSuggestEl = node;
    return node;
  }

  function tagSuggestHtml(items) {
    const rows = items.map((entry, i) => (
      `<button type="button" class="tag-suggest-item" data-i="${i}" role="option">` +
      `<span class="ts-en">${esc(entry.en)}</span>` +
      `<span class="ts-zh">${esc(entry.zh) || '—'}</span></button>`
    )).join('');
    return `<div class="tag-suggest-head"><span>TAG SUGGEST · 相近词条</span>` +
      `<span class="ts-hint">TAB 补全 · ↑↓ 选择 · ESC 关闭</span></div>` +
      `<div class="tag-suggest-list">${rows}</div>`;
  }

  function setTagSuggestActive(index) {
    if (!tagSuggestEl || !tagSuggestItems.length) return;
    const next = Math.max(0, Math.min(tagSuggestItems.length - 1, index));
    if (next === tagSuggestActive) return;
    tagSuggestActive = next;
    tagSuggestEl.querySelectorAll('.tag-suggest-item').forEach((node, i) => {
      const on = i === tagSuggestActive;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const active = tagSuggestEl.querySelector('.tag-suggest-item.is-active');
    if (active && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  /* 浮窗优先放在编辑中的词块上方；上方空间不够时翻到下方。 */
  function placeTagSuggest(input) {
    const node = ensureTagSuggestEl();
    const rect = input.getBoundingClientRect();
    const width = Math.min(Math.max(320, rect.width), window.innerWidth - 16);
    node.style.width = `${width}px`;
    node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    node.style.top = '0px';
    node.style.bottom = 'auto';
    const height = node.offsetHeight;
    const above = rect.top - height - 10;
    if (above >= 8) {
      node.style.top = `${above}px`;
    } else {
      node.style.top = `${Math.min(window.innerHeight - height - 8, rect.bottom + 10)}px`;
    }
  }

  function renderTagSuggest(input) {
    if (!input || !input.classList.contains('inline-edit')) return;
    const editing = state.editing;
    if (!editing) return hideTagSuggest();
    const block = findBlock(editing.bid);
    /* 只有词块（tag）才有相近词条；描述句子编辑不弹 */
    if (!block || block.kind !== 'tag') return hideTagSuggest();
    const items = suggestTags(input.value);
    if (!items.length) return hideTagSuggest();
    tagSuggestItems = items;
    tagSuggestActive = -1;
    const node = ensureTagSuggestEl();
    node.innerHTML = tagSuggestHtml(items);
    node.hidden = false;
    setTagSuggestActive(0);
    requestAnimationFrame(() => {
      if (!node.hidden && document.activeElement === input) placeTagSuggest(input);
    });
    placeTagSuggest(input);
  }

  function hideTagSuggest() {
    tagSuggestItems = [];
    tagSuggestActive = 0;
    if (tagSuggestEl) {
      tagSuggestEl.hidden = true;
      tagSuggestEl.innerHTML = '';
    }
  }

  function tagSuggestOpen() {
    return Boolean(tagSuggestEl && !tagSuggestEl.hidden && tagSuggestItems.length);
  }

  function applyTagSuggestion(entry) {
    const input = document.querySelector('.inline-edit');
    if (!input || !state.editing || !entry) return;
    /* 中文侧编辑填译文，英文侧填原文 */
    const value = state.editing.side === 'target' ? entry.zh : entry.en;
    input.value = value;
    input.focus();
    input.setSelectionRange(value.length, value.length);
    hideTagSuggest();
  }

  /* ----------------------------------------------------------------------- */
  /* glossary editor                                                         */
  /* ----------------------------------------------------------------------- */

  /* 词条库动辄上万条：一次性铺开 9142 个 input 等于每次切进视图都要重排
     约 96000 个布局对象（实测 880–1370ms 首帧）。所以 DOM 里只保留视口
     附近的行，真实编辑状态放在 state.glossaryRows，滚动时按需重建窗口。 */
  const GLOSSARY_OVERSCAN = 8;          // 视口上下各多渲染的行数
  const GLOSSARY_ROW_H_FALLBACK = 61;   // 未实测前的行高估计

  function glossaryCellHtml(rowIndex, row) {
    return `<div class="glossary-cell" data-index="${rowIndex}">` +
      `<input class="glossary-en" spellcheck="false" placeholder="english tag" value="${esc(row.en)}">` +
      `<input class="glossary-zh" spellcheck="false" placeholder="中文译法" value="${esc(row.zh)}">` +
      `<button type="button" class="glossary-del" title="删除该词条" aria-label="删除">×</button>` +
      `</div>`;
  }

  function glossaryRowHeight() {
    return state.glossaryRowH > 0 ? state.glossaryRowH : GLOSSARY_ROW_H_FALLBACK;
  }

  function measureGlossaryRowHeight() {
    const row = el.glossaryList.querySelector('.glossary-row');
    if (!row || !row.querySelector('.glossary-cell')) return 0;
    const height = Math.round(row.getBoundingClientRect().height);
    return height > 8 ? height : 0;
  }

  /* 只画 [start, end) 的视觉行，上下留两个流内 spacer 撑出完整滚动高度。
     注意不能用容器 padding 撑高：#glossaryList 是 border-box 的弹性子项，
     padding 会把元素自身顶高，clientHeight 随之暴涨，可见行数进入死循环。 */
  function renderGlossaryWindow(force = false, startOverride = null) {
    const list = el.glossaryList;
    if (!list) return;
    state.glossaryRendered = true;
    const rows = state.glossaryRows;
    const view = state.glossaryView;
    const totalPairs = Math.ceil(view.length / 2);
    if (!rows.length || !totalPairs) {
      list.innerHTML = rows.length
        ? '<div class="glossary-row"><span class="blk-empty">NO MATCH / 没有匹配的词条</span></div>'
        : '<div class="glossary-row"><span class="blk-empty">NO ENTRIES / 暂无词条</span></div>';
      state.glossaryWindow = { start: -1, end: -1 };
      return;
    }
    const rowHeight = glossaryRowHeight();
    const viewport = list.clientHeight || 620;
    const visiblePairs = Math.max(1, Math.ceil(viewport / rowHeight));
    const start = startOverride === null || startOverride === undefined
      ? Math.max(0, Math.min(
        Math.max(0, totalPairs - 1),
        Math.floor(list.scrollTop / rowHeight) - GLOSSARY_OVERSCAN,
      ))
      : Math.max(0, Math.min(Math.max(0, totalPairs - 1), startOverride));
    const end = Math.min(totalPairs, start + visiblePairs + GLOSSARY_OVERSCAN * 2);
    const win = state.glossaryWindow;
    if (!force && win.start === start && win.end === end) return;
    const html = [];
    if (start > 0) html.push(`<div class="glossary-spacer" style="height:${start * rowHeight}px"></div>`);
    for (let pair = start; pair < end; pair += 1) {
      const first = view[pair * 2];
      const second = view[pair * 2 + 1];
      let cells = '';
      if (first !== undefined) cells += glossaryCellHtml(first, rows[first]);
      if (second !== undefined) cells += glossaryCellHtml(second, rows[second]);
      html.push(`<div class="glossary-row">${cells}</div>`);
    }
    if (end < totalPairs) html.push(`<div class="glossary-spacer" style="height:${(totalPairs - end) * rowHeight}px"></div>`);
    const keepTop = list.scrollTop;
    list.innerHTML = html.join('');
    if (list.scrollTop !== keepTop) list.scrollTop = keepTop;
    state.glossaryWindow = { start, end };
    /* 第一次渲染后用实测行高校准，CSS 改过 padding/height 也不会累积偏移 */
    if (!state.glossaryRowH) {
      const measured = measureGlossaryRowHeight();
      if (measured && Math.abs(measured - rowHeight) > 1) {
        state.glossaryRowH = measured;
        state.glossaryWindow = { start: -1, end: -1 };
        requestAnimationFrame(() => renderGlossaryWindow(true));
      }
    }
  }

  /* 过滤改到数据层做，不再读 DOM；顺带刷新页头/页脚计数。 */
  function refreshGlossaryView(options = {}) {
    const rows = state.glossaryRows;
    const query = (el.glossarySearch?.value || '').trim().toLowerCase();
    let view;
    if (!query) {
      view = new Array(rows.length);
      for (let index = 0; index < rows.length; index += 1) view[index] = index;
    } else {
      view = [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row.en.toLowerCase().includes(query) || row.zh.toLowerCase().includes(query)) {
          view.push(index);
        }
      }
    }
    state.glossaryView = view;
    state.glossaryWindow = { start: -1, end: -1 };
    el.glossaryMeta.textContent = `${rows.length} ENTRIES`;
    el.glossaryVisibleMeta.textContent = `VISIBLE ${view.length} / ${rows.length}`;
    if (el.glossaryFormCount) el.glossaryFormCount.textContent = String(rows.length);
    if (options.resetScroll) {
      el.glossaryList.scrollTop = 0;
      state.glossaryScrollTop = 0;
    }
    renderGlossaryWindow(true);
  }

  /* 校验失败时把出问题的行滚进视口再聚焦（行可能远在当前窗口之外，
     直接设 scrollTop 会被当前 scrollHeight 截断，所以先按目标行重建窗口）。 */
  function focusGlossaryRow(rowIndex, field) {
    const list = el.glossaryList;
    const position = state.glossaryView.indexOf(rowIndex);
    if (position < 0) return;
    const pair = Math.floor(position / 2);
    const rowHeight = glossaryRowHeight();
    const visiblePairs = Math.max(1, Math.ceil((list.clientHeight || 620) / rowHeight));
    renderGlossaryWindow(true, Math.max(0, pair - Math.floor(visiblePairs / 2) - GLOSSARY_OVERSCAN));
    list.scrollTop = Math.max(0, pair * rowHeight - rowHeight * 2);
    renderGlossaryWindow();
    const cell = list.querySelector(`.glossary-cell[data-index="${rowIndex}"]`);
    const input = cell && cell.querySelector(field === 'zh' ? '.glossary-zh' : '.glossary-en');
    if (input) input.focus();
  }

  let glossaryScrollRaf = 0;
  function onGlossaryScroll() {
    if (el.glossaryList.clientHeight > 0) state.glossaryScrollTop = el.glossaryList.scrollTop;
    if (glossaryScrollRaf) return;
    glossaryScrollRaf = requestAnimationFrame(() => {
      glossaryScrollRaf = 0;
      renderGlossaryWindow();
    });
  }

  /* ----------------------------------------------------------------------- */
  /* 词块 → 词条库：选择态 · 拖拽释放 · 确认添加                                */
  /* ----------------------------------------------------------------------- */

  /* 词块相对词条库的三种状态：
     new   —— 库里没有该英文词条（默认可勾选）
     drift —— 库里有，但当前中文译法和库值不同（可勾选，属于“改写”）
     same  —— 库里有且译法一致（不可勾选）
     skip  —— 句块 / 空词块，不入库 */
  function glossaryBlockZh(block) {
    return String(state.translations?.[block.id]?.text || '').trim();
  }

  function glossaryBlockStatus(block) {
    if (!block || block.kind !== 'tag') return 'skip';
    const en = String(block.text || '').trim();
    if (!en) return 'skip';
    const existing = lookupGlossary(en);
    if (!existing) return 'new';
    const zh = glossaryBlockZh(block);
    if (!zh) return 'drift';
    return normalizeGlossaryZh(existing) === normalizeGlossaryZh(zh) ? 'same' : 'drift';
  }

  function glossaryCandidateBlocks() {
    return (state.blocks?.tags || []).filter((block) => {
      const status = glossaryBlockStatus(block);
      return status === 'new' || status === 'drift';
    });
  }

  /* 英文 → 词库键（尽量复用库里已有的键，避免下划线/空格写法出现重复词条） */
  function glossaryKeyInfo(en, zh) {
    const entries = state.glossary || {};
    const key = normTagKey(en);
    let realKey = key;
    let existing = '';
    if (key && entries[key] !== undefined) {
      realKey = key;
      existing = String(entries[key] || '');
    } else if (key) {
      for (const [k, v] of Object.entries(entries)) {
        if (normTagKey(k) === key) { realKey = k; existing = String(v || ''); break; }
      }
    }
    let mode = 'new';
    if (existing) {
      mode = normalizeGlossaryZh(existing) === normalizeGlossaryZh(zh) ? 'same' : 'update';
    }
    return { key: realKey || key, existing, mode };
  }

  function syncGlossaryAddTrigger() {
    const btn = el.glossaryAddTrigger;
    if (!btn) return;
    const add = state.glossaryAdd;
    const armed = Boolean(add.dragArmed);
    btn.classList.toggle('is-picking', add.picking);
    btn.dataset.state = armed ? 'drop' : (add.picking ? 'pick' : 'idle');
    btn.setAttribute('aria-pressed', add.picking ? 'true' : 'false');
    btn.setAttribute('aria-expanded', add.open ? 'true' : 'false');
    const count = add.picks.size;
    btn.dataset.picks = add.picking && count > 0 ? 'on' : 'none';
    if (el.glossaryAddLabel) {
      el.glossaryAddLabel.textContent = armed
        ? '在此释放以添加'
        : (add.picking ? (count > 0 ? '确认添加' : '取消高亮') : '添加入词库');
    }
    btn.title = add.picking
      ? (count > 0 ? '确认添加已勾选的词块，再点一次打开确认浮窗' : '退出选择态，取消词块高亮')
      : '把未入库的词块勾选后写入词条库';
    if (el.glossaryAddCount) {
      el.glossaryAddCount.hidden = !(add.picking && !armed && count > 0);
      el.glossaryAddCount.textContent = String(count);
    }
  }

  /* 双侧面板（原文词块 / 译文词块）同步勾选态；只在 css 上做区分 */
  function syncGlossaryPickClass() {
    const add = state.glossaryAdd;
    const picking = Boolean(add && add.picking);
    document.body.classList.toggle('glossary-picking', picking);
    const nodes = document.querySelectorAll('#segmentsBody .blk, #targetBody .blk');
    nodes.forEach((node) => {
      if (!picking) { node.removeAttribute('data-gpick'); return; }
      const block = findBlock(node.dataset.bid);
      const status = glossaryBlockStatus(block);
      if (status === 'skip') { node.removeAttribute('data-gpick'); return; }
      if (add.picks.has(node.dataset.bid) && status !== 'same') {
        node.dataset.gpick = 'on';
        return;
      }
      node.dataset.gpick = status === 'drift' ? 'drift' : status;
    });
  }

  function enterGlossaryPick() {
    const add = state.glossaryAdd;
    if (add.picking) return;
    if (!state.blocks) { toast('先翻译一段提示词，再往里加词条', 'info', 2400); return; }
    if (state.phase === 'translating') { toast('翻译进行中，稍后再试', 'info', 2400); return; }
    const candidates = glossaryCandidateBlocks();
    if (!candidates.length) { toast('当前词块都已在词条库中', 'info', 2600); return; }
    hideTagSuggest();
    if (state.selectedBlockId) setSelectedBlock(null);
    add.picking = true;
    add.picks.clear();
    syncGlossaryPickClass();
    syncGlossaryAddTrigger();
    toast(`已高亮 ${candidates.length} 个未入库词块 · 点击勾选后点按钮确认，再点一次取消高亮`, 'info', 3800);
  }

  function exitGlossaryPick({ silent = false } = {}) {
    const add = state.glossaryAdd;
    if (!add.picking) return;
    add.picking = false;
    add.picks.clear();
    add.dragArmed = false;
    syncGlossaryPickClass();
    syncGlossaryAddTrigger();
    if (!silent) toast('已退出添加入词库', 'info', 1800);
  }

  function toggleGlossaryPick(bid) {
    const add = state.glossaryAdd;
    if (!add.picking || !bid) return;
    const block = findBlock(bid);
    const status = glossaryBlockStatus(block);
    if (status === 'same') { toast('该词块已在词条库中，译法一致', 'info', 2000); return; }
    if (status === 'skip') { toast('句块不能入库，请选择 TAGS 词块', 'info', 2400); return; }
    if (add.picks.has(bid)) add.picks.delete(bid);
    else add.picks.add(bid);
    syncGlossaryPickClass();
    syncGlossaryAddTrigger();
  }

  function onGlossaryAddTrigger() {
    const add = state.glossaryAdd;
    if (add.open) return;
    if (!add.picking) { enterGlossaryPick(); return; }
    const bids = [...add.picks];
    /* 还没勾选任何词块时，再点按钮即退出选择态（取消高亮） */
    if (!bids.length) { exitGlossaryPick(); return; }
    openGlossaryAddDialog(bids);
  }

  /* 词块末尾常带句号/逗号（源提示词的断句标点），入库前去掉，避免写出 "xxx." 这种键 */
  function glossaryTrimEntry(text) {
    return String(text || '')
      .replace(/[\s,，、;；:：]+$/g, '')
      .replace(/\.+$/g, '')
      .trim();
  }

  function buildGlossaryAddRows(bids) {
    const rows = [];
    const seen = new Set();
    for (const bid of bids) {
      if (seen.has(bid)) continue;
      const block = findBlock(bid);
      if (!block || block.kind !== 'tag') continue;
      seen.add(bid);
      const en = glossaryTrimEntry(block.text);
      if (!en) continue;
      rows.push({ bid, en, zh: glossaryTrimEntry(glossaryBlockZh(block)) });
    }
    return rows;
  }

  function glossaryAddRowHtml(row, index) {
    const info = glossaryKeyInfo(row.en, row.zh);
    const badge = info.mode === 'update' ? 'UPDATE · 改写'
      : (info.mode === 'same' ? 'EXIST · 一致' : 'NEW · 新增');
    const diffHidden = info.mode === 'new' ? ' hidden' : '';
    const diffLabel = info.mode === 'same' ? '本次输入' : '本次改写';
    return `<div class="ga-row" data-index="${index}" data-mode="${info.mode}">` +
      `<span class="ga-idx">${pad2(index + 1)}</span>` +
      `<div class="ga-main">` +
        `<div class="ga-fields">` +
          `<label class="ga-field ga-field-en"><span>EN // 英文词条</span>` +
            `<input class="ga-input" data-field="en" spellcheck="false" autocomplete="off" value="${esc(row.en)}"></label>` +
          `<label class="ga-field ga-field-zh"><span>ZH // 中文译法</span>` +
            `<input class="ga-input" data-field="zh" spellcheck="false" autocomplete="off" value="${esc(row.zh)}"></label>` +
        `</div>` +
        `<div class="ga-diff"${diffHidden}>` +
          `<span class="ga-diff-label">词库现值</span>` +
          `<s class="ga-diff-old">${esc(info.existing)}</s>` +
          `<span class="ga-diff-arrow" aria-hidden="true">-&gt;</span>` +
          `<span class="ga-diff-label is-new">${diffLabel}</span>` +
          `<b class="ga-diff-new">${esc(row.zh || '—')}</b>` +
        `</div>` +
      `</div>` +
      `<span class="ga-badge">${badge}</span>` +
    `</div>`;
  }

  function syncGlossaryAddMeta() {
    const rows = state.glossaryAdd.rows || [];
    let added = 0;
    let updated = 0;
    let same = 0;
    for (const row of rows) {
      const info = glossaryKeyInfo(row.en, row.zh);
      if (info.mode === 'update') updated += 1;
      else if (info.mode === 'same') same += 1;
      else added += 1;
    }
    if (el.glossaryAddMeta) {
      el.glossaryAddMeta.textContent = `${rows.length} 项 · 新增 ${added} · 改写 ${updated}` +
        (same ? ` · 一致 ${same}` : '');
    }
    if (el.glossaryAddOk) el.glossaryAddOk.disabled = !added && !updated;
    if (el.glossaryAddNote) {
      el.glossaryAddNote.textContent = (!added && !updated)
        ? '没有需要写入的变化；未入库的词块可先改中文译法。'
        : (updated ? `其中 ${updated} 项会覆盖词条库中已有的中文译法。` : '确认后写入词条库，可直接改写英文或中文。');
    }
  }

  function renderGlossaryAddRows() {
    if (!el.glossaryAddList) return;
    el.glossaryAddList.innerHTML = state.glossaryAdd.rows
      .map((row, index) => glossaryAddRowHtml(row, index)).join('');
    el.glossaryAddList.scrollTop = 0;
    syncGlossaryAddMeta();
  }

  function updateGlossaryRowState(rowEl) {
    if (!rowEl) return;
    const index = Number(rowEl.dataset.index);
    const row = state.glossaryAdd.rows[index];
    if (!row) return;
    const enInput = rowEl.querySelector('[data-field="en"]');
    const zhInput = rowEl.querySelector('[data-field="zh"]');
    if (enInput) row.en = enInput.value;
    if (zhInput) row.zh = zhInput.value;
    const info = glossaryKeyInfo(row.en, row.zh);
    rowEl.dataset.mode = info.mode;
    const badge = rowEl.querySelector('.ga-badge');
    if (badge) {
      badge.textContent = info.mode === 'update' ? 'UPDATE · 改写'
        : (info.mode === 'same' ? 'EXIST · 一致' : 'NEW · 新增');
    }
    const diff = rowEl.querySelector('.ga-diff');
    if (diff) {
      diff.hidden = info.mode === 'new';
      const old = diff.querySelector('.ga-diff-old');
      if (old) old.textContent = info.existing;
      const label = diff.querySelector('.ga-diff-label.is-new');
      if (label) label.textContent = info.mode === 'same' ? '本次输入' : '本次改写';
      const fresh = diff.querySelector('.ga-diff-new');
      if (fresh) fresh.textContent = String(row.zh || '').trim() || '—';
    }
    syncGlossaryAddMeta();
  }

  function focusGlossaryAddRow(index, field) {
    if (!el.glossaryAddList) return;
    const input = el.glossaryAddList
      .querySelector(`.ga-row[data-index="${index}"] [data-field="${field || 'en'}"]`);
    if (input) {
      input.scrollIntoView({ block: 'nearest' });
      input.focus();
      input.select?.();
    }
  }

  function openGlossaryAddDialog(bids, { fromDrop = false } = {}) {
    const candidates = buildGlossaryAddRows(bids || []);
    const rows = candidates.filter((row) => glossaryKeyInfo(row.en, row.zh).mode !== 'same');
    if (!rows.length) {
      toast(candidates.length ? '所选词块与词条库一致，无需写入' : '没有可写入词条库的词块', 'info', 2600);
      return;
    }
    const add = state.glossaryAdd;
    add.rows = rows;
    add.open = true;
    add.returnFocus = document.activeElement;
    renderGlossaryAddRows();
    mShow(el.glossaryAddBackdrop, { enter: 'fade' });
    syncGlossaryAddTrigger();
    if (fromDrop) toast(`已接收 ${rows.length} 个词块 · 确认后写入`, 'info', 2400);
    requestAnimationFrame(() => {
      const input = el.glossaryAddList?.querySelector('[data-field="zh"]');
      if (input) { input.focus(); input.select?.(); }
    });
  }

  function closeGlossaryAddDialog() {
    const add = state.glossaryAdd;
    if (!add.open) return;
    add.open = false;
    add.rows = [];
    if (el.glossaryAddList) el.glossaryAddList.innerHTML = '';
    if (el.glossaryAddMeta) el.glossaryAddMeta.textContent = '';
    if (el.glossaryAddNote) el.glossaryAddNote.textContent = '';
    if (el.glossaryAddOk) el.glossaryAddOk.disabled = true;
    if (el.glossaryAddBackdrop) mHide(el.glossaryAddBackdrop, { leave: 'fade' });
    syncGlossaryAddTrigger();
    const back = add.returnFocus;
    add.returnFocus = null;
    if (back && typeof back.focus === 'function' && back.isConnected) back.focus();
  }

  async function submitGlossaryAdd() {
    const add = state.glossaryAdd;
    if (!add.open || add.busy) return;
    const rowEls = el.glossaryAddList ? [...el.glossaryAddList.querySelectorAll('.ga-row')] : [];
    rowEls.forEach(updateGlossaryRowState);
    const rows = add.rows;
    const seen = new Set();
    const payload = [];
    for (let index = 0; index < rows.length; index += 1) {
      const en = String(rows[index].en || '').trim().toLowerCase();
      const zh = String(rows[index].zh || '').trim();
      if (!en || !zh) {
        toast(`第 ${index + 1} 项需要同时填写英文和中文`, 'error', 3000);
        focusGlossaryAddRow(index, en ? 'zh' : 'en');
        return;
      }
      if (en.includes(',') || en.includes('\n')) {
        toast('英文词条不能包含逗号或换行', 'error', 3000);
        focusGlossaryAddRow(index, 'en');
        return;
      }
      if (en.length > 120 || zh.length > 160) {
        toast('词条太长（英文 ≤120，中文 ≤160）', 'error', 3000);
        focusGlossaryAddRow(index, en.length > 120 ? 'en' : 'zh');
        return;
      }
      if (seen.has(en)) {
        toast(`英文词条重复：${en}`, 'error', 3000);
        focusGlossaryAddRow(index, 'en');
        return;
      }
      seen.add(en);
      payload.push({ en, zh });
    }
    if (!payload.length) return;
    if (state.glossaryDirty && !(await confirmDiscardAction(
      '词条库有未保存的修改。本次写入以已保存的词条库为基准，未保存的改动会被覆盖。继续添加？',
      '词条库有未保存修改'))) return;

    const entries = { ...(state.glossary || {}) };
    let added = 0;
    let updated = 0;
    for (const item of payload) {
      const info = glossaryKeyInfo(item.en, item.zh);
      const key = info.key;
      const current = entries[key];
      if (current === undefined || current === '') added += 1;
      else if (normalizeGlossaryZh(current) !== normalizeGlossaryZh(item.zh)) updated += 1;
      entries[key] = item.zh;
    }
    add.busy = true;
    if (el.glossaryAddOk) { el.glossaryAddOk.disabled = true; el.glossaryAddOk.textContent = '写入中…'; }
    try {
      const res = await fetch('/api/glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) throw new Error(data?.error?.message || '写入失败');
      state.glossary = entries;
      state.glossaryPromise = Promise.resolve(entries);
      rebuildGlossaryReverse();
      resetGlossaryRows(entries);
      markGlossaryDirty(false);
      refreshGlossaryView();
      closeGlossaryAddDialog();
      exitGlossaryPick({ silent: true });
      if (state.blocks) { renderSegments(); renderTarget(); }
      toast(`已写入词条库 · 新增 ${added} · 改写 ${updated}`, 'info', 3200);
    } catch (err) {
      toast('写入词条库失败：' + prettyError(err), 'error', 4600);
    } finally {
      add.busy = false;
      if (el.glossaryAddOk) { el.glossaryAddOk.disabled = false; el.glossaryAddOk.textContent = '确认写入'; }
      syncGlossaryAddMeta();
    }
  }

  function markGlossaryDirty(dirty) {
    state.glossaryDirty = dirty;
    el.glossaryDirty.hidden = !dirty;
  }

  /* 接口数据 → 编辑真源（state.glossaryRows 顺序即显示顺序） */
  function resetGlossaryRows(entries) {
    state.glossaryRows = Object.entries(entries || {})
      .map(([en, zh]) => ({ en: String(en), zh: String(zh) }));
    state.glossaryView = [];
    state.glossaryWindow = { start: -1, end: -1 };
    state.glossaryScrollTop = 0;
  }

  function collectGlossaryEntries() {
    const entries = {};
    const seen = new Set();
    const rows = state.glossaryRows;
    if (!rows.length) {
      toast('词条库不能为空', 'error', 2400);
      return null;
    }
    for (let index = 0; index < rows.length; index += 1) {
      const en = String(rows[index].en || '').trim().toLowerCase();
      const zh = String(rows[index].zh || '').trim();
      if (!en && !zh) continue;
      if (!en || !zh) {
        toast(`第 ${index + 1} 个词条需要同时填写英文和中文`, 'error', 3000);
        focusGlossaryRow(index, en ? 'zh' : 'en');
        return null;
      }
      if (en.includes(',') || en.includes('\n')) {
        toast('英文词条不能包含逗号或换行', 'error', 3000);
        focusGlossaryRow(index, 'en');
        return null;
      }
      if (en.length > 120 || zh.length > 160) {
        toast('词条太长（英文 ≤120，中文 ≤160）', 'error', 3000);
        focusGlossaryRow(index, 'en');
        return null;
      }
      if (seen.has(en)) {
        toast(`英文词条重复：${en}`, 'error', 3000);
        focusGlossaryRow(index, 'en');
        return null;
      }
      seen.add(en);
      entries[en] = zh;
    }
    if (!Object.keys(entries).length) {
      toast('词条库不能为空', 'error', 2400);
      return null;
    }
    return entries;
  }

  async function saveGlossaryEntries() {
    const entries = collectGlossaryEntries();
    if (!entries) return;
    el.glossarySaveBtn.disabled = true;
    el.glossarySaveBtn.textContent = '保存中…';
    try {
      const res = await fetch('/api/glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      state.glossary = entries;
      state.glossaryPromise = Promise.resolve(entries);
      rebuildGlossaryReverse();
      markGlossaryDirty(false);
      refreshGlossaryView();
      toast(`词条库已保存 · ${data.count} 条`, 'info', 2200);
    } catch (err) {
      toast('保存词条库失败：' + prettyError(err), 'error', 4600);
    } finally {
      el.glossarySaveBtn.disabled = false;
      el.glossarySaveBtn.textContent = '保存 SAVE';
    }
  }

  async function reloadGlossaryEntries() {
    if (state.glossaryDirty && !(await confirmDiscardAction(
      '放弃未保存的词条修改并重新载入？', '重新载入词条库'))) return;
    try {
      const res = await fetch('/api/glossary', { cache: 'no-store' });
      if (!res.ok) throw new Error('请求失败');
      const data = await res.json();
      state.glossary = data.entries || {};
      state.glossaryPromise = Promise.resolve(state.glossary);
      resetGlossaryRows(state.glossary);
      rebuildGlossaryReverse();
      markGlossaryDirty(false);
      refreshGlossaryView({ resetScroll: true });
      toast('词条库已重新载入', 'info', 2000);
    } catch (err) {
      toast('载入词条库失败：' + prettyError(err), 'error', 4000);
    }
  }

  function addGlossaryEntry() {
    const enInput = el.glossaryNewEn;
    const zhInput = el.glossaryNewZh;
    const en = enInput.value.trim().toLowerCase();
    const zh = zhInput.value.trim();
    if (!en || !zh) {
      toast('请同时填写英文词条和中文译法', 'error', 2600);
      (en ? zhInput : enInput).focus();
      return;
    }
    if (en.includes(',') || en.includes('\n')) {
      toast('英文词条不能包含逗号或换行', 'error', 2800);
      enInput.focus();
      return;
    }
    const exists = state.glossaryRows
      .some((row) => String(row.en || '').trim().toLowerCase() === en);
    if (exists) {
      toast(`词条已存在：${en}`, 'error', 2600);
      enInput.focus();
      return;
    }
    state.glossaryRows.unshift({ en, zh });
    enInput.value = '';
    zhInput.value = '';
    enInput.focus();
    markGlossaryDirty(true);
    refreshGlossaryView({ resetScroll: true });
    toast('已添加词条，点「保存」后生效', 'info', 2400);
  }

  async function openGlossaryView() {
    if (!state.glossary) {
      await loadGlossary();
    }
    refreshGlossaryView();
    if (state.glossaryScrollTop > 0) {
      el.glossaryList.scrollTop = state.glossaryScrollTop;
      renderGlossaryWindow(true);
    }
    if (!state.glossaryEntered) {
      state.glossaryEntered = true;
      mStagger(el.glossaryList, { step: 18 });
    }
  }

  /* ----------------------------------------------------------------------- */
  /* character cards                                                         */
  /* ----------------------------------------------------------------------- */

  function characterById(id) {
    return (state.characters || []).find((card) => String(card.id) === String(id)) || null;
  }

  function characterPortraitSrc(card) {
    return card?.portrait
      ? `/api/character/portrait/${encodeURIComponent(card.id)}?v=${encodeURIComponent(card.updatedAt || card.portrait)}`
      : '';
  }

  function characterFixedTags(card) {
    const raw = card?.tags;
    if (Array.isArray(raw)) {
      return raw.map((tag) => String(tag || '').trim()).filter(Boolean);
    }
    return String(raw || '').split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
  }

  function closeCharacterPicker() {
    if (!el.characterPickerPanel) return;
    mHide(el.characterPickerPanel, { leave: 'fade' });
    el.characterPickerTrigger?.setAttribute('aria-expanded', 'false');
  }

  function renderCharacterPicker() {
    if (!el.characterPicker) return;
    const cards = state.characters || [];
    const active = state.activeCharacterId ? characterById(state.activeCharacterId) : null;
    const creating = state.characterCreating;
    const gallery = state.characterMode === 'gallery';
    el.characterPickerCount.textContent = String(cards.length);

    if (gallery) {
      el.characterPickerName.textContent = '角色卡列表';
      el.characterPickerSource.textContent = `${cards.length} CARDS`;
    } else if (active && !creating) {
      el.characterPickerName.textContent = active.name || '未命名角色';
      el.characterPickerSource.textContent = active.source || 'CHARACTER CARD';
    } else {
      el.characterPickerName.textContent = creating ? '新建角色卡' : (cards.length ? '选择角色卡' : '暂无角色卡');
      el.characterPickerSource.textContent = 'CHARACTER CARD';
    }

    const newRow = `<button type="button" class="character-pick-row character-pick-new${creating ? ' is-selected' : ''}" data-character-pick-new>` +
      `<span class="character-pick-thumb">＋</span><span class="character-pick-copy"><b>新建角色卡</b><span>NEW CHARACTER</span></span></button>`;
    const rows = cards.map((card) => {
      const selected = !creating && !gallery && String(card.id) === String(state.activeCharacterId);
      const src = characterPortraitSrc(card);
      const thumb = src
        ? `<img src="${src}" alt="">`
        : esc((card.name || 'C').slice(0, 1).toUpperCase());
      return `<button type="button" class="character-pick-row${selected ? ' is-selected' : ''}" data-character-pick="${esc(card.id)}">` +
        `<span class="character-pick-thumb">${thumb}</span>` +
        `<span class="character-pick-copy"><b>${esc(card.name || '未命名角色')}</b><span>${esc(card.source || 'CHARACTER CARD')}</span></span>` +
        `<span class="character-pick-arrow">${selected ? '●' : '›'}</span></button>`;
    }).join('');
    el.characterPickerList.innerHTML = newRow + rows;
  }

  function renderCharacterSelect() {
    const cards = state.characters || [];
    el.characterSelect.innerHTML = '<option value="">＋ NEW / 新建角色卡</option>' +
      cards.map((card) => `<option value="${esc(card.id)}">${esc(card.name || '未命名角色')}${card.source ? ' · ' + esc(card.source) : ''}</option>`).join('');
    el.characterSelect.value = state.activeCharacterId || '';
    el.characterMeta.textContent = `${cards.length} CARDS`;
    el.characterDeleteBtn.disabled = state.characterMode !== 'edit' || !state.activeCharacterId;
    renderCharacterPicker();
  }

  function setCharacterMode(mode) {
    state.characterMode = mode;
    const creating = mode === 'create';
    const wardrobe = mode === 'wardrobe';
    state.characterCreating = creating;
    mSwapIn(el.characterGallery, mode === 'gallery', 'fade');
    mSwapIn(el.characterEditBody, mode === 'edit', 'rise');
    mSwapIn(el.characterEditFoot, mode === 'edit', 'rise');
    mSwapIn(el.characterCreateMode, creating, 'rise');
    mSwapIn(el.characterWardrobe, wardrobe, 'rise');
    el.characterBackBtn.hidden = mode === 'gallery' || wardrobe;
    el.characterDeleteBtn.disabled = mode !== 'edit' || !state.activeCharacterId;
    el.characterNewBtn.disabled = wardrobe;
    el.characterNewBtn.hidden = wardrobe;
    el.characterDeleteBtn.hidden = wardrobe;
    el.characterWardrobeBtn.textContent = '衣柜';
    el.characterWardrobeBtn.hidden = wardrobe;
    el.characterPickerTrigger.disabled = wardrobe;
    if (wardrobe) closeCharacterPicker();
    if (mode !== 'edit' && el.characterComboWardrobePop) {
      el.characterComboWardrobePop.hidden = true;
    }
    if (mode !== 'edit' && el.characterTagsWardrobeFold) {
      mFold(el.characterTagsWardrobeFold, false);
      el.characterTagsWardrobeBtn.setAttribute('aria-expanded', 'false');
    }
    renderCharacterPicker();
  }

  function renderCharacterGallery() {
    const cards = state.characters || [];
    const cardHtml = cards.map((card) => {
      const tags = String(card.tags || '').split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
      const tagHtml = tags.length
        ? tags.map((tag) => `<span class="cg-tag">${esc(tag)}</span>`).join('')
        : '<span class="cg-empty-tags">NO TAGS / 暂无固定词条</span>';
      const src = characterPortraitSrc(card);
      const portrait = src
        ? `<img src="${src}" alt="${esc(card.name || '角色肖像')}" draggable="false">`
        : '<span class="cg-portrait-empty">NO PORTRAIT</span>';
      return `<article class="character-gallery-card" draggable="true" data-character-card="${esc(card.id)}">` +
        `<button type="button" class="cg-delete" data-character-delete="${esc(card.id)}" title="删除角色卡" aria-label="删除角色卡">×</button>` +
        `<div class="cg-main"><div class="cg-portrait">${portrait}</div>` +
        `<div class="cg-info"><span class="cg-code">CHARACTER // CARD</span>` +
        `<h3>${esc(card.name || '未命名角色')}</h3>` +
        `<p class="cg-source">${esc(card.source || '未填写出处')}</p>` +
        `<div class="cg-tags">${tagHtml}</div></div></div>` +
        `<div class="cg-foot">` +
        `<button type="button" class="btn btn-ghost btn-sm" data-character-apply="${esc(card.id)}">填入翻译台</button>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-character-copy="${esc(card.id)}">复制到剪贴板</button>` +
        `</div></article>`;
    }).join('');
    el.characterGalleryGrid.innerHTML = cardHtml +
      `<button type="button" class="character-gallery-card cg-new" id="characterNewCardTile">` +
      `<span class="cg-new-plus">＋</span><b>新建角色卡</b><span>NEW CHARACTER CARD</span></button>`;
    mStagger(el.characterGalleryGrid, { step: 24 });
  }

  function showCharacterGallery() {
    closeCharacterComboAdd();
    state.activeCharacterId = null;
    state.characterPortraitData = null;
    state.characterDirty = false;
    el.characterDirty.hidden = true;
    closeCharacterPicker();
    setCharacterMode('gallery');
    renderCharacterSelect();
    renderCharacterGallery();
  }

  function wardrobeOutfitById(id) {
    return (state.wardrobe || []).find((item) => String(item.id) === String(id)) || null;
  }

  function markWardrobeDirty(dirty) {
    state.wardrobeDirty = !!dirty;
    if (el.wardrobeDirty) el.wardrobeDirty.hidden = !dirty;
  }

  async function loadWardrobe({ silent = false } = {}) {
    try {
      const res = await fetch('/api/wardrobe', { cache: 'no-store' });
      if (!res.ok) throw new Error('衣柜请求失败');
      const data = await res.json();
      state.wardrobe = Array.isArray(data.outfits) ? data.outfits : [];
    } catch (err) {
      state.wardrobe = state.wardrobe || [];
      if (!silent) toast('载入衣柜失败：' + prettyError(err), 'error', 3600);
    }
    renderWardrobe();
    renderWardrobeFoldLists();
  }

  async function ensureWardrobeLoaded() {
    if (state.wardrobe === null) {
      await loadWardrobe({ silent: true });
    } else {
      renderWardrobeFoldLists();
    }
    renderComboWardrobeList();
  }

  function wardrobeMiniCardHtml(outfit, attr) {
    const tags = Array.isArray(outfit.tags) ? outfit.tags : [];
    const image = outfit.image
      ? `<img src="/api/wardrobe/image/${encodeURIComponent(outfit.id)}?v=${encodeURIComponent(outfit.updatedAt || outfit.image)}" alt="">`
      : `<span>${esc((outfit.name || 'W').slice(0, 1).toUpperCase())}</span>`;
    return `<button type="button" class="wardrobe-mini-card" ${attr}="${esc(outfit.id)}">` +
      `<span class="wardrobe-mini-thumb">${image}</span>` +
      `<span class="wardrobe-mini-copy"><b>${esc(outfit.name || '未命名衣物')}</b>` +
      `<span>${tags.length} TAGS</span></span></button>`;
  }

  function renderWardrobeFoldLists() {
    const outfits = state.wardrobe || [];
    const html = outfits.length
      ? outfits.map((outfit) => wardrobeMiniCardHtml(outfit, 'data-wardrobe-fold')).join('')
      : '<div class="source-fold-empty">还没有保存的衣物</div>';
    if (el.wardrobeFoldList) {
      el.wardrobeFoldList.innerHTML = html;
      if (el.wardrobeFoldCount) el.wardrobeFoldCount.textContent = String(outfits.length);
    }
    if (el.sourceWardrobeFoldList) {
      el.sourceWardrobeFoldList.innerHTML = outfits.length
        ? outfits.map((outfit) => wardrobeMiniCardHtml(outfit, 'data-source-wardrobe')).join('')
        : '<div class="source-fold-empty">还没有保存的衣物</div>';
      if (el.sourceWardrobeFoldCount) el.sourceWardrobeFoldCount.textContent = String(outfits.length);
    }
    renderComboWardrobeList();
    renderCharacterTagsWardrobeList();
    hideWardrobeHover();
  }

  function hideWardrobeHover() {
    if (el.wardrobeHoverPop) mHide(el.wardrobeHoverPop, { leave: 'fade' });
  }

  function showWardrobeHover(cardEl, outfit) {
    if (!el.wardrobeHoverPop || !cardEl || !outfit) return;
    const tags = Array.isArray(outfit.tags) ? outfit.tags : [];
    el.wardrobeHoverPop.innerHTML = `<div class="preset-hover-head"><b>${esc(outfit.name || '未命名衣物')}</b><span>${tags.length} TAGS</span></div>` +
      `<div class="preset-hover-tags">${tags.length
        ? tags.map((tag) => `<span class="preset-hover-tag">${esc(tag)}</span>`).join('')
        : '<span class="preset-hover-empty">没有衣物词条</span>'}</div>` +
      (outfit.notes ? `<div class="wardrobe-hover-notes">${esc(outfit.notes)}</div>` : '');
    mShow(el.wardrobeHoverPop, { enter: 'rise' });
    const cardRect = cardEl.getBoundingClientRect();
    const popRect = el.wardrobeHoverPop.getBoundingClientRect();
    let left = Math.min(cardRect.left, window.innerWidth - popRect.width - 12);
    left = Math.max(12, left);
    let top = cardRect.top - popRect.height - 8;
    if (top < 12) top = Math.min(window.innerHeight - popRect.height - 12, cardRect.bottom + 8);
    el.wardrobeHoverPop.style.left = `${Math.round(left)}px`;
    el.wardrobeHoverPop.style.top = `${Math.round(top)}px`;
  }

  function closeWardrobeFold() {
    if (!el.wardrobeFoldBody) return;
    mFold(el.wardrobeFoldBody, false);
    el.wardrobeFoldToggle.setAttribute('aria-expanded', 'false');
    hideWardrobeHover();
  }

  async function toggleWardrobeFold() {
    const opening = el.wardrobeFoldBody.hidden;
    mFold(el.wardrobeFoldBody, opening);
    el.wardrobeFoldToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (!opening) {
      hideWardrobeHover();
      return;
    }
    closeCharacterFold();
    mFold(el.presetFoldBody, false);
    el.presetFoldToggle.setAttribute('aria-expanded', 'false');
    closeSourceFolds();
    hidePresetHover();
    hideCharacterHover();
    await ensureWardrobeLoaded();
  }

  function applyWardrobeFoldOutfit(id) {
    const outfit = wardrobeOutfitById(id);
    const tags = Array.isArray(outfit?.tags) ? outfit.tags : [];
    if (!tags.length) {
      toast('这套衣物没有提示词', 'info', 1800);
      return;
    }
    closeWardrobeFold();
    if (state.phase !== 'idle') backToInput();
    if (document.activeElement !== el.composerInput) {
      el.composerInput.focus();
      const end = el.composerInput.value.length;
      el.composerInput.setSelectionRange(end, end);
    }
    const beforeValue = el.composerInput.value;
    const beforeSelection = [el.composerInput.selectionStart, el.composerInput.selectionEnd];
    insertIntoComposer(tags.join(', '));
    pushActionUndo('插入衣柜提示词', () => {
      el.composerInput.value = beforeValue;
      state.text = beforeValue;
      state.translatedText = beforeValue;
      updateMeter();
      scheduleDraftSave();
      renderSessionBar();
      history.programmaticUndo = false;
      history.programmaticTarget = null;
      el.composerInput.focus();
      if (beforeSelection[0] != null) {
        el.composerInput.setSelectionRange(beforeSelection[0], beforeSelection[1]);
      }
    }, 'wardrobe-insert');
    toast(`已填入 ${outfit.name || '衣物'}`, 'info', 2200);
  }

  function applySourceWardrobeOutfit(id) {
    const outfit = wardrobeOutfitById(id);
    const tags = Array.isArray(outfit?.tags) ? outfit.tags : [];
    if (!tags.length) {
      toast('这套衣物没有提示词', 'info', 1800);
      return;
    }
    const beforeValue = el.sourceText.value;
    const beforeSelection = [el.sourceText.selectionStart, el.sourceText.selectionEnd];
    closeSourceFolds();
    insertIntoSourceText(tags.join(', '));
    pushActionUndo('插入衣柜提示词', () => {
      el.sourceText.value = beforeValue;
      el.sourceText.dispatchEvent(new Event('input', { bubbles: true }));
      history.programmaticUndo = false;
      history.programmaticTarget = null;
      el.sourceText.focus();
      if (beforeSelection[0] != null) {
        el.sourceText.setSelectionRange(beforeSelection[0], beforeSelection[1]);
      }
    }, 'wardrobe-insert');
    toast(`已将 ${outfit.name || '衣物'} 填入原文`, 'info', 2200);
  }

  async function toggleSourceWardrobeFold() {
    const opening = el.sourceWardrobeFoldBody.hidden;
    closeSourceFolds();
    if (!opening) return;
    mFold(el.sourceWardrobeFoldBody, true);
    el.sourceWardrobeFoldToggle.setAttribute('aria-expanded', 'true');
    closeCharacterFold();
    mFold(el.presetFoldBody, false);
    el.presetFoldToggle.setAttribute('aria-expanded', 'false');
    closeWardrobeFold();
    hidePresetHover();
    hideCharacterHover();
    await ensureWardrobeLoaded();
  }

  function inlineWardrobeCardHtml(outfit) {
    const draft = state.wardrobeInlineDraft || {};
    const tags = Array.isArray(outfit.tags) ? outfit.tags : [];
    const preview = state.wardrobeInlinePreviewData
      || (outfit.image ? `/api/wardrobe/image/${encodeURIComponent(outfit.id)}?v=${encodeURIComponent(outfit.updatedAt || outfit.image)}` : '');
    const previewHtml = preview
      ? `<img src="${preview}" alt="衣物示意图">`
      : '<span class="wardrobe-card-no-image">NO PREVIEW</span>';
    return `<article class="wardrobe-card is-inline-editing" data-wardrobe-id="${esc(outfit.id)}">` +
      `<div class="wardrobe-card-main"><button type="button" class="wardrobe-card-preview wardrobe-inline-preview" data-wardrobe-inline-preview="${esc(outfit.id)}" title="点击更换示意图">${previewHtml}` +
      `<span class="wardrobe-inline-preview-hint">点击更换示意图</span></button>` +
      `<div class="wardrobe-inline-form">` +
      `<label class="wardrobe-inline-field"><span>NAME / 名称</span><input data-inline-name="${esc(outfit.id)}" maxlength="80" value="${esc(draft.name ?? outfit.name ?? '')}" spellcheck="false"></label>` +
      `<label class="wardrobe-inline-field"><span>CLOTHING TAGS / 衣物提示词</span><textarea data-inline-tags="${esc(outfit.id)}" rows="4" spellcheck="false">${esc(draft.tags ?? tags.join(', '))}</textarea></label>` +
      `<label class="wardrobe-inline-field"><span>NOTES / 备注</span><textarea data-inline-notes="${esc(outfit.id)}" rows="2" spellcheck="false">${esc(draft.notes ?? outfit.notes ?? '')}</textarea></label>` +
      `</div></div>` +
      `<footer class="wardrobe-inline-actions">` +
      `<button type="button" class="btn btn-ghost btn-sm" data-wardrobe-inline-cancel="${esc(outfit.id)}">取消</button>` +
      `<button type="button" class="btn btn-primary btn-sm" data-wardrobe-inline-save="${esc(outfit.id)}">保存 SAVE</button>` +
      `</footer></article>`;
  }

  function renderWardrobe() {
    if (!el.wardrobeGrid) return;
    const outfits = state.wardrobe || [];
    if (el.wardrobeMeta) el.wardrobeMeta.textContent = `${outfits.length} OUTFITS`;
    const cards = outfits.map((outfit) => {
      if (String(state.wardrobeInlineEditId) === String(outfit.id)) return inlineWardrobeCardHtml(outfit);
      const tags = Array.isArray(outfit.tags) ? outfit.tags : [];
      const tagHtml = tags.length
        ? tags.map((tag) => `<span class="wardrobe-tag">${esc(tag)}</span>`).join('')
        : '<span class="wardrobe-tag">NO TAGS</span>';
      const image = outfit.image
        ? `<img src="/api/wardrobe/image/${encodeURIComponent(outfit.id)}?v=${encodeURIComponent(outfit.updatedAt || outfit.image)}" alt="${esc(outfit.name || '衣物示意图')}" draggable="false">`
        : '<span class="wardrobe-card-no-image">NO PREVIEW</span>';
      return `<article class="wardrobe-card" draggable="true" data-wardrobe-id="${esc(outfit.id)}">` +
        `<button type="button" class="wardrobe-card-delete" data-wardrobe-delete="${esc(outfit.id)}" title="删除衣物" aria-label="删除衣物">×</button>` +
        `<div class="wardrobe-card-main"><div class="wardrobe-card-preview">${image}` +
        `<span class="wardrobe-preview-count">${tags.length} TAGS</span></div>` +
        `<div class="wardrobe-card-info"><span class="wardrobe-card-code">OUTFIT // WARDROBE</span>` +
        `<h3>${esc(outfit.name || '未命名衣物')}</h3>` +
        `<div class="wardrobe-card-tags">${tagHtml}</div>` +
        (outfit.notes ? `<p class="wardrobe-card-notes">${esc(outfit.notes)}</p>` : '') +
        `</div></div>` +
        `<footer class="wardrobe-card-actions">` +
        `<button type="button" class="btn btn-ghost btn-sm" data-wardrobe-edit="${esc(outfit.id)}">编辑</button>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-wardrobe-copy="${esc(outfit.id)}">复制到剪贴板</button>` +
        `</footer></article>`;
    }).join('');
    const addTile = `<button type="button" class="wardrobe-add-card" data-wardrobe-new>` +
      `<span class="wardrobe-add-plus">＋</span><b>添加新作品</b><span>NEW OUTFIT</span></button>`;
    el.wardrobeGrid.innerHTML = cards + addTile;
    mStagger(el.wardrobeGrid, { step: 18 });
    requestAnimationFrame(syncWardrobeCardSize);
  }

  function syncWardrobeCardSize() {
    if (!el.wardrobeGrid || state.characterMode !== 'wardrobe' || !el.wardrobeEditor.hidden) return;
    const body = el.wardrobeGrid.parentElement;
    if (!body) return;
    const style = getComputedStyle(body);
    const available = body.clientHeight
      - parseFloat(style.paddingTop || '0')
      - parseFloat(style.paddingBottom || '0');
    if (available <= 0) return;
    const gap = 16;
    const height = Math.max(240, Math.floor((available - gap) / 2));
    el.wardrobeGrid.style.setProperty('--wardrobe-card-height', `${height}px`);
  }

  function setWardrobeEditing(editing) {
    if (!el.characterWardrobe) return;
    el.characterWardrobe.classList.toggle('is-editing', editing);
    el.wardrobeBackBtn.textContent = editing ? '← 衣柜' : '← 角色卡';
    el.wardrobeNewBtn.hidden = editing;
    el.wardrobeEditor.hidden = !editing;
    if (!editing) {
      state.wardrobeEditingId = null;
      markWardrobeDirty(false);
      requestAnimationFrame(syncWardrobeCardSize);
    }
  }

  async function openWardrobe() {
    if (state.characterMode === 'wardrobe') return;
    wardrobeReturnMode = state.characterMode === 'edit' || state.characterMode === 'create'
      ? state.characterMode
      : 'gallery';
    closeCharacterPicker();
    closeCharacterComboAdd();
    state.wardrobeEditingId = null;
    state.wardrobePreviewData = null;
    state.wardrobeInlineEditId = null;
    state.wardrobeInlinePreviewData = null;
    state.wardrobeInlineDraft = null;
    state.wardrobeInlineDirty = false;
    markWardrobeDirty(false);
    setWardrobeEditing(false);
    setCharacterMode('wardrobe');
    await loadWardrobe();
  }

  async function backFromWardrobe() {
    if (state.characterMode !== 'wardrobe') return;
    if (state.wardrobeInlineEditId) {
      if (state.wardrobeInlineDirty
          && !(await confirmDiscardAction('放弃当前未保存的衣物修改？', '放弃衣物修改'))) return;
      state.wardrobeInlineEditId = null;
      state.wardrobeInlinePreviewData = null;
      state.wardrobeInlineDraft = null;
      state.wardrobeInlineDirty = false;
      renderWardrobe();
    }
    await closeWardrobe();
  }

  async function closeWardrobe() {
    if (state.wardrobeDirty
        && !(await confirmDiscardAction('放弃未保存的衣物修改？', '放弃衣物修改'))) return;
    if (state.wardrobeInlineEditId && state.wardrobeInlineDirty
        && !(await confirmDiscardAction('放弃当前未保存的衣物修改？', '放弃衣物修改'))) return;
    state.wardrobeEditingId = null;
    state.wardrobePreviewData = null;
    state.wardrobeInlineEditId = null;
    state.wardrobeInlinePreviewData = null;
    state.wardrobeInlineDraft = null;
    state.wardrobeInlineDirty = false;
    markWardrobeDirty(false);
    setWardrobeEditing(false);
    if (wardrobeReturnMode === 'edit') {
      setCharacterMode('edit');
      return;
    }
    if (wardrobeReturnMode === 'create') {
      setCharacterMode('create');
      return;
    }
    showCharacterGallery();
  }

  function renderWardrobePreview(outfit = null) {
    const dataUrl = state.wardrobePreviewData;
    const src = dataUrl || (outfit?.image
      ? `/api/wardrobe/image/${encodeURIComponent(outfit.id)}?v=${encodeURIComponent(outfit.updatedAt || outfit.image)}`
      : '');
    if (src) {
      el.wardrobePreviewImg.src = src;
      el.wardrobePreviewImg.hidden = false;
      el.wardrobePreviewEmpty.hidden = true;
      el.wardrobePreviewFrame.classList.add('has-image');
    } else {
      el.wardrobePreviewImg.removeAttribute('src');
      el.wardrobePreviewImg.hidden = true;
      el.wardrobePreviewEmpty.hidden = false;
      el.wardrobePreviewFrame.classList.remove('has-image');
    }
  }

  async function pasteWardrobeClipboard() {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((type) => ['image/png', 'image/jpeg', 'image/webp'].includes(type));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          const ext = imageType === 'image/png' ? 'png' : (imageType === 'image/jpeg' ? 'jpg' : 'webp');
          await handleWardrobePreview(new File([blob], `clipboard.${ext}`, { type: imageType }));
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast('剪贴板为空', 'info', 1800);
        return;
      }
      const current = el.wardrobeTags.value.trim();
      el.wardrobeTags.value = current ? `${current}, ${text.trim()}` : text.trim();
      markWardrobeDirty(true);
      toast('剪贴板文本已粘贴到衣物提示词', 'info', 2000);
    } catch {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          const current = el.wardrobeTags.value.trim();
          el.wardrobeTags.value = current ? `${current}, ${text.trim()}` : text.trim();
          markWardrobeDirty(true);
          toast('剪贴板文本已粘贴到衣物提示词', 'info', 2000);
          return;
        }
      } catch { /* ignore */ }
      toast('无法读取剪贴板，请点击左侧预览后按 Ctrl+V 粘贴图片', 'error', 4200);
    }
  }

  async function handleWardrobeInlinePreview(id, file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast('衣物示意图只支持 PNG / JPEG / WebP', 'error', 3200);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('衣物示意图不能超过 8 MB', 'error', 3200);
      return;
    }
    const card = el.wardrobeGrid.querySelector(`[data-wardrobe-id="${id}"]`);
    const frame = card?.querySelector('[data-wardrobe-inline-preview]');
    if (!frame) return;
    const currentImage = frame.querySelector('img');
    const previous = {
      data: state.wardrobeInlinePreviewData,
      src: currentImage?.getAttribute('src') || '',
      hadImage: !!currentImage,
    };
    try {
      const dataUrl = await readCharacterPortrait(file);
      state.wardrobeInlinePreviewData = dataUrl;
      state.wardrobeInlineDirty = true;
      let img = frame.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = '衣物示意图';
        frame.prepend(img);
        frame.querySelector('.wardrobe-card-no-image')?.remove();
      }
      img.src = dataUrl;
      img.hidden = false;
      pushActionUndo('更换衣物示意图', () => {
        if (state.wardrobeInlineEditId !== id) throw new Error('当前衣物已切换');
        state.wardrobeInlinePreviewData = previous.data;
        const activeCard = el.wardrobeGrid.querySelector(`[data-wardrobe-id="${id}"]`);
        const activeFrame = activeCard?.querySelector('[data-wardrobe-inline-preview]');
        if (!activeFrame) throw new Error('衣物卡已关闭');
        let activeImage = activeFrame.querySelector('img');
        if (previous.hadImage) {
          if (!activeImage) {
            activeImage = document.createElement('img');
            activeImage.alt = '衣物示意图';
            activeFrame.prepend(activeImage);
            activeFrame.querySelector('.wardrobe-card-no-image')?.remove();
          }
          activeImage.src = previous.src;
          activeImage.hidden = false;
        } else {
          activeImage?.remove();
          if (!activeFrame.querySelector('.wardrobe-card-no-image')) {
            const empty = document.createElement('span');
            empty.className = 'wardrobe-card-no-image';
            empty.textContent = 'NO PREVIEW';
            activeFrame.prepend(empty);
          }
        }
        state.wardrobeInlineDirty = true;
      }, 'wardrobe-insert');
    } catch {
      toast('读取衣物示意图失败', 'error', 3200);
    }
  }

  async function handleWardrobePreview(file) {    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast('衣物示意图只支持 PNG / JPEG / WebP', 'error', 3200);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('衣物示意图不能超过 8 MB', 'error', 3200);
      return;
    }
    const previous = {
      data: state.wardrobePreviewData,
      src: el.wardrobePreviewImg.getAttribute('src') || '',
      hidden: el.wardrobePreviewImg.hidden,
      emptyHidden: el.wardrobePreviewEmpty.hidden,
      hasImage: el.wardrobePreviewFrame.classList.contains('has-image'),
    };
    try {
      const dataUrl = await readCharacterPortrait(file);
      state.wardrobePreviewData = dataUrl;
      renderWardrobePreview();
      markWardrobeDirty(true);
      pushActionUndo('更换衣物示意图', () => {
        state.wardrobePreviewData = previous.data;
        if (previous.src) el.wardrobePreviewImg.src = previous.src;
        else el.wardrobePreviewImg.removeAttribute('src');
        el.wardrobePreviewImg.hidden = previous.hidden;
        el.wardrobePreviewEmpty.hidden = previous.emptyHidden;
        el.wardrobePreviewFrame.classList.toggle('has-image', previous.hasImage);
        markWardrobeDirty(true);
      });
      toast('衣物示意图已更新', 'info', 2200);
    } catch {
      toast('读取衣物示意图失败', 'error', 3200);
    }
  }

  async function openWardrobeEditor(outfit = null) {
    if (state.characterMode !== 'wardrobe') return;
    if (state.wardrobeDirty
        && !(await confirmDiscardAction('放弃当前未保存的衣物修改？', '切换衣物'))) return;
    if (state.wardrobeInlineEditId && state.wardrobeInlineDirty
        && !(await confirmDiscardAction('放弃当前未保存的衣物修改？', '切换衣物'))) return;
    if (outfit) {
      wardrobeInlineImageTargetId = null;
      state.wardrobeEditingId = null;
      state.wardrobePreviewData = null;
      state.wardrobeInlineEditId = String(outfit.id);
      state.wardrobeInlinePreviewData = null;
      state.wardrobeInlineDraft = {
        name: outfit.name || '',
        tags: Array.isArray(outfit.tags) ? outfit.tags.join(', ') : '',
        notes: outfit.notes || '',
      };
      state.wardrobeInlineDirty = false;
      setWardrobeEditing(false);
      renderWardrobe();
      requestAnimationFrame(() => {
        const input = el.wardrobeGrid.querySelector(`[data-inline-name="${outfit.id}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      });
      return;
    }
    state.wardrobeInlineEditId = null;
    state.wardrobeInlinePreviewData = null;
    state.wardrobeInlineDraft = null;
    state.wardrobeInlineDirty = false;
    state.wardrobeEditingId = null;
    state.wardrobePreviewData = null;
    wardrobeInlineImageTargetId = null;
    el.wardrobeEditorTitle.textContent = 'NEW OUTFIT // 新建衣物';
    el.wardrobeName.value = '';
    el.wardrobeTags.value = '';
    el.wardrobeNotes.value = '';
    renderWardrobePreview(null);
    markWardrobeDirty(false);
    setWardrobeEditing(true);
    requestAnimationFrame(() => {
      el.wardrobeName.focus();
      el.wardrobeName.select();
      el.wardrobeEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  async function cancelWardrobeInlineEdit() {
    if (state.wardrobeInlineDirty
        && !(await confirmDiscardAction('放弃当前未保存的衣物修改？', '取消编辑'))) return;
    wardrobeInlineImageTargetId = null;
    state.wardrobeInlineEditId = null;
    state.wardrobeInlinePreviewData = null;
    state.wardrobeInlineDraft = null;
    state.wardrobeInlineDirty = false;
    renderWardrobe();
  }

  async function saveWardrobeInlineEdit(id) {
    const card = el.wardrobeGrid.querySelector(`[data-wardrobe-id="${id}"]`);
    if (!card) return;
    const name = card.querySelector(`[data-inline-name="${id}"]`)?.value.trim() || '';
    const tags = (card.querySelector(`[data-inline-tags="${id}"]`)?.value || '')
      .split(/[,，\n;；、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const notes = card.querySelector(`[data-inline-notes="${id}"]`)?.value.trim() || '';
    if (!tags.length) {
      toast('请输入衣物提示词', 'info', 2200);
      return;
    }
    const saveBtn = card.querySelector(`[data-wardrobe-inline-save="${id}"]`);
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
    }
    try {
      const res = await fetch('/api/wardrobe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entry: { id, name, tags, notes },
          imageData: state.wardrobeInlinePreviewData || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      wardrobeInlineImageTargetId = null;
      state.wardrobeInlineEditId = null;
      state.wardrobeInlinePreviewData = null;
      state.wardrobeInlineDraft = null;
      state.wardrobeInlineDirty = false;
      await loadWardrobe({ silent: true });
      toast('衣物已保存', 'info', 2000);
    } catch (err) {
      toast('保存衣物失败：' + prettyError(err), 'error', 4200);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存 SAVE';
      }
    }
  }

  async function closeWardrobeEditor() {
    if (state.wardrobeDirty
        && !(await confirmDiscardAction('放弃当前未保存的衣物修改？', '取消编辑'))) return;
    state.wardrobePreviewData = null;
    setWardrobeEditing(false);
    renderWardrobe();
  }

  function appendWardrobeTags(field, tags) {
    if (!field) return 0;
    const current = String(field.value || '')
      .split(/[,，\n;；、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const seen = new Set(current);
    let added = 0;
    tags.forEach((tag) => {
      const text = String(tag || '').trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        current.push(text);
        added += 1;
      }
    });
    if (added) {
      field.value = current.join(', ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return added;
  }

  function applyWardrobeToCharacter(outfit) {
    const tags = Array.isArray(outfit?.tags) ? outfit.tags : [];
    if (!tags.length) return;
    if (state.activeCharacterId) {
      const added = appendWardrobeTags(el.characterTags, tags);
      if (added) markCharacterDirty(true);
      toast(added ? `已加入角色卡固定词条 · ${added} 个` : '这些词条已经在角色卡中', 'info', 2200);
      return;
    }
    if (wardrobeReturnMode === 'create') {
      const added = appendWardrobeTags(el.characterCreateInput, tags);
      if (added) updateCharacterCreateMeter();
      toast(added ? `已加入新建角色 tags · ${added} 个` : '这些词条已经存在', 'info', 2200);
      return;
    }
    toast('请先打开或新建一张角色卡', 'info', 2200);
  }

  function renderCharacterTagsWardrobeList() {
    if (!el.characterTagsWardrobeList) return;
    const outfits = state.wardrobe || [];
    el.characterTagsWardrobeList.innerHTML = outfits.length
      ? outfits.map((outfit) => wardrobeMiniCardHtml(outfit, 'data-character-wardrobe')).join('')
      : '<div class="source-fold-empty">还没有保存的衣物</div>';
    hideWardrobeHover();
  }

  async function toggleCharacterTagsWardrobeFold() {
    if (!el.characterTagsWardrobeFold) return;
    const opening = el.characterTagsWardrobeFold.hidden;
    mFold(el.characterTagsWardrobeFold, opening);
    el.characterTagsWardrobeBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (!opening) {
      hideWardrobeHover();
      return;
    }
    await ensureWardrobeLoaded();
    renderCharacterTagsWardrobeList();
  }

  function applyCharacterWardrobeTags(id) {
    const outfit = wardrobeOutfitById(id);
    const tags = Array.isArray(outfit?.tags) ? outfit.tags : [];
    if (!tags.length) {
      toast('这套衣物没有提示词', 'info', 1800);
      return;
    }
    const previousValue = el.characterTags.value;
    const previousSelection = [el.characterTags.selectionStart, el.characterTags.selectionEnd];
    const added = appendWardrobeTags(el.characterTags, tags);
    if (added) {
      markCharacterDirty(true);
      pushActionUndo('插入衣柜词条', () => {
        el.characterTags.value = previousValue;
        updateCharacterTagPreview();
        markCharacterDirty(true);
        el.characterTags.focus();
        if (previousSelection[0] != null) {
          el.characterTags.setSelectionRange(previousSelection[0], previousSelection[1]);
        }
      });
    }
    el.characterTagsWardrobeFold.hidden = true;
    el.characterTagsWardrobeBtn.setAttribute('aria-expanded', 'false');
    hideWardrobeHover();
    toast(added ? `已将衣柜词条加入固定词条 · ${added} 个` : '这些词条已经存在', 'info', 2600);
  }

  async function saveWardrobeEntry() {
    const name = el.wardrobeName.value.trim();
    const tags = el.wardrobeTags.value
      .split(/[,，\n;；、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!tags.length) {
      toast('请输入衣物提示词', 'info', 2200);
      el.wardrobeTags.focus();
      return;
    }
    el.wardrobeSaveBtn.disabled = true;
    el.wardrobeSaveBtn.textContent = '保存中…';
    try {
      const entry = {
        id: state.wardrobeEditingId || undefined,
        name,
        tags,
        notes: el.wardrobeNotes.value.trim(),
      };
      const res = await fetch('/api/wardrobe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry, imageData: state.wardrobePreviewData || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      state.wardrobeEditingId = null;
      state.wardrobePreviewData = null;
      markWardrobeDirty(false);
      setWardrobeEditing(false);
      await loadWardrobe({ silent: true });
      toast('衣物已保存', 'info', 2000);
    } catch (err) {
      toast('保存衣物失败：' + prettyError(err), 'error', 4200);
    } finally {
      el.wardrobeSaveBtn.disabled = false;
      el.wardrobeSaveBtn.textContent = '保存 SAVE';
    }
  }

  async function deleteWardrobeOutfit(id) {
    const outfit = wardrobeOutfitById(id);
    if (!outfit) return;
    if (!(await confirmDeleteAction(`删除衣物「${outfit.name || '未命名衣物'}」？`, '删除衣物'))) return;
    try {
      const res = await fetch('/api/wardrobe/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '删除失败');
      if (state.wardrobeEditingId === String(id)) {
        state.wardrobeEditingId = null;
        markWardrobeDirty(false);
        setWardrobeEditing(false);
      }
      await loadWardrobe({ silent: true });
      if (data?.undoToken) {
        pushActionUndo('删除衣物', async () => {
          await restoreServerDeletion(data.undoToken);
          await loadWardrobe({ silent: true });
        });
      }
      toast('衣物已删除', 'info', 2200);
    } catch (err) {
      toast('删除衣物失败：' + prettyError(err), 'error', 3600);
    }
  }

  function updateCharacterCreateMeter() {
    el.characterCreateMeter.textContent = `${String(el.characterCreateInput.value.length).padStart(4, '0')} / 4000`;
  }

  function clearCharacterCreateInput(undoable = false) {
    const value = el.characterCreateInput.value || '';
    const selectionStart = el.characterCreateInput.selectionStart;
    const selectionEnd = el.characterCreateInput.selectionEnd;
    el.characterCreateInput.value = '';
    updateCharacterCreateMeter();
    el.characterCreateInput.focus();
    if (undoable && value) {
      pushActionUndo('清空角色 tags', () => {
        el.characterCreateInput.value = value;
        updateCharacterCreateMeter();
        el.characterCreateInput.focus();
        el.characterCreateInput.setSelectionRange(selectionStart, selectionEnd);
      }, 'clear-character');
      toast('已清空角色 tags', 'info', 1800);
    }
  }

  function enterCharacterCreateMode() {
    if (el.characterComboWardrobePop) el.characterComboWardrobePop.hidden = true;
    state.activeCharacterId = null;
    state.characterPortraitData = null;
    state.characterDirty = false;
    state.characterGroups = [];
    state.characterCombo = [];
    state.characterComboTags = [];
    state.characterComboWardrobe = [];
    state.characterGroupEditingId = null;
    el.characterDirty.hidden = true;
    closeCharacterPicker();
    setCharacterMode('create');
    renderCharacterSelect();
    clearCharacterCreateInput();
  }

  async function createCharacterFromInput() {
    const tags = el.characterCreateInput.value.trim();
    if (!tags) {
      toast('请先输入角色固定 tags', 'info', 2200);
      el.characterCreateInput.focus();
      return;
    }
    el.characterCreateBtn.disabled = true;
    el.characterCreateBtn.textContent = '创建中…';
    try {
      const res = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card: { name: '未命名角色', tags } }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '创建失败');
      await loadCharacters();
      state.activeCharacterId = data.card.id;
      const fresh = characterById(data.card.id) || data.card;
      fillCharacterForm(fresh);
      el.characterCreateInput.value = '';
      updateCharacterCreateMeter();
      toast('角色卡已创建，请补充名称、出处或肖像', 'info', 2600);
    } catch (err) {
      toast('创建角色卡失败：' + prettyError(err), 'error', 4200);
    } finally {
      el.characterCreateBtn.disabled = false;
      el.characterCreateBtn.textContent = '创建角色卡 CREATE';
    }
  }

  async function pasteCharacterCreate() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('clipboard unsupported');
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        toast('剪贴板是空的', 'info', 1800);
        return;
      }
      const input = el.characterCreateInput;
      input.value = text;
      updateCharacterCreateMeter();
      input.focus();
    } catch {
      toast('无法读取剪贴板，请点击输入框后按 Ctrl+V 粘贴', 'error', 4200);
      el.characterCreateInput.focus();
    }
  }

  function updateCharacterTagPreview() {
    state.selectedCharacterTags.clear();
    const tags = el.characterTags.value.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
    el.characterTagPreview.innerHTML = tags.length
      ? tags.map((tag) => `<span class="character-tag-chip is-draggable" data-tag="${esc(tag)}">${esc(tag)}</span>`).join('')
      : '<span class="character-tag-empty">NO TAGS / 暂无固定词条</span>';
  }

  function clearCharacterTagSelection() {
    if (!state.selectedCharacterTags.size) return;
    state.selectedCharacterTags.clear();
    el.characterTagPreview.querySelectorAll('.character-tag-chip.is-selected').forEach((chip) => {
      chip.classList.remove('is-selected');
    });
  }

  function toggleCharacterTagSelection(chip) {
    const tag = chip.dataset.tag;
    if (!tag) return;
    if (state.selectedCharacterTags.has(tag)) state.selectedCharacterTags.delete(tag);
    else state.selectedCharacterTags.add(tag);
    chip.classList.toggle('is-selected', state.selectedCharacterTags.has(tag));
  }

  function selectedCharacterTagList() {
    return [...el.characterTagPreview.querySelectorAll('.character-tag-chip[data-tag]')]
      .map((chip) => chip.dataset.tag)
      .filter((tag) => state.selectedCharacterTags.has(tag));
  }

  function clearCharacterTagDragVisuals() {
    el.characterTagPreview.querySelectorAll('.character-tag-chip.is-dragging').forEach((chip) => {
      chip.classList.remove('is-dragging');
    });
    el.characterGroups.querySelectorAll('.character-group.is-drop-over').forEach((group) => {
      group.classList.remove('is-drop-over');
    });
    document.body.classList.remove('is-character-tag-dragging');
  }

  function finishCharacterTagPointer() {
    if (!characterTagPointer) return;
    document.removeEventListener('mousemove', characterTagPointer.move);
    document.removeEventListener('mouseup', characterTagPointer.up);
    characterTagPointer = null;
    clearCharacterTagDragVisuals();
  }

  function onCharacterTagMouseDown(event) {
    if (event.button !== 0) return;
    const chip = event.target.closest?.('.character-tag-chip[data-tag]');
    if (!chip) return;
    const tag = chip.dataset.tag;
    const selected = state.selectedCharacterTags;
    const tags = selected.has(tag) && selected.size > 1 ? selectedCharacterTagList() : [tag];
    const pointer = {
      startX: event.clientX,
      startY: event.clientY,
      tags,
      dragging: false,
      move: null,
      up: null,
    };
    pointer.move = (moveEvent) => {
      if (!characterTagPointer) return;
      const dx = moveEvent.clientX - pointer.startX;
      const dy = moveEvent.clientY - pointer.startY;
      if (!pointer.dragging && Math.hypot(dx, dy) < 5) return;
      if (!pointer.dragging) {
        pointer.dragging = true;
        document.body.classList.add('is-character-tag-dragging');
        el.characterTagPreview.querySelectorAll('.character-tag-chip[data-tag]').forEach((node) => {
          if (pointer.tags.includes(node.dataset.tag)) node.classList.add('is-dragging');
        });
      }
      moveEvent.preventDefault();
      const over = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const group = over?.closest?.('.character-group');
      el.characterGroups.querySelectorAll('.character-group.is-drop-over').forEach((node) => {
        if (node !== group) node.classList.remove('is-drop-over');
      });
      if (group) group.classList.add('is-drop-over');
    };
    pointer.up = (upEvent) => {
      if (!characterTagPointer) return;
      const wasDragging = pointer.dragging;
      const over = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const group = over?.closest?.('.character-group');
      const tags = [...pointer.tags];
      finishCharacterTagPointer();
      if (!wasDragging) return;
      suppressCharacterTagClickUntil = Date.now() + 350;
      clearCharacterTagSelection();
      if (group) addTagsToCharacterGroup(group.dataset.groupId, tags);
    };
    characterTagPointer = pointer;
    document.addEventListener('mousemove', pointer.move);
    document.addEventListener('mouseup', pointer.up);
  }

  function chineseGroupNumber(number) {
    const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (number <= 9) return digits[number];
    if (number === 10) return '十';
    if (number < 20) return '十' + digits[number % 10];
    if (number < 100) return digits[Math.floor(number / 10)] + '十' + (number % 10 ? digits[number % 10] : '');
    return String(number);
  }

  function nextCharacterGroupName() {
    const names = new Set((state.characterGroups || []).map((group) => group.name));
    let index = 1;
    while (names.has(`组${chineseGroupNumber(index)}`)) index += 1;
    return `组${chineseGroupNumber(index)}`;
  }

  function normalizeCharacterGroups(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((group, index) => ({
      id: String(group?.id || `g-${Date.now()}-${index}`),
      name: String(group?.name || `组${chineseGroupNumber(index + 1)}`),
      tags: Array.isArray(group?.tags)
        ? group.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
        : [],
    }));
  }

  function renderCharacterGroups() {
    if (!el.characterGroups) return;
    const groups = state.characterGroups || [];
    if (!groups.length) {
      el.characterGroups.innerHTML = '<div class="character-groups-empty">还没有分组，点击「＋ 新建组」开始拆分词条。</div>';
      return;
    }
    el.characterGroups.innerHTML = groups.map((group) => {
      const editing = state.characterGroupEditingId === group.id;
      const title = editing
        ? `<input class="character-group-input" data-group-input="${esc(group.id)}" maxlength="80" value="${esc(group.name)}" spellcheck="false">`
        : `<span class="character-group-name" data-group-title="${esc(group.id)}" title="双击重命名">${esc(group.name)}</span>`;
      const pencil = editing ? '' :
        `<button type="button" class="character-group-pencil" data-group-rename="${esc(group.id)}" title="重命名分组" aria-label="重命名分组"><svg class="icon"><use href="#ico-pencil"/></svg></button>`;
      const tags = group.tags.length
        ? group.tags.map((tag) => `<span class="character-group-tag">${esc(tag)}<button type="button" class="character-group-tag-remove" data-group-remove="${esc(group.id)}" data-tag="${esc(tag)}" title="移出分组" aria-label="移出分组">×</button></span>`).join('')
        : '<span class="character-group-empty">拖动词块到这里</span>';
      return `<section class="character-group" data-group-id="${esc(group.id)}">` +
        `<header class="character-group-head">${title}${pencil}` +
        `<span class="character-group-count">${group.tags.length}</span>` +
        `<button type="button" class="character-group-add" data-group-add-combo="${esc(group.id)}" title="加入组合" aria-label="加入组合">＋</button>` +
        `<button type="button" class="character-group-delete" data-group-delete="${esc(group.id)}" title="删除分组" aria-label="删除分组">×</button>` +
        `</header>` +
        `<div class="character-group-drop" data-group-drop="${esc(group.id)}">${tags}</div></section>`;
    }).join('');
  }

  function startCharacterGroupRename(id) {
    const group = (state.characterGroups || []).find((item) => String(item.id) === String(id));
    if (!group) return;
    if (state.characterGroupEditingId && state.characterGroupEditingId !== group.id) {
      commitCharacterGroupRename(state.characterGroupEditingId);
    }
    state.characterGroupEditingId = group.id;
    renderCharacterGroups();
    requestAnimationFrame(() => {
      const input = el.characterGroups.querySelector(`[data-group-input="${group.id}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  function commitCharacterGroupRename(id) {
    const group = (state.characterGroups || []).find((item) => String(item.id) === String(id));
    const input = el.characterGroups.querySelector(`[data-group-input="${id}"]`);
    if (!group) {
      state.characterGroupEditingId = null;
      renderCharacterGroups();
      return;
    }
    const value = input ? input.value.trim() : '';
    if (value && value !== group.name) {
      const oldName = group.name;
      const characterId = state.activeCharacterId;
      group.name = value.slice(0, 80);
      state.characterGroupEditingId = null;
      renderCharacterGroups();
      renderCharacterCombo();
      markCharacterDirty(true);
      pushActionUndo('重命名分组', () => {
        if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
        const target = characterGroupById(id);
        if (!target || target.name !== value.slice(0, 80)) throw new Error('分组名称已再次变化');
        target.name = oldName;
        renderCharacterGroups();
        renderCharacterCombo();
        markCharacterDirty(true);
      });
      toast('分组已重命名', 'info', 1800);
      return;
    }
    state.characterGroupEditingId = null;
    renderCharacterGroups();
    renderCharacterCombo();
  }

  function cancelCharacterGroupRename() {
    state.characterGroupEditingId = null;
    renderCharacterGroups();
  }

  function addCharacterGroup() {
    if (state.characterGroupEditingId) commitCharacterGroupRename(state.characterGroupEditingId);
    state.characterGroups = state.characterGroups || [];
    const group = {
      id: `g-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      name: nextCharacterGroupName(),
      tags: [],
    };
    state.characterGroups.push(group);
    state.characterGroupEditingId = null;
    renderCharacterGroups();
    markCharacterDirty(true);
  }

  function addTagsToCharacterGroup(groupId, tags) {
    const group = (state.characterGroups || []).find((item) => String(item.id) === String(groupId));
    if (!group) return;
    const list = (Array.isArray(tags) ? tags : [tags])
      .map((tag) => String(tag || '').trim())
      .filter(Boolean);
    let added = 0;
    let duplicates = 0;
    list.forEach((tag) => {
      if (group.tags.includes(tag)) {
        duplicates += 1;
        return;
      }
      group.tags.push(tag);
      added += 1;
    });
    if (added) {
      renderCharacterGroups();
      markCharacterDirty(true);
    }
    if (duplicates) {
      toast(`${duplicates} 个词条已经在这个分组中`, 'info', 1800);
    }
    return added;
  }

  function removeTagFromCharacterGroup(groupId, tag) {
    const group = (state.characterGroups || []).find((item) => String(item.id) === String(groupId));
    if (!group) return;
    const index = group.tags.indexOf(String(tag || ''));
    if (index < 0) return;
    const characterId = state.activeCharacterId;
    group.tags.splice(index, 1);
    renderCharacterGroups();
    markCharacterDirty(true);
    pushActionUndo('移出分组词条', () => {
      if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
      const restored = characterGroupById(groupId);
      if (!restored) throw new Error('分组已不存在');
      restored.tags.splice(Math.min(index, restored.tags.length), 0, String(tag || ''));
      renderCharacterGroups();
      markCharacterDirty(true);
    });
    toast('已移出词条', 'info', 1800);
  }

  function characterGroupById(groupId) {
    return (state.characterGroups || []).find((group) => String(group.id) === String(groupId)) || null;
  }

  function renderCharacterCombo() {
    if (!el.characterComboList) return;
    const groups = state.characterCombo
      .map((id) => characterGroupById(id))
      .filter(Boolean);
    const customTags = state.characterComboTags || [];
    const groupBlocks = groups.map((group) =>
      `<span class="character-combo-block" data-combo-group="${esc(group.id)}" title="拖动调整顺序">` +
      `${esc(group.name)}<button type="button" class="character-combo-remove" data-combo-group-remove="${esc(group.id)}" title="从组合移除">×</button></span>`);
    const customBlocks = customTags.map((tag, index) =>
      `<span class="character-combo-block character-combo-tag" data-combo-tag-index="${index}" title="自定义组合词块">` +
      `${esc(tag)}<button type="button" class="character-combo-remove" data-combo-tag-remove="${index}" title="从组合移除">×</button></span>`);
    const wardrobeBlocks = (state.characterComboWardrobe || []).map((outfitId) => {
      const outfit = wardrobeOutfitById(outfitId);
      const name = outfit?.name || '已删除衣物';
      return `<span class="character-combo-block character-combo-wardrobe" data-combo-wardrobe="${esc(outfitId)}" title="衣柜衣物 · ${esc(name)}">` +
        `${esc(name)}<button type="button" class="character-combo-remove" data-combo-wardrobe-remove="${esc(outfitId)}" title="从组合移除">×</button></span>`;
    });
    const blocks = [...groupBlocks, ...customBlocks, ...wardrobeBlocks];
    el.characterComboList.innerHTML = blocks.length
      ? blocks.join('')
      : '<span class="character-combo-empty">输入自定义词块、从衣柜加入衣物名称，或点击分组右上角「＋」把组名加入组合</span>';
  }

  function addCharacterGroupToCombo(groupId) {
    const group = characterGroupById(groupId);
    if (!group) return;
    if (state.characterCombo.includes(group.id)) {
      toast('该组已经在组合中', 'info', 1600);
      return;
    }
    state.characterCombo.push(group.id);
    renderCharacterCombo();
    markCharacterDirty(true);
  }

  function removeCharacterGroupFromCombo(groupId) {
    const group = characterGroupById(groupId);
    if (!group || !state.characterCombo.includes(group.id)) return;
    const characterId = state.activeCharacterId;
    const index = state.characterCombo.indexOf(group.id);
    state.characterCombo = state.characterCombo.filter((id) => String(id) !== String(group.id));
    renderCharacterCombo();
    markCharacterDirty(true);
    pushActionUndo('移出组合分组', () => {
      if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
      if (!characterGroupById(groupId)) throw new Error('分组已不存在');
      state.characterCombo.splice(Math.min(index, state.characterCombo.length), 0, groupId);
      renderCharacterCombo();
      markCharacterDirty(true);
    });
    toast('已从组合移出', 'info', 1800);
  }

  function openCharacterComboAdd() {
    if (el.characterComboWardrobePop) el.characterComboWardrobePop.hidden = true;
    mSwapIn(el.characterComboAdd, true, 'drop');
    el.characterComboAddInput.value = '';
    el.characterComboAddInput.focus();
  }

  function closeCharacterComboAdd() {
    if (!el.characterComboAdd) return;
    /* in-flow 工具条：同步 hidden，避免退场期间继续占位造成塌陷延迟 */
    mSwapIn(el.characterComboAdd, false);
    el.characterComboAddInput.value = '';
  }

  function saveCharacterComboCustomTags() {
    const tags = el.characterComboAddInput.value
      .split(/[,\n;，；、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!tags.length) {
      toast('请输入词块', 'info', 1800);
      el.characterComboAddInput.focus();
      return;
    }
    state.characterComboTags = state.characterComboTags || [];
    let added = 0;
    let duplicates = 0;
    tags.forEach((tag) => {
      if (state.characterComboTags.includes(tag)) {
        duplicates += 1;
        return;
      }
      state.characterComboTags.push(tag);
      added += 1;
    });
    if (duplicates) toast(`${duplicates} 个词块已经在组合中`, 'info', 1800);
    if (!added) {
      el.characterComboAddInput.focus();
      return;
    }
    renderCharacterCombo();
    markCharacterDirty(true);
    closeCharacterComboAdd();
    toast(`已加入组合 · ${added} 个词块`, 'info', 1800);
  }

  function removeCharacterComboTag(index) {
    const tags = state.characterComboTags || [];
    if (!Number.isInteger(index) || index < 0 || index >= tags.length) return;
    const characterId = state.activeCharacterId;
    const tag = tags[index];
    tags.splice(index, 1);
    renderCharacterCombo();
    markCharacterDirty(true);
    pushActionUndo('移出组合词块', () => {
      if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
      state.characterComboTags.splice(Math.min(index, state.characterComboTags.length), 0, tag);
      renderCharacterCombo();
      markCharacterDirty(true);
    });
    toast('已从组合移出', 'info', 1800);
  }

  function addWardrobeToCombo(outfitId) {
    const outfit = wardrobeOutfitById(outfitId);
    if (!outfit) return;
    state.characterComboWardrobe = state.characterComboWardrobe || [];
    if (state.characterComboWardrobe.includes(String(outfit.id))) {
      toast('这套衣物已经在组合中', 'info', 1800);
      return;
    }
    const characterId = state.activeCharacterId;
    state.characterComboWardrobe.push(String(outfit.id));
    renderCharacterCombo();
    markCharacterDirty(true);
    el.characterComboWardrobePop.hidden = true;
    pushActionUndo('加入组合衣物', () => {
      if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
      state.characterComboWardrobe = (state.characterComboWardrobe || [])
        .filter((item) => String(item) !== String(outfit.id));
      renderCharacterCombo();
      markCharacterDirty(true);
    });
    toast(`已加入组合 · ${outfit.name || '衣物'}`, 'info', 2400);
  }

  function removeCharacterComboWardrobe(outfitId) {
    const ids = state.characterComboWardrobe || [];
    const index = ids.indexOf(String(outfitId));
    if (index < 0) return;
    const characterId = state.activeCharacterId;
    const removed = ids[index];
    ids.splice(index, 1);
    renderCharacterCombo();
    markCharacterDirty(true);
    pushActionUndo('移出组合衣物', () => {
      if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
      state.characterComboWardrobe.splice(Math.min(index, state.characterComboWardrobe.length), 0, removed);
      renderCharacterCombo();
      markCharacterDirty(true);
    });
    toast('已从组合移出衣物', 'info', 1800);
  }

  function renderComboWardrobeList() {
    if (!el.characterComboWardrobeList) return;
    const outfits = state.wardrobe || [];
    if (el.characterComboWardrobeCount) el.characterComboWardrobeCount.textContent = String(outfits.length);
    el.characterComboWardrobeList.innerHTML = outfits.length
      ? outfits.map((outfit) => {
        const image = outfit.image
          ? `<img src="/api/wardrobe/image/${encodeURIComponent(outfit.id)}?v=${encodeURIComponent(outfit.updatedAt || outfit.image)}" alt="">`
          : '<span class="combo-wardrobe-no-image">W</span>';
        return `<button type="button" class="combo-wardrobe-item" data-combo-wardrobe-add="${esc(outfit.id)}">` +
          `<span class="combo-wardrobe-thumb">${image}</span>` +
          `<span class="combo-wardrobe-copy"><b>${esc(outfit.name || '未命名衣物')}</b>` +
          `<span>${Array.isArray(outfit.tags) ? outfit.tags.length : 0} TAGS</span></span></button>`;
      }).join('')
      : '<div class="combo-wardrobe-empty">衣柜里还没有衣物</div>';
  }

  async function toggleComboWardrobePop() {
    if (!el.characterComboWardrobePop) return;
    if (!el.characterComboWardrobePop.hidden) {
      el.characterComboWardrobePop.hidden = true;
      hideWardrobeHover();
      return;
    }
    await ensureWardrobeLoaded();
    renderComboWardrobeList();
    closeCharacterComboAdd();
    el.characterComboWardrobePop.hidden = false;
  }

  function deleteCharacterGroup(groupId) {
    const group = characterGroupById(groupId);
    if (!group) return;
    return confirmDeleteAction(`删除分组「${group.name}」？`, '删除分组').then((ok) => {
      if (!ok) return;
      const characterId = state.activeCharacterId;
      const groupIndex = state.characterGroups.findIndex((item) => String(item.id) === String(groupId));
      const comboIndex = state.characterCombo.indexOf(groupId);
      const snapshot = cloneJson(group);
      state.characterGroups = state.characterGroups.filter((item) => String(item.id) !== String(groupId));
      state.characterCombo = state.characterCombo.filter((id) => String(id) !== String(groupId));
      if (state.characterGroupEditingId === group.id) state.characterGroupEditingId = null;
      renderCharacterGroups();
      renderCharacterCombo();
      markCharacterDirty(true);
      pushActionUndo('删除分组', () => {
        if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
        state.characterGroups.splice(Math.min(groupIndex, state.characterGroups.length), 0, cloneJson(snapshot));
        if (comboIndex >= 0) state.characterCombo.splice(Math.min(comboIndex, state.characterCombo.length), 0, snapshot.id);
        renderCharacterGroups();
        renderCharacterCombo();
        markCharacterDirty(true);
      });
      toast('分组已删除', 'info', 2000);
    });
  }

  function comboCharacterTags() {
    const groupTags = state.characterCombo.flatMap((id) => {
      const group = characterGroupById(id);
      return group ? [...group.tags] : [];
    });
    const wardrobeTags = (state.characterComboWardrobe || []).flatMap((id) => {
      const outfit = wardrobeOutfitById(id);
      return outfit && Array.isArray(outfit.tags) ? [...outfit.tags] : [];
    });
    return [...groupTags, ...(state.characterComboTags || []), ...wardrobeTags];
  }

  async function copyCharacterCombo() {
    const tags = comboCharacterTags();
    if (!tags.length) {
      toast('组合里还没有词条', 'info', 2000);
      return;
    }
    try {
      await navigator.clipboard.writeText(tags.join(', '));
      toast(`${tags.length} 个词条已复制到剪贴板`, 'info', 2200);
    } catch {
      toast('复制失败，请手动选择文本复制', 'error', 3200);
    }
  }

  function clearCharacterComboDragVisuals() {
    el.characterComboList.querySelectorAll('.character-combo-block').forEach((block) => {
      block.classList.remove('is-dragging', 'is-combo-over-left', 'is-combo-over-right');
    });
  }

  function finishCharacterComboPointer() {
    if (!characterComboPointer) return;
    document.removeEventListener('mousemove', characterComboPointer.move);
    document.removeEventListener('mouseup', characterComboPointer.up);
    characterComboPointer = null;
    clearCharacterComboDragVisuals();
  }

  function onCharacterComboMouseDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest?.('[data-combo-group-remove]')) return;
    const block = event.target.closest?.('.character-combo-block[data-combo-group]');
    if (!block) return;
    const pointer = {
      groupId: block.dataset.comboGroup,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      move: null,
      up: null,
    };
    pointer.move = (moveEvent) => {
      if (!characterComboPointer) return;
      const dx = moveEvent.clientX - pointer.startX;
      const dy = moveEvent.clientY - pointer.startY;
      if (!pointer.dragging && Math.hypot(dx, dy) < 5) return;
      if (!pointer.dragging) {
        pointer.dragging = true;
        block.classList.add('is-dragging');
      }
      moveEvent.preventDefault();
      clearCharacterComboDragVisuals();
      block.classList.add('is-dragging');
      const over = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.('.character-combo-block[data-combo-group]');
      if (!over || over === block) return;
      const rect = over.getBoundingClientRect();
      over.classList.add(moveEvent.clientX < rect.left + rect.width / 2 ? 'is-combo-over-left' : 'is-combo-over-right');
    };
    pointer.up = (upEvent) => {
      if (!characterComboPointer) return;
      const wasDragging = pointer.dragging;
      const over = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest?.('.character-combo-block[data-combo-group]');
      let insertAfter = false;
      if (over && over !== block) {
        const rect = over.getBoundingClientRect();
        insertAfter = upEvent.clientX >= rect.left + rect.width / 2;
      }
      const dragId = pointer.groupId;
      const targetId = over && over !== block ? over.dataset.comboGroup : null;
      finishCharacterComboPointer();
      if (!wasDragging || !targetId) return;
      const combo = [...state.characterCombo];
      const from = combo.findIndex((id) => String(id) === String(dragId));
      const targetBefore = combo.findIndex((id) => String(id) === String(targetId));
      if (from < 0 || targetBefore < 0) return;
      const [moved] = combo.splice(from, 1);
      const targetAfter = combo.findIndex((id) => String(id) === String(targetId));
      combo.splice(targetAfter + (insertAfter ? 1 : 0), 0, moved);
      state.characterCombo = combo;
      renderCharacterCombo();
      markCharacterDirty(true);
    };
    characterComboPointer = pointer;
    document.addEventListener('mousemove', pointer.move);
    document.addEventListener('mouseup', pointer.up);
  }

  async function loadPresets() {
    try {
      const res = await fetch('/api/presets', { cache: 'no-store' });
      if (!res.ok) throw new Error('preset request failed');
      const data = await res.json();
      state.presets = Array.isArray(data.presets) ? data.presets : [];
    } catch {
      state.presets = [];
    }
    if (presetEditingId && !(state.presets || []).some((preset) => String(preset.id) === String(presetEditingId))) {
      presetEditingId = null;
    }
    renderPresetList();
    renderSourcePresetFoldList();
  }

  function renderPresetList() {
    if (!el.presetList) return;
    hidePresetHover();
    const presets = state.presets || [];
    el.presetFoldCount.textContent = String(presets.length);
    if (!presets.length) {
      el.presetList.innerHTML = '<span class="preset-empty">还没有保存的预设词组</span>';
      return;
    }
    el.presetList.innerHTML = presets.map((preset) => {
      const editing = String(preset.id) === String(presetEditingId);
      const name = editing
        ? `<input class="preset-card-input" data-preset-input="${esc(preset.id)}" maxlength="80" value="${esc(preset.name || '预设')}" spellcheck="false">`
        : `<button type="button" class="preset-card-name" data-preset-apply="${esc(preset.id)}" title="点击填入翻译台">${esc(preset.name || '预设')}</button>`;
      return `<div class="preset-card" data-preset-card="${esc(preset.id)}">` +
        `<span class="preset-card-actions">` +
        `<button type="button" class="preset-card-action preset-card-delete" data-preset-delete="${esc(preset.id)}" title="删除预设" aria-label="删除预设">×</button>` +
        `<button type="button" class="preset-card-action preset-card-edit" data-preset-rename="${esc(preset.id)}" title="重命名预设" aria-label="重命名预设"><svg class="icon"><use href="#ico-pencil"/></svg></button>` +
        `</span>` +
        `${name}` +
        `<span class="preset-card-count">${Array.isArray(preset.tags) ? preset.tags.length : 0}</span>` +
        `</div>`;
    }).join('');
  }

  function startPresetRename(id) {
    if (!(state.presets || []).some((preset) => String(preset.id) === String(id))) return;
    presetEditingId = String(id);
    renderPresetList();
    requestAnimationFrame(() => {
      const input = el.presetList.querySelector(`[data-preset-input="${id}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  async function commitPresetRename(id) {
    if (String(presetEditingId) !== String(id)) return;
    const input = el.presetList.querySelector(`[data-preset-input="${id}"]`);
    const name = input ? input.value.trim() : '';
    if (!name) {
      presetEditingId = null;
      renderPresetList();
      return;
    }
    const preset = (state.presets || []).find((item) => String(item.id) === String(id));
    const oldName = preset?.name || '';
    if (oldName === name) {
      presetEditingId = null;
      renderPresetList();
      return;
    }
    presetEditingId = null;
    try {
      const res = await fetch('/api/presets/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '重命名失败');
      await loadPresets();
      if (oldName) {
        pushActionUndo('重命名预设', async () => {
          const undoRes = await fetch('/api/presets/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name: oldName }),
          });
          const undoData = await undoRes.json().catch(() => null);
          if (!undoRes.ok) throw new Error(undoData?.error?.message || '重命名失败');
          await loadPresets();
        });
      }
      toast('预设已重命名', 'info', 2000);
    } catch (err) {
      toast('重命名预设失败：' + prettyError(err), 'error', 3200);
      await loadPresets();
    }
  }

  function cancelPresetRename() {
    presetEditingId = null;
    renderPresetList();
  }

  async function deletePresetById(id) {
    const preset = (state.presets || []).find((item) => String(item.id) === String(id));
    if (!preset) return;
    if (!(await confirmDeleteAction(`删除预设「${preset.name || '预设'}」？`, '删除预设'))) return;
    try {
      const res = await fetch('/api/presets/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '删除失败');
      if (String(presetEditingId) === String(id)) presetEditingId = null;
      await loadPresets();
      if (data?.undoToken) {
        pushActionUndo('删除预设', async () => {
          await restoreServerDeletion(data.undoToken);
          await loadPresets();
        });
      }
      toast('预设已删除', 'info', 2000);
    } catch (err) {
      toast('删除预设失败：' + prettyError(err), 'error', 3200);
    }
  }

  function togglePresetFold() {
    const opening = el.presetFoldBody.hidden;
    mFold(el.presetFoldBody, opening);
    el.presetFoldToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) {
      closeCharacterFold();
      closeWardrobeFold();
      closeSourceFolds();
      hideCharacterHover();
      loadPresets();
    } else {
      hidePresetHover();
    }
  }

  function closeCharacterFold() {
    if (!el.characterFoldBody) return;
    mFold(el.characterFoldBody, false);
    el.characterFoldToggle.setAttribute('aria-expanded', 'false');
    hideCharacterHover();
  }

  function hideCharacterHover() {
    if (el.characterHoverPop) mHide(el.characterHoverPop, { leave: 'fade' });
  }

  function scrollHoverPopOnWheel(event, pop) {
    if (!pop || pop.hidden) return;
    if (pop.scrollHeight <= pop.clientHeight + 1) return;
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16
      : event.deltaMode === 2 ? event.deltaY * pop.clientHeight
      : event.deltaY;
    pop.scrollTop += delta;
  }

  function showCharacterHover(cardEl, card) {
    if (!el.characterHoverPop || !cardEl || !card) return;
    const tags = characterFixedTags(card);
    el.characterHoverPop.innerHTML = `<div class="preset-hover-head"><b>${esc(card.name || '未命名角色')}</b><span>${tags.length} TAGS</span></div>` +
      `<div class="preset-hover-tags">${tags.length
        ? tags.map((tag) => `<span class="preset-hover-tag">${esc(tag)}</span>`).join('')
        : '<span class="preset-hover-empty">没有固定词条</span>'}</div>`;
    /* mRiseIn 只做 translateY + opacity，不会改变 getBoundingClientRect 的尺寸，
       所以进场动画可以和下面的定位测量共存 */
    mShow(el.characterHoverPop, { enter: 'rise' });
    const cardRect = cardEl.getBoundingClientRect();
    const popRect = el.characterHoverPop.getBoundingClientRect();
    let left = Math.min(cardRect.left, window.innerWidth - popRect.width - 12);
    left = Math.max(12, left);
    let top = cardRect.top - popRect.height - 8;
    if (top < 12) top = Math.min(window.innerHeight - popRect.height - 12, cardRect.bottom + 8);
    el.characterHoverPop.style.left = `${Math.round(left)}px`;
    el.characterHoverPop.style.top = `${Math.round(top)}px`;
  }

  function renderCharacterFoldList() {
    if (!el.characterFoldList) return;
    hideCharacterHover();
    const cards = state.characters || [];
    el.characterFoldCount.textContent = String(cards.length);
    el.characterFoldList.innerHTML = cards.length
      ? cards.map((card) => {
        const src = characterPortraitSrc(card);
        const thumb = src
          ? `<img src="${src}" alt="${esc(card.name || '角色卡')}">`
          : esc((card.name || 'C').slice(0, 1).toUpperCase());
        return `<button type="button" class="character-mini-card" data-character-fold="${esc(card.id)}">` +
          `<span class="character-mini-thumb">${thumb}</span>` +
          `<span class="character-mini-copy"><b>${esc(card.name || '未命名角色')}</b>` +
          `<span>${esc(card.source || 'CHARACTER CARD')} · ${characterFixedTags(card).length} TAGS</span></span></button>`;
      }).join('')
      : '<div class="character-fold-empty">还没有保存的角色卡</div>';
  }

  async function loadCharacterFoldCards() {
    try {
      const res = await fetch('/api/characters', { cache: 'no-store' });
      if (!res.ok) throw new Error('character request failed');
      const data = await res.json();
      state.characters = Array.isArray(data.cards) ? data.cards : [];
    } catch {
      state.characters = [];
    }
    renderCharacterFoldList();
    renderSourceCharacterFoldList();
  }

  function toggleCharacterFold() {
    const opening = el.characterFoldBody.hidden;
    mFold(el.characterFoldBody, opening);
    el.characterFoldToggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) {
      mFold(el.presetFoldBody, false);
      el.presetFoldToggle.setAttribute('aria-expanded', 'false');
      closeWardrobeFold();
      closeSourceFolds();
      hidePresetHover();
      loadCharacterFoldCards();
    } else {
      hideCharacterHover();
    }
  }

  function applyCharacterFoldCard(id) {
    const card = (state.characters || []).find((item) => String(item.id) === String(id));
    if (!card) return;
    const tags = characterFixedTags(card);
    if (!tags.length) {
      toast('这张角色卡没有固定词条', 'info', 2000);
      return;
    }
    closeCharacterFold();
    if (state.phase !== 'idle') backToInput();
    insertIntoComposer(tags.join(', '));
    toast('角色卡固定词条已插入', 'info', 2000);
  }

  function renderSourceCharacterFoldList() {
    if (!el.sourceCharacterFoldList) return;
    const cards = state.characters || [];
    el.sourceCharacterFoldCount.textContent = String(cards.length);
    el.sourceCharacterFoldList.innerHTML = cards.length
      ? cards.map((card) => {
        const src = characterPortraitSrc(card);
        const thumb = src
          ? `<img src="${src}" alt="${esc(card.name || '角色卡')}">`
          : esc((card.name || 'C').slice(0, 1).toUpperCase());
        return `<button type="button" class="character-mini-card" data-source-character="${esc(card.id)}">` +
          `<span class="character-mini-thumb">${thumb}</span>` +
          `<span class="character-mini-copy"><b>${esc(card.name || '未命名角色')}</b>` +
          `<span>${esc(card.source || 'CHARACTER CARD')} · ${characterFixedTags(card).length} TAGS</span></span></button>`;
      }).join('')
      : '<div class="source-fold-empty">还没有保存的角色卡</div>';
  }

  function renderSourcePresetFoldList() {
    if (!el.sourcePresetFoldList) return;
    const presets = state.presets || [];
    el.sourcePresetFoldCount.textContent = String(presets.length);
    el.sourcePresetFoldList.innerHTML = presets.length
      ? presets.map((preset) => `<button type="button" class="source-preset-item" data-source-preset="${esc(preset.id)}">` +
        `${esc(preset.name || '预设')}<span>${Array.isArray(preset.tags) ? preset.tags.length : 0} TAGS</span></button>`).join('')
      : '<div class="source-fold-empty">还没有保存的预设词组</div>';
  }

  function closeSourceFolds() {
    mFold(el.sourceCharacterFoldBody, false);
    mFold(el.sourcePresetFoldBody, false);
    mFold(el.sourceWardrobeFoldBody, false);
    el.sourceCharacterFoldToggle.setAttribute('aria-expanded', 'false');
    el.sourcePresetFoldToggle.setAttribute('aria-expanded', 'false');
    el.sourceWardrobeFoldToggle.setAttribute('aria-expanded', 'false');
    hideCharacterHover();
    hidePresetHover();
    hideWardrobeHover();
  }

  function insertIntoSourceText(text) {
    const value = String(text || '');
    if (!value) return;
    flushTextBurst();
    const before = snapshotState();
    const input = el.sourceText;
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    input.value = input.value.slice(0, start) + value + input.value.slice(end);
    const cursor = start + value.length;
    input.setSelectionRange(cursor, cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (history.textBurst) {
      clearTimeout(history.textBurst.timer);
      history.textBurst = null;
    }
    pushHistory(before);
    commitHistory();
    history.programmaticUndo = true;
    history.programmaticTarget = 'source';
    input.focus();
  }

  function applySourceCharacterCard(id) {
    const card = (state.characters || []).find((item) => String(item.id) === String(id));
    if (!card) return;
    const tags = characterFixedTags(card);
    if (!tags.length) {
      toast('这张角色卡没有固定词条', 'info', 2000);
      return;
    }
    closeSourceFolds();
    insertIntoSourceText(tags.join(', '));
    toast('角色卡固定词条已插入原文', 'info', 2000);
  }

  function applySourcePreset(id) {
    const preset = (state.presets || []).find((item) => String(item.id) === String(id));
    const tags = Array.isArray(preset?.tags) ? preset.tags : [];
    if (!tags.length) {
      toast('这个预设没有词条', 'info', 1800);
      return;
    }
    closeSourceFolds();
    insertIntoSourceText(tags.join(', '));
    toast('预设词条已插入原文', 'info', 2000);
  }

  function toggleSourceCharacterFold() {
    const opening = el.sourceCharacterFoldBody.hidden;
    closeSourceFolds();
    if (!opening) return;
    mFold(el.sourceCharacterFoldBody, true);
    el.sourceCharacterFoldToggle.setAttribute('aria-expanded', 'true');
    closeCharacterFold();
    closeWardrobeFold();
    mFold(el.presetFoldBody, false);
    el.presetFoldToggle.setAttribute('aria-expanded', 'false');
    hidePresetHover();
    hideCharacterHover();
    loadCharacterFoldCards();
  }

  function toggleSourcePresetFold() {
    const opening = el.sourcePresetFoldBody.hidden;
    closeSourceFolds();
    if (!opening) return;
    mFold(el.sourcePresetFoldBody, true);
    el.sourcePresetFoldToggle.setAttribute('aria-expanded', 'true');
    closeCharacterFold();
    closeWardrobeFold();
    mFold(el.presetFoldBody, false);
    el.presetFoldToggle.setAttribute('aria-expanded', 'false');
    hidePresetHover();
    hideCharacterHover();
    loadPresets();
  }

  function hidePresetHover() {
    if (el.presetHoverPop) mHide(el.presetHoverPop, { leave: 'fade' });
  }

  function showPresetHover(card, preset) {
    if (!el.presetHoverPop || !card || !preset) return;
    const tags = Array.isArray(preset.tags) ? preset.tags : [];
    el.presetHoverPop.innerHTML = `<div class="preset-hover-head"><b>${esc(preset.name || '预设')}</b><span>${tags.length} TAGS</span></div>` +
      `<div class="preset-hover-tags">${tags.length
        ? tags.map((tag) => `<span class="preset-hover-tag">${esc(tag)}</span>`).join('')
        : '<span class="preset-hover-empty">没有保存词条</span>'}</div>`;
    /* 同 showCharacterHover：translateY 不影响尺寸测量 */
    mShow(el.presetHoverPop, { enter: 'rise' });
    const cardRect = card.getBoundingClientRect();
    const popRect = el.presetHoverPop.getBoundingClientRect();
    let left = Math.min(cardRect.left, window.innerWidth - popRect.width - 12);
    left = Math.max(12, left);
    let top = cardRect.top - popRect.height - 8;
    if (top < 12) top = Math.min(window.innerHeight - popRect.height - 12, cardRect.bottom + 8);
    el.presetHoverPop.style.left = `${Math.round(left)}px`;
    el.presetHoverPop.style.top = `${Math.round(top)}px`;
  }

  function applyPreset(preset) {
    const tags = Array.isArray(preset?.tags) ? preset.tags : [];
    if (!tags.length) {
      toast('这个预设没有词条', 'info', 1800);
      return;
    }
    if (state.phase !== 'idle') backToInput();
    if (document.activeElement !== el.composerInput) {
      el.composerInput.focus();
      const end = el.composerInput.value.length;
      el.composerInput.setSelectionRange(end, end);
    }
    insertIntoComposer(tags.join(', '));
    toast(`已填入 ${preset.name || '预设'}`, 'info', 2000);
  }

  function beginCharacterPresetSave() {
    if (characterPresetEditing) {
      el.characterPresetNameInput.focus();
      return;
    }
    if (!comboCharacterTags().length) {
      toast('组合里还没有词条，无法保存预设', 'info', 2200);
      return;
    }
    characterPresetEditing = true;
    el.characterSavePresetBtn.hidden = true;
    el.characterPresetPrompt.hidden = false;
    el.characterPresetNameInput.hidden = false;
    el.characterPresetNameInput.value = '';
    el.characterPresetNameInput.focus();
  }

  function cancelCharacterPresetSave() {
    characterPresetEditing = false;
    el.characterPresetNameInput.hidden = true;
    el.characterPresetPrompt.hidden = true;
    el.characterSavePresetBtn.hidden = false;
    el.characterSavePresetBtn.disabled = false;
    el.characterSavePresetBtn.textContent = '保存预设';
  }

  async function commitCharacterPresetSave() {
    if (!characterPresetEditing) return;
    characterPresetEditing = false;
    const name = el.characterPresetNameInput.value.trim();
    const tags = comboCharacterTags();
    el.characterPresetNameInput.hidden = true;
    el.characterPresetPrompt.hidden = true;
    el.characterSavePresetBtn.hidden = false;
    el.characterSavePresetBtn.disabled = true;
    el.characterSavePresetBtn.textContent = '保存中…';
    try {
      const res = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags, name: name || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '保存预设失败');
      await loadPresets();
      toast(`已保存为「${data.preset.name}」`, 'info', 2400);
    } catch (err) {
      toast('保存预设失败：' + prettyError(err), 'error', 3600);
    } finally {
      el.characterSavePresetBtn.disabled = false;
      el.characterSavePresetBtn.textContent = '保存预设';
    }
  }

  async function copyFixedCharacterTags() {
    const text = el.characterTags.value.trim();
    if (!text) {
      toast('固定词条为空', 'info', 1800);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('固定词条已复制到剪贴板', 'info', 2000);
    } catch {
      toast('复制失败，请手动选择文本复制', 'error', 3200);
    }
  }

  function markCharacterDirty(dirty) {
    state.characterDirty = dirty;
    el.characterDirty.hidden = !dirty;
    el.characterStatus.textContent = dirty
      ? '有未保存的修改'
      : (state.activeCharacterId ? '已载入角色卡' : '新建或选择一张角色卡');
  }

  function renderCharacterPortrait() {
    const dataUrl = state.characterPortraitData;
    const card = state.activeCharacterId ? characterById(state.activeCharacterId) : null;
    const src = dataUrl || (card?.portrait
      ? `/api/character/portrait/${encodeURIComponent(card.id)}?v=${encodeURIComponent(card.updatedAt || card.portrait)}`
      : '');
    if (src) {
      el.characterPortraitImg.src = src;
      el.characterPortraitImg.hidden = false;
      el.characterPortraitEmpty.hidden = true;
      el.characterPortrait.classList.add('has-image');
    } else {
      el.characterPortraitImg.removeAttribute('src');
      el.characterPortraitImg.hidden = true;
      el.characterPortraitEmpty.hidden = false;
      el.characterPortrait.classList.remove('has-image');
    }
  }

  function fillCharacterForm(card) {
    closeCharacterComboAdd();
    if (el.characterComboWardrobePop) el.characterComboWardrobePop.hidden = true;
    state.characterCreating = false;
    state.activeCharacterId = card?.id || null;
    state.characterPortraitData = null;
    el.characterName.value = card?.name || '';
    el.characterSource.value = card?.source || '';
    el.characterTags.value = card?.tags || '';
    el.characterNotes.value = card?.notes || '';
    state.characterGroups = normalizeCharacterGroups(card?.groups);
    state.characterCombo = Array.isArray(card?.combo)
      ? card.combo.map((id) => String(id)).filter((id) => state.characterGroups.some((group) => String(group.id) === id))
      : [];
    state.characterComboTags = Array.isArray(card?.comboTags)
      ? card.comboTags.map((tag) => String(tag || '').trim()).filter(Boolean)
      : [];
    state.characterComboWardrobe = Array.isArray(card?.comboWardrobe)
      ? card.comboWardrobe.map((id) => String(id)).filter(Boolean)
      : [];
    state.characterGroupEditingId = null;
    updateCharacterTagPreview();
    renderCharacterGroups();
    renderCharacterCombo();
    if (state.characterComboWardrobe.length && state.wardrobe === null) {
      const characterId = state.activeCharacterId;
      ensureWardrobeLoaded().then(() => {
        if (state.activeCharacterId === characterId) renderCharacterCombo();
      });
    }
    renderCharacterPortrait();
    setCharacterMode('edit');
    renderCharacterSelect();
    closeCharacterPicker();
    state.characterDirty = false;
    el.characterDirty.hidden = true;
    el.characterStatus.textContent = card ? `已载入 · ${card.name || '未命名角色'}` : '新建角色卡';
  }

  function clearCharacterForm() {
    closeCharacterComboAdd();
    if (el.characterComboWardrobePop) el.characterComboWardrobePop.hidden = true;
    state.activeCharacterId = null;
    state.characterPortraitData = null;
    el.characterName.value = '';
    el.characterSource.value = '';
    el.characterTags.value = '';
    el.characterNotes.value = '';
    state.characterGroups = [];
    state.characterCombo = [];
    state.characterComboTags = [];
    state.characterComboWardrobe = [];
    state.characterGroupEditingId = null;
    updateCharacterTagPreview();
    renderCharacterGroups();
    renderCharacterCombo();
    renderCharacterPortrait();
    renderCharacterSelect();
    state.characterDirty = false;
    el.characterDirty.hidden = true;
    el.characterStatus.textContent = '新建角色卡 · 填写后点击保存';
  }

  async function loadCharacters() {
    try {
      const res = await fetch('/api/characters', { cache: 'no-store' });
      if (!res.ok) throw new Error('character request failed');
      const data = await res.json();
      state.characters = Array.isArray(data.cards) ? data.cards : [];
    } catch {
      state.characters = [];
    }
    if (state.activeCharacterId && !characterById(state.activeCharacterId)) {
      state.activeCharacterId = null;
    }
    renderCharacterSelect();
  }

  async function openCharacterView() {
    if (state.characters === null) {
      await loadCharacters();
    }
    if (state.characterMode === 'wardrobe') {
      renderCharacterSelect();
      setCharacterMode('wardrobe');
      if (state.wardrobe === null) await loadWardrobe();
      return;
    }
    if (state.characterMode === 'create') {
      renderCharacterSelect();
      setCharacterMode('create');
      return;
    }
    if (state.characterMode === 'edit' && state.characterDirty) {
      renderCharacterSelect();
      setCharacterMode('edit');
      return;
    }
    showCharacterGallery();
  }

  function readCharacterPortrait(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }

  async function handleCharacterPortrait(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast('角色肖像只支持 PNG / JPEG / WebP', 'error', 3200);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('角色肖像不能超过 8 MB', 'error', 3200);
      return;
    }
    const characterId = state.activeCharacterId;
    const previous = {
      data: state.characterPortraitData,
      src: el.characterPortraitImg.getAttribute('src') || '',
      hidden: el.characterPortraitImg.hidden,
      emptyHidden: el.characterPortraitEmpty.hidden,
      hasImage: el.characterPortrait.classList.contains('has-image'),
      status: el.characterStatus.textContent,
    };
    try {
      const dataUrl = await readCharacterPortrait(file);
      state.characterPortraitData = dataUrl;
      el.characterPortraitImg.src = dataUrl;
      el.characterPortraitImg.hidden = false;
      el.characterPortraitEmpty.hidden = true;
      el.characterPortrait.classList.add('has-image');
      markCharacterDirty(true);
      el.characterStatus.textContent = '肖像待保存';
      pushActionUndo('更换角色肖像', () => {
        if (state.activeCharacterId !== characterId) throw new Error('当前角色卡已切换');
        state.characterPortraitData = previous.data;
        if (previous.src) el.characterPortraitImg.src = previous.src;
        else el.characterPortraitImg.removeAttribute('src');
        el.characterPortraitImg.hidden = previous.hidden;
        el.characterPortraitEmpty.hidden = previous.emptyHidden;
        el.characterPortrait.classList.toggle('has-image', previous.hasImage);
        markCharacterDirty(true);
        el.characterStatus.textContent = '肖像待保存';
      });
      toast('肖像已更新', 'info', 2000);
    } catch {
      toast('读取肖像失败', 'error', 3200);
    }
  }

  async function saveCharacterCard() {
    if (state.characterGroupEditingId) commitCharacterGroupRename(state.characterGroupEditingId);
    const card = {
      id: state.activeCharacterId || undefined,
      name: el.characterName.value.trim(),
      source: el.characterSource.value.trim(),
      tags: el.characterTags.value.trim(),
      notes: el.characterNotes.value.trim(),
      groups: state.characterGroups.map((group) => ({
        id: group.id,
        name: group.name,
        tags: [...group.tags],
      })),
      combo: [...state.characterCombo],
      comboTags: [...(state.characterComboTags || [])],
      comboWardrobe: [...(state.characterComboWardrobe || [])],
    };
    if (!card.name && !card.tags) {
      toast('至少填写角色名或固定词条中的一项', 'info', 2600);
      return;
    }
    el.characterSaveBtn.disabled = true;
    el.characterSaveBtn.textContent = '保存中…';
    try {
      const res = await fetch('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card, portraitData: state.characterPortraitData || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      const saved = data.card;
      state.characterPortraitData = null;
      await loadCharacters();
      state.activeCharacterId = saved.id;
      const fresh = characterById(saved.id) || saved;
      fillCharacterForm(fresh);
      toast('角色卡已保存', 'info', 2000);
    } catch (err) {
      toast('保存角色卡失败：' + prettyError(err), 'error', 4200);
    } finally {
      el.characterSaveBtn.disabled = false;
      el.characterSaveBtn.textContent = '保存 SAVE';
    }
  }

  async function deleteCharacterCard() {
    if (!state.activeCharacterId) return;
    if (!(await confirmDeleteAction(`删除角色卡「${el.characterName.value.trim() || '未命名角色'}」？`, '删除角色卡'))) return;
    try {
      const res = await fetch('/api/characters/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.activeCharacterId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '删除失败');
      state.activeCharacterId = null;
      state.characterPortraitData = null;
      await loadCharacters();
      showCharacterGallery();
      if (data?.undoToken) {
        pushActionUndo('删除角色卡', async () => {
          await restoreServerDeletion(data.undoToken);
          await loadCharacters();
          if (state.view === 'card') showCharacterGallery();
        });
      }
      toast('角色卡已删除', 'info', 2000);
    } catch (err) {
      toast('删除角色卡失败：' + prettyError(err), 'error', 3600);
    }
  }

  async function deleteGalleryCharacter(id) {
    const card = characterById(id);
    if (!card) return;
    if (!(await confirmDeleteAction(`删除角色卡「${card.name || '未命名角色'}」？`, '删除角色卡'))) return;
    try {
      const res = await fetch('/api/characters/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '删除失败');
      await loadCharacters();
      showCharacterGallery();
      if (data?.undoToken) {
        pushActionUndo('删除角色卡', async () => {
          await restoreServerDeletion(data.undoToken);
          await loadCharacters();
          if (state.view === 'card') showCharacterGallery();
        });
      }
      toast('角色卡已删除', 'info', 2000);
    } catch (err) {
      toast('删除角色卡失败：' + prettyError(err), 'error', 3600);
    }
  }

  async function backToCharacterGallery() {
    if (state.characterGroupEditingId) commitCharacterGroupRename(state.characterGroupEditingId);
    if (state.characterMode === 'create' && el.characterCreateInput.value.trim()) {
      if (!(await confirmDiscardAction('放弃已输入的角色 tags？', '放弃创建'))) return;
    }
    if (state.characterDirty && !(await confirmDiscardAction('放弃当前未保存的修改？', '放弃修改'))) return;
    showCharacterGallery();
  }

  async function newCharacterCard() {
    if (state.characterGroupEditingId) commitCharacterGroupRename(state.characterGroupEditingId);
    if (state.characterDirty && !(await confirmDiscardAction('放弃当前未保存的修改？', '放弃修改'))) return;
    enterCharacterCreateMode();
  }

  async function switchCharacterCard(id) {
    if (!id) {
      newCharacterCard();
      return;
    }
    const card = characterById(id);
    if (!card || String(card.id) === String(state.activeCharacterId)) return;
    if (state.characterGroupEditingId) commitCharacterGroupRename(state.characterGroupEditingId);
    if (state.characterDirty && !(await confirmDiscardAction('放弃当前未保存的修改？', '放弃修改'))) {
      el.characterSelect.value = state.activeCharacterId || '';
      return;
    }
    fillCharacterForm(card);
  }

  function fillComposerWithTags(tags, sourceName = '角色卡') {
    const text = String(tags || '').trim();
    if (!text) {
      toast('这张角色卡还没有固定词条', 'info', 2200);
      return false;
    }
    switchView('translate');
    if (state.phase !== 'idle') backToInput();
    el.composerInput.value = text;
    el.composerInput.dispatchEvent(new Event('input', { bubbles: true }));
    el.composerInput.focus();
    toast(`${sourceName}已填入翻译台`, 'info', 2000);
    return true;
  }

  function applyCharacterCard() {
    fillComposerWithTags(el.characterTags.value);
  }

  async function copyCharacterTags(id) {
    const card = characterById(id);
    if (!card) return;
    const text = String(card.tags || '').trim();
    if (!text) {
      toast('这张角色卡还没有固定词条', 'info', 2200);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('角色 tags 已复制到剪贴板', 'info', 2000);
    } catch {
      toast('复制失败，请手动选择文本复制', 'error', 3200);
    }
  }

  async function reorderCharacterGallery(dragId, targetId) {
    const cards = [...(state.characters || [])];
    const from = cards.findIndex((card) => String(card.id) === String(dragId));
    if (from < 0) return;
    const targetBefore = cards.findIndex((card) => String(card.id) === String(targetId));
    if (targetBefore < 0) return;
    const [moved] = cards.splice(from, 1);
    const targetAfter = cards.findIndex((card) => String(card.id) === String(targetId));
    const insert = targetAfter + (from < targetBefore ? 1 : 0);
    cards.splice(insert, 0, moved);
    state.characters = cards;
    renderCharacterGallery();
    renderCharacterSelect();
    try {
      const res = await fetch('/api/characters/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: cards.map((card) => card.id) }),
      });
      if (!res.ok) throw new Error('order failed');
    } catch {
      toast('角色卡顺序保存失败', 'error', 2600);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* gallery                                                                 */
  /* ----------------------------------------------------------------------- */

  async function loadGalleryWorks() {
    try {
      const res = await fetch('/api/gallery', { cache: 'no-store' });
      if (!res.ok) throw new Error('gallery request failed');
      const data = await res.json();
      state.galleryWorks = Array.isArray(data.works) ? data.works : [];
    } catch {
      state.galleryWorks = [];
    }
    renderGalleryHome();
  }

  function renderGalleryHome() {
    if (!el.galleryList) return;
    const works = state.galleryWorks || [];
    el.galleryMeta.textContent = `${works.length} WORKS`;
    const splitTags = (value) => String(value || '')
      .split(/[,\n;]+/).map((part) => part.trim()).filter(Boolean);
    const formatGalleryDate = (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      const pad = (number) => String(number).padStart(2, '0');
      return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    const copyButton = (field) =>
      `<button type="button" class="gallery-copy" data-gallery-copy="${field}" title="复制">复制 COPY</button>`;
    const chipSection = (label, field, value) => {
      const parts = splitTags(value);
      if (!parts.length) return '';
      return `<section class="gallery-card-section"><div class="gallery-card-section-head">` +
        `<span>${label}</span>${copyButton(field)}</div>` +
        `<div class="gallery-chips">${parts.map((part) => `<span class="gallery-chip">${esc(part)}</span>`).join('')}</div>` +
        `</section>`;
    };
    const subjectSection = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      let tagText = raw;
      let description = '';
      const blank = raw.search(/\n\s*\n/);
      if (blank >= 0) {
        tagText = raw.slice(0, blank);
        description = raw.slice(blank).trim();
      } else {
        const lines = raw.split(/\r?\n/);
        let descriptionLine = -1;
        for (let i = 1; i < lines.length; i += 1) {
          const line = lines[i].trim();
          if (!line) continue;
          if (line.length > 60 && /\s/.test(line) && /[.!?]/.test(line)) {
            descriptionLine = i;
            break;
          }
        }
        if (descriptionLine > 0) {
          tagText = lines.slice(0, descriptionLine).join(', ');
          description = lines.slice(descriptionLine).join('\n').trim();
        }
      }
      const parts = splitTags(tagText);
      const chips = parts.length
        ? `<div class="gallery-chips">${parts.map((part, index) =>
          `<span class="gallery-chip"><span class="gallery-chip-idx">${String(index + 1).padStart(2, '0')}</span><span>${esc(part)}</span></span>`
        ).join('')}</div>`
        : '';
      const descriptionHtml = description
        ? `<div class="gallery-card-description">${esc(description)}</div>`
        : '';
      if (!chips && !descriptionHtml) return '';
      return `<section class="gallery-card-section"><div class="gallery-card-section-head">` +
        `<span>主体提示词 / SUBJECT</span>${copyButton('subjectPrompt')}</div>` +
        chips + descriptionHtml + `</section>`;
    };
    const cards = works.map((work) => {
      const id = String(work.id || '');
      const image = work.image
        ? `<img src="/api/gallery/image/${encodeURIComponent(id)}?v=${encodeURIComponent(work.updatedAt || work.image)}" alt="${esc(work.title || '作品预览')}">`
        : '<span class="gallery-card-preview-empty">NO PREVIEW / 暂无预览图</span>';
      const basic = [];
      if (String(work.character || '').trim()) {
        basic.push(`<div class="gallery-card-field"><span>角色 / CHARACTER</span><span>${esc(work.character)}</span></div>`);
      }
      if (String(work.source || '').trim()) {
        basic.push(`<div class="gallery-card-field"><span>出处 / SOURCE</span><span>${esc(work.source)}</span></div>`);
      }
      basic.push(`<div class="gallery-card-field"><span>创建时间 / CREATED</span>` +
        `<span>${esc(formatGalleryDate(work.createdAt))}</span></div>`);
      if (String(work.seed || '').trim()) {
        basic.push(`<div class="gallery-card-field"><span>种子码 / SEED</span>` +
          `<span class="gallery-card-seed"><span>${esc(work.seed)}</span>${copyButton('seed')}</span></div>`);
      }
      const sections = chipSection('画师串 / ARTIST', 'artist', work.artist) +
        subjectSection(work.subjectPrompt) +
        chipSection('质量提示词 / QUALITY', 'qualityPrompt', work.qualityPrompt) +
        chipSection('LORA / LORA', 'loras', work.loras);
      return `<article class="gallery-card" data-gallery-id="${esc(id)}">` +
        `<div class="gallery-card-preview">${image}</div>` +
        `<div class="gallery-card-info"><span class="gallery-card-code">GALLERY // WORK</span>` +
        `<div class="gallery-card-title-row"><h3>${esc(work.title || '未命名作品')}</h3>` +
        `<span class="gallery-card-dims" data-gallery-dims>—</span>` +
        `<div class="gallery-card-actions">` +
        `<button type="button" class="gallery-edit" data-gallery-edit="${esc(id)}">编辑 EDIT</button>` +
        `<button type="button" class="gallery-icon-btn gallery-delete" data-gallery-delete="${esc(id)}" title="删除作品" aria-label="删除作品">×</button>` +
        `<button type="button" class="gallery-icon-btn gallery-drag" data-gallery-drag="${esc(id)}" title="拖动调整顺序" aria-label="拖动调整顺序">` +
        `<span class="gallery-grip"><i></i><i></i><i></i></span></button>` +
        `</div></div>` +
        `<div class="gallery-card-fields">${basic.join('') || '<div class="gallery-card-field"><span>INFO</span><span>未填写作品信息</span></div>'}</div>` +
        `<div class="gallery-card-sections">${sections}</div></div></article>`;
    }).join('');
    el.galleryList.innerHTML = cards +
      `<button type="button" class="gallery-card gallery-new" data-gallery-new>` +
      `<span class="gallery-new-plus">＋</span><b>添加新作品</b><span>NEW ARTWORK</span></button>`;
    el.galleryList.querySelectorAll('.gallery-card-preview img').forEach((img) => {
      const dims = img.closest('.gallery-card')?.querySelector('[data-gallery-dims]');
      if (!dims) return;
      const apply = () => {
        if (img.naturalWidth && img.naturalHeight) {
          dims.textContent = `${img.naturalWidth} × ${img.naturalHeight} PX`;
        }
      };
      if (img.complete) apply();
      else img.addEventListener('load', apply, { once: true });
    });
    mStagger(el.galleryList, { step: 24, max: 10 });
  }

  function resetGalleryAddForm() {
    state.galleryPreviewData = null;
    state.galleryEditingId = null;
    el.galleryPreviewImg.removeAttribute('src');
    el.galleryPreviewImg.hidden = true;
    el.galleryPreviewEmpty.hidden = false;
    el.galleryPreviewDimensions.textContent = '—';
    el.galleryPreviewFrame.classList.remove('has-image');
    el.galleryAddTitle.textContent = '添加新作品';
    el.galleryAddTitleEn.textContent = 'NEW ARTWORK';
    [el.galleryTitle, el.galleryCharacter, el.gallerySource, el.gallerySeed,
      el.galleryArtist, el.gallerySubject, el.galleryQuality, el.galleryLoras].forEach((input) => {
      input.value = '';
    });
  }

  function openGalleryAdd() {
    resetGalleryAddForm();
    mSwapIn(el.galleryHome, false);
    mSwapIn(el.galleryAddView, true, 'rise');
    el.galleryTitle.focus();
  }

  function openGalleryEdit(work) {
    if (!work) return;
    resetGalleryAddForm();
    state.galleryEditingId = String(work.id || '');
    el.galleryAddTitle.textContent = '编辑作品';
    el.galleryAddTitleEn.textContent = 'EDIT ARTWORK';
    el.galleryTitle.value = work.title || '';
    el.galleryCharacter.value = work.character || '';
    el.gallerySource.value = work.source || '';
    el.gallerySeed.value = work.seed || '';
    el.galleryArtist.value = work.artist || '';
    el.gallerySubject.value = work.subjectPrompt || '';
    el.galleryQuality.value = work.qualityPrompt || '';
    el.galleryLoras.value = work.loras || '';
    if (work.image) {
      el.galleryPreviewImg.src = `/api/gallery/image/${encodeURIComponent(work.id)}?v=${encodeURIComponent(work.updatedAt || work.image)}`;
      el.galleryPreviewImg.hidden = false;
      el.galleryPreviewEmpty.hidden = true;
      el.galleryPreviewFrame.classList.add('has-image');
      if (el.galleryPreviewImg.complete) updateGalleryPreviewDimensions();
    }
    mSwapIn(el.galleryHome, false);
    mSwapIn(el.galleryAddView, true, 'rise');
    el.galleryTitle.focus();
  }

  async function openGalleryView() {
    el.galleryHome.hidden = false;
    el.galleryAddView.hidden = true;
    resetGalleryAddForm();
    await loadGalleryWorks();
  }

  function closeGalleryAdd() {
    mSwapIn(el.galleryAddView, false);
    mSwapIn(el.galleryHome, true, 'fade');
    resetGalleryAddForm();
    loadGalleryWorks();
  }

  function updateGalleryPreviewDimensions() {
    const width = el.galleryPreviewImg.naturalWidth;
    const height = el.galleryPreviewImg.naturalHeight;
    el.galleryPreviewDimensions.textContent = width && height ? `${width} × ${height} PX` : '—';
  }

  async function handleGalleryPreviewFile(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast('作品预览只支持 PNG / JPEG / WebP', 'error', 3000);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('作品预览不能超过 8 MB', 'error', 3000);
      return;
    }
    const editingId = state.galleryEditingId;
    const previous = {
      data: state.galleryPreviewData,
      src: el.galleryPreviewImg.getAttribute('src') || '',
      hidden: el.galleryPreviewImg.hidden,
      emptyHidden: el.galleryPreviewEmpty.hidden,
      hasImage: el.galleryPreviewFrame.classList.contains('has-image'),
      dimensions: el.galleryPreviewDimensions.textContent,
    };
    try {
      const dataUrl = await readCharacterPortrait(file);
      state.galleryPreviewData = dataUrl;
      el.galleryPreviewImg.src = dataUrl;
      el.galleryPreviewImg.hidden = false;
      el.galleryPreviewEmpty.hidden = true;
      el.galleryPreviewFrame.classList.add('has-image');
      if (el.galleryPreviewImg.complete) {
        updateGalleryPreviewDimensions();
      }
      pushActionUndo('更换作品预览', () => {
        if (state.galleryEditingId !== editingId) throw new Error('当前编辑作品已切换');
        state.galleryPreviewData = previous.data;
        if (previous.data) el.galleryPreviewImg.src = previous.data;
        else if (previous.src) el.galleryPreviewImg.src = previous.src;
        else el.galleryPreviewImg.removeAttribute('src');
        el.galleryPreviewImg.hidden = previous.hidden;
        el.galleryPreviewEmpty.hidden = previous.emptyHidden;
        el.galleryPreviewFrame.classList.toggle('has-image', previous.hasImage);
        el.galleryPreviewDimensions.textContent = previous.dimensions;
      });
      toast('作品预览已更新', 'info', 2000);
    } catch {
      toast('读取预览图失败', 'error', 3000);
    }
  }

  async function saveGalleryWork() {
    const work = {
      title: el.galleryTitle.value.trim(),
      character: el.galleryCharacter.value.trim(),
      source: el.gallerySource.value.trim(),
      seed: el.gallerySeed.value.trim(),
      artist: el.galleryArtist.value.trim(),
      subjectPrompt: el.gallerySubject.value.trim(),
      qualityPrompt: el.galleryQuality.value.trim(),
      loras: el.galleryLoras.value.trim(),
    };
    const editingId = state.galleryEditingId;
    el.gallerySaveBtn.disabled = true;
    el.gallerySaveBtn.textContent = '保存中…';
    try {
      const res = await fetch(editingId ? '/api/gallery/update' : '/api/gallery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId || undefined,
          work,
          imageData: state.galleryPreviewData || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      closeGalleryAdd();
      toast(editingId ? '作品已更新' : '作品已保存', 'info', 2200);
    } catch (err) {
      toast('保存作品失败：' + prettyError(err), 'error', 3800);
    } finally {
      el.gallerySaveBtn.disabled = false;
      el.gallerySaveBtn.textContent = '保存 SAVE';
    }
  }

  async function deleteGalleryWork(id) {
    const work = (state.galleryWorks || []).find((item) => String(item.id) === String(id));
    const name = work?.title || '未命名作品';
    if (!(await confirmDeleteAction(`删除作品「${name}」？`, '删除作品'))) return;
    try {
      const res = await fetch('/api/gallery/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || '删除失败');
      state.galleryWorks = (state.galleryWorks || []).filter((item) => String(item.id) !== String(id));
      renderGalleryHome();
      if (data?.undoToken) {
        pushActionUndo('删除作品', async () => {
          await restoreServerDeletion(data.undoToken);
          await loadGalleryWorks();
        });
      }
      toast('作品已删除', 'info', 2200);
    } catch (err) {
      toast('删除作品失败：' + prettyError(err), 'error', 3600);
    }
  }

  async function saveGalleryOrder(ids) {
    try {
      const res = await fetch('/api/gallery/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error('order request failed');
      toast('作品顺序已保存', 'info', 1800);
    } catch {
      toast('作品顺序保存失败', 'error', 3000);
    }
  }

  function startGalleryDrag(card, event) {
    if (!card || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    const list = el.galleryList;
    const stateDrag = { card, moved: false };
    card.classList.add('is-dragging');
    document.body.classList.add('is-gallery-dragging');
    const onMove = (moveEvent) => {
      if (!stateDrag.card) return;
      moveEvent.preventDefault();
      const listRect = list.getBoundingClientRect();
      if (moveEvent.clientY < listRect.top + 32) list.scrollTop -= 14;
      else if (moveEvent.clientY > listRect.bottom - 32) list.scrollTop += 14;
      const cards = [...list.querySelectorAll('.gallery-card[data-gallery-id]')].filter((item) => item !== stateDrag.card);
      if (!cards.length) return;
      let target = cards.find((item) => {
        const rect = item.getBoundingClientRect();
        return moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom;
      });
      if (!target) {
        target = cards.reduce((best, item) => {
          const rect = item.getBoundingClientRect();
          const center = rect.top + rect.height / 2;
          const distance = Math.abs(center - moveEvent.clientY);
          return !best || distance < best.distance ? { item, distance } : best;
        }, null)?.item;
      }
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const after = moveEvent.clientY > rect.top + rect.height / 2;
      const reference = after ? target.nextSibling : target;
      if (reference !== stateDrag.card) list.insertBefore(stateDrag.card, reference);
      stateDrag.moved = true;
    };
    const finish = async () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', finish, true);
      card.classList.remove('is-dragging');
      document.body.classList.remove('is-gallery-dragging');
      if (!stateDrag.moved) return;
      const ids = [...list.querySelectorAll('.gallery-card[data-gallery-id]')]
        .map((item) => item.dataset.galleryId);
      const byId = new Map((state.galleryWorks || []).map((work) => [String(work.id), work]));
      state.galleryWorks = ids.map((id) => byId.get(id)).filter(Boolean);
      await saveGalleryOrder(ids);
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', finish, true);
  }

  /* ----------------------------------------------------------------------- */
  /* health / engine status                                                  */
  /* ----------------------------------------------------------------------- */

  async function loadConfig() {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      state.config = data.config || DEFAULT_CONFIG;
    } catch {
      state.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      toast('无法读取本地配置，已使用默认引擎', 'error', 4200);
    }
    updateEngineChip();
    return state.config;
  }

  async function refreshHealth() {
    if (location.protocol === 'file:') return;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('bad response');
      state.health = await res.json();
    } catch {
      state.health = null;
    }
    updateEngineChip();
    if (state.settingsOpen) renderHealthReadout();
  }

  async function detectChrome() {
    if (state.chromeAvailability) return state.chromeAvailability;
    if (!('Translator' in self)) {
      state.chromeAvailability = 'unsupported';
      return state.chromeAvailability;
    }
    try {
      state.chromeAvailability = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
    } catch {
      state.chromeAvailability = 'unavailable';
    }
    updateEngineChip();
    return state.chromeAvailability;
  }

  function engineLabel(engine) {
    return ({
      ollama: 'OLLAMA', openai: 'LM STUDIO / API', libretranslate: 'LIBRETRANSLATE',
      chrome: 'CHROME', glossary: 'GLOSSARY', auto: 'AUTO',
    })[engine] || String(engine || '').toUpperCase();
  }

  function updateEngineChip() {
    if (!el.engineChipText) return;
    const engine = state.config?.engine || 'auto';
    const health = state.health;
    let sub = '—';
    let led = 'is-warn';

    if (engine === 'auto') {
      if (!health) sub = 'CHECKING…';
      else if (health.resolved) {
        sub = '→ ' + engineLabel(health.resolved) + (health.resolvedModel ? ' · ' + health.resolvedModel : '');
        led = 'is-ok';
      } else if (state.chromeAvailability && state.chromeAvailability !== 'unsupported' && state.chromeAvailability !== 'unavailable') {
        sub = state.chromeAvailability === 'downloadable'
          ? '→ CHROME · FIRST-RUN FETCH'
          : '→ CHROME · ON-DEVICE';
        led = 'is-ok';
      } else {
        sub = 'NO ENGINE';
        led = 'is-bad';
      }
    } else if (engine === 'chrome') {
      const av = state.chromeAvailability;
      if (av === 'available') { sub = 'ON-DEVICE MODEL'; led = 'is-ok'; }
      else if (av === 'downloadable' || av === 'downloading') { sub = 'MODEL FETCH ON FIRST RUN'; led = 'is-warn'; }
      else if (av === 'unsupported' || av === 'unavailable') { sub = 'UNAVAILABLE'; led = 'is-bad'; }
      else sub = 'CHECKING…';
    } else if (engine === 'glossary') {
      sub = 'TAGS ONLY · OFFLINE';
      led = 'is-warn';
    } else {
      const info = health?.engines?.[engine];
      if (info?.reachable) {
        sub = 'READY' + (info.models?.length ? ' · ' + info.models.length + ' MODELS' : '');
        led = 'is-ok';
      } else if (health) { sub = 'OFFLINE'; led = 'is-bad'; }
      else sub = 'CHECKING…';
    }

    el.engineChipText.textContent = 'ENGINE · ' + engine.toUpperCase();
    el.engineChipSub.textContent = sub;
    el.engineLed.className = 'led ' + led + (state.phase === 'translating' ? ' is-busy' : '');
    /* 引擎状态真正变化时让 chip 标签闪一次；motion-nav.css 已把 chip 自身淡入中和 */
    const chipSig = engine + '|' + sub + '|' + led;
    if (el.engineChip && el.engineChip.dataset.motionSig && el.engineChip.dataset.motionSig !== chipSig) {
      mPlay(el.engineChip, 'fade', { fast: true });
    }
    if (el.engineChip) el.engineChip.dataset.motionSig = chipSig;
  }

  function renderHealthReadout(healthOverride) {
    if (!el.healthReadout) return;
    const health = healthOverride || state.health;
    if (!health) {
      el.healthReadout.innerHTML = '<span class="hr-placeholder">本地服务无响应 · SERVER OFFLINE</span>';
      updateCfgStates(null);
      return;
    }
    const rows = [];
    const row = (key, cls, value, note) => (
      `<div class="hr-row"><span class="hr-key">${esc(key)}</span>` +
      `<span class="hr-val ${cls}">${esc(value)}</span>` +
      (note ? `<span class="hr-note">${esc(note)}</span>` : '') +
      '</div>'
    );

    const ollama = health.engines?.ollama || {};
    rows.push(row('OLLAMA', ollama.reachable ? 'ok' : 'bad',
      ollama.reachable ? 'READY' : 'OFFLINE',
      ollama.reachable ? `${(ollama.models || []).length} 个模型` : (ollama.error || '')));

    const openai = health.engines?.openai || {};
    rows.push(row('LM STUDIO / API', openai.reachable ? 'ok' : 'bad',
      openai.reachable ? 'READY' : 'OFFLINE',
      openai.reachable ? `${(openai.models || []).length} 个模型` : (openai.error || '')));

    const libre = health.engines?.libretranslate || {};
    rows.push(row('LIBRETRANSLATE', libre.reachable ? 'ok' : 'bad',
      libre.reachable ? 'READY' : 'OFFLINE', libre.reachable ? '' : (libre.error || '')));

    const av = state.chromeAvailability;
    const chromeMap = {
      available: ['ok', 'READY', 'Chrome 内置 · 已安装模型'],
      downloadable: ['warn', 'READY', 'Chrome 内置 · 首次翻译需下载模型'],
      downloading: ['warn', 'DOWNLOADING', 'Chrome 内置 · 模型下载中'],
      unavailable: ['bad', 'UNAVAILABLE', 'Chrome 内置 · 模型不可用'],
      unsupported: ['bad', 'NOT SUPPORTED', '需要 Chrome 138+'],
    };
    const chromeRow = chromeMap[av] || ['warn', 'CHECKING', '检测中'];
    rows.push(row('CHROME 内置', chromeRow[0], chromeRow[1], chromeRow[2]));

    rows.push(row('AUTO RESOLVE', health.resolved ? 'ok' : 'warn',
      health.resolved ? engineLabel(health.resolved) : 'NONE',
      health.resolved ? (health.resolvedModel || '') : '没有可用的服务端引擎'));

    el.healthReadout.innerHTML = rows.join('');
    updateCfgStates(health);
  }

  function updateCfgStates(health) {
    document.querySelectorAll('.cfg-state').forEach((node) => {
      const key = node.dataset.state;
      let text = '—';
      let cls = 'cfg-state';
      if (key === 'ollama' && health) {
        const info = health.engines?.ollama;
        if (info?.reachable) { text = `READY · ${(info.models || []).length} MODELS`; cls += ' is-ok'; }
        else { text = 'OFFLINE'; cls += ' is-bad'; }
      }
      if (key === 'openai' && health) {
        const info = health.engines?.openai;
        if (info?.reachable) { text = 'READY'; cls += ' is-ok'; }
        else { text = 'OFFLINE'; cls += ' is-bad'; }
      }
      if (key === 'libretranslate' && health) {
        const info = health.engines?.libretranslate;
        if (info?.reachable) { text = 'READY'; cls += ' is-ok'; }
        else { text = 'OFFLINE'; cls += ' is-bad'; }
      }
      node.textContent = text;
      node.className = cls;
    });
  }

  /* ----------------------------------------------------------------------- */
  /* rendering                                                               */
  /* ----------------------------------------------------------------------- */

  function allBlocks() {
    if (!state.blocks) return [];
    return [...state.blocks.tags, ...state.blocks.sentences];
  }

  function blockAddHtml(side, kind) {
    const label = kind === 'tag' ? '新增词块' : '新增句子';
    const extra = kind === 'sentence' ? ' block-add-sent' : '';
    return `<button type="button" class="block-add${extra}" data-add="${side}" data-kind="${kind}" ` +
      `title="${label}">+ ADD</button>`;
  }

  function chipHtml(block, index, translated) {
    const editing = state.editing && state.editing.bid === block.id
      && state.editing.side === (translated ? 'target' : 'source');
    const idx = `<button type="button" class="idx" data-bid="${esc(block.id)}" ` +
      `title="${translated ? '删除该译文块' : '删除该词块'}" aria-label="删除">` +
      `<span class="idx-num">${pad2(index)}</span><span class="idx-x">×</span></button>`;
    if (editing) {
      const value = translated ? (state.translations[block.id]?.text || '') : block.text;
      return `<span class="blk is-editing" data-bid="${esc(block.id)}">${idx}` +
        `<input class="inline-edit" spellcheck="false" value="${esc(value)}"></span>`;
    }
    let cls = 'blk' + (translated ? ' blk-zh' : '');
    if (state.syncingIds.has(block.id)) cls += ' is-syncing';
    if (state.pendingIds.has(block.id) || state.syncingIds.has(block.id)) cls += ' is-working';
    let content = '';
    const pending = state.pendingIds.has(block.id);
    if (translated) {
      const hit = state.translations[block.id];
      if (pending) {
        cls += ' is-pending';
        content = '<span class="pending-dots">· · ·</span>';
      } else if (hit) {
        content = esc(hit.text);
      } else if (state.phase === 'translating') {
        cls += ' is-pending';
        content = '<span class="pending-dots">· · ·</span>';
      } else {
        cls += ' is-missing';
        content = '<span class="missing">未翻译</span>';
      }
    } else {
      content = block.text ? esc(block.text) : '<span class="blk-placeholder">…</span>';
    }
    return `<span class="${cls}" data-bid="${esc(block.id)}" tabindex="0" draggable="true" title="${esc(block.text)}">` +
      `${idx}${content}</span>`;
  }

  function sentenceHtml(block, index, translated) {
    const editing = state.editing && state.editing.bid === block.id
      && state.editing.side === (translated ? 'target' : 'source');
    const idx = `<button type="button" class="idx" data-bid="${esc(block.id)}" ` +
      `title="${translated ? '删除该译文块' : '删除该句块'}" aria-label="删除">` +
      `<span class="idx-num">${pad2(index)}</span><span class="idx-x">×</span></button>`;
    if (editing) {
      const value = translated ? (state.translations[block.id]?.text || '') : block.text;
      const heightStyle = state.editing.height ? ` style="height:${state.editing.height}px"` : '';
      return `<div class="sent is-editing" data-bid="${esc(block.id)}">${idx}` +
        `<textarea class="inline-edit" rows="3" spellcheck="false"${heightStyle}>${esc(value)}</textarea></div>`;
    }
    let cls = 'sent' + (translated ? ' sent-zh' : '');
    if (state.syncingIds.has(block.id)) cls += ' is-syncing';
    if (state.pendingIds.has(block.id) || state.syncingIds.has(block.id)) cls += ' is-working';
    let body = '';
    const pending = state.pendingIds.has(block.id);
    if (translated) {
      const hit = state.translations[block.id];
      if (pending) {
        cls += ' is-pending';
        body = '<div class="txt txt-zh"><span class="pending-dots">· · ·</span></div>';
      } else if (hit) {
        body = `<div class="txt txt-zh">${esc(hit.text)}</div>`;
      } else if (state.phase === 'translating') {
        cls += ' is-pending';
        body = '<div class="txt txt-zh"><span class="pending-dots">· · ·</span></div>';
      } else {
        cls += ' is-missing';
        body = '<div class="txt txt-zh"><span class="missing">未翻译</span></div>';
      }
    } else {
      body = `<div class="txt">${block.text ? esc(block.text) : '<span class="blk-placeholder">…</span>'}</div>`;
    }
    const title = translated ? ` title="${esc(block.text)}"` : '';
    return `<div class="${cls}" data-bid="${esc(block.id)}" tabindex="0" draggable="true"${title}>` +
      `${idx}${body}</div>`;
  }

  function renderSegments() {
    const tags = state.blocks?.tags || [];
    const sentences = state.blocks?.sentences || [];
    el.tagChips.innerHTML = (tags.length
      ? tags.map((block, i) => chipHtml(block, i + 1, false)).join('')
      : '<span class="blk-empty">NO TAGS / 无词条</span>') + blockAddHtml('source', 'tag');
    el.sentenceBlocks.innerHTML = (sentences.length
      ? sentences.map((block, i) => sentenceHtml(block, i + 1, false)).join('')
      : '<span class="blk-empty">NO DESCRIPTION / 无描述</span>') + blockAddHtml('source', 'sentence');
    el.tagCountB.textContent = String(tags.length);
    el.sentCountB.textContent = String(sentences.length);
    /* 高频重渲染容器：只写 --m-i，不重播进场，避免每次编辑整屏闪烁 */
    mStagger(el.tagChips, { play: false });
    mStagger(el.sentenceBlocks, { play: false });
    syncSelectedBlockClass();
    syncGlossaryPickClass();
  }

  function renderTarget() {
    const tags = state.blocks?.tags || [];
    const sentences = state.blocks?.sentences || [];
    el.tagChipsZh.innerHTML = (tags.length
      ? tags.map((block, i) => chipHtml(block, i + 1, true)).join('')
      : '<span class="blk-empty">NO TAGS / 无词条</span>') + blockAddHtml('target', 'tag');
    el.sentenceBlocksZh.innerHTML = (sentences.length
      ? sentences.map((block, i) => sentenceHtml(block, i + 1, true)).join('')
      : '<span class="blk-empty">NO DESCRIPTION / 无描述</span>') + blockAddHtml('target', 'sentence');
    el.tagCountC.textContent = `${tags.filter((t) => state.translations[t.id]).length}/${tags.length}`;
    el.sentCountC.textContent = `${sentences.filter((s) => state.translations[s.id]).length}/${sentences.length}`;
    const all = allBlocks();
    const done = all.filter((block) => state.translations[block.id]).length;
    el.targetMeta.textContent = `${done} / ${all.length} BLOCKS`;
    el.engineUsed.textContent = state.lastEngine || '—';
    el.panelC.classList.toggle('is-working', state.phase === 'translating');
    if (state.phase === 'translating' && state.progressText) {
      el.targetStatusText.textContent = state.progressText;
      el.targetStatus.hidden = false;
    } else if (state.phase !== 'translating') {
      el.targetStatus.hidden = true;
    }
    mStagger(el.tagChipsZh, { play: false });
    mStagger(el.sentenceBlocksZh, { play: false });
    syncSelectedBlockClass();
    syncGlossaryPickClass();
  }

  function setProgress(text) {
    state.progressText = text;
    el.targetStatusText.textContent = text;
    el.targetStatus.hidden = false;
  }

  function updateMeta() {
    el.sourceMeta.textContent = `${(state.text || '').length} CHARS`;
    const tags = state.blocks?.tags || [];
    const sentences = state.blocks?.sentences || [];
    el.segmentMeta.textContent = `TAGS ${tags.length} · SENT ${sentences.length}`;
    updateMeter();
  }

  function updateMeter() {
    if (!el.charMeter || !el.composerInput) return;
    const length = Math.min(el.composerInput.value.length, 4000);
    el.charMeter.textContent = String(length).padStart(4, '0');
  }

  function updateDirty() {
    const dirty = state.phase === 'done' && el.sourceText.value.trim() !== state.translatedText.trim();
    el.dirtyFlag.hidden = !dirty;
  }

  function setPhaseUI() {
    const translating = state.phase === 'translating';
    el.viewTranslate.classList.toggle('is-translating', translating);
    el.viewTranslate.classList.toggle('has-results', state.phase !== 'idle' && !!state.blocks);
    el.translateBtn.disabled = translating;
    el.translateBtn.classList.toggle('is-busy', translating);
    el.retranslateBtn.disabled = translating;
    updateEngineChip();
    updateFavoriteSaveButton();
    renderSessionBar();
  }

  function showAlert(title, message) {
    el.alertTitle.textContent = title || 'TRANSLATION FAILED';
    el.alertMsg.textContent = message || '';
    mShow(el.alert, { enter: 'drop' });
  }

  function hideAlert() {
    mHide(el.alert, { leave: 'drop' });
  }

  /* ----------------------------------------------------------------------- */
  /* hover linking                                                           */
  /* ----------------------------------------------------------------------- */

  function setLinked(bid, on, root = document) {
    if (!bid) return;
    let nodes;
    try {
      nodes = (root || document).querySelectorAll(`[data-bid="${CSS.escape(bid)}"]`);
    } catch {
      return;
    }
    nodes.forEach((node) => node.classList.toggle('is-linked', on));
  }

  function bindHoverLinking() {
    const onEvent = (event) => {
      const block = event.target.closest && event.target.closest('.blk, .sent');
      if (!block) return;
      if (event.relatedTarget && block.contains(event.relatedTarget)) return;
      const scope = block.closest('.record-card') || document;
      setLinked(block.dataset.bid, event.type === 'mouseover' || event.type === 'focusin', scope);
    };
    document.addEventListener('mouseover', onEvent);
    document.addEventListener('mouseout', onEvent);
    document.addEventListener('focusin', onEvent);
    document.addEventListener('focusout', onEvent);
  }

  /* ----------------------------------------------------------------------- */
  /* translation pipeline                                                    */
  /* ----------------------------------------------------------------------- */

  async function startTranslation(rawText) {
    if (state.phase === 'translating') return;
    clearSourceSyncTimer();
    if (state.selectedBlockId) setSelectedBlock(null);
    if (location.protocol === 'file:') { el.bootError.hidden = false; return; }

    const text = String(rawText == null ? '' : rawText).trim();
    if (!text) {
      toast('请先粘贴或输入提示词', 'error');
      el.composerInput.focus();
      return;
    }
    const parsed = parsePrompt(text);
    if (!parsed.tags.length && !parsed.sentences.length) {
      toast('没有解析出可翻译的文本', 'error');
      return;
    }

    flushTextBurst();
    pushHistory();
    state.docVersion += 1;
    hideAlert();
    state.text = text;
    state.translatedText = text;
    state.blocks = parsed;
    state.translations = {};
    state.pendingIds = new Set();
    state.syncingIds = new Set();
    /* 重新解析词块后旧 bid 可能被复用，先退出添加入词库状态，避免勾选串到别的词块 */
    exitGlossaryPick({ silent: true });
    closeGlossaryAddDialog();
    state.phase = 'translating';
    state.progressText = 'LINKING ENGINE…';
    state.lastEngine = '';
    state.warnings = [];
    state.error = null;

    translateAbortController?.abort();
    const runId = ++translateRunId;
    const controller = new AbortController();
    translateAbortController = controller;

    el.sourceText.value = text;
    el.panels.hidden = false;
    el.viewTranslate.classList.add('has-results');
    el.sourceText.scrollTop = 0;
    el.segmentsBody.scrollTop = 0;
    el.targetBody.scrollTop = 0;
    if (document.activeElement === el.composerInput || document.activeElement === el.sourceText) {
      document.activeElement.blur();
    }

    renderSegments();
    renderTarget();
    updateMeta();
    updateDirty();
    setPhaseUI();

    await loadGlossary();
    if (runId !== translateRunId || controller.signal.aborted) return;
    const glossaryOn = state.config?.options?.useGlossary !== false;
    if (glossaryOn) {
      for (const block of parsed.tags) {
        const hit = lookupGlossary(block.text);
        if (hit) state.translations[block.id] = { text: hit, from: 'glossary' };
      }
    }

    const pending = allBlocks().filter((block) => !state.translations[block.id]);
    renderTarget();

    if (!pending.length) {
      if (runId !== translateRunId || controller.signal.aborted) return;
      if (translateAbortController === controller) translateAbortController = null;
      finishTranslation('GLOSSARY · 词条库');
      return;
    }

    try {
      const map = await translatePending(pending, 'en2zh', controller.signal);
      if (runId !== translateRunId || controller.signal.aborted) return;
      Object.assign(state.translations, map);
      finishTranslation();
    } catch (err) {
      if (runId !== translateRunId || controller.signal.aborted || err?.name === 'AbortError') return;
      state.phase = 'error';
      state.error = err;
      state.lastEngine = '';
      state.progressText = '';
      renderTarget();
      updateDirty();
      setPhaseUI();
      commitHistory();
      const title = err.title || '翻译失败';
      const message = [prettyError(err), err.hint].filter(Boolean).join(' ');
      showAlert(title, message);
      toast(title, 'error', 5000);
    } finally {
      if (translateAbortController === controller) translateAbortController = null;
    }
  }

  async function translatePending(blocks, direction = 'en2zh', signal = null) {
    const engine = state.config?.engine || 'auto';

    if (engine === 'chrome') return translateWithChrome(blocks, direction);
    if (engine === 'glossary') {
      if (direction === 'zh2en') {
        throw new UiError('词条库不支持反向翻译', '在引擎舱切换到 Ollama / LM Studio / Chrome 后，才能把中文改动同步回英文。');
      }
      throw new UiError('当前引擎为词条库', '词条库只翻译内置 tags，句块需要真实翻译引擎。请在引擎舱切换到 Chrome 内置或本地模型。');
    }

    // fast path: auto + no server engine -> use Chrome directly, while the
    // click still counts as a user gesture (the model download needs one)
    if (engine === 'auto' && state.health && !state.health.resolved) {
      const availability = await detectChrome();
      if (availability === 'available' || availability === 'downloadable' || availability === 'downloading') {
        return translateWithChrome(blocks, direction);
      }
    }

    let response;
    try {
      response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine,
          direction,
          blocks: blocks.map((block) => ({ id: block.id, text: block.text, type: block.kind })),
        }),
        signal: signal || undefined,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new UiError('本地服务无响应', '请确认 S.P.E.C. 7 服务仍然运行（启动SPEC.bat），然后重试。');
    }

    let data = null;
    try { data = await response.json(); } catch { data = null; }

    if (!response.ok) {
      const code = data?.error?.code;
      if (engine === 'auto' && code === 'NO_ENGINE') {
        const availability = await detectChrome();
        if (availability && availability !== 'unsupported' && availability !== 'unavailable') {
          return translateWithChrome(blocks, direction);
        }
        throw new UiError('没有可用的翻译引擎',
          '在引擎舱启用 Chrome 内置翻译，或连接 Ollama / LM Studio / LibreTranslate 后重试。');
      }
      const error = data?.error;
      throw new UiError(error?.message || '翻译请求失败', error?.hint || '');
    }

    state.lastEngine = [String(data.engine || '').toUpperCase(), data.model].filter(Boolean).join(' · ');
    if (Array.isArray(data.warnings) && data.warnings.length) state.warnings.push(...data.warnings);

    const map = {};
    for (const item of data.results || []) {
      if (item && item.id && item.text) map[item.id] = { text: item.text, from: 'engine' };
    }
    return map;
  }

  async function getChromeTranslator(direction, onProgress) {
    const sourceLanguage = direction === 'zh2en' ? 'zh' : 'en';
    const targetLanguage = direction === 'zh2en' ? 'en' : 'zh';
    const key = `${sourceLanguage}>${targetLanguage}`;
    if (state.chromeTranslators[key]) return state.chromeTranslators[key];
    if (!('Translator' in self)) {
      throw new UiError('无法使用 Chrome 内置翻译',
        '当前浏览器不支持 Translator API。请使用 Chrome 138 或更新版本，或在引擎舱配置 Ollama / LM Studio。');
    }
    let availability;
    try {
      availability = await Translator.availability({ sourceLanguage, targetLanguage });
    } catch {
      availability = 'unavailable';
    }
    if (direction === 'en2zh') {
      state.chromeAvailability = availability;
      updateEngineChip();
    }

    if (availability === 'unavailable') {
      throw new UiError('Chrome 内置翻译不可用',
        direction === 'zh2en'
          ? '浏览器没有可用的中译英模型。请确认联网后重试，或在引擎舱配置其他引擎。'
          : '浏览器没有可用的英译中模型。请确认联网后重试，或在引擎舱配置其他引擎。');
    }
    try {
      state.chromeTranslators[key] = await Translator.create({
        sourceLanguage,
        targetLanguage,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            try { if (onProgress) onProgress(event.loaded); } catch { /* ignore */ }
          });
        },
      });
    } catch (err) {
      // Browser exceptions can contain private request or environment details.
      throw new UiError('Chrome 内置翻译启动失败',
        '首次使用需要联网下载语言模型。请再点一次「重新翻译」以授权下载；若仍失败，请在引擎舱切换其他引擎。');
    }
    if (direction === 'en2zh') {
      state.chromeAvailability = 'available';
      updateEngineChip();
    }
    return state.chromeTranslators[key];
  }

  async function translateWithChrome(blocks, direction = 'en2zh') {
    let lastTick = Date.now();
    const stallTimer = setInterval(() => {
      if (state.phase !== 'translating') return;
      if (Date.now() - lastTick > 15000) {
        setProgress('CHROME · 首次下载语言模型，可能需要几分钟…');
      }
    }, 5000);
    try {
      const translator = await getChromeTranslator(direction, (loaded) => {
        lastTick = Date.now();
        const percent = Math.round(Math.max(0, Math.min(1, Number(loaded) || 0)) * 100);
        setProgress(`CHROME MODEL DOWNLOAD · ${percent}%`);
      });
      state.lastEngine = direction === 'zh2en' ? 'CHROME · ZH→EN' : 'CHROME · ON-DEVICE';
      const map = {};
      let finished = 0;
      for (const block of blocks) {
        lastTick = Date.now();
        setProgress(`CHROME · ${finished + 1} / ${blocks.length}`);
        try {
          const output = await translator.translate(block.text);
          if (output && output.trim()) map[block.id] = { text: output.trim(), from: 'chrome' };
        } catch {
          /* leave this block missing; the footer will report it */
        }
        finished += 1;
        if (direction === 'en2zh' && (finished % 2 === 0 || finished === blocks.length)) {
          Object.assign(state.translations, map);
          renderTarget();
        }
      }
      return map;
    } finally {
      clearInterval(stallTimer);
    }
  }

  function finishTranslation(label) {
    state.phase = 'done';
    if (label) state.lastEngine = label;
    state.progressText = '';
    el.targetStatus.hidden = true;
    const missing = allBlocks().filter((block) => !state.translations[block.id]);
    renderTarget();
    updateMeta();
    updateDirty();
    setPhaseUI();
    commitHistory();
    maybeSaveHistory();

    const notes = [];
    if (state.warnings.length) notes.push(state.warnings.join(' '));
    if (missing.length) notes.push(`有 ${missing.length} 个词块未翻译`);
    if (notes.length) toast(notes.join(' · '), 'error', 5400);
    else toast(`翻译完成 · ${state.lastEngine || 'AUTO'}`, 'info', 2100);
  }

  /* ----------------------------------------------------------------------- */
  /* editor / composer actions                                               */
  /* ----------------------------------------------------------------------- */

  function updateSourceFromEditor() {
    state.text = el.sourceText.value;
    if (state.blocks && state.phase === 'done') updateDirty();
  }

  function clearSourceSyncTimer() {
    if (sourceSyncTimer) {
      clearTimeout(sourceSyncTimer);
      sourceSyncTimer = null;
    }
  }

  function scheduleSourceSync(delay = SOURCE_SYNC_DELAY) {
    clearSourceSyncTimer();
    if (state.phase !== 'done' || !state.blocks) return;
    if (state.view !== 'translate' || state.recordMode) return;
    if (sessionBusy()) return;
    sourceSyncTimer = setTimeout(() => {
      sourceSyncTimer = null;
      syncSourceEdits();
    }, delay);
  }

  function nextSourceBlockId(prefix, oldBlocks, translations) {
    let id;
    do {
      sourceSyncSeq += 1;
      id = `${prefix}n${Date.now().toString(36)}${sourceSyncSeq}`;
    } while (oldBlocks.some((block) => block.id === id) || translations[id]);
    return id;
  }

  function remapSyncedBlocks(parsed) {
    const old = state.blocks || { tags: [], sentences: [] };
    const oldTranslations = state.translations || {};
    const used = new Set();
    const allOld = [...old.tags, ...old.sentences];
    const pick = (block, pool, prefix) => {
      const text = String(block.text || '').trim();
      const match = pool.find((item) => !used.has(item.id) && String(item.text || '').trim() === text);
      let id;
      if (match) {
        id = match.id;
        used.add(id);
      } else {
        id = nextSourceBlockId(prefix, allOld, oldTranslations);
      }
      return { ...block, id, text };
    };
    const tags = parsed.tags.map((block) => pick(block, old.tags, 't'));
    const sentences = parsed.sentences.map((block) => pick(block, old.sentences, 's'));
    const translations = {};
    [...tags, ...sentences].forEach((block) => {
      if (oldTranslations[block.id]) translations[block.id] = oldTranslations[block.id];
    });
    return { blocks: { tags, sentences }, translations };
  }

  async function syncSourceEdits() {
    if (sourceSyncRunning) return;
    if (state.phase !== 'done' || !state.blocks) return;
    if (state.view !== 'translate' || state.recordMode) return;
    const text = el.sourceText.value;
    if (text.trim() === String(state.translatedText || '').trim()) return;
    const runId = translateRunId;
    clearSourceSyncTimer();
    sourceSyncRunning = true;
    const parsed = parsePrompt(text);
    flushTextBurst();
    pushHistory();
    state.docVersion += 1;
    state.text = text;
    state.translatedText = text;
    exitGlossaryPick({ silent: true });
    closeGlossaryAddDialog();
    state.phase = 'translating';
    state.progressText = 'SYNCING SOURCE…';
    state.error = null;
    hideAlert();
    el.composerInput.value = text;
    if (!parsed.tags.length && !parsed.sentences.length) {
      state.blocks = { tags: [], sentences: [] };
      state.translations = {};
      state.phase = 'done';
      state.progressText = '';
      renderSegments();
      renderTarget();
      updateMeta();
      updateDirty();
      setPhaseUI();
      commitHistory();
      sourceSyncRunning = false;
      toast('原文已清空，词块与译文已同步', 'info', 2200);
      return;
    }
    const remapped = remapSyncedBlocks(parsed);
    state.blocks = remapped.blocks;
    state.translations = remapped.translations;
    renderSegments();
    renderTarget();
    updateMeta();
    updateDirty();
    setPhaseUI();
    let pendingCount = 0;
    try {
      await loadGlossary();
      const glossaryOn = state.config?.options?.useGlossary !== false;
      if (glossaryOn) {
        for (const block of state.blocks.tags) {
          if (state.translations[block.id]) continue;
          const hit = lookupGlossary(block.text);
          if (hit) state.translations[block.id] = { text: hit, from: 'glossary' };
        }
      }
      const pending = allBlocks().filter((block) => !state.translations[block.id]);
      pendingCount = pending.length;
      renderTarget();
      if (pending.length) {
        const map = await translatePending(pending);
        if (runId !== translateRunId) return;
        Object.assign(state.translations, map);
      }
      state.phase = 'done';
      state.progressText = '';
      toast(pendingCount
        ? `已同步并翻译 ${pendingCount} 个新词块`
        : '词块与译文已同步', 'info', 2200);
    } catch (err) {
      if (runId !== translateRunId) return;
      state.phase = 'done';
      state.progressText = '';
      toast('同步翻译失败：' + prettyError(err), 'error', 4200);
    } finally {
      sourceSyncRunning = false;
      if (runId !== translateRunId) return;
      state.translatedText = text;
      renderSegments();
      renderTarget();
      updateMeta();
      updateDirty();
      setPhaseUI();
      commitHistory();
      if (el.sourceText.value.trim() !== String(state.translatedText || '').trim()
        && state.phase === 'done') {
        scheduleSourceSync();
      }
    }
  }

  function backToInput() {
    if (state.phase === 'translating') { toast('正在翻译，请稍候'); return; }
    clearSourceSyncTimer();
    flushTextBurst();
    pushHistory();
    state.docVersion += 1;
    state.phase = 'idle';
    state.blocks = null;
    state.translations = {};
    state.pendingIds = new Set();
    state.syncingIds = new Set();
    state.progressText = '';
    state.lastEngine = '';
    hideAlert();
    el.panels.hidden = true;
    el.targetStatus.hidden = true;
    el.viewTranslate.classList.remove('has-results');
    el.composerInput.value = state.text || '';
    el.composerInput.scrollTop = 0;
    updateMeter();
    setPhaseUI();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    commitHistory();
  }

  function findBlock(bid) {
    if (!state.blocks) return null;
    return [...state.blocks.tags, ...state.blocks.sentences].find((block) => block.id === bid) || null;
  }

  function normalizeReversedTag(text) {
    return String(text || '')
      .trim()
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .replace(/[，,;；、]+/g, ' ')
      .replace(/[.。!?！？]+$/, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/^(a|an|the)\s+/i, '')
      .trim();
  }

  function rebuildSourceText() {
    clearSourceSyncTimer();
    const tagText = (state.blocks?.tags || []).map((block) => block.text.trim()).filter(Boolean).join(', ');
    const sentenceText = (state.blocks?.sentences || []).map((block) => block.text.trim()).filter(Boolean).join(' ');
    const text = [tagText, sentenceText].filter(Boolean).join('\n\n');
    state.text = text;
    state.translatedText = text;
    el.sourceText.value = text;
    el.composerInput.value = text;
    updateMeta();
    updateDirty();
    return text;
  }

  async function translateSingleBlock(block, direction = 'en2zh') {
    const glossaryOn = state.config?.options?.useGlossary !== false;
    if (direction === 'en2zh' && block.kind === 'tag' && glossaryOn) {
      const hit = lookupGlossary(block.text);
      if (hit) return { text: hit, from: 'glossary' };
    }
    const map = await translatePending([block], direction);
    const result = map[block.id];
    if (!result || !result.text) {
      throw new UiError('重新翻译失败', '引擎没有返回结果，请检查引擎舱后重试。');
    }
    return result;
  }

  /* ----------------------------------------------------------------------- */
  /* 词块选中：单击选中，Backspace / Delete 删除                               */
  /* ----------------------------------------------------------------------- */

  /* 只认 B/C 两个面板里的块；历史卡片的预览也是 .blk，不能一起高亮 */
  function blockNodesById(bid) {
    if (!bid) return [];
    const sel = `.blk[data-bid="${CSS.escape(bid)}"], .sent[data-bid="${CSS.escape(bid)}"]`;
    return [...document.querySelectorAll(sel)]
      .filter((node) => node.closest('#segmentsBody, #targetBody'));
  }

  function syncSelectedBlockClass() {
    document.querySelectorAll('#segmentsBody .is-selected, #targetBody .is-selected')
      .forEach((node) => node.classList.remove('is-selected'));
    /* 源/译文两侧同属一个块：一起高亮，直接切类避免整屏重渲染 */
    blockNodesById(state.selectedBlockId).forEach((node) => node.classList.add('is-selected'));
  }

  function setSelectedBlock(bid) {
    const next = bid || null;
    if (state.selectedBlockId === next) return;
    state.selectedBlockId = next;
    syncSelectedBlockClass();
  }

  /* 焦点落在词块本身（tabindex=0）时也算选中；焦点在输入控件内则不算 */
  function focusedBlockId() {
    const active = document.activeElement;
    if (!active || active === document.body) return null;
    if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) return null;
    const node = active.closest && active.closest('.blk, .sent');
    return node ? node.dataset.bid : null;
  }

  function selectedBlockIdForDelete() {
    const bid = focusedBlockId() || state.selectedBlockId;
    if (!bid || !findBlock(bid)) return null;
    return bid;
  }

  /* 删除选中块，并把选中交给相邻块，便于连续删除 */
  function deleteSelectedBlock(bid) {
    if (!findBlock(bid)) return;
    const inTags = (state.blocks?.tags || []).some((item) => item.id === bid);
    const list = inTags ? state.blocks.tags : (state.blocks?.sentences || []);
    const index = list.findIndex((item) => item.id === bid);
    const neighbor = index > 0 ? list[index - 1] : (list[index + 1] || null);
    setSelectedBlock(null);
    deleteBlock(bid);
    if (neighbor && findBlock(neighbor.id)) {
      setSelectedBlock(neighbor.id);
      const node = blockNodesById(neighbor.id)[0];
      if (node) node.focus();
    }
  }

  function deleteBlock(bid) {
    if (!state.blocks) return;
    const block = findBlock(bid);
    if (!block) return;
    if (state.selectedBlockId === bid) state.selectedBlockId = null;
    state.docVersion += 1;
    state.editing = null;
    flushTextBurst();
    pushHistory();
    state.blocks = {
      tags: state.blocks.tags.filter((item) => item.id !== bid),
      sentences: state.blocks.sentences.filter((item) => item.id !== bid),
    };
    delete state.translations[bid];
    state.pendingIds.delete(bid);
    state.syncingIds.delete(bid);

    if (!state.blocks.tags.length && !state.blocks.sentences.length) {
      state.phase = 'idle';
      state.blocks = null;
      state.translations = {};
      state.pendingIds = new Set();
      state.syncingIds = new Set();
      state.text = '';
      state.translatedText = '';
      state.lastEngine = '';
      state.progressText = '';
      state.error = null;
      hideAlert();
      el.panels.hidden = true;
      el.targetStatus.hidden = true;
      el.sourceText.value = '';
      el.composerInput.value = '';
      el.viewTranslate.classList.remove('has-results');
      updateMeter();
      updateMeta();
      setPhaseUI();
      commitHistory();
      el.composerInput.focus();
      toast('已删除最后一块', 'info', 1600);
      return;
    }

    renderSegments();
    renderTarget();
    rebuildSourceText();
    setPhaseUI();
    commitHistory();
    toast('已删除该块', 'info', 1400);
  }

  function startInlineEdit(blockEl) {
    if (!state.blocks || state.phase !== 'done') return;
    hideTagSuggest();
    setSelectedBlock(null);
    if (state.editing) {
      if (state.editing.isNew) removeNewBlock(state.editing);
      else cancelInlineEdit();
    }
    const bid = blockEl.dataset.bid;
    const block = findBlock(bid);
    if (!block) return;
    const side = blockEl.closest('.panel-c') ? 'target' : 'source';
    if (side === 'target' && !state.translations[bid]) return;
    const textEl = blockEl.querySelector('.txt');
    const textHeight = textEl?.getBoundingClientRect().height || 0;
    state.editing = {
      bid,
      side,
      height: block.kind === 'sentence' && textHeight ? Math.max(48, Math.ceil(textHeight + 14)) : null,
    };
    renderSegments();
    renderTarget();
    focusInlineEdit();
  }

  function focusInlineEdit() {
    const input = document.querySelector('.inline-edit');
    if (!input) return;
    input.focus();
    input.select();
    input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function cancelInlineEdit() {
    if (!state.editing) return;
    hideTagSuggest();
    if (state.editing.isNew) {
      removeNewBlock(state.editing);
      return;
    }
    state.editing = null;
    renderSegments();
    renderTarget();
  }

  function removeBlockById(bid, kind) {
    const key = kind === 'tag' ? 'tags' : 'sentences';
    const array = state.blocks?.[key];
    if (!array) return;
    const index = array.findIndex((block) => block.id === bid);
    if (index >= 0) array.splice(index, 1);
  }

  function removeNewBlock(editing) {
    hideTagSuggest();
    removeBlockById(editing.bid, editing.kind);
    delete state.translations[editing.bid];
    state.pendingIds.delete(editing.bid);
    state.syncingIds.delete(editing.bid);
    state.editing = null;
    renderSegments();
    renderTarget();
    updateMeta();
    setPhaseUI();
  }

  function nextBlockId(kind) {
    const prefix = kind === 'tag' ? 't' : 's';
    const array = kind === 'tag' ? state.blocks.tags : state.blocks.sentences;
    let maximum = 0;
    for (const block of array) {
      const match = String(block.id).match(/\d+/);
      if (match) maximum = Math.max(maximum, parseInt(match[0], 10));
    }
    return prefix + (maximum + 1);
  }

  function addNewBlock(side, kind) {
    if (!state.blocks || state.phase === 'translating') return;
    if (state.editing) {
      if (state.editing.isNew) removeNewBlock(state.editing);
      else cancelInlineEdit();
    }
    const array = kind === 'tag' ? state.blocks.tags : state.blocks.sentences;
    const block = { id: nextBlockId(kind), kind, text: '' };
    array.push(block);
    state.editing = { bid: block.id, side, isNew: true, kind };
    renderSegments();
    renderTarget();
    focusInlineEdit();
  }

  function clearDropTargets() {
    document.querySelectorAll('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
    document.querySelectorAll('.is-dragging').forEach((node) => node.classList.remove('is-dragging'));
  }

  function reorderBlock(sourceId, targetId, before) {
    if (!state.blocks || sourceId === targetId) return;
    const source = findBlock(sourceId);
    const target = findBlock(targetId);
    if (!source || !target || source.kind !== target.kind) return;
    const key = source.kind === 'tag' ? 'tags' : 'sentences';
    const array = state.blocks[key];
    const from = array.findIndex((block) => block.id === sourceId);
    if (from < 0) return;
    const next = array.slice();
    const [item] = next.splice(from, 1);
    let insertAt = next.findIndex((block) => block.id === targetId);
    if (insertAt < 0) return;
    if (!before) insertAt += 1;
    next.splice(insertAt, 0, item);
    if (next.every((block, index) => block.id === array[index].id)) return;
    pushHistory();
    state.blocks[key] = next;
    renderSegments();
    renderTarget();
    rebuildSourceText();
    commitHistory();
  }

  function commitInlineEdit() {
    const editing = state.editing;
    if (!editing) return;
    hideTagSuggest();
    const input = document.querySelector('.inline-edit');
    if (!input) return;
    const value = input.value.trim();
    if (!value) {
      state.editing = null;
      if (editing.isNew) {
        removeNewBlock(editing);
      } else {
        toast('内容不能为空', 'error', 1800);
      }
      return;
    }
    state.editing = null;
    if (editing.side === 'target') {
      commitTargetEdit(editing.bid, value, { isNew: !!editing.isNew });
      return;
    }
    commitSourceEdit(editing.bid, value);
  }

  async function commitTargetEdit(bid, value, { isNew = false } = {}) {
    const block = findBlock(bid);
    if (!block) return;
    const glossaryHit = block.kind === 'tag' ? lookupGlossaryReverse(value) : null;
    if (glossaryHit) {
      if (!isNew && state.translations[bid]?.text === glossaryHit.zh && block.text === glossaryHit.en) {
        renderSegments();
        renderTarget();
        return;
      }
      flushTextBurst();
      pushHistory();
      state.docVersion += 1;
      state.translations[bid] = { text: glossaryHit.zh, from: 'glossary' };
      block.text = glossaryHit.en;
      state.syncingIds.delete(bid);
      rebuildSourceText();
      renderSegments();
      renderTarget();
      commitHistory();
      toast(`词条库命中：${glossaryHit.en} · ${glossaryHit.zh}`, 'info', 2200);
      return;
    }
    const current = state.translations[bid]?.text || '';
    if (!isNew && current === value) {
      renderTarget();
      return;
    }
    flushTextBurst();
    pushHistory();
    const version = ++state.docVersion;
    state.translations[bid] = { text: value, from: 'manual' };
    state.syncingIds.add(bid);
    renderSegments();
    renderTarget();
    try {
      const result = await translateSingleBlock({ ...block, text: value }, 'zh2en');
      if (version !== state.docVersion) return;
      if (!/[A-Za-z]/.test(result.text)) {
        throw new UiError('反向翻译失败', '模型没有返回英文内容，请重试或切换引擎。');
      }
      block.text = block.kind === 'tag' ? normalizeReversedTag(result.text) : result.text.trim();
      state.syncingIds.delete(bid);
      rebuildSourceText();
      renderSegments();
      renderTarget();
      commitHistory();
      toast('中文已保存，英文原文已同步', 'info', 2000);
    } catch (err) {
      if (version !== state.docVersion) return;
      state.syncingIds.delete(bid);
      if (isNew) {
        removeNewBlock({ bid, kind: block.kind, isNew: true });
        commitHistory();
        toast('反向翻译失败，已移除新增块：' + prettyError(err), 'error', 4600);
        return;
      }
      renderSegments();
      renderTarget();
      commitHistory();
      toast('中文已保存，但英文同步失败：' + prettyError(err), 'error', 4600);
    }
  }

  async function commitSourceEdit(bid, value) {
    const block = findBlock(bid);
    if (!block) return;
    if (block.text === value) {
      renderSegments();
      renderTarget();
      return;
    }
    flushTextBurst();
    pushHistory();
    const version = ++state.docVersion;
    const previous = state.translations[bid];
    block.text = value;
    delete state.translations[bid];
    state.pendingIds.add(bid);
    rebuildSourceText();
    renderSegments();
    renderTarget();
    try {
      const result = await translateSingleBlock(block);
      if (version !== state.docVersion) return;
      state.translations[bid] = result;
      state.pendingIds.delete(bid);
      renderSegments();
      renderTarget();
      commitHistory();
      toast('已重新翻译该块', 'info', 1500);
    } catch (err) {
      if (version !== state.docVersion) return;
      state.pendingIds.delete(bid);
      if (previous) state.translations[bid] = previous;
      renderSegments();
      renderTarget();
      commitHistory();
      toast('重新翻译失败：' + prettyError(err), 'error', 4200);
    }
  }

  async function copySourceToClipboard() {
    const text = el.sourceText.value || '';
    if (!text.trim()) {
      toast('原文为空，没有可复制的内容', 'info', 1800);
      return;
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      toast('原文已复制到剪贴板', 'info', 1800);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      helper.remove();
      copied = ok;
      if (ok) toast('原文已复制到剪贴板', 'info', 1800);
      else toast('复制失败，请手动选择原文复制', 'error', 3600);
    }
    if (!copied) return;

    const result = await unloadTranslationModel();
    if (result.unloaded) {
      toast('翻译模型已卸载 · 显存已释放', 'info', 2600);
    } else if (result.busy) {
      toast('原文已复制 · 翻译进行中，暂不卸载模型', 'info', 3000);
    } else if (result.error) {
      toast('原文已复制，但卸载模型失败：' + result.error, 'error', 4200);
    }
  }

  function forceStopTranslation() {
    const busy = state.phase === 'translating' || state.pendingIds.size || state.syncingIds.size;
    if (!busy) return false;
    translateRunId += 1;
    translateAbortController?.abort();
    translateAbortController = null;
    clearSourceSyncTimer();
    sourceSyncRunning = false;
    state.pendingIds = new Set();
    state.syncingIds = new Set();
    state.docVersion += 1;
    state.phase = 'done';
    state.progressText = '';
    state.error = null;
    hideAlert();
    renderSegments();
    renderTarget();
    updateMeta();
    updateDirty();
    setPhaseUI();
    commitHistory();
    return true;
  }

  async function manualUnloadModel() {
    if (unloadInFlight || !el.hwUnloadBtn) return;
    const wasBusy = state.phase === 'translating' || state.pendingIds.size > 0 || state.syncingIds.size > 0;
    el.hwUnloadBtn.disabled = true;
    el.hwUnloadBtn.textContent = '卸载中…';
    try {
      if (wasBusy) {
        forceStopTranslation();
        toast('翻译已强制终止，正在卸载模型…', 'info', 2800);
      }
      const result = await unloadTranslationModel({ force: wasBusy });
      if (result.unloaded) {
        toast(wasBusy ? '翻译已终止 · 模型已卸载' : '模型已卸载 · 显存已释放', 'info', 2800);
        refreshHealth();
        setTimeout(updateHardware, 900);
        setTimeout(updateHardware, 2200);
      } else if (result.busy) {
        toast('翻译进行中，暂不卸载模型', 'info', 2600);
      } else if (result.skipped) {
        if (wasBusy) {
          toast(result.reason === 'not-ollama'
            ? '翻译已强制终止；当前引擎不是 Ollama，无法卸载模型'
            : '翻译已强制终止；没有找到可卸载的 Ollama 模型', 'info', 3400);
        } else {
          toast(result.reason === 'not-ollama'
            ? '当前引擎不是 Ollama，无法卸载模型'
            : '没有正在使用的 Ollama 模型', 'info', 2800);
        }
      } else if (result.error) {
        toast((wasBusy ? '翻译已终止，但卸载模型失败：' : '卸载模型失败：') + result.error, 'error', 4200);
      }
    } finally {
      el.hwUnloadBtn.disabled = false;
      el.hwUnloadBtn.textContent = '卸载模型';
    }
  }

  async function unloadTranslationModel({ force = false } = {}) {
    const configured = state.config?.engine || 'auto';
    const engine = configured === 'auto' ? (state.health?.resolved || '') : configured;
    if (engine !== 'ollama') return { skipped: true, reason: 'not-ollama' };
    if (!force && (state.phase === 'translating' || state.pendingIds.size || state.syncingIds.size)) {
      return { busy: true };
    }
    const model = (state.health?.resolved === 'ollama' ? state.health.resolvedModel : '')
      || state.config?.ollama?.model
      || '';
    if (!model) return { skipped: true, reason: 'no-model' };
    if (unloadInFlight) return { busy: true };
    unloadInFlight = true;
    try {
      const res = await fetch('/api/unload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'ollama', model, force }),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) throw new Error(data?.error?.message || '卸载请求失败');
      return { unloaded: !!data?.unloaded, model: data?.model || model, forced: !!data?.forced };
    } catch (err) {
      return { error: prettyError(err) };
    } finally {
      unloadInFlight = false;
    }
  }

  function insertIntoComposer(text) {
    flushTextBurst();
    const before = snapshotState();
    const input = el.composerInput;
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const cursor = start + text.length;
    input.setSelectionRange(cursor, cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (history.textBurst) {
      clearTimeout(history.textBurst.timer);
      history.textBurst = null;
    }
    pushHistory(before);
    commitHistory();
    history.programmaticUndo = true;
    history.programmaticTarget = 'composer';
    input.focus();
  }

  function clearComposerInput() {
    const value = el.composerInput.value || '';
    if (!value) {
      toast('输入内容已经是空的', 'info', 1600);
      el.composerInput.focus();
      return;
    }
    const selectionStart = el.composerInput.selectionStart;
    const selectionEnd = el.composerInput.selectionEnd;
    const scrollTop = el.composerInput.scrollTop;
    flushTextBurst();
    pushHistory();
    el.composerInput.value = '';
    el.composerInput.scrollTop = 0;
    state.text = '';
    state.translatedText = '';
    updateMeter();
    scheduleDraftSave();
    commitHistory();
    renderSessionBar();
    el.composerInput.focus();
    pushActionUndo('清空输入', () => {
      el.composerInput.value = value;
      state.text = value;
      state.translatedText = value;
      updateMeter();
      scheduleDraftSave();
      commitHistory();
      renderSessionBar();
      el.composerInput.focus();
      el.composerInput.scrollTop = scrollTop;
      el.composerInput.setSelectionRange(selectionStart, selectionEnd);
    }, 'clear');
    toast('已清空输入内容', 'info', 1800);
  }

  async function pasteClipboard() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('clipboard unsupported');
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) { toast('剪贴板是空的'); return; }
      insertIntoComposer(text);
      toast('已粘贴剪贴板内容');
    } catch {
      toast('无法读取剪贴板，请点击输入框后按 Ctrl+V 粘贴', 'error', 4600);
      el.composerInput.focus();
    }
  }

  function scheduleDraftSave() {
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(() => {
      try { localStorage.setItem('spec7:draft', state.text || el.composerInput.value); } catch { /* ignore */ }
    }, 260);
  }

  function restoreDraft() {
    try {
      const draft = localStorage.getItem('spec7:draft');
      if (draft) {
        el.composerInput.value = draft;
        state.text = draft;
      }
    } catch { /* ignore */ }
  }

  /* ----------------------------------------------------------------------- */
  /* view switching & help                                                   */
  /* ----------------------------------------------------------------------- */

  const VIEW_ORDER = ['translate', 'card', 'gallery', 'glossary'];

  function setRackIndex(view) {
    const nav = document.querySelector('.rack-nav');
    if (!nav) return;
    const index = Math.max(0, VIEW_ORDER.indexOf(view));
    nav.style.setProperty('--rack-idx', String(index));
    nav.dataset.navIdx = String(index);
  }

  function switchView(view, trigger = null) {
    if (state.recordMode) closeRecordSession();
    if (view !== 'translate') clearSourceSyncTimer();
    if (state.selectedBlockId) setSelectedBlock(null);
    if (state.glossaryAdd.open) closeGlossaryAddDialog();
    if (state.glossaryAdd.picking) exitGlossaryPick({ silent: true });
    const previousView = state.view;
    /* 词条库是窗口化渲染的：切走前先记下滚动位置（display:none 会把 scrollTop 归零） */
    if (previousView === 'glossary' && el.glossaryList && el.glossaryList.clientHeight > 0) {
      state.glossaryScrollTop = el.glossaryList.scrollTop;
    }
    state.view = view;
    setRackIndex(view);
    document.querySelectorAll('.rack-btn').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === view);
    });
    el.viewTranslate.classList.toggle('is-active', view === 'translate');
    el.viewCard.classList.toggle('is-active', view === 'card');
    el.viewGlossary.classList.toggle('is-active', view === 'glossary');
    el.viewGallery.classList.toggle('is-active', view === 'gallery');
    const fromIndex = VIEW_ORDER.indexOf(previousView);
    const toIndex = VIEW_ORDER.indexOf(view);
    const viewEl = view === 'translate' ? el.viewTranslate
      : view === 'card' ? el.viewCard
      : view === 'gallery' ? el.viewGallery
      : view === 'glossary' ? el.viewGlossary
      : null;
    /* .view 的显隐由 .is-active 控制（不是 hidden），所以用 play 而不是 show */
    if (viewEl) mPlay(viewEl, fromIndex >= 0 && toIndex < fromIndex ? 'rise' : 'drop');
    const meta = {
      translate: { code: 'BAY 01', name: 'TRANSLATION', cn: '翻译台' },
      card: { code: 'BAY 02', name: 'CHARACTER CARD', cn: '角色卡' },
      gallery: { code: 'BAY 03', name: 'GALLERY', cn: '画廊' },
      glossary: { code: 'BAY 04', name: 'GLOSSARY', cn: '词条库' },
      history: { code: 'BAY 04', name: 'HISTORY', cn: '历史记录' },
      favorite: { code: 'BAY 05', name: 'FAVORITE', cn: '收藏夹' },
    }[view] || { code: 'BAY 00', name: 'STANDBY', cn: '待机' };
    el.bayCode.textContent = meta.code;
    el.bayName.textContent = meta.name;
    el.bayCn.textContent = meta.cn;
    mFlip(el.bayCode);
    mFlip(el.bayName);
    mFlip(el.bayCn);
    if (trigger) mPress(trigger);
    if (view !== 'card') closeCharacterPicker();
    if (view === 'glossary') openGlossaryView();
    if (view === 'card') openCharacterView();
    if (view === 'gallery') openGalleryView();
    hideHelp();
  }

  const HELP_MANUAL = {
    translate: {
      scope: 'TRANSLATION',
      items: [
        ['输入', 'Tags 用英文逗号分隔；空行后写自然语言描述。'],
        ['翻译', '按 <b>CTRL + ENTER</b> 或点红色箭头；停止输入 5 秒自动同步。'],
        ['编辑', '双击词块编辑，<b>ENTER</b> 保存；拖动排序；悬停序号点 × 删除。'],
        ['会话', '最多 10 个；拖动标签排序，双击重命名。'],
        ['插入', '底部或原文栏「角色卡 / 预设 / 衣柜」点击卡片插入；悬停查看内容。'],
        ['记录', '历史 / 收藏夹可打开、复制、收藏；<b>CTRL + Z</b> 撤回删除和编辑。'],
        ['引擎', '引擎舱切换服务；硬件栏可卸载 Ollama 模型。'],
      ],
    },
    card: {
      scope: 'CHARACTER CARD',
      items: [
        ['画廊', '拖动排序；点击编辑；右上角 × 删除；末尾 ＋ 新建。'],
        ['编辑', '填写名称、出处、固定 tags 和备注，按 SAVE 保存。'],
        ['肖像', '点击上传，或悬停后 <b>CTRL + V</b> 粘贴。'],
        ['拆分', '拖动词块入组；<b>CTRL</b> 多选；双击组名重命名。'],
        ['组合', '分组 ＋ 加入组名；ADD 添加词块；衣柜加入衣物；× 移出。'],
        ['衣柜', '上传示意图，点击卡片内编辑；拖动排序；× 删除；末尾新建。'],
        ['预设', '保存当前组合为预设。'],
      ],
    },
    glossary: {
      scope: 'GLOSSARY',
      items: [
        ['搜索', '按中文或英文过滤。'],
        ['新增', '输入英文和中文，按 <b>ENTER</b> 或 ADD。'],
        ['编辑', '修改单元格后按 SAVE 生效。'],
        ['删除', '点行尾 ×；<b>CTRL + Z</b> 撤回。'],
        ['重载', '<b>RELOAD</b> 放弃未保存修改。'],
      ],
    },
    gallery: {
      scope: 'GALLERY',
      items: [
        ['浏览', '每行一件作品，左侧预览，右侧信息。'],
        ['添加', '点「添加新作品」；上传预览图或 <b>CTRL + V</b> 粘贴。'],
        ['字段', '作品信息均可选；COPY 复制整段字段。'],
        ['编辑', '点 EDIT 修改并保存。'],
        ['排序 / 删除', '拖动 ☰ 排序；× 删除；<b>CTRL + Z</b> 撤回。'],
        ['保存', '<b>SAVE</b> 写入并返回画廊。'],
      ],
    },
    history: {
      scope: 'HISTORY',
      items: [
        ['查看', '最多 25 条，最新在前。'],
        ['打开', '点标题在新会话打开。'],
        ['操作', '☆ 收藏；复制提示词；× 删除。'],
      ],
    },
    favorite: {
      scope: 'FAVORITE',
      items: [
        ['查看', '收藏永久保存。'],
        ['示例图', '点击或 <b>CTRL + V</b> 上传。'],
        ['重命名', '双击标题或点铅笔，<b>ENTER</b> 确认。'],
        ['操作', '打开、复制提示词、× 删除；<b>CTRL + Z</b> 撤回。'],
      ],
    },
  };
  function renderHelpForView() {
    const key = state.recordMode || state.view;
    const data = HELP_MANUAL[key] || HELP_MANUAL.translate;
    el.helpScope.textContent = data.scope;
    el.helpList.innerHTML = data.items
      .map(([label, text]) => `<li><b>${label}</b> ${text}</li>`)
      .join('');
  }

  function toggleHelp() {
    if (el.helpPop.hidden) {
      renderHelpForView();
      el.helpPop.hidden = false;
    } else {
      el.helpPop.hidden = true;
    }
  }

  function hideHelp() {
    el.helpPop.hidden = true;
  }

  function updateImageViewerSize() {
    if (!el.imageViewerSize) return;
    const img = el.imageViewerImg;
    if (!img || !img.naturalWidth) {
      el.imageViewerSize.textContent = '—';
      return;
    }
    el.imageViewerSize.textContent = `${img.naturalWidth} × ${img.naturalHeight} PX`;
  }

  function openImageViewer(src, caption) {
    if (!src || !el.imageViewer) return;
    imageViewerReturnFocus = document.activeElement;
    el.imageViewerCaption.textContent = String(caption || '').trim() || 'PREVIEW';
    el.imageViewerImg.alt = String(caption || '').trim() || '图片预览';
    el.imageViewerImg.src = src;
    el.imageViewerSize.textContent = '—';
    el.imageViewer.hidden = false;
    document.body.classList.add('is-image-viewing');
    if (el.imageViewerImg.complete) updateImageViewerSize();
    el.imageViewerClose.focus({ preventScroll: true });
  }

  function closeImageViewer() {
    if (!el.imageViewer || el.imageViewer.hidden) return;
    el.imageViewer.hidden = true;
    el.imageViewerImg.removeAttribute('src');
    document.body.classList.remove('is-image-viewing');
    const focus = imageViewerReturnFocus;
    imageViewerReturnFocus = null;
    if (focus && focus.isConnected) focus.focus({ preventScroll: true });
  }

  /* ----------------------------------------------------------------------- */
  /* engine bay (settings)                                                   */
  /* ----------------------------------------------------------------------- */

  function getSelectedEngine() {
    const checked = document.querySelector('input[name="engine"]:checked');
    return checked ? checked.value : 'auto';
  }

  function syncCfgOpen() {
    const engine = getSelectedEngine();
    document.querySelectorAll('.cfg').forEach((details) => {
      details.open = details.dataset.cfg === engine;
    });
  }

  function populateSettings() {
    const cfg = state.config || DEFAULT_CONFIG;
    document.querySelectorAll('input[name="engine"]').forEach((input) => {
      input.checked = input.value === (cfg.engine || 'auto');
    });
    el.ollamaUrl.value = cfg.ollama?.baseUrl || '';
    el.ollamaModel.value = cfg.ollama?.model || '';
    el.openaiUrl.value = cfg.openai?.baseUrl || '';
    el.openaiModel.value = cfg.openai?.model || '';
    el.openaiKey.value = '';
    el.openaiKey.placeholder = cfg.openai?.hasApiKey ? '已保存密钥 · 留空保持' : 'sk-… 可留空';
    el.libreUrl.value = cfg.libretranslate?.baseUrl || '';
    el.libreKey.value = '';
    el.libreKey.placeholder = cfg.libretranslate?.hasApiKey ? '已保存密钥 · 留空保持' : '可选';
    el.useGlossary.checked = cfg.options?.useGlossary !== false;
    syncCfgOpen();
  }

  function collectConfig() {
    return {
      engine: getSelectedEngine(),
      ollama: { baseUrl: el.ollamaUrl.value.trim(), model: el.ollamaModel.value.trim() },
      openai: {
        baseUrl: el.openaiUrl.value.trim(),
        model: el.openaiModel.value.trim(),
        apiKey: el.openaiKey.value.trim(),
      },
      libretranslate: { baseUrl: el.libreUrl.value.trim(), apiKey: el.libreKey.value.trim() },
      options: { useGlossary: el.useGlossary.checked },
    };
  }

  async function openSettings() {
    if (location.protocol === 'file:') { el.bootError.hidden = false; return; }
    hideHelp();
    state.settingsOpen = true;
    mShow(el.modalBackdrop, { enter: 'fade' });
    if (!state.config) await loadConfig();
    populateSettings();
    renderHealthReadout();
    refreshHealth();
    detectChrome().then(() => renderHealthReadout());
    fetchModelsFor('ollama', { silent: true });
    el.modalSave.focus();
  }

  function closeSettings() {
    state.settingsOpen = false;
    mHide(el.modalBackdrop, { leave: 'fade' });
  }

  function setModalBusy(busy) {
    el.modalSave.disabled = busy;
    el.testBtn.disabled = busy;
    el.modalSave.textContent = busy ? '保存中…' : '保存 SAVE';
  }

  async function saveSettings({ close = true } = {}) {
    const payload = collectConfig();
    setModalBusy(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res.ok) throw new Error(data?.error?.message || '保存失败');
      state.config = data.config || state.config;
      updateEngineChip();
      toast('配置已保存', 'info', 2000);
      refreshHealth();
      if (close) closeSettings();
      return true;
    } catch (err) {
      toast('保存失败：' + prettyError(err), 'error', 4600);
      return false;
    } finally {
      setModalBusy(false);
    }
  }

  async function testConnection() {
    el.testBtn.disabled = true;
    try {
      const res = await fetch('/api/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: collectConfig(), fresh: true }),
      });
      let health = null;
      try { health = await res.json(); } catch { health = null; }
      if (!res.ok || !health) throw new Error(health?.error?.message || '测试失败');
      await detectChrome();
      renderHealthReadout(health);
      toast('连接测试完成（未保存配置）', 'info', 2400);
      el.testBtn.textContent = '测试完成 ✓';
      setTimeout(() => { el.testBtn.textContent = '测试连接 TEST'; }, 1800);
    } catch (err) {
      toast('连接测试失败：' + prettyError(err), 'error', 4200);
    } finally {
      el.testBtn.disabled = false;
    }
  }

  async function fetchModelsFor(engine, { silent = false } = {}) {
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, config: collectConfig() }),
      });
      const data = await res.json();
      const models = data.models || [];
      const list = engine === 'ollama' ? el.ollamaModelList : el.openaiModelList;
      const hint = engine === 'ollama' ? el.ollamaHint : el.openaiHint;
      list.innerHTML = models.map((model) => `<option value="${esc(model)}"></option>`).join('');
      if (models.length) hint.textContent = `发现 ${models.length} 个模型`;
      else hint.textContent = data.error ? '无法获取模型：' + data.error : '没有发现模型';
      if (!silent) toast(models.length ? `发现 ${models.length} 个模型` : '没有发现模型', models.length ? 'info' : 'error');
    } catch {
      if (!silent) toast('刷新模型失败', 'error');
    }
  }

  /* ----------------------------------------------------------------------- */
  /* boot / events                                                           */
  /* ----------------------------------------------------------------------- */

  function cacheElements() {
    IDS.forEach((id) => { el[id] = document.getElementById(id); });
  }

  function bindEvents() {
    document.querySelectorAll('.rack-btn').forEach((button) => {
      button.addEventListener('click', () => switchView(button.dataset.view, button));
    });
    setRackIndex(state.view);

    el.imageViewerClose.addEventListener('click', closeImageViewer);
    el.imageViewerImg.addEventListener('load', updateImageViewerSize);
    el.imageViewer.addEventListener('click', (event) => {
      if (event.target === el.imageViewer || event.target === el.imageViewerStage) closeImageViewer();
    });
    document.addEventListener('click', (event) => {
      if (event.__ptcPreviewReplay) return;
      const img = event.target.closest?.('img');
      if (!img || img.closest('#imageViewer')) return;
      if (event.detail > 1) {
        if (pendingPreviewImageClick) {
          clearTimeout(pendingPreviewImageClick);
          pendingPreviewImageClick = null;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: 1,
        button: 0,
        buttons: 0,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      };
      if (pendingPreviewImageClick) clearTimeout(pendingPreviewImageClick);
      pendingPreviewImageClick = setTimeout(() => {
        pendingPreviewImageClick = null;
        const replay = new MouseEvent('click', init);
        Object.defineProperty(replay, '__ptcPreviewReplay', { value: true });
        img.dispatchEvent(replay);
      }, 240);
    }, true);
    document.addEventListener('dblclick', (event) => {
      const img = event.target.closest?.('img');
      if (!img || img.closest('#imageViewer')) return;
      if (pendingPreviewImageClick) {
        clearTimeout(pendingPreviewImageClick);
        pendingPreviewImageClick = null;
      }
      event.preventDefault();
      openImageViewer(img.currentSrc || img.src, img.alt);
    });

    el.sessionTabs.addEventListener('click', (event) => {
      const add = event.target.closest('[data-session-add]');
      if (add) {
        event.preventDefault();
        newSession();
        return;
      }
      const close = event.target.closest('[data-close]');
      if (close) {
        event.preventDefault();
        closeSession(close.dataset.close);
        return;
      }
      if (Date.now() < suppressSessionClickUntil) return;
      const switchButton = event.target.closest('[data-switch]');
      if (switchButton) {
        event.preventDefault();
        if (event.detail >= 2) {
          startSessionRename(switchButton.closest('.session-tab')?.dataset.id);
          return;
        }
        switchSession(switchButton.dataset.switch);
      }
    });
    el.sessionTabs.addEventListener('pointerdown', (event) => {
      const tab = event.target.closest('.session-tab');
      if (!tab) return;
      startSessionDrag(tab, event);
    });
    el.sessionTabs.addEventListener('dblclick', (event) => {
      if (event.target.closest('.st-close, [data-session-rename-input]')) return;
      const tab = event.target.closest('.session-tab');
      if (!tab) return;
      event.preventDefault();
      startSessionRename(tab.dataset.id);
    });
    el.sessionTabs.addEventListener('keydown', (event) => {
      const input = event.target.closest('[data-session-rename-input]');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const id = sessionRenameId;
        if (id) commitSessionRename(id, input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelSessionRename();
      }
    });
    el.sessionTabs.addEventListener('focusout', (event) => {
      const input = event.target.closest('[data-session-rename-input]');
      if (!input || sessionRenameId == null) return;
      const id = sessionRenameId;
      commitSessionRename(id, input.value);
    });

    el.translateBtn.addEventListener('click', () => startTranslation(el.composerInput.value));
    el.retranslateBtn.addEventListener('click', () => startTranslation(el.sourceText.value));
    el.backToInput.addEventListener('click', backToInput);
    el.copySourceBtn.addEventListener('click', copySourceToClipboard);
    el.saveFavoriteBtn.addEventListener('click', saveFavoriteChanges);
    el.favoriteCurrentBtn.addEventListener('click', addCurrentToFavorite);
    el.clearBtn.addEventListener('click', clearComposerInput);
    el.pasteBtn.addEventListener('click', pasteClipboard);
    el.historyBtn.addEventListener('click', openHistoryPage);
    el.favoriteBtn.addEventListener('click', openFavoritePage);
    [el.historyList, el.favoriteList].forEach((list) => {
      list.addEventListener('click', (event) => {
        const star = event.target.closest('[data-record-star]');
        if (star) {
          event.preventDefault();
          starHistoryRecord(star.dataset.recordStar);
          return;
        }
        const del = event.target.closest('[data-record-del]');
        if (del) {
          event.preventDefault();
          deleteRecord(del.dataset.recordKind, del.dataset.recordDel);
          return;
        }
        const rename = event.target.closest('[data-record-rename-icon]');
        if (rename) {
          event.preventDefault();
          startFavoriteTitleEdit(rename.dataset.recordRenameIcon);
          return;
        }
        const exampleUpload = event.target.closest('[data-record-example-upload]');
        if (exampleUpload) {
          event.preventDefault();
          const card = exampleUpload.closest('.record-card');
          card?.querySelector('.record-example-input')?.click();
          return;
        }
        const copy = event.target.closest('[data-record-copy]');
        if (copy) {
          event.preventDefault();
          const records = copy.dataset.recordKind === 'history' ? state.historyRecords : state.favoriteRecords;
          const record = (records || []).find((item) => String(item.id) === String(copy.dataset.recordCopy));
          if (record) copyRecordPrompt(record);
          return;
        }
        const heading = event.target.closest('.record-card-heading');
        if (heading) {
          if (event.target.closest('[data-record-title], .record-title-input, [data-record-rename-icon]')) return;
          if (Date.now() < suppressRecordOpenUntil) return;
          event.preventDefault();
          const card = heading.closest('.record-card');
          if (card) openRecordInSession(card.dataset.recordId, card.dataset.recordKind);
          return;
        }
        const open = event.target.closest('[data-record-open]');
        if (open) {
          event.preventDefault();
          openRecordInSession(open.dataset.recordOpen, open.dataset.recordKind);
        }
      });
    });
    el.favoriteList.addEventListener('change', (event) => {
      const input = event.target.closest('.record-example-input');
      if (!input) return;
      const file = input.files?.[0];
      const recordId = input.dataset.recordExampleInput;
      input.value = '';
      if (file && recordId) uploadFavoriteExample(recordId, file);
    });
    el.favoriteList.addEventListener('dblclick', (event) => {
      const title = event.target.closest('[data-record-title]');
      if (!title) return;
      event.preventDefault();
      event.stopPropagation();
      startFavoriteTitleEdit(title.dataset.recordTitle);
    });
    el.favoriteList.addEventListener('keydown', (event) => {
      const input = event.target.closest('.record-title-input');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitFavoriteTitleEdit(input.dataset.recordTitleInput, input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelFavoriteTitleEdit();
      }
    });
    el.favoriteList.addEventListener('focusout', (event) => {
      const input = event.target.closest('.record-title-input');
      if (!input) return;
      const recordId = input.dataset.recordTitleInput;
      suppressRecordOpenUntil = Date.now() + 400;
      setTimeout(() => {
        if (recordEditingId !== recordId) return;
        if (document.querySelector('.record-title-input') === input) {
          commitFavoriteTitleEdit(recordId, input.value);
        }
      }, 0);
    });
    el.favoriteList.addEventListener('mouseover', (event) => {
      const frame = event.target.closest('.record-example-frame');
      if (frame) hoveredExampleId = frame.dataset.recordExampleId || null;
    });
    el.favoriteList.addEventListener('mouseout', (event) => {
      const frame = event.target.closest('.record-example-frame');
      if (!frame) return;
      if (event.relatedTarget && frame.contains(event.relatedTarget)) return;
      hoveredExampleId = null;
    });
    el.favoriteList.addEventListener('mouseleave', () => {
      hoveredExampleId = null;
    });
    document.addEventListener('paste', (event) => {
      if (!hoveredExampleId || state.recordMode !== 'favorite') return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      const items = event.clipboardData?.items ? [...event.clipboardData.items] : [];
      for (const item of items) {
        if (!item.type || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          uploadFavoriteExample(hoveredExampleId, file);
          return;
        }
      }
    });

    el.composerInput.addEventListener('input', () => {
      history.programmaticUndo = false;
      history.programmaticTarget = null;
      if (actionUndoStack[actionUndoStack.length - 1]?.kind === 'clear') actionUndoStack.pop();
      state.text = el.composerInput.value;
      updateMeter();
      scheduleDraftSave();
      noteTextChange();
      renderSessionBar();
    });
    el.composerInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        startTranslation(el.composerInput.value);
      }
    });

    el.sourceText.addEventListener('input', () => {
      history.programmaticUndo = false;
      history.programmaticTarget = null;
      updateSourceFromEditor();
      updateMeta();
      scheduleDraftSave();
      noteTextChange();
      renderSessionBar();
      scheduleSourceSync(SOURCE_SYNC_DELAY);
    });
    el.sourceText.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        clearSourceSyncTimer();
        syncSourceEdits();
      }
    });

    el.engineChip.addEventListener('click', openSettings);
    el.engineBayBtn.addEventListener('click', openSettings);
    el.hwUnloadBtn.addEventListener('click', manualUnloadModel);
    el.helpBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleHelp();
    });
    el.helpClose.addEventListener('click', hideHelp);

    document.addEventListener('click', (event) => {
      if (el.helpPop.hidden) return;
      if (el.helpPop.contains(event.target) || el.helpBtn.contains(event.target)) return;
      hideHelp();
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest('.record-card')) return;
      /* 选择态下点词块之外的空白（面板空白、原文区、顶栏…）即退出选择态 */
      if (state.glossaryAdd.picking && !state.glossaryAdd.open) {
        const node = event.target instanceof Element ? event.target : null;
        const hitChip = node && node.closest('.blk, .sent');
        const inPanelChip = hitChip && (el.segmentsBody.contains(hitChip) || el.targetBody.contains(hitChip));
        const onTrigger = node && node.closest('#glossaryAddTrigger');
        const onEditable = node && node.closest('input, textarea, select, [contenteditable="true"], .inline-edit');
        if (!inPanelChip && !onTrigger && !onEditable) {
          exitGlossaryPick();
        }
      }
      if (state.glossaryAdd.picking && !event.target.closest('.inline-edit')) {
        const pickEl = event.target.closest && event.target.closest('.blk');
        const inPanel = pickEl && (el.segmentsBody.contains(pickEl) || el.targetBody.contains(pickEl));
        if (pickEl && inPanel) {
          event.preventDefault();
          event.stopPropagation();
          toggleGlossaryPick(pickEl.dataset.bid);
          return;
        }
      }
      const add = event.target.closest && event.target.closest('.block-add, .group-add');
      if (add) {
        event.preventDefault();
        addNewBlock(add.dataset.add, add.dataset.kind);
        return;
      }
      const idx = event.target.closest && event.target.closest('.idx');
      if (!idx) {
        /* 单击词块 = 选中（随后 Backspace / Delete 删除）；点空白处取消选中 */
        if (!state.editing) {
          const chip = event.target.closest && event.target.closest('.blk, .sent');
          const inPanel = chip && (el.segmentsBody.contains(chip) || el.targetBody.contains(chip));
          setSelectedBlock(inPanel ? chip.dataset.bid : null);
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const bid = idx.dataset.bid;
      if (state.editing && state.editing.bid === bid) {
        cancelInlineEdit();
        return;
      }
      deleteBlock(bid);
    });

    document.addEventListener('dblclick', (event) => {
      if (event.target.closest('.record-card')) return;
      if (state.glossaryAdd.picking) return;
      if (event.target.closest('.idx') || event.target.closest('.inline-edit')) return;
      const blockEl = event.target.closest('.blk, .sent');
      if (!blockEl) return;
      startInlineEdit(blockEl);
    });

    document.addEventListener('dragstart', (event) => {
      const blockEl = event.target.closest && event.target.closest('.blk, .sent');
      if (!blockEl) return;
      if (event.target.closest('.idx, .block-add, .inline-edit, input, button')) {
        event.preventDefault();
        return;
      }
      if (!state.blocks || state.phase === 'translating' || state.editing) {
        event.preventDefault();
        return;
      }
      dragBlockId = blockEl.dataset.bid;
      blockEl.classList.add('is-dragging');
      try {
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData('text/plain', dragBlockId);
      } catch { /* ignore */ }
      /* 拖拽开始不点亮按钮：只有拖到按钮上（重合）才高亮，见按钮的 dragover */
    });

    document.addEventListener('dragover', (event) => {
      if (!dragBlockId) return;
      const targetEl = event.target.closest && event.target.closest('.blk, .sent');
      document.querySelectorAll('.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
      if (!targetEl || targetEl.dataset.bid === dragBlockId) return;
      const source = findBlock(dragBlockId);
      const target = findBlock(targetEl.dataset.bid);
      if (!source || !target || source.kind !== target.kind) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
      targetEl.classList.add('is-drop-target');
    });

    document.addEventListener('drop', (event) => {
      if (!dragBlockId) return;
      const targetEl = event.target.closest && event.target.closest('.blk, .sent');
      if (!targetEl) return;
      const source = findBlock(dragBlockId);
      const target = findBlock(targetEl.dataset.bid);
      if (!source || !target || source.kind !== target.kind) return;
      event.preventDefault();
      const rect = targetEl.getBoundingClientRect();
      const horizontal = targetEl.classList.contains('blk');
      const before = horizontal
        ? event.clientX < rect.left + rect.width / 2
        : event.clientY < rect.top + rect.height / 2;
      const sourceId = dragBlockId;
      dragBlockId = null;
      clearDropTargets();
      reorderBlock(sourceId, targetEl.dataset.bid, before);
    });

    document.addEventListener('dragend', () => {
      dragBlockId = null;
      clearDropTargets();
      if (state.glossaryAdd.dragArmed) {
        state.glossaryAdd.dragArmed = false;
        syncGlossaryAddTrigger();
      }
      el.glossaryAddTrigger.classList.remove('is-drop-hover');
    });

    /* ---------------- 添加入词库：触发按钮 ---------------- */
    el.glossaryAddTrigger.addEventListener('click', (event) => {
      event.preventDefault();
      onGlossaryAddTrigger();
    });

    el.glossaryAddTrigger.addEventListener('dragenter', (event) => {
      /* 进入按钮即接受 drop 并预备高亮；具体校验仍交给 dragover/drop */
      event.preventDefault();
      try { event.dataTransfer.dropEffect = pickDropEffect(event); } catch { /* ignore */ }
    });

    el.glossaryAddTrigger.addEventListener('dragover', (event) => {
      /* 无条件 preventDefault：浏览器只有在 dragover 被接受时才派发 drop，
         否则松手就是“什么都没发生”。词块类型校验放到 drop 里给出提示。 */
      event.preventDefault();
      const bid = dragBlockId || readDraggedBid(event);
      const block = bid ? findBlock(bid) : null;
      if (!block || block.kind !== 'tag') {
        try { event.dataTransfer.dropEffect = pickDropEffect(event); } catch { /* ignore */ }
        el.glossaryAddTrigger.classList.remove('is-drop-hover');
        if (state.glossaryAdd.dragArmed) {
          state.glossaryAdd.dragArmed = false;
          syncGlossaryAddTrigger();
        }
        return;
      }
      try { event.dataTransfer.dropEffect = pickDropEffect(event); } catch { /* ignore */ }
      el.glossaryAddTrigger.classList.add('is-drop-hover');
      if (!state.glossaryAdd.dragArmed) {
        state.glossaryAdd.dragArmed = true;
        syncGlossaryAddTrigger();
      }
    });

    el.glossaryAddTrigger.addEventListener('dragleave', (event) => {
      if (event.relatedTarget && el.glossaryAddTrigger.contains(event.relatedTarget)) return;
      el.glossaryAddTrigger.classList.remove('is-drop-hover');
      /* 拖离按钮 → 撤下高亮，恢复原状态 */
      if (state.glossaryAdd.dragArmed) {
        state.glossaryAdd.dragArmed = false;
        syncGlossaryAddTrigger();
      }
    });

    el.glossaryAddTrigger.addEventListener('drop', (event) => {
      const bid = dragBlockId || readDraggedBid(event);
      if (!bid) return;
      const block = findBlock(bid);
      event.preventDefault();
      event.stopPropagation();
      dragBlockId = null;
      clearDropTargets();
      state.glossaryAdd.dragArmed = false;
      el.glossaryAddTrigger.classList.remove('is-drop-hover');
      document.querySelectorAll('.is-dragging').forEach((node) => node.classList.remove('is-dragging'));
      syncGlossaryAddTrigger();
      if (!block || block.kind !== 'tag') {
        toast('只有 TAGS 词块能加入词条库', 'error', 2600);
        return;
      }
      const add = state.glossaryAdd;
      const bids = add.picking ? [...add.picks, bid] : [bid];
      openGlossaryAddDialog(bids, { fromDrop: true });
    });

    /* ---------------- 添加入词库：确认浮窗 ---------------- */
    el.glossaryAddBackdrop.addEventListener('click', (event) => {
      if (event.target === el.glossaryAddBackdrop) closeGlossaryAddDialog();
    });

    el.glossaryAddCancel.addEventListener('click', () => closeGlossaryAddDialog());
    el.glossaryAddClose.addEventListener('click', () => closeGlossaryAddDialog());
    el.glossaryAddOk.addEventListener('click', () => { submitGlossaryAdd(); });

    el.glossaryAddList.addEventListener('input', (event) => {
      const input = event.target.closest && event.target.closest('.ga-input');
      if (!input) return;
      updateGlossaryRowState(input.closest('.ga-row'));
    });

    el.glossaryAddList.addEventListener('keydown', (event) => {
      const input = event.target.closest && event.target.closest('.ga-input');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        submitGlossaryAdd();
      }
    });

    document.addEventListener('focusout', (event) => {
      const input = event.target;
      if (!input || !input.classList || !input.classList.contains('inline-edit')) return;
      hideTagSuggest();
      setTimeout(() => {
        if (!state.editing || document.querySelector('.inline-edit') !== input) return;
        if (state.editing.isNew) {
          commitInlineEdit();
        } else {
          cancelInlineEdit();
        }
      }, 0);
    });

    /* 词块编辑时按输入检索词库相近 tag，浮窗显示在词块上方 */
    document.addEventListener('input', (event) => {
      const input = event.target;
      if (!input || !input.classList || !input.classList.contains('inline-edit')) return;
      renderTagSuggest(input);
    });
    /* 面板滚动 / 窗口尺寸变化时浮窗会飘，直接收起来 */
    ['segmentsBody', 'targetBody'].forEach((key) => {
      el[key]?.addEventListener('scroll', hideTagSuggest, { passive: true });
    });
    window.addEventListener('resize', hideTagSuggest);

    el.alertAction.addEventListener('click', openSettings);
    el.alertClose.addEventListener('click', hideAlert);

    el.modalClose.addEventListener('click', closeSettings);
    el.modalCancel.addEventListener('click', closeSettings);
    el.modalBackdrop.addEventListener('click', (event) => {
      if (event.target === el.modalBackdrop) closeSettings();
    });
    el.modalSave.addEventListener('click', () => saveSettings({ close: true }));
    el.confirmCancel.addEventListener('click', () => closeConfirmDialog(false));
    el.confirmOk.addEventListener('click', () => closeConfirmDialog(true));
    el.confirmBackdrop.addEventListener('click', (event) => {
      if (event.target === el.confirmBackdrop) closeConfirmDialog(false);
    });
    el.testBtn.addEventListener('click', testConnection);
    el.refreshOllamaBtn.addEventListener('click', () => fetchModelsFor('ollama'));
    el.refreshOpenaiBtn.addEventListener('click', () => fetchModelsFor('openai'));

    el.glossaryAddBtn.addEventListener('click', addGlossaryEntry);
    el.glossarySaveBtn.addEventListener('click', saveGlossaryEntries);
    el.glossaryReloadBtn.addEventListener('click', reloadGlossaryEntries);
    el.glossarySearch.addEventListener('input', () => refreshGlossaryView({ resetScroll: true }));
    el.glossaryList.addEventListener('scroll', onGlossaryScroll, { passive: true });
    /* 尺寸变化（窗口缩放、面板折叠）后可见行数会变，重算窗口 */
    if (window.ResizeObserver) {
      const glossaryResize = new ResizeObserver(() => {
        if (state.view === 'glossary') renderGlossaryWindow(true);
      });
      glossaryResize.observe(el.glossaryList);
    }
    el.glossaryList.addEventListener('input', (event) => {
      const input = event.target;
      if (!input.matches('.glossary-en, .glossary-zh')) return;
      const cell = input.closest('.glossary-cell');
      const index = Number(cell?.dataset.index);
      const row = state.glossaryRows[index];
      if (row) {
        if (input.classList.contains('glossary-en')) row.en = input.value;
        else row.zh = input.value;
      }
      markGlossaryDirty(true);
    });
    el.glossaryList.addEventListener('click', (event) => {
      const del = event.target.closest('.glossary-del');
      if (!del) return;
      const cell = del.closest('.glossary-cell');
      const index = Number(cell?.dataset.index);
      const row = state.glossaryRows[index];
      if (!row) return;
      const removed = { en: row.en, zh: row.zh };
      state.glossaryRows.splice(index, 1);
      markGlossaryDirty(true);
      refreshGlossaryView();
      pushActionUndo('删除词条', () => {
        state.glossaryRows.splice(Math.min(index, state.glossaryRows.length), 0, removed);
        markGlossaryDirty(true);
        refreshGlossaryView();
      });
      toast('已删除词条', 'info', 2000);
    });
    [el.glossaryNewEn, el.glossaryNewZh].forEach((input) => {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          addGlossaryEntry();
        }
      });
    });

    el.characterSelect.addEventListener('change', () => switchCharacterCard(el.characterSelect.value));
    el.characterPickerTrigger.addEventListener('click', (event) => {
      event.stopPropagation();
      renderCharacterPicker();
      const opening = el.characterPickerPanel.hidden;
      if (opening) {
        mShow(el.characterPickerPanel, { enter: 'drop' });
        mStagger(el.characterPickerList, { step: 22 });
      } else {
        mHide(el.characterPickerPanel, { leave: 'fade' });
      }
      el.characterPickerTrigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });
    el.characterPickerPanel.addEventListener('click', (event) => {
      const newRow = event.target.closest('[data-character-pick-new]');
      if (newRow) {
        event.preventDefault();
        closeCharacterPicker();
        newCharacterCard();
        return;
      }
      const row = event.target.closest('[data-character-pick]');
      if (row) {
        event.preventDefault();
        closeCharacterPicker();
        switchCharacterCard(row.dataset.characterPick);
      }
    });
    document.addEventListener('click', (event) => {
      if (!el.characterPicker.contains(event.target)) closeCharacterPicker();
    });
    el.characterNewBtn.addEventListener('click', newCharacterCard);
    el.characterDeleteBtn.addEventListener('click', deleteCharacterCard);
    el.characterBackBtn.addEventListener('click', backToCharacterGallery);
    el.characterWardrobeBtn.addEventListener('click', () => {
      if (state.characterMode === 'wardrobe') closeWardrobe();
      else openWardrobe();
    });
    el.wardrobeBackBtn.addEventListener('click', () => {
      if (state.characterMode === 'wardrobe' && !el.wardrobeEditor.hidden) closeWardrobeEditor();
      else backFromWardrobe();
    });
    el.wardrobeNewBtn.addEventListener('click', () => openWardrobeEditor());
    el.wardrobePreviewFrame.addEventListener('click', () => el.wardrobePreviewInput.click());
    el.wardrobePreviewFrame.addEventListener('mouseenter', () => { hoveredWardrobePreview = true; });
    el.wardrobePreviewFrame.addEventListener('mouseleave', () => { hoveredWardrobePreview = false; });
    el.wardrobePreviewInput.addEventListener('change', () => {
      const file = el.wardrobePreviewInput.files?.[0];
      el.wardrobePreviewInput.value = '';
      if (!file) return;
      const inlineId = wardrobeInlineImageTargetId;
      wardrobeInlineImageTargetId = null;
      if (inlineId) handleWardrobeInlinePreview(inlineId, file);
      else handleWardrobePreview(file);
    });
    el.wardrobeCancelBtn.addEventListener('click', closeWardrobeEditor);
    el.wardrobeSaveBtn.addEventListener('click', saveWardrobeEntry);
    el.wardrobePasteBtn.addEventListener('click', pasteWardrobeClipboard);
    [el.wardrobeName, el.wardrobeTags, el.wardrobeNotes].forEach((input) => {
      input.addEventListener('input', () => markWardrobeDirty(true));
    });
    el.wardrobeGrid.addEventListener('click', async (event) => {
      if (Date.now() < suppressWardrobeClickUntil) return;
      const inlinePreview = event.target.closest?.('[data-wardrobe-inline-preview]');
      if (inlinePreview) {
        event.preventDefault();
        wardrobeInlineImageTargetId = inlinePreview.dataset.wardrobeInlinePreview;
        el.wardrobePreviewInput.click();
        return;
      }
      const inlineCancel = event.target.closest?.('[data-wardrobe-inline-cancel]');
      if (inlineCancel) {
        event.preventDefault();
        await cancelWardrobeInlineEdit();
        return;
      }
      const inlineSave = event.target.closest?.('[data-wardrobe-inline-save]');
      if (inlineSave) {
        event.preventDefault();
        await saveWardrobeInlineEdit(inlineSave.dataset.wardrobeInlineSave);
        return;
      }
      const del = event.target.closest('[data-wardrobe-delete]');
      if (del) {
        event.preventDefault();
        event.stopPropagation();
        await deleteWardrobeOutfit(del.dataset.wardrobeDelete);
        return;
      }
      if (event.target.closest('[data-wardrobe-new]')) {
        event.preventDefault();
        await openWardrobeEditor();
        return;
      }
      const edit = event.target.closest('[data-wardrobe-edit]');
      if (edit) {
        event.preventDefault();
        const outfit = wardrobeOutfitById(edit.dataset.wardrobeEdit);
        if (outfit) await openWardrobeEditor(outfit);
        return;
      }
      const copy = event.target.closest('[data-wardrobe-copy]');
      if (copy) {
        event.preventDefault();
        const outfit = wardrobeOutfitById(copy.dataset.wardrobeCopy);
        if (!outfit) return;
        const tags = Array.isArray(outfit.tags) ? outfit.tags : [];
        const ok = await copyTextToClipboard(tags.join(', '));
        toast(ok ? `${tags.length} 个衣物词条已复制` : '复制失败', ok ? 'info' : 'error', 2200);
        return;
      }
      const card = event.target.closest('[data-wardrobe-id]');
      if (!card || card.classList.contains('is-inline-editing')) return;
      const outfit = wardrobeOutfitById(card.dataset.wardrobeId);
      if (outfit) await openWardrobeEditor(outfit);
    });
    el.wardrobeGrid.addEventListener('input', (event) => {
      const card = event.target.closest?.('.wardrobe-card.is-inline-editing');
      if (!card) return;
      const id = card.dataset.wardrobeId;
      state.wardrobeInlineDirty = true;
      state.wardrobeInlineDraft = {
        name: card.querySelector(`[data-inline-name="${id}"]`)?.value || '',
        tags: card.querySelector(`[data-inline-tags="${id}"]`)?.value || '',
        notes: card.querySelector(`[data-inline-notes="${id}"]`)?.value || '',
      };
    });
    el.wardrobeGrid.addEventListener('mouseover', (event) => {
      const preview = event.target.closest?.('[data-wardrobe-inline-preview]');
      if (preview) hoveredWardrobeInlinePreviewId = preview.dataset.wardrobeInlinePreview;
    });
    el.wardrobeGrid.addEventListener('mouseout', (event) => {
      const preview = event.target.closest?.('[data-wardrobe-inline-preview]');
      if (!preview) return;
      if (event.relatedTarget && preview.contains(event.relatedTarget)) return;
      if (hoveredWardrobeInlinePreviewId === preview.dataset.wardrobeInlinePreview) {
        hoveredWardrobeInlinePreviewId = null;
      }
    });
    el.wardrobeGrid.addEventListener('mouseleave', () => {
      hoveredWardrobeInlinePreviewId = null;
    });
    el.wardrobeGrid.addEventListener('dragstart', (event) => {
      const card = event.target.closest('[data-wardrobe-id]');
      if (!card) return;
      if (event.target.closest('button, input, textarea')) {
        event.preventDefault();
        return;
      }
      wardrobeDragId = card.dataset.wardrobeId;
      card.classList.add('is-dragging');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', wardrobeDragId);
      } catch { /* ignore */ }
    });
    el.wardrobeGrid.addEventListener('dragover', (event) => {
      if (!wardrobeDragId) return;
      const card = event.target.closest('[data-wardrobe-id]');
      el.wardrobeGrid.querySelectorAll('.wardrobe-card.is-drag-over').forEach((node) => {
        if (node !== card) node.classList.remove('is-drag-over');
      });
      if (!card || card.dataset.wardrobeId === wardrobeDragId) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
      card.classList.add('is-drag-over');
    });
    el.wardrobeGrid.addEventListener('drop', async (event) => {
      if (!wardrobeDragId) return;
      const target = event.target.closest('[data-wardrobe-id]');
      const sourceId = wardrobeDragId;
      wardrobeDragId = null;
      el.wardrobeGrid.querySelectorAll('.wardrobe-card').forEach((node) => {
        node.classList.remove('is-dragging', 'is-drag-over');
      });
      if (!target || target.dataset.wardrobeId === sourceId) return;
      event.preventDefault();
      const order = (state.wardrobe || []).map((item) => String(item.id));
      const from = order.indexOf(String(sourceId));
      const to = order.indexOf(String(target.dataset.wardrobeId));
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, String(sourceId));
      const byId = new Map((state.wardrobe || []).map((item) => [String(item.id), item]));
      state.wardrobe = order.map((id) => byId.get(id)).filter(Boolean);
      suppressWardrobeClickUntil = Date.now() + 320;
      renderWardrobe();
      try {
        await fetch('/api/wardrobe/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: order }),
        });
      } catch {
        toast('衣物排序保存失败', 'error', 2600);
      }
    });
    el.wardrobeGrid.addEventListener('dragend', () => {
      wardrobeDragId = null;
      el.wardrobeGrid.querySelectorAll('.wardrobe-card').forEach((node) => {
        node.classList.remove('is-dragging', 'is-drag-over');
      });
      suppressWardrobeClickUntil = Date.now() + 320;
    });
    window.addEventListener('resize', syncWardrobeCardSize);
    document.addEventListener('paste', (event) => {
      if (state.characterMode !== 'wardrobe' || !el.viewCard.classList.contains('is-active')) return;
      const inlineId = hoveredWardrobeInlinePreviewId;
      const editorHover = hoveredWardrobePreview && !el.wardrobeEditor.hidden;
      if (!inlineId && !editorHover) return;
      const items = event.clipboardData?.items ? [...event.clipboardData.items] : [];
      for (const item of items) {
        if (!item.type || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          if (inlineId) handleWardrobeInlinePreview(inlineId, file);
          else handleWardrobePreview(file);
          return;
        }
      }
    });
    el.characterGalleryGrid.addEventListener('click', (event) => {
      const del = event.target.closest('[data-character-delete]');
      if (del) {
        event.preventDefault();
        event.stopPropagation();
        deleteGalleryCharacter(del.dataset.characterDelete);
        return;
      }
      const apply = event.target.closest('[data-character-apply]');
      if (apply) {
        event.preventDefault();
        event.stopPropagation();
        const card = characterById(apply.dataset.characterApply);
        if (card) fillComposerWithTags(card.tags);
        return;
      }
      const copy = event.target.closest('[data-character-copy]');
      if (copy) {
        event.preventDefault();
        event.stopPropagation();
        copyCharacterTags(copy.dataset.characterCopy);
        return;
      }
      const newTile = event.target.closest('#characterNewCardTile');
      if (newTile) {
        event.preventDefault();
        enterCharacterCreateMode();
        return;
      }
      const card = event.target.closest('[data-character-card]');
      if (card) {
        event.preventDefault();
        const found = characterById(card.dataset.characterCard);
        if (found) fillCharacterForm(found);
      }
    });
    el.characterGalleryGrid.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('[data-character-card]');
      if (!card) return;
      state.characterDragId = card.dataset.characterCard;
      card.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', state.characterDragId);
      }
    });
    el.characterGalleryGrid.addEventListener('dragover', (event) => {
      const target = event.target.closest?.('[data-character-card]');
      if (!target || !state.characterDragId || target.dataset.characterCard === state.characterDragId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      el.characterGalleryGrid.querySelectorAll('.is-drag-over').forEach((node) => node.classList.remove('is-drag-over'));
      target.classList.add('is-drag-over');
    });
    el.characterGalleryGrid.addEventListener('dragleave', (event) => {
      const target = event.target.closest?.('[data-character-card]');
      if (target) target.classList.remove('is-drag-over');
    });
    el.characterGalleryGrid.addEventListener('drop', (event) => {
      const target = event.target.closest?.('[data-character-card]');
      if (!target || !state.characterDragId || target.dataset.characterCard === state.characterDragId) return;
      event.preventDefault();
      const dragId = state.characterDragId;
      state.characterDragId = null;
      el.characterGalleryGrid.querySelectorAll('.is-dragging, .is-drag-over').forEach((node) => {
        node.classList.remove('is-dragging', 'is-drag-over');
      });
      reorderCharacterGallery(dragId, target.dataset.characterCard);
    });
    el.characterGalleryGrid.addEventListener('dragend', () => {
      state.characterDragId = null;
      el.characterGalleryGrid.querySelectorAll('.is-dragging, .is-drag-over').forEach((node) => {
        node.classList.remove('is-dragging', 'is-drag-over');
      });
    });
    el.characterSaveBtn.addEventListener('click', saveCharacterCard);
    el.characterApplyBtn.addEventListener('click', applyCharacterCard);
    el.characterCreateClear.addEventListener('click', () => clearCharacterCreateInput(true));
    el.characterCreatePaste.addEventListener('click', pasteCharacterCreate);
    el.characterCreateBtn.addEventListener('click', createCharacterFromInput);
    el.characterCreateInput.addEventListener('input', () => {
      if (actionUndoStack[actionUndoStack.length - 1]?.kind === 'clear-character') actionUndoStack.pop();
      updateCharacterCreateMeter();
    });
    el.characterCreateInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        createCharacterFromInput();
      }
    });
    el.characterCopyTagsBtn.addEventListener('click', copyFixedCharacterTags);
    el.characterTagsWardrobeBtn.addEventListener('click', toggleCharacterTagsWardrobeFold);
    el.characterTagsWardrobeList.addEventListener('click', (event) => {
      const card = event.target.closest?.('[data-character-wardrobe]');
      if (!card) return;
      event.preventDefault();
      applyCharacterWardrobeTags(card.dataset.characterWardrobe);
    });
    el.characterTagsWardrobeList.addEventListener('mouseover', (event) => {
      const cardEl = event.target.closest?.('.wardrobe-mini-card');
      if (!cardEl || (event.relatedTarget && cardEl.contains(event.relatedTarget))) return;
      const outfit = wardrobeOutfitById(cardEl.dataset.characterWardrobe);
      if (outfit) showWardrobeHover(cardEl, outfit);
    });
    el.characterTagsWardrobeList.addEventListener('mouseout', (event) => {
      const cardEl = event.target.closest?.('.wardrobe-mini-card');
      if (cardEl && !cardEl.contains(event.relatedTarget)) hideWardrobeHover();
    });
    el.characterTagsWardrobeList.addEventListener('mouseleave', hideWardrobeHover);
    el.characterTagsWardrobeList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.wardrobeHoverPop);
    }, { passive: false });
    el.characterGroupAddBtn.addEventListener('click', addCharacterGroup);
    el.characterComboAddBtn.addEventListener('click', openCharacterComboAdd);
    el.characterComboAddSave.addEventListener('click', saveCharacterComboCustomTags);
    el.characterComboAddCancel.addEventListener('click', closeCharacterComboAdd);
    el.characterComboAddInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveCharacterComboCustomTags();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeCharacterComboAdd();
      }
    });
    el.characterComboCopyBtn.addEventListener('click', copyCharacterCombo);
    el.characterSavePresetBtn.addEventListener('click', beginCharacterPresetSave);
    el.characterPresetNameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitCharacterPresetSave();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelCharacterPresetSave();
      }
    });
    el.characterPresetNameInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (characterPresetEditing) commitCharacterPresetSave();
      }, 0);
    });
    el.characterComboList.addEventListener('mousedown', onCharacterComboMouseDown);
    el.characterComboWardrobeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleComboWardrobePop();
    });
    el.characterComboWardrobeList.addEventListener('click', (event) => {
      const add = event.target.closest?.('[data-combo-wardrobe-add]');
      if (!add) return;
      event.preventDefault();
      addWardrobeToCombo(add.dataset.comboWardrobeAdd);
    });
    el.characterComboWardrobeList.addEventListener('mouseover', (event) => {
      const item = event.target.closest?.('.combo-wardrobe-item');
      if (!item || (event.relatedTarget && item.contains(event.relatedTarget))) return;
      const outfit = wardrobeOutfitById(item.dataset.comboWardrobeAdd);
      if (outfit) showWardrobeHover(item, outfit);
    });
    el.characterComboWardrobeList.addEventListener('mouseout', (event) => {
      const item = event.target.closest?.('.combo-wardrobe-item');
      if (item && !item.contains(event.relatedTarget)) hideWardrobeHover();
    });
    el.characterComboWardrobeList.addEventListener('mouseleave', hideWardrobeHover);
    el.characterComboWardrobeList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.wardrobeHoverPop);
    }, { passive: false });
    el.characterComboList.addEventListener('click', (event) => {
      const removeGroup = event.target.closest?.('[data-combo-group-remove]');
      if (removeGroup) {
        event.preventDefault();
        removeCharacterGroupFromCombo(removeGroup.dataset.comboGroupRemove);
        return;
      }
      const removeWardrobe = event.target.closest?.('[data-combo-wardrobe-remove]');
      if (removeWardrobe) {
        event.preventDefault();
        removeCharacterComboWardrobe(removeWardrobe.dataset.comboWardrobeRemove);
        return;
      }
      const remove = event.target.closest?.('[data-combo-tag-remove]');
      if (!remove) return;
      event.preventDefault();
      removeCharacterComboTag(Number(remove.dataset.comboTagRemove));
    });
    el.presetFoldToggle.addEventListener('click', togglePresetFold);
    [el.characterFold, el.presetFold, el.wardrobeFold].forEach((fold) => {
      fold.addEventListener('mousedown', (event) => {
        if (state.view !== 'translate') return;
        if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if (document.activeElement !== el.composerInput) return;
        event.preventDefault();
      });
    });
    el.wardrobeFoldToggle.addEventListener('click', toggleWardrobeFold);
    el.wardrobeFoldList.addEventListener('click', (event) => {
      hideWardrobeHover();
      const card = event.target.closest?.('[data-wardrobe-fold]');
      if (!card) return;
      event.preventDefault();
      applyWardrobeFoldOutfit(card.dataset.wardrobeFold);
    });
    el.wardrobeFoldList.addEventListener('mouseover', (event) => {
      const cardEl = event.target.closest?.('.wardrobe-mini-card');
      if (!cardEl || (event.relatedTarget && cardEl.contains(event.relatedTarget))) return;
      const outfit = wardrobeOutfitById(cardEl.dataset.wardrobeFold);
      if (outfit) showWardrobeHover(cardEl, outfit);
    });
    el.wardrobeFoldList.addEventListener('mouseout', (event) => {
      const cardEl = event.target.closest?.('.wardrobe-mini-card');
      if (cardEl && !cardEl.contains(event.relatedTarget)) hideWardrobeHover();
    });
    el.wardrobeFoldList.addEventListener('mouseleave', hideWardrobeHover);
    el.wardrobeFoldList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.wardrobeHoverPop);
    }, { passive: false });
    el.characterFoldToggle.addEventListener('click', toggleCharacterFold);
    el.characterFoldList.addEventListener('click', (event) => {
      hideCharacterHover();
      const card = event.target.closest?.('[data-character-fold]');
      if (!card) return;
      event.preventDefault();
      applyCharacterFoldCard(card.dataset.characterFold);
    });
    el.characterFoldList.addEventListener('mouseover', (event) => {
      const cardEl = event.target.closest?.('.character-mini-card');
      if (!cardEl || (event.relatedTarget && cardEl.contains(event.relatedTarget))) return;
      const card = (state.characters || []).find((item) => String(item.id) === String(cardEl.dataset.characterFold));
      if (card) showCharacterHover(cardEl, card);
    });
    el.characterFoldList.addEventListener('mouseout', (event) => {
      const cardEl = event.target.closest?.('.character-mini-card');
      if (cardEl && !cardEl.contains(event.relatedTarget)) hideCharacterHover();
    });
    el.characterFoldList.addEventListener('mouseleave', hideCharacterHover);
    el.characterFoldList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.characterHoverPop);
    }, { passive: false });
    el.sourceCharacterFoldList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.characterHoverPop);
    }, { passive: false });
    el.presetList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.presetHoverPop);
    }, { passive: false });
    el.sourcePresetFoldList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.presetHoverPop);
    }, { passive: false });
    el.sourceCharacterFoldToggle.addEventListener('click', toggleSourceCharacterFold);
    el.sourcePresetFoldToggle.addEventListener('click', toggleSourcePresetFold);
    el.sourceCharacterFoldList.addEventListener('click', (event) => {
      hideCharacterHover();
      const card = event.target.closest?.('[data-source-character]');
      if (!card) return;
      event.preventDefault();
      applySourceCharacterCard(card.dataset.sourceCharacter);
    });
    el.sourceCharacterFoldList.addEventListener('mouseover', (event) => {
      const cardEl = event.target.closest?.('.character-mini-card');
      if (!cardEl || (event.relatedTarget && cardEl.contains(event.relatedTarget))) return;
      const card = (state.characters || []).find((item) => String(item.id) === String(cardEl.dataset.sourceCharacter));
      if (card) showCharacterHover(cardEl, card);
    });
    el.sourceCharacterFoldList.addEventListener('mouseout', (event) => {
      const cardEl = event.target.closest?.('.character-mini-card');
      if (cardEl && !cardEl.contains(event.relatedTarget)) hideCharacterHover();
    });
    el.sourceCharacterFoldList.addEventListener('mouseleave', hideCharacterHover);
    el.sourcePresetFoldList.addEventListener('click', (event) => {
      hidePresetHover();
      const preset = event.target.closest?.('[data-source-preset]');
      if (!preset) return;
      event.preventDefault();
      applySourcePreset(preset.dataset.sourcePreset);
    });
    el.sourcePresetFoldList.addEventListener('mouseover', (event) => {
      const item = event.target.closest?.('.source-preset-item');
      if (!item || (event.relatedTarget && item.contains(event.relatedTarget))) return;
      const preset = (state.presets || []).find((entry) => String(entry.id) === String(item.dataset.sourcePreset));
      if (preset) showPresetHover(item, preset);
    });
    el.sourcePresetFoldList.addEventListener('mouseout', (event) => {
      const item = event.target.closest?.('.source-preset-item');
      if (item && !item.contains(event.relatedTarget)) hidePresetHover();
    });
    el.sourcePresetFoldList.addEventListener('mouseleave', hidePresetHover);
    el.sourceWardrobeFoldToggle.addEventListener('click', toggleSourceWardrobeFold);
    el.sourceWardrobeFoldList.addEventListener('click', (event) => {
      hideWardrobeHover();
      const card = event.target.closest?.('[data-source-wardrobe]');
      if (!card) return;
      event.preventDefault();
      applySourceWardrobeOutfit(card.dataset.sourceWardrobe);
    });
    el.sourceWardrobeFoldList.addEventListener('mouseover', (event) => {
      const cardEl = event.target.closest?.('.wardrobe-mini-card');
      if (!cardEl || (event.relatedTarget && cardEl.contains(event.relatedTarget))) return;
      const outfit = wardrobeOutfitById(cardEl.dataset.sourceWardrobe);
      if (outfit) showWardrobeHover(cardEl, outfit);
    });
    el.sourceWardrobeFoldList.addEventListener('mouseout', (event) => {
      const cardEl = event.target.closest?.('.wardrobe-mini-card');
      if (cardEl && !cardEl.contains(event.relatedTarget)) hideWardrobeHover();
    });
    el.sourceWardrobeFoldList.addEventListener('mouseleave', hideWardrobeHover);
    el.sourceWardrobeFoldList.addEventListener('wheel', (event) => {
      scrollHoverPopOnWheel(event, el.wardrobeHoverPop);
    }, { passive: false });
    [el.sourceCharacterFold, el.sourcePresetFold, el.sourceWardrobeFold].forEach((fold) => {
      fold.addEventListener('mousedown', (event) => {
        if (document.activeElement !== el.sourceText) return;
        if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
      });
    });
    document.addEventListener('click', (event) => {
      if (el.sourceCharacterFoldBody.hidden && el.sourcePresetFoldBody.hidden && el.sourceWardrobeFoldBody.hidden) return;
      if (el.sourceCharacterFold.contains(event.target) || el.sourcePresetFold.contains(event.target)
          || el.sourceWardrobeFold.contains(event.target)) return;
      closeSourceFolds();
    });
    document.addEventListener('click', (event) => {
      if (el.characterFoldBody.hidden) return;
      if (el.characterFold.contains(event.target)) return;
      closeCharacterFold();
    });
    document.addEventListener('click', (event) => {
      if (el.wardrobeFoldBody.hidden) return;
      if (el.wardrobeFold.contains(event.target)) return;
      closeWardrobeFold();
    });
    document.addEventListener('click', (event) => {
      if (el.characterTagsWardrobeFold.hidden) return;
      if (el.characterTagsWardrobeFold.contains(event.target)
          || el.characterTagsWardrobeBtn.contains(event.target)) return;
      mFold(el.characterTagsWardrobeFold, false);
      el.characterTagsWardrobeBtn.setAttribute('aria-expanded', 'false');
      hideWardrobeHover();
    });
    document.addEventListener('click', (event) => {
      if (el.characterComboWardrobePop.hidden) return;
      if (el.characterComboWardrobePop.contains(event.target) || el.characterComboWardrobeBtn.contains(event.target)) return;
      el.characterComboWardrobePop.hidden = true;
      hideWardrobeHover();
    });
    document.addEventListener('click', (event) => {
      if (el.presetFoldBody.hidden) return;
      if (el.presetFold.contains(event.target)) return;
      mFold(el.presetFoldBody, false);
      el.presetFoldToggle.setAttribute('aria-expanded', 'false');
      hidePresetHover();
    });
    el.presetList.addEventListener('click', (event) => {
      hidePresetHover();
      const rename = event.target.closest?.('[data-preset-rename]');
      if (rename) {
        event.preventDefault();
        startPresetRename(rename.dataset.presetRename);
        return;
      }
      const remove = event.target.closest?.('[data-preset-delete]');
      if (remove) {
        event.preventDefault();
        deletePresetById(remove.dataset.presetDelete);
        return;
      }
      const apply = event.target.closest?.('[data-preset-apply]');
      if (!apply) return;
      const preset = (state.presets || []).find((entry) => String(entry.id) === String(apply.dataset.presetApply));
      if (preset) applyPreset(preset);
    });
    el.presetList.addEventListener('keydown', (event) => {
      const input = event.target.closest?.('[data-preset-input]');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitPresetRename(input.dataset.presetInput);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelPresetRename();
      }
    });
    el.presetList.addEventListener('focusout', (event) => {
      const input = event.target.closest?.('[data-preset-input]');
      if (!input) return;
      const id = input.dataset.presetInput;
      setTimeout(() => {
        if (String(presetEditingId) === String(id)) commitPresetRename(id);
      }, 0);
    });
    el.presetList.addEventListener('mouseover', (event) => {
      const card = event.target.closest?.('.preset-card');
      if (!card || (event.relatedTarget && card.contains(event.relatedTarget))) return;
      const preset = (state.presets || []).find((entry) => String(entry.id) === String(card.dataset.presetCard));
      if (preset) showPresetHover(card, preset);
    });
    el.presetList.addEventListener('mouseout', (event) => {
      const card = event.target.closest?.('.preset-card');
      if (card && !card.contains(event.relatedTarget)) hidePresetHover();
    });
    el.presetList.addEventListener('mouseleave', hidePresetHover);
    document.addEventListener('scroll', (event) => {
      if (event.target === el.characterHoverPop || event.target === el.presetHoverPop
          || event.target === el.wardrobeHoverPop) return;
      hidePresetHover();
      hideCharacterHover();
      hideWardrobeHover();
    }, true);
    window.addEventListener('resize', () => {
      hidePresetHover();
      hideCharacterHover();
      hideWardrobeHover();
    });
    el.characterTagPreview.addEventListener('mousedown', onCharacterTagMouseDown);
    el.characterTagPreview.addEventListener('click', (event) => {
      if (Date.now() < suppressCharacterTagClickUntil) return;
      const chip = event.target.closest?.('.character-tag-chip[data-tag]');
      if (!chip) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        toggleCharacterTagSelection(chip);
      } else if (state.selectedCharacterTags.size) {
        clearCharacterTagSelection();
      }
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Control' || event.key === 'Meta') clearCharacterTagSelection();
    });
    el.characterGroups.addEventListener('click', (event) => {
      const addCombo = event.target.closest?.('[data-group-add-combo]');
      if (addCombo) {
        event.preventDefault();
        addCharacterGroupToCombo(addCombo.dataset.groupAddCombo);
        return;
      }
      const deleteGroup = event.target.closest?.('[data-group-delete]');
      if (deleteGroup) {
        event.preventDefault();
        deleteCharacterGroup(deleteGroup.dataset.groupDelete);
        return;
      }
      const pencil = event.target.closest?.('[data-group-rename]');
      if (pencil) {
        event.preventDefault();
        startCharacterGroupRename(pencil.dataset.groupRename);
        return;
      }
      const remove = event.target.closest?.('[data-group-remove]');
      if (remove) {
        event.preventDefault();
        removeTagFromCharacterGroup(remove.dataset.groupRemove, remove.dataset.tag);
      }
    });
    el.characterGroups.addEventListener('dblclick', (event) => {
      const title = event.target.closest?.('[data-group-title]');
      if (!title) return;
      event.preventDefault();
      startCharacterGroupRename(title.dataset.groupTitle);
    });
    el.characterGroups.addEventListener('keydown', (event) => {
      const input = event.target.closest?.('[data-group-input]');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitCharacterGroupRename(input.dataset.groupInput);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelCharacterGroupRename();
      }
    });
    el.characterGroups.addEventListener('focusout', (event) => {
      const input = event.target.closest?.('[data-group-input]');
      if (!input) return;
      const id = input.dataset.groupInput;
      setTimeout(() => {
        if (state.characterGroupEditingId === id) commitCharacterGroupRename(id);
      }, 0);
    });
    el.characterPortrait.addEventListener('click', () => el.characterPortraitInput.click());
    el.characterPortrait.addEventListener('mouseenter', () => { hoveredCharacterPortrait = true; });
    el.characterPortrait.addEventListener('mouseleave', () => { hoveredCharacterPortrait = false; });
    el.characterPortraitInput.addEventListener('change', () => {
      const file = el.characterPortraitInput.files?.[0];
      el.characterPortraitInput.value = '';
      if (file) handleCharacterPortrait(file);
    });
    [el.characterName, el.characterSource, el.characterTags,
      el.characterNotes].forEach((field) => {
      field.addEventListener('input', () => {
        markCharacterDirty(true);
        if (field === el.characterTags) updateCharacterTagPreview();
      });
    });
    document.addEventListener('paste', (event) => {
      if (!hoveredCharacterPortrait || !el.viewCard.classList.contains('is-active')) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      const items = event.clipboardData?.items ? [...event.clipboardData.items] : [];
      for (const item of items) {
        if (!item.type || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          handleCharacterPortrait(file);
          return;
        }
      }
    });

    el.galleryAddBtnTop.addEventListener('click', openGalleryAdd);
    el.galleryList.addEventListener('click', async (event) => {
      const edit = event.target.closest('[data-gallery-edit]');
      if (edit) {
        event.preventDefault();
        const work = (state.galleryWorks || []).find((item) => String(item.id) === String(edit.dataset.galleryEdit));
        openGalleryEdit(work);
        return;
      }
      const remove = event.target.closest('[data-gallery-delete]');
      if (remove) {
        event.preventDefault();
        await deleteGalleryWork(remove.dataset.galleryDelete);
        return;
      }
      const copy = event.target.closest('[data-gallery-copy]');
      if (copy) {
        event.preventDefault();
        const card = copy.closest('[data-gallery-id]');
        const work = (state.galleryWorks || []).find((item) => String(item.id) === String(card?.dataset.galleryId));
        const field = copy.dataset.galleryCopy;
        const labels = {
          seed: '种子码', artist: '画师串', subjectPrompt: '主体提示词',
          qualityPrompt: '质量提示词', loras: 'LoRA',
        };
        const value = String(work?.[field] || '').trim();
        if (!value) {
          toast('该字段为空', 'info', 1800);
          return;
        }
        const ok = await copyTextToClipboard(value);
        if (ok) toast(`${labels[field] || '内容'}已复制到剪贴板`, 'info', 1800);
        else toast('复制失败', 'error', 2400);
        return;
      }
      const add = event.target.closest('[data-gallery-new]');
      if (!add) return;
      event.preventDefault();
      openGalleryAdd();
    });
    el.galleryPreviewImg.addEventListener('load', updateGalleryPreviewDimensions);
    el.galleryList.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('[data-gallery-drag]');
      if (!handle) return;
      const card = handle.closest('.gallery-card[data-gallery-id]');
      if (card) startGalleryDrag(card, event);
    });
    el.galleryBackBtn.addEventListener('click', closeGalleryAdd);
    el.gallerySaveBtn.addEventListener('click', saveGalleryWork);
    el.galleryPreviewFrame.addEventListener('click', () => el.galleryPreviewInput.click());
    el.galleryPreviewInput.addEventListener('change', () => {
      const file = el.galleryPreviewInput.files?.[0];
      el.galleryPreviewInput.value = '';
      if (file) handleGalleryPreviewFile(file);
    });
    el.galleryPreviewFrame.addEventListener('mouseenter', () => { hoveredGalleryPreview = true; });
    el.galleryPreviewFrame.addEventListener('mouseleave', () => { hoveredGalleryPreview = false; });
    document.addEventListener('paste', (event) => {
      if (!hoveredGalleryPreview || el.galleryAddView.hidden || !el.viewGallery.classList.contains('is-active')) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      const items = event.clipboardData?.items ? [...event.clipboardData.items] : [];
      for (const item of items) {
        if (!item.type || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          handleGalleryPreviewFile(file);
          return;
        }
      }
    });

    document.querySelectorAll('input[name="engine"]').forEach((input) => {
      input.addEventListener('change', syncCfgOpen);
    });

    document.addEventListener('keydown', (event) => {
      if (!el.glossaryAddBackdrop.hidden) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeGlossaryAddDialog();
        }
        return;
      }
      if (!el.confirmBackdrop.hidden) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeConfirmDialog(false);
        }
        return;
      }
      const inline = event.target.closest && event.target.closest('.inline-edit');
      if (inline) {
        /* 相近词条浮窗打开时，Tab 补全当前高亮项，↑↓ 换选，Esc 先关浮窗再说 */
        if (tagSuggestOpen()) {
          if (event.key === 'Tab') {
            event.preventDefault();
            applyTagSuggestion(tagSuggestItems[tagSuggestActive]);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setTagSuggestActive(tagSuggestActive + 1);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setTagSuggestActive(tagSuggestActive - 1);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            hideTagSuggest();
            return;
          }
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          hideTagSuggest();
          commitInlineEdit();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          hideTagSuggest();
          cancelInlineEdit();
          return;
        }
        return;
      }
      /* 选中词块后 Backspace / Delete 删除（编辑态已在上面拦掉，此处不会误删字符） */
      if (event.key === 'Escape' && state.glossaryAdd.picking) {
        event.preventDefault();
        exitGlossaryPick();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (state.glossaryAdd.picking) return;
        if (!el.modalBackdrop.hidden || !el.confirmBackdrop.hidden) return;
        if (!el.imageViewer.hidden || !el.characterPickerPanel.hidden) return;
        if (!el.viewTranslate.classList.contains('is-active')) return;
        if (!state.blocks || state.phase === 'translating') return;
        const bid = selectedBlockIdForDelete();
        if (!bid) return;
        event.preventDefault();
        deleteSelectedBlock(bid);
        return;
      }
      if (event.key === 'Escape') {
        if (!el.imageViewer.hidden) { closeImageViewer(); return; }
        if (!el.characterPickerPanel.hidden) { closeCharacterPicker(); return; }
        if (!el.modalBackdrop.hidden) { closeSettings(); return; }
        if (!el.helpPop.hidden) { hideHelp(); return; }
      }
      if (event.key.toLowerCase() === 'z' && (event.ctrlKey || event.metaKey) && !event.shiftKey
          && el.modalBackdrop.hidden && el.confirmBackdrop.hidden) {
        const active = document.activeElement;
        const editing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
          && active.getClientRects().length > 0;
        const programmaticTarget = active === el.composerInput ? 'composer'
          : active === el.sourceText ? 'source'
          : null;
        const topAction = actionUndoStack[actionUndoStack.length - 1];
        const wardrobeInsertUndo = topAction?.kind === 'wardrobe-insert'
          && (!editing || (topAction.guard && active
            && active.id === topAction.guard.id
            && active.value === topAction.guard.value));
        if (wardrobeInsertUndo) {
          event.preventDefault();
          history.programmaticUndo = false;
          history.programmaticTarget = null;
          undoLastAction();
          return;
        }
        if (history.programmaticUndo && programmaticTarget && history.programmaticTarget === programmaticTarget) {
          event.preventDefault();
          history.programmaticUndo = false;
          history.programmaticTarget = null;
          undoLast();
          return;
        }
        const clearUndo = topAction?.kind === 'clear'
          && active === el.composerInput && !el.composerInput.value;
        const guardedAction = topAction?.guard && active
          && active.id === topAction.guard.id
          && active.value === topAction.guard.value;
        if (topAction && (!editing || clearUndo || guardedAction)) {
          event.preventDefault();
          undoLastAction();
          return;
        }
        if (!editing) {
          event.preventDefault();
          history.programmaticUndo = false;
          history.programmaticTarget = null;
          undoLast();
        }
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && el.modalBackdrop.hidden) {
        event.preventDefault();
        if (state.phase === 'translating') return;
        if (state.phase !== 'idle') {
          startTranslation(el.sourceText.value);
        } else {
          startTranslation(el.composerInput.value);
        }
      }
    });

    bindHoverLinking();
  }

  async function init() {
    cacheElements();
    bindEvents();

    if (location.protocol === 'file:') {
      el.bootError.hidden = false;
      return;
    }

    restoreDraft();
    updateMeter();
    history.last = snapshotState();
    initSessions();
    detectChrome();

    /* health 走服务端缓存，不阻塞首屏：先渲染，引擎状态芯片稍后更新 */
    await loadConfig();
    refreshHealth();
    loadGlossary();
    loadRecordLists();
    loadPresets();
    loadCharacterFoldCards();
    updateEngineChip();
    updateHardware();
    setInterval(updateHardware, 3000);
    commitHistory();
    setInterval(refreshHealth, 90000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* debug / test hooks (harmless in production, useful for automated checks) */
  window.SPEC = {
    version: '0.1.0',
    getState: () => ({
      phase: state.phase,
      view: state.view,
      engine: state.config?.engine || null,
      engineUsed: state.lastEngine,
      chrome: state.chromeAvailability,
      blocks: state.blocks,
      translations: state.translations,
      favoriteSourceId: state.favoriteSourceId,
      warnings: state.warnings,
      progress: state.progressText,
      error: state.error ? { title: state.error.title, message: state.error.message } : null,
      health: state.health,
      config: state.config,
      glossary: state.glossary ? Object.keys(state.glossary).length : 0,
    }),
    setPrompt(text) {
      el.composerInput.value = String(text || '');
      el.composerInput.dispatchEvent(new Event('input', { bubbles: true }));
    },
    translate(text) { return startTranslation(text == null ? el.composerInput.value : text); },
    backToInput,
    openSettings,
    closeSettings,
    switchView,
    parsePrompt,
    splitTags,
    splitSentences,
  };
})();
