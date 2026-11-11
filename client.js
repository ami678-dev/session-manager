window.__ModuleLoader__.load({
  id: '@local/session-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace and the local preference key. */
    const NS = 'sessionManager';
    const PREFS_KEY = 'dsh.session-manager.v1';

    const MAX_TOASTS = 4;
    const AUTO_DISMISS_MS = 8000;
    const RESOLVE_DISMISS_MS = 2000;
    const DEDUPE_MS = 10000;
    const ERROR_SUPPRESS_MS = 5000;
    const PENDING_KINDS = new Set(['approval', 'question', 'plan-review', 'reminder']);
    const STICKY_KINDS = new Set([...PENDING_KINDS, 'scheduled']);
    const COALESCED_KINDS = new Set([...PENDING_KINDS, 'scheduled']);

    // The order of these entries is the waterfall order; see `wireUiSession`.
    const KIND_TITLE_KEY = {
      approval: 'notice.approval',
      question: 'notice.question',
      'plan-review': 'notice.planReview',
      reminder: 'notice.reminder',
      completed: 'notice.completed',
      error: 'notice.error',
      deleted: 'notice.deleted',
      scheduled: 'notice.scheduled',
      warning: 'notice.warning',
      test: 'notice.test',
    };

    const en = {
      untitled: 'Untitled session',
      'preview.title': 'Alert preview',
      'sound.on': 'Alerts on — click to mute, Shift+click to preview',
      'sound.off': 'Alerts muted — click to enable',
      'notice.approval': 'Approval needed',
      'notice.question': 'Answer needed',
      'notice.planReview': 'Plan review',
      'notice.reminder': 'Action needed',
      'notice.completed': 'Session finished',
      'notice.error': 'Session error',
      'notice.deleted': 'Session deleted',
      'notice.scheduled': 'Deletion scheduled',
      'notice.warning': 'Cleanup notice',
      'notice.test': 'Preview alert',
      'notice.testBody': 'Popups and sound are working.',
      'notice.dismiss': 'Dismiss',
      'notice.resolved': 'Handled',
      'delete.menu': 'Delete archived session…',
      'delete.title': 'Delete archived session?',
      'delete.desc': 'The session record for “{title}” — messages, title, approval and question history — and its subagent sessions will be permanently deleted. This cannot be undone.',
      'delete.keepTitle': 'What stays untouched',
      'delete.keepFiles': 'Files and generated documents in the workspace',
      'delete.keepAttachments': 'Attachments',
      'delete.keepSchedules': 'Scheduled tasks (a task that still targets this session may no longer be able to wake it)',
      'delete.cancel': 'Cancel',
      'delete.confirm': 'Delete permanently',
      'delete.pending': 'Deleting…',
      'delete.failed': 'Delete failed: {message}',
      'delete.notArchived': 'This session is no longer archived.',
      'delete.sessionLive': 'Close this session first. If you just archived it, wait a moment or reload the page and try again.',
      'delete.sessionActive': 'This session is still running. Stop it before deleting.',
      'delete.unauthorized': 'Your sign-in has expired or this origin is not trusted. Reload the page and try again.',
      'delete.unavailable': 'The delete service is unavailable. Refresh the page and confirm the plugin is enabled.',
      'delete.warningTitle': 'Cleanup incomplete',
      'delete.keptSchedules': 'Kept {count} scheduled task(s) that referenced it.',
      'delete.childSessions': 'Also deleted {count} subagent session(s).',
      'delete.restartRequired': 'This session is held by the running DSH process. Deletion is scheduled; restart DSH and it will complete automatically.',
      'delete.filesOption': 'Also move the related log files to the Recycle Bin (recoverable)',
      'batch.menu': 'Batch clean archived sessions…',
      'batch.title': 'Batch clean archived sessions',
      'batch.desc': 'Select the archived sessions to delete permanently. Sessions still held by the running DSH process are scheduled and removed on the next DSH start.',
      'batch.search': 'Search by title or session ID',
      'batch.selectAll': 'Select all',
      'batch.selected': '{count} selected',
      'batch.loading': 'Loading archived sessions…',
      'batch.empty': 'There are no archived sessions.',
      'batch.noMatch': 'No archived sessions match the search.',
      'batch.loadFailed': 'Could not load archived sessions. Refresh the page and try again.',
      'batch.delete': 'Delete ({count})',
      'batch.deleting': 'Deleting…',
      'batch.done': 'Done',
      'batch.resultDeleted': '{count} deleted',
      'batch.resultScheduled': '{count} scheduled for the next DSH start',
      'batch.resultSkipped': '{count} skipped',
      'batch.resultFailed': '{count} failed',
      'batch.deletedToast': 'Deleted {count} archived session(s).',
      'batch.scheduledToast': '{count} session(s) are scheduled to be deleted after DSH restarts.',
      'batch.partialToast': 'Deleted {deleted}, scheduled {scheduled}, skipped or failed {failed}.',
      'batch.reason': '{title}: {reason}',
      'batch.moveToTrash': 'Move the log files to the Recycle Bin (recoverable)',
      'trash.label': 'Recycle Bin',
      'cleanup.menu': 'Clean up leftover session files…',
      'cleanup.title': 'Clean up leftover files',
      'cleanup.desc': 'Leftover session directories, stale deletion files and empty directories found under the session store. None of them belongs to an existing session. Select the leftovers to move to the Recycle Bin.',
      'cleanup.loading': 'Scanning the session store…',
      'cleanup.loadFailed': 'Could not scan the session store. Refresh the page and try again.',
      'cleanup.empty': 'No leftover files found.',
      'cleanup.kind.sessionDir': 'Session directory',
      'cleanup.kind.tombstone': 'Stale deletion file',
      'cleanup.kind.emptyDir': 'Empty directory',
      'cleanup.openLocation': 'Open location',
      'cleanup.truncated': 'Only the first {count} leftovers are listed. Clean them up and scan again for more.',
      'cleanup.moveAll': 'Move to Recycle Bin ({count})',
      'cleanup.moving': 'Moving to the Recycle Bin…',
      'cleanup.resultMoved': '{count} moved to the Recycle Bin',
      'cleanup.resultFailed': '{count} failed',
      'cleanup.toast': 'Moved {moved} leftover item(s) to the Recycle Bin.',
      'cleanup.partialToast': 'Moved {moved} leftover item(s) to the Recycle Bin, {failed} failed.',
      'cleanup.reason': 'Could not move it: {reason}',
      'aria.notifications': 'Session alerts',
      'aria.close': 'Close',
    };

    const zh = {
      untitled: '未命名会话',
      'preview.title': '提醒预览',
      'sound.on': '提醒已开启 — 点击静音，Shift+点击预览',
      'sound.off': '提醒已静音 — 点击开启',
      'notice.approval': '需要审批',
      'notice.question': '需要你的回答',
      'notice.planReview': '计划待审阅',
      'notice.reminder': '需要处理',
      'notice.completed': '会话已完成',
      'notice.error': '会话出错',
      'notice.deleted': '已删除会话',
      'notice.scheduled': '已安排删除',
      'notice.warning': '清理提示',
      'notice.test': '示例提醒',
      'notice.testBody': '弹窗与声音工作正常。',
      'notice.dismiss': '关闭',
      'notice.resolved': '已处理',
      'delete.menu': '删除已归档会话…',
      'delete.title': '删除已归档会话？',
      'delete.desc': '「{title}」的会话记录（消息、标题、审批/提问记录）及其子代理会话将被永久删除，无法恢复。',
      'delete.keepTitle': '以下内容会保留',
      'delete.keepFiles': '工作区中的文件与已生成文档',
      'delete.keepAttachments': '附件',
      'delete.keepSchedules': '定时任务（若任务仍指向该会话，之后可能无法再唤醒它）',
      'delete.cancel': '取消',
      'delete.confirm': '永久删除',
      'delete.pending': '正在删除…',
      'delete.failed': '删除失败：{message}',
      'delete.notArchived': '该会话已不在归档列表中。',
      'delete.sessionLive': '请先关闭该会话；若刚归档，请稍等片刻或刷新页面后重试。',
      'delete.sessionActive': '该会话仍在运行，请先停止后再删除。',
      'delete.unauthorized': '登录状态已失效或当前地址不受信任，请刷新页面后重试。',
      'delete.unavailable': '删除服务不可用，请刷新页面并确认插件已启用。',
      'delete.warningTitle': '清理未完全完成',
      'delete.keptSchedules': '已保留 {count} 个引用它的定时任务。',
      'delete.childSessions': '已一并删除 {count} 个子代理会话。',
      'delete.restartRequired': '该会话仍被当前 DSH 进程持有。已安排删除，请重启 DSH，启动后会自动完成。',
      'delete.filesOption': '同时删除相关文件（移入回收站，可恢复）',
      'batch.menu': '批量清理已归档会话…',
      'batch.title': '批量清理已归档会话',
      'batch.desc': '选择要永久删除的已归档会话。仍被当前 DSH 进程持有的会话将安排在下次启动 DSH 时自动删除。',
      'batch.search': '按标题或会话 ID 搜索',
      'batch.selectAll': '全选',
      'batch.selected': '已选 {count} 个',
      'batch.loading': '正在加载归档会话…',
      'batch.empty': '没有已归档会话。',
      'batch.noMatch': '没有匹配的会话。',
      'batch.loadFailed': '无法加载归档会话，请刷新页面后重试。',
      'batch.delete': '删除（{count}）',
      'batch.deleting': '正在删除…',
      'batch.done': '完成',
      'batch.resultDeleted': '已删除 {count} 个',
      'batch.resultScheduled': '{count} 个将在下次启动 DSH 时删除',
      'batch.resultSkipped': '已跳过 {count} 个',
      'batch.resultFailed': '失败 {count} 个',
      'batch.deletedToast': '已删除 {count} 个已归档会话。',
      'batch.scheduledToast': '{count} 个会话将在重启 DSH 后删除。',
      'batch.partialToast': '已删除 {deleted} 个，已安排 {scheduled} 个，跳过或失败 {failed} 个。',
      'batch.reason': '{title}：{reason}',
      'batch.moveToTrash': '删除时把日志文件移入回收站（可恢复）',
      'trash.label': '回收站',
      'cleanup.menu': '清理残留会话文件…',
      'cleanup.title': '清理残留文件',
      'cleanup.desc': '以下是会话存储中不属于任何现有会话的残留会话目录、残留删除文件与空目录。请选择要移入回收站的项目。',
      'cleanup.loading': '正在扫描会话存储…',
      'cleanup.loadFailed': '无法扫描会话存储，请刷新页面后重试。',
      'cleanup.empty': '没有发现残留文件。',
      'cleanup.kind.sessionDir': '会话目录',
      'cleanup.kind.tombstone': '残留删除文件',
      'cleanup.kind.emptyDir': '空目录',
      'cleanup.openLocation': '打开位置',
      'cleanup.truncated': '仅列出前 {count} 项，清理后可再次扫描。',
      'cleanup.moveAll': '移入回收站（{count}）',
      'cleanup.moving': '正在移入回收站…',
      'cleanup.resultMoved': '已移入回收站 {count} 项',
      'cleanup.resultFailed': '失败 {count} 项',
      'cleanup.toast': '已将 {moved} 项残留文件移入回收站。',
      'cleanup.partialToast': '已将 {moved} 项移入回收站，{failed} 项失败。',
      'cleanup.reason': '移动失败：{reason}',
      'aria.notifications': '会话提醒',
      'aria.close': '关闭',
    };

    const CSS = `
.sm-toasts{position:fixed;top:52px;right:16px;z-index:500;display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px));pointer-events:none;font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary)}
.sm-toast{position:relative;display:flex;align-items:flex-start;gap:8px;padding:10px 8px 10px 14px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.18));pointer-events:auto;overflow:hidden}
.sm-toast__accent{position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-brand-primary)}
.sm-toast--approval .sm-toast__accent,.sm-toast--warning .sm-toast__accent{background:var(--dsw-alias-state-warn-primary)}
.sm-toast--question .sm-toast__accent,.sm-toast--plan-review .sm-toast__accent{background:var(--dsw-alias-brand-primary)}
.sm-toast--completed .sm-toast__accent,.sm-toast--deleted .sm-toast__accent{background:var(--dsw-alias-state-success-primary)}
.sm-toast--error .sm-toast__accent{background:var(--dsw-alias-state-error-primary)}
.sm-toast--openable{cursor:pointer}
.sm-toast--openable:hover{border-color:var(--dsw-alias-border-l2)}
.sm-toast--openable:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sm-toast__main{flex:1;min-width:0}
.sm-toast__kind{font-size:10px;line-height:14px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}
.sm-toast__title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-toast__detail{color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sm-toast__resolved{color:var(--dsw-alias-state-success-primary);font-size:11px;margin-top:2px}
.sm-toast__actions{display:flex;align-items:center;gap:2px;flex:none}
.sm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 10px;font:inherit;cursor:pointer}
.sm-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.sm-btn:disabled{opacity:.5;cursor:default}
.sm-btn--ghost{border-color:transparent;color:var(--dsw-alias-brand-primary);padding:3px 6px}
.sm-btn--ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.sm-icon-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:16px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.sm-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sm-btn:focus-visible,.sm-icon-btn:focus-visible,.sm-menu-item:focus-visible,.sm-footer-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sm-footer-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);width:28px;height:28px;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.sm-footer-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sm-menu-item{appearance:none;border:none;background:transparent;color:var(--dsw-alias-state-error-primary);display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border-radius:var(--dsw-radius-md);font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
@media (hover:hover){.sm-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}}
.sm-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger)}
.sm-menu-item__label{white-space:nowrap}
.sm-modal-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;pointer-events:auto}
.sm-modal-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0) 0 0;backdrop-filter:var(--dsw-mask-blur)}
.sm-modal-mask:after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);animation:sm-modal-fade var(--ds-transition-duration) var(--ds-ease-in-out)}
.sm-modal{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(560px,100%);max-height:calc(100vh - 48px);padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);animation:sm-modal-enter var(--ds-transition-duration) var(--ds-ease-in-out)}
.sm-modal:focus{outline:none}
.sm-modal__content{display:flex;flex-direction:column;min-height:0;overflow:hidden;width:100%}
.sm-modal__header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px;flex:none}
.sm-modal__title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sm-modal__close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.sm-modal__close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sm-modal__close:disabled{opacity:.4;cursor:not-allowed}
.sm-modal__description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary);flex:none}
.sm-modal__body{display:flex;flex-direction:column;min-width:0;min-height:0;margin-top:20px;padding:6px 24px 0;overflow:auto}
.sm-modal__footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px;flex:none}
.sm-footer-check{display:inline-flex;align-items:center;gap:6px;flex:none;margin-right:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.sm-footer-check:hover{color:var(--dsw-alias-label-primary)}
.sm-footer-check input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.sm-footer-check input:disabled{cursor:not-allowed}
.sm-footer-check:has(input:disabled){cursor:default;opacity:.4}
.sm-modal .sm-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}
.sm-modal .sm-btn--md{height:36px}
.sm-modal .sm-btn:disabled{cursor:not-allowed;opacity:.4}
.sm-modal .sm-btn--outline{box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsw-alias-border-l3)}
.sm-modal .sm-btn--danger{color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsw-alias-border-l3)}
.sm-modal .sm-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
@media (hover:hover){.sm-modal .sm-btn--outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sm-modal .sm-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);box-shadow:none;color:var(--dsw-alias-state-error-primary)}.sm-modal .sm-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}}
.sm-modal .sm-btn:focus-visible,.sm-modal__close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.sm-dialog__warn{border-radius:var(--dsw-radius-md);padding:12px 14px;margin:0;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsw-alias-border-l2)}
.sm-dialog__warn-title{margin:0 0 6px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sm-dialog__list{margin:0;padding-left:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sm-dialog__list li{margin:2px 0}
.sm-dialog__error{margin:12px 0 0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.sm-dialog__status{margin:12px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.sm-batch-toolbar{display:flex;align-items:center;gap:10px;flex:none}
.sm-batch-search{flex:1;min-width:0;box-sizing:border-box;height:36px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);outline:none;padding:6px 12px;font-family:inherit;font-size:14px;line-height:22px}
.sm-batch-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.sm-batch-search:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.sm-batch-count{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.sm-batch-all{display:flex;align-items:center;gap:10px;margin-top:12px;padding:6px 8px;border-radius:var(--dsw-radius-sm);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sm-batch-all:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sm-batch-all input,.sm-batch-row input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.sm-batch-list{display:flex;flex-direction:column;gap:1px;max-height:min(42vh,320px);overflow:auto;margin-top:4px}
.sm-batch-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:var(--dsw-radius-sm);font-size:14px;line-height:20px;cursor:pointer}
.sm-batch-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sm-batch-row__title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.sm-batch-row__meta{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.sm-batch-empty{padding:26px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.sm-batch-results{display:flex;flex-direction:column;gap:10px}
.sm-batch-summary{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px;line-height:22px}
.sm-batch-summary__ok{color:var(--dsw-alias-state-success-primary)}
.sm-batch-summary__scheduled{color:var(--dsw-alias-state-warn-primary)}
.sm-batch-summary__failed{color:var(--dsw-alias-state-error-primary)}
.sm-batch-summary__skipped{color:var(--dsw-alias-label-secondary)}
.sm-batch-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sm-batch-failures{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sm-batch-failure__title{color:var(--dsw-alias-label-primary);font-weight:500}
@keyframes sm-modal-enter{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
@keyframes sm-modal-fade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.sm-modal,.sm-modal-mask:after{animation:none}}
`;

    let nextNoticeId = 0;

    // ── tiny observable store ────────────────────────────────────────────────

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(patch) {
          state = { ...state, ...patch };
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.error('[session-manager] store listener failed', error);
            }
          }
        },
      };
    }

    function loadPrefs() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return { muted: false };
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return { muted: false };
        const parsed = JSON.parse(raw);
        return { muted: parsed && parsed.muted === true };
      } catch {
        return { muted: false };
      }
    }

    function savePrefs(prefs) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(PREFS_KEY, JSON.stringify({ muted: prefs.muted === true }));
        }
      } catch {
        /* preferences are best effort */
      }
    }

    // ── pure notice helpers (also exported for tests) ────────────────────────

    function noticeKey(notice) {
      return `${notice.kind}|${notice.sessionId || '-'}|${notice.detail || ''}`;
    }

    /**
     * Whether the whole notice card is a click target for opening its session.
     * Mirrors the "Open" button's own condition so the card and the button can
     * never disagree.
     */
    function noticeOpenable(notice, canOpen) {
      return Boolean(notice && notice.sessionId && canOpen !== false);
    }

    /**
     * Append one notice, skipping a visible duplicate and capping the stack.
     * Returns the same array reference when nothing changed.
     */
    function addNotice(list, notice, max = MAX_TOASTS, now = Date.now()) {
      const key = noticeKey(notice);
      // Pending-action duplicates are the same outstanding request, and a
      // repeated scheduled notice is the same queued deletion. Completions and
      // errors are discrete events and must alert every time.
      if (COALESCED_KINDS.has(notice.kind)
        && list.some((entry) => !entry.resolved
          && noticeKey(entry) === key
          && now - entry.createdAt < DEDUPE_MS)) {
        return list;
      }
      const next = [...list, notice];
      while (next.length > max) {
        // Never drop the notice that just arrived: prefer the oldest existing
        // non-sticky entry, then the oldest existing entry.
        const index = next.findIndex((entry, position) => position < next.length - 1 && !entry.sticky);
        next.splice(index === -1 ? 0 : index, 1);
      }
      return next;
    }

    function pendingKindOf(pending) {
      if (!pending || typeof pending !== 'object') return null;
      if (pending.kind === 'approval') return 'approval';
      if (pending.kind === 'plan-review') return 'plan-review';
      if (pending.kind === 'question') return 'question';
      return 'reminder';
    }

    function pendingKeyOf(pending) {
      if (!pending || typeof pending !== 'object') return '';
      const questionId = Array.isArray(pending.questions) ? pending.questions[0]?.id : undefined;
      return String(pending.key ?? pending.callId ?? questionId ?? pending.kind ?? '');
    }

    /**
     * Pure diff of two `uiSession.sessionStatus` snapshots into the alert
     * decisions the caller should apply. Kept free of React and services so
     * the approval/completion rules can be tested without a browser.
     */
    function statusTransitions(previous, next) {
      const out = [];
      const ids = new Set([...previous.keys(), ...next.keys()]);
      for (const id of ids) {
        const before = previous.get(id) || {};
        const after = next.get(id) || {};
        const wasPending = before.pendingInteraction;
        const isPending = after.pendingInteraction;
        if (isPending && pendingKeyOf(isPending) !== pendingKeyOf(wasPending)) {
          out.push({
            type: 'pending',
            sessionId: id,
            kind: pendingKindOf(isPending),
            interaction: isPending,
          });
        } else if (!isPending && wasPending) {
          out.push({ type: 'resolved', sessionId: id });
        }
        if (before.running === true && after.running === false && !isPending) {
          // A turn that ends while an interaction is still pending is waiting
          // for the user, not finished; the pending notice is the useful one.
          out.push({ type: 'completed', sessionId: id });
        }
      }
      return out;
    }

    // ── sound ────────────────────────────────────────────────────────────────

    function createAudio() {
      let audioContext = null;
      let gestureInstalled = false;

      const installGesture = () => {
        if (gestureInstalled) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        gestureInstalled = true;
        const resume = () => {
          try {
            void audioContext?.resume?.();
          } catch {
            /* optional */
          }
        };
        window.addEventListener('pointerdown', resume, { once: true });
        window.addEventListener('keydown', resume, { once: true });
      };

      const ensure = () => {
        if (audioContext) return audioContext;
        const Ctor = typeof window !== 'undefined'
          ? (window.AudioContext || window.webkitAudioContext)
          : undefined;
        if (typeof Ctor !== 'function') return null;
        try {
          audioContext = new Ctor();
        } catch {
          return null;
        }
        installGesture();
        return audioContext;
      };

      const tone = (ac, frequency, startAt, duration, gainValue) => {
        const oscillator = ac.createOscillator();
        const gain = ac.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
        oscillator.connect(gain);
        gain.connect(ac.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + duration + 0.02);
      };

      const play = (kind) => {
        const ac = ensure();
        if (!ac) return;
        if (ac.state === 'suspended') {
          try {
            void ac.resume?.();
          } catch {
            /* optional */
          }
          return;
        }
        try {
          const now = ac.currentTime + 0.02;
          if (kind === 'approval') {
            tone(ac, 880, now, 0.12, 0.08);
            tone(ac, 1046, now + 0.14, 0.14, 0.08);
          } else if (kind === 'question' || kind === 'plan-review') {
            tone(ac, 660, now, 0.12, 0.07);
            tone(ac, 880, now + 0.14, 0.14, 0.07);
          } else if (kind === 'error') {
            tone(ac, 440, now, 0.14, 0.07);
            tone(ac, 330, now + 0.16, 0.16, 0.07);
          } else if (kind === 'completed' || kind === 'deleted') {
            tone(ac, 784, now, 0.16, 0.06);
          } else {
            tone(ac, 784, now, 0.14, 0.06);
          }
        } catch {
          /* sound is optional */
        }
      };

      const close = () => {
        try {
          void audioContext?.close?.();
        } catch {
          /* optional */
        }
        audioContext = null;
      };

      return { play, close };
    }

    // ── icons ────────────────────────────────────────────────────────────────

    function BellIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('path', { d: 'M18 9a6 6 0 1 0-12 0c0 3.2-1.2 5.1-2 6.2-.3.4 0 .8.4.8h15.2c.4 0 .7-.4.4-.8-.8-1.1-2-3-2-6.2z' }),
      h('path', { d: 'M10 19a2.2 2.2 0 0 0 4 0' }));
    }

    function BellOffIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('path', { d: 'M18 9a6 6 0 0 0-9.3-5' }),
      h('path', { d: 'M6 9c0 3.2-1.2 5.1-2 6.2-.3.4 0 .8.4.8h9.2' }),
      h('path', { d: 'M10 19a2.2 2.2 0 0 0 4 0' }),
      h('path', { d: 'M3 3l18 18' }));
    }

    function TrashIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }),
      h('path', { d: 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13' }),
      h('path', { d: 'M10 11v6M14 11v6' }));
    }

    function EraserIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      h('path', { d: 'm7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21' }),
      h('path', { d: 'M22 21H7' }),
      h('path', { d: 'm5 11 9 9' }));
    }

    // ── components ───────────────────────────────────────────────────────────

    class EntryBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        console.error('[session-manager] slot entry failed', error);
      }

      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    /** Wrap one slot entry so a rendering failure only blanks this plugin. */
    function guardEntry(name, Component) {
      return function SessionManagerEntry(props) {
        return h(EntryBoundary, null, h(Component, props));
      };
    }

    function focusableNodes(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return [];
      try {
        return Array.from(root.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )).filter((node) => !node.disabled);
      } catch {
        return [];
      }
    }

    function Toast({ notice, actions, t, showOpen }) {
      React.useEffect(() => {
        const ms = notice.resolved ? RESOLVE_DISMISS_MS : (notice.sticky ? 0 : AUTO_DISMISS_MS);
        if (!ms) return undefined;
        const timer = setTimeout(() => actions.dismiss(notice.id), ms);
        return () => clearTimeout(timer);
      }, [notice.id, notice.resolved, notice.sticky, actions]);

      const openable = noticeOpenable(notice, showOpen);
      const open = () => actions.open(notice.sessionId);
      return h('div', {
        className: `sm-toast sm-toast--${notice.kind}${openable ? ' sm-toast--openable' : ''}`,
        role: notice.kind === 'error' ? 'alert' : 'status',
        tabIndex: openable ? 0 : undefined,
        onClick: openable ? open : undefined,
        onKeyDown: openable ? (event) => {
          // Only keys pressed on the card itself; the buttons handle their
          // own Enter/Space activation.
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        } : undefined,
      },
      h('span', { className: 'sm-toast__accent', 'aria-hidden': true }),
      h('div', { className: 'sm-toast__main' },
        h('div', { className: 'sm-toast__kind' }, t(notice.kindKey)),
        h('div', { className: 'sm-toast__title', title: notice.title }, notice.title),
        notice.detail ? h('div', { className: 'sm-toast__detail', title: notice.detail }, notice.detail) : null,
        notice.resolved ? h('div', { className: 'sm-toast__resolved' }, t('notice.resolved')) : null),
      h('div', { className: 'sm-toast__actions' },
        h('button', {
          type: 'button',
          className: 'sm-icon-btn',
          'aria-label': t('notice.dismiss'),
          title: t('notice.dismiss'),
          onClick: (event) => {
            event.stopPropagation();
            actions.dismiss(notice.id);
          },
        }, '×')));
    }

    function ToastEntry({ view, actions, t, canOpen }) {
      const snapshot = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
      const translate = typeof t === 'function' ? t : (key) => key;
      let showOpen = true;
      try {
        showOpen = typeof canOpen === 'function' ? canOpen() !== false : true;
      } catch {
        showOpen = false;
      }
      return h(React.Fragment, null,
        h('style', null, CSS),
        snapshot.toasts.length === 0 ? null : h('div', {
          className: 'sm-toasts',
          'aria-label': translate('aria.notifications'),
        }, snapshot.toasts.map((notice) => h(Toast, {
          key: String(notice.id),
          notice,
          actions,
          t: translate,
          showOpen,
        }))));
    }

    function FooterActions({ view, actions, batch, cleanup, t }) {
      const snapshot = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
      const translate = typeof t === 'function' ? t : (key) => key;
      const label = snapshot.muted ? translate('sound.off') : translate('sound.on');
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'sm-footer-btn',
          'aria-label': translate('batch.menu'),
          title: translate('batch.menu'),
          onClick: () => batch.open(),
        }, h(TrashIcon, { size: 16 })),
        h('button', {
          type: 'button',
          className: 'sm-footer-btn',
          'aria-label': translate('cleanup.menu'),
          title: translate('cleanup.menu'),
          onClick: () => cleanup.open(),
        }, h(EraserIcon, { size: 16 })),
        h('button', {
          type: 'button',
          className: 'sm-footer-btn',
          'aria-pressed': !snapshot.muted,
          'aria-label': label,
          title: label,
          onClick: (event) => {
            if (event.shiftKey) actions.preview();
            else actions.toggleMuted();
          },
        }, h(snapshot.muted ? BellOffIcon : BellIcon, { size: 16 })));
    }

    function DeleteArchivedRow(props) {
      // The shipped slot always supplies both Hooks; a composition that does
      // not gets no row, and the body below keeps its Hook order invariant.
      if (typeof props.useWorkspaces !== 'function' || typeof props.useMenuOpenState !== 'function') {
        return null;
      }
      return h(DeleteArchivedRowBody, props);
    }

    function DeleteArchivedRowBody(props) {
      const { sessionId, displayTitle, requestDelete } = props;
      const translate = typeof props.t === 'function' ? props.t : (key) => key;
      const archived = props.useWorkspaces((state) => Array.isArray(state?.archivedSessionIds)
        && state.archivedSessionIds.includes(sessionId));
      const menu = props.useMenuOpenState();
      const setOpen = Array.isArray(menu) ? menu[1] : undefined;

      if (!archived) return null;

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'sm-menu-item',
        onClick: (event) => {
          try {
            event.stopPropagation();
          } catch {
            /* optional */
          }
          try {
            setOpen?.(false);
          } catch {
            /* optional */
          }
          if (typeof requestDelete === 'function') {
            requestDelete({ sessionId, title: displayTitle || translate('untitled') });
          }
        },
      },
      h(TrashIcon, { size: 14 }),
      h('span', { className: 'sm-menu-item__label' }, translate('delete.menu')));
    }

    /**
     * Host dialog markup and metrics copied from the installed Harness Client
     * modal (header 22/14/12/24, 16px title, 36px footer buttons, panel radius,
     * layer-2 surface). DSH's plugin guidance explicitly forbids importing the
     * primitives package at runtime, so the styles are reproduced here with the
     * stable `--dsw-*` design tokens instead.
     */
    function CloseIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        d: 'M4 4l8 8M12 4l-8 8',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
      }));
    }

    /**
     * Shared modal behavior: focus the first control, trap Tab, close on
     * Escape, restore focus, and never close while a request is in flight.
     */
    function useModalFocus(cardRef, initialRef, busyRef, requestClose) {
      const closeRef = React.useRef(requestClose);
      React.useEffect(() => {
        closeRef.current = requestClose;
      }, [requestClose]);

      React.useEffect(() => {
        let previous = null;
        try {
          previous = document.activeElement;
        } catch {
          /* optional */
        }
        try {
          initialRef?.current?.focus?.();
        } catch {
          /* optional */
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            if (!busyRef?.current) {
              try {
                event.stopPropagation();
              } catch {
                /* optional */
              }
              try {
                closeRef.current?.();
              } catch {
                /* optional */
              }
            }
            return;
          }
          if (event.key !== 'Tab') return;
          const nodes = focusableNodes(cardRef?.current);
          if (nodes.length === 0) {
            // An in-flight request disables the footer; keep focus inside
            // the dialog instead of letting Tab escape to the page behind.
            event.preventDefault();
            try {
              cardRef?.current?.focus?.();
            } catch {
              /* optional */
            }
            return;
          }
          const first = nodes[0];
          const last = nodes[nodes.length - 1];
          let active;
          try {
            active = document.activeElement;
          } catch {
            active = null;
          }
          if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        };
        try {
          document.addEventListener('keydown', onKey, true);
        } catch {
          /* optional */
        }
        return () => {
          try {
            document.removeEventListener('keydown', onKey, true);
          } catch {
            /* optional */
          }
          try {
            previous?.focus?.();
          } catch {
            /* optional */
          }
        };
      }, [cardRef, initialRef, busyRef]);
    }

    function ModalFrame({
      cardRef,
      titleId,
      descId,
      title,
      closeLabel,
      onClose,
      closeDisabled,
      description,
      footer,
      children,
    }) {
      return h('div', { className: 'sm-modal-root' },
        h('div', {
          className: 'sm-modal-mask',
          'aria-hidden': true,
          onClick: onClose,
        }),
        h('div', {
          ref: cardRef,
          className: 'sm-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          'aria-describedby': descId,
          tabIndex: -1,
        },
        h('div', { className: 'sm-modal__content' },
          h('div', { className: 'sm-modal__header' },
            h('h2', { id: titleId, className: 'sm-modal__title' }, title),
            h('button', {
              type: 'button',
              className: 'sm-modal__close',
              'aria-label': closeLabel,
              title: closeLabel,
              disabled: closeDisabled === true,
              onClick: onClose,
            }, h(CloseIcon))),
          description ? h('p', { id: descId, className: 'sm-modal__description' }, description) : null,
          h('div', { className: 'sm-modal__body' }, children)),
        h('div', { className: 'sm-modal__footer' }, footer)));
    }

    function ConfirmDialog({ request, actions, t }) {
      const cardRef = React.useRef(null);
      const cancelRef = React.useRef(null);
      const busy = request.busy === true;
      const busyRef = React.useRef(busy);
      React.useEffect(() => {
        busyRef.current = busy;
      }, [busy]);

      const title = request.title || t('untitled');
      const close = () => {
        if (!busy) actions.cancelDelete();
      };
      useModalFocus(cardRef, cancelRef, busyRef, close);

      return h(ModalFrame, {
        cardRef,
        titleId: 'sm-delete-title',
        descId: 'sm-delete-desc',
        title: t('delete.title'),
        closeLabel: t('aria.close'),
        onClose: close,
        closeDisabled: busy,
        description: t('delete.desc', { title }),
        footer: h(React.Fragment, null,
          h('label', {
            className: 'sm-footer-check',
            title: t('delete.filesOption'),
          },
          h('input', {
            type: 'checkbox',
            checked: request.moveToTrash === true,
            disabled: busy,
            onChange: (event) => actions.setMoveToTrash(event.target.checked),
          }),
          h('span', null, t('trash.label'))),
          h('button', {
            ref: cancelRef,
            type: 'button',
            className: 'sm-btn sm-btn--outline sm-btn--md',
            disabled: busy,
            onClick: close,
          }, t('delete.cancel')),
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn--danger sm-btn--md',
            disabled: busy,
            onClick: () => actions.confirmDelete(),
          }, t('delete.confirm'))),
      },
      h('div', { className: 'sm-dialog__warn' },
        h('h3', { className: 'sm-dialog__warn-title' }, t('delete.keepTitle')),
        h('ul', { className: 'sm-dialog__list' },
          h('li', null, t('delete.keepFiles')),
          h('li', null, t('delete.keepAttachments')),
          h('li', null, t('delete.keepSchedules')))),
      request.error ? h('div', { className: 'sm-dialog__error', role: 'alert' }, request.error) : null,
      busy ? h('div', { className: 'sm-dialog__status', role: 'status' }, t('delete.pending')) : null);
    }

    function ConfirmEntry({ view, actions, t }) {
      const snapshot = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
      const translate = typeof t === 'function' ? t : (key) => key;
      return h(React.Fragment, null,
        h('style', null, CSS),
        snapshot.confirm ? h(ConfirmDialog, {
          request: snapshot.confirm,
          actions,
          t: translate,
        }) : null);
    }

    function batchReasonOf(item, t) {
      if (item?.code === 'not-archived') return t('delete.notArchived');
      if (item?.code === 'session-active') return t('delete.sessionActive');
      if (item?.code === 'session-live') return t('delete.sessionLive');
      if (typeof item?.message === 'string' && item.message !== '') {
        return t('delete.failed', { message: item.message });
      }
      return t('delete.failed', { message: '' });
    }

    function BatchDialog({ snapshot, actions, t, titleOf }) {
      const cardRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const doneRef = React.useRef(null);
      const busyRef = React.useRef(snapshot.deleting === true);
      React.useEffect(() => {
        busyRef.current = snapshot.deleting === true;
      }, [snapshot.deleting]);
      React.useEffect(() => {
        if (snapshot.results) {
          try {
            doneRef.current?.focus?.();
          } catch {
            /* optional */
          }
        }
      }, [snapshot.results]);

      const close = () => actions.close();
      useModalFocus(cardRef, searchRef, busyRef, close);

      const selected = new Set(Array.isArray(snapshot.selected) ? snapshot.selected : []);
      const needle = String(snapshot.filter || '').trim().toLowerCase();
      const rows = [];
      for (const id of snapshot.ids || []) {
        const title = titleOf(id);
        if (!needle || title.toLowerCase().includes(needle) || id.toLowerCase().includes(needle)) {
          rows.push({ id, title });
        }
      }
      const selectedVisible = rows.reduce((count, row) => count + (selected.has(row.id) ? 1 : 0), 0);
      const allVisible = rows.length > 0 && selectedVisible === rows.length;
      const someVisible = selectedVisible > 0 && !allVisible;

      let body;
      let footer;
      if (snapshot.results) {
        const results = snapshot.results;
        const issues = Array.isArray(results.items)
          ? results.items.filter((item) => item.status === 'failed' || item.status === 'skipped')
          : [];
        body = h('div', { className: 'sm-batch-results' },
          h('div', { className: 'sm-batch-summary' },
            results.deleted > 0 ? h('span', { className: 'sm-batch-summary__ok' }, t('batch.resultDeleted', { count: results.deleted })) : null,
            results.scheduled > 0 ? h('span', { className: 'sm-batch-summary__scheduled' }, t('batch.resultScheduled', { count: results.scheduled })) : null,
            results.skipped > 0 ? h('span', { className: 'sm-batch-summary__skipped' }, t('batch.resultSkipped', { count: results.skipped })) : null,
            results.failed > 0 ? h('span', { className: 'sm-batch-summary__failed' }, t('batch.resultFailed', { count: results.failed })) : null),
          results.scheduled > 0 ? h('p', { className: 'sm-batch-note' }, t('delete.restartRequired')) : null,
          issues.length > 0 ? h('ul', { className: 'sm-batch-failures' },
            issues.map((item) => h('li', { key: item.sessionId },
              h('span', { className: 'sm-batch-failure__title' }, titleOf(item.sessionId)),
              batchReasonOf(item, t)))) : null);
        footer = h('button', {
          ref: doneRef,
          type: 'button',
          className: 'sm-btn sm-btn--primary sm-btn--md',
          onClick: close,
        }, t('batch.done'));
      } else {
        body = h(React.Fragment, null,
          h('div', { className: 'sm-batch-toolbar' },
            h('input', {
              ref: searchRef,
              type: 'search',
              className: 'sm-batch-search',
              value: snapshot.filter || '',
              placeholder: t('batch.search'),
              'aria-label': t('batch.search'),
              disabled: snapshot.deleting === true,
              onChange: (event) => actions.setFilter(event.target.value),
            }),
            h('span', { className: 'sm-batch-count' }, t('batch.selected', { count: selected.size }))),
          h('label', { className: 'sm-batch-all' },
            h('input', {
              type: 'checkbox',
              checked: allVisible,
              ref: (node) => {
                if (node) node.indeterminate = someVisible;
              },
              disabled: snapshot.deleting === true || rows.length === 0,
              onChange: () => actions.toggleAll(rows.map((row) => row.id)),
            }),
            h('span', null, t('batch.selectAll')),
            h('span', { className: 'sm-batch-row__meta' }, rows.length)),
          snapshot.loading
            ? h('div', { className: 'sm-batch-empty' }, t('batch.loading'))
            : snapshot.ids.length === 0
              ? h('div', { className: 'sm-batch-empty' }, t('batch.empty'))
              : rows.length === 0
                ? h('div', { className: 'sm-batch-empty' }, t('batch.noMatch'))
                : h('div', { className: 'sm-batch-list' },
                  rows.map((row) => h('label', { key: row.id, className: 'sm-batch-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.has(row.id),
                      disabled: snapshot.deleting === true,
                      onChange: () => actions.toggle(row.id),
                    }),
                    h('span', { className: 'sm-batch-row__title', title: row.title }, row.title)))),
          snapshot.error ? h('div', { className: 'sm-dialog__error', role: 'alert' }, snapshot.error) : null,
          snapshot.deleting ? h('div', { className: 'sm-dialog__status', role: 'status' }, t('batch.deleting')) : null);
        footer = h(React.Fragment, null,
          h('label', {
            className: 'sm-footer-check',
            title: t('batch.moveToTrash'),
          },
          h('input', {
            type: 'checkbox',
            checked: snapshot.moveToTrash === true,
            disabled: snapshot.deleting === true,
            onChange: (event) => actions.setMoveToTrash(event.target.checked),
          }),
          h('span', null, t('trash.label'))),
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn--outline sm-btn--md',
            disabled: snapshot.deleting === true,
            onClick: close,
          }, t('delete.cancel')),
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn--danger sm-btn--md',
            disabled: snapshot.deleting === true || snapshot.loading === true || selected.size === 0,
            onClick: () => actions.deleteSelected(),
          }, snapshot.deleting ? t('batch.deleting') : t('batch.delete', { count: selected.size })));
      }

      return h(ModalFrame, {
        cardRef,
        titleId: 'sm-batch-title',
        descId: 'sm-batch-desc',
        title: t('batch.title'),
        closeLabel: t('aria.close'),
        onClose: close,
        closeDisabled: snapshot.deleting === true,
        description: t('batch.desc'),
        footer,
      }, body);
    }

    function BatchEntry({ view, actions, t, titleOf }) {
      const snapshot = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
      const translate = typeof t === 'function' ? t : (key) => key;
      if (!snapshot.open) return null;
      return h(React.Fragment, null,
        h('style', null, CSS),
        h(BatchDialog, {
          snapshot,
          actions,
          t: translate,
          titleOf,
        }));
    }

    function cleanupKindLabel(kind, t) {
      if (kind === 'tombstone') return t('cleanup.kind.tombstone');
      if (kind === 'empty-dir') return t('cleanup.kind.emptyDir');
      return t('cleanup.kind.sessionDir');
    }

    function CleanupDialog({ snapshot, actions, t }) {
      const cardRef = React.useRef(null);
      const cancelRef = React.useRef(null);
      const doneRef = React.useRef(null);
      const busyRef = React.useRef(snapshot.busy === true);
      React.useEffect(() => {
        busyRef.current = snapshot.busy === true;
      }, [snapshot.busy]);
      React.useEffect(() => {
        if (snapshot.results) {
          try {
            doneRef.current?.focus?.();
          } catch {
            /* optional */
          }
        }
      }, [snapshot.results]);

      const close = () => actions.close();
      useModalFocus(cardRef, cancelRef, busyRef, close);

      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      const selected = new Set(Array.isArray(snapshot.selected) ? snapshot.selected : []);
      const allSelected = items.length > 0 && items.every((item) => selected.has(item.path));
      const someSelected = selected.size > 0 && !allSelected;

      let body;
      let footer;
      if (snapshot.results) {
        const { moved, failed } = snapshot.results;
        const issues = snapshot.results.items.filter((item) => item.status === 'failed');
        body = h('div', { className: 'sm-batch-results' },
          h('div', { className: 'sm-batch-summary' },
            moved > 0 ? h('span', { className: 'sm-batch-summary__ok' }, t('cleanup.resultMoved', { count: moved })) : null,
            failed > 0 ? h('span', { className: 'sm-batch-summary__failed' }, t('cleanup.resultFailed', { count: failed })) : null),
          issues.length > 0 ? h('ul', { className: 'sm-batch-failures' },
            issues.map((item) => h('li', { key: item.path },
              h('span', { className: 'sm-batch-failure__title', title: item.path }, item.path),
              t('cleanup.reason', { reason: item.message || '' })))) : null);
        footer = h('button', {
          ref: doneRef,
          type: 'button',
          className: 'sm-btn sm-btn--primary sm-btn--md',
          onClick: close,
        }, t('batch.done'));
      } else {
        body = h(React.Fragment, null,
          snapshot.loading
            ? h('div', { className: 'sm-batch-empty' }, t('cleanup.loading'))
            : snapshot.items.length === 0
              ? h('div', { className: 'sm-batch-empty' }, t('cleanup.empty'))
              : h(React.Fragment, null,
                h('label', { className: 'sm-batch-all' },
                  h('input', {
                    type: 'checkbox',
                    checked: allSelected,
                    ref: (node) => {
                      if (node) node.indeterminate = someSelected;
                    },
                    disabled: snapshot.busy === true,
                    onChange: () => actions.toggleAll(),
                  }),
                  h('span', null, t('batch.selectAll')),
                  h('span', { className: 'sm-batch-row__meta' }, t('batch.selected', { count: selected.size }))),
                h('div', { className: 'sm-batch-list' },
                  items.map((item) => h('label', {
                    key: item.path,
                    className: 'sm-batch-row',
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(item.path),
                    disabled: snapshot.busy === true,
                    'aria-label': item.path,
                    onChange: () => actions.toggle(item.path),
                  }),
                  h('span', { className: 'sm-batch-row__meta' }, cleanupKindLabel(item.kind, t)),
                  h('span', { className: 'sm-batch-row__title', title: item.path }, item.path),
                  h('button', {
                    type: 'button',
                    className: 'sm-btn sm-btn--ghost',
                    disabled: snapshot.busy === true,
                    onClick: () => actions.openLocation(item.path),
                  }, t('cleanup.openLocation')))))),
          snapshot.truncated
            ? h('p', { className: 'sm-batch-note' }, t('cleanup.truncated', { count: snapshot.items.length }))
            : null,
          snapshot.error ? h('div', { className: 'sm-dialog__error', role: 'alert' }, snapshot.error) : null,
          snapshot.busy ? h('div', { className: 'sm-dialog__status', role: 'status' }, t('cleanup.moving')) : null);
        footer = h(React.Fragment, null,
          h('button', {
            ref: cancelRef,
            type: 'button',
            className: 'sm-btn sm-btn--outline sm-btn--md',
            disabled: snapshot.busy === true,
            onClick: close,
          }, t('delete.cancel')),
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn--danger sm-btn--md',
            disabled: snapshot.busy === true || snapshot.loading === true || selected.size === 0,
            onClick: () => actions.moveAll(),
          }, snapshot.busy ? t('cleanup.moving') : t('cleanup.moveAll', { count: selected.size })));
      }

      return h(ModalFrame, {
        cardRef,
        titleId: 'sm-cleanup-title',
        descId: 'sm-cleanup-desc',
        title: t('cleanup.title'),
        closeLabel: t('aria.close'),
        onClose: close,
        closeDisabled: snapshot.busy === true,
        description: t('cleanup.desc'),
        footer,
      }, body);
    }

    function CleanupEntry({ view, actions, t }) {
      const snapshot = React.useSyncExternalStore(view.subscribe, view.getSnapshot);
      const translate = typeof t === 'function' ? t : (key) => key;
      if (!snapshot.open) return null;
      return h(React.Fragment, null,
        h('style', null, CSS),
        h(CleanupDialog, {
          snapshot,
          actions,
          t: translate,
        }));
    }

    // ── plugin body ──────────────────────────────────────────────────────────

    function apply(ctx) {
      const guard = (label, fn) => {
        try {
          return fn();
        } catch (error) {
          console.error(`[session-manager] ${label} failed`, error);
          return undefined;
        }
      };

      guard('dictionaries', () => ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'session-manager: dictionaries',
      ));

      let boundTranslate;
      try {
        boundTranslate = ctx.locale.bind(NS);
      } catch {
        boundTranslate = undefined;
      }
      const t = (key, params) => {
        try {
          if (typeof boundTranslate === 'function') {
            const value = boundTranslate(key, params);
            if (typeof value === 'string' && value !== '') return value;
          }
        } catch {
          /* fall through to the key */
        }
        return String(key);
      };

      const prefs = loadPrefs();
      const store = createStore({
        toasts: [],
        muted: prefs.muted === true,
        confirm: null,
      });
      const view = { subscribe: store.subscribe, getSnapshot: store.getSnapshot };
      const audio = createAudio();

      const sessionRow = (sessionId) => {
        try {
          return ctx.sessions.list.getSnapshot().byId[sessionId];
        } catch {
          return undefined;
        }
      };

      const sessionTitle = (sessionId) => {
        if (!sessionId) return t('untitled');
        const row = sessionRow(sessionId);
        if (row && row.blank !== true) {
          // `displayTitle` is the list's always-present projection (persisted
          // title, then project directory, then id); `title` is optional.
          if (typeof row.displayTitle === 'string' && row.displayTitle.trim() !== '') {
            return row.displayTitle.trim();
          }
          if (typeof row.title === 'string' && row.title.trim() !== '') {
            return row.title.trim();
          }
        }
        return t('untitled');
      };

      const isCurrentMain = (sessionId) => {
        const row = sessionRow(sessionId);
        return (row?.retainedBy?.mainView ?? 0) > 0;
      };

      // Subagent sessions are never sidebar rows; their parent already shows
      // running-subagent activity, so a per-child completion popup is noise.
      // Forks also carry a parent id but keep `origin` unset and must alert.
      const isSubagentSession = (sessionId) => sessionRow(sessionId)?.origin === 'subagent';

      const isWindowFocused = () => {
        try {
          return typeof document !== 'undefined'
            && document.visibilityState === 'visible'
            && typeof document.hasFocus === 'function'
            && document.hasFocus();
        } catch {
          return false;
        }
      };

      const canOpenSession = () => {
        try {
          return typeof ctx.get === 'function' && ctx.get('uiWorkspace') !== undefined;
        } catch {
          return false;
        }
      };

      const resolveText = (text) => {
        // Approval display copy is either a plain string or a
        // `{ en, [locale]: string }` map handed to the locale service.
        if (typeof text === 'string') {
          if (text === '') return '';
          try {
            const resolved = ctx.locale.resolveText?.(text);
            if (typeof resolved === 'string' && resolved !== '') return resolved;
          } catch {
            /* use the raw text */
          }
          return text;
        }
        if (text && typeof text === 'object') {
          try {
            const resolved = ctx.locale.resolveText?.(text);
            if (typeof resolved === 'string' && resolved !== '') return resolved;
          } catch {
            /* use the English fallback */
          }
          if (typeof text.en === 'string') return text.en;
        }
        return '';
      };

      const pendingDetailOf = (pending) => {
        if (!pending || typeof pending !== 'object') return '';
        if (pendingKindOf(pending) === 'approval') {
          const parts = [];
          if (typeof pending.toolName === 'string' && pending.toolName) parts.push(pending.toolName);
          const reason = resolveText(pending.displayReason ?? pending.reason);
          if (reason) parts.push(reason);
          return parts.join(' · ');
        }
        const question = Array.isArray(pending.questions) ? pending.questions[0] : undefined;
        if (question && typeof question === 'object') {
          if (typeof question.header === 'string' && question.header) return question.header;
          if (typeof question.question === 'string' && question.question) return question.question;
        }
        return '';
      };

      // A failed turn emits `api-session/error` and then flips running→idle;
      // without this window the plugin would announce the same turn twice.
      const lastErrorAt = new Map();
      const hasRecentError = (sessionId, now = Date.now()) => {
        const at = lastErrorAt.get(sessionId);
        if (at === undefined) return false;
        if (now - at < ERROR_SUPPRESS_MS) return true;
        lastErrorAt.delete(sessionId);
        return false;
      };

      const pushNotice = (kind, sessionId, detail, titleOverride) => {
        guard('push notice', () => {
          if (kind === 'error' && sessionId) lastErrorAt.set(sessionId, Date.now());
          const snapshot = store.getSnapshot();
          const notice = {
            id: nextNoticeId += 1,
            kind,
            kindKey: KIND_TITLE_KEY[kind] || 'notice.reminder',
            sessionId: sessionId || null,
            title: titleOverride || sessionTitle(sessionId),
            detail: detail || '',
            sticky: STICKY_KINDS.has(kind),
            resolved: false,
            createdAt: Date.now(),
          };
          const toasts = addNotice(snapshot.toasts, notice, MAX_TOASTS);
          if (toasts === snapshot.toasts) return;
          store.set({ toasts });
          if (snapshot.muted !== true) audio.play(kind);
        });
      };

      const resolveSession = (sessionId) => {
        const current = store.getSnapshot().toasts;
        let changed = false;
        const toasts = current.map((entry) => {
          if (entry.sessionId === sessionId && PENDING_KINDS.has(entry.kind) && !entry.resolved) {
            changed = true;
            return { ...entry, resolved: true };
          }
          return entry;
        });
        if (changed) store.set({ toasts });
      };

      const actions = {
        dismiss(id) {
          const current = store.getSnapshot().toasts;
          const toasts = current.filter((entry) => entry.id !== id);
          if (toasts.length !== current.length) store.set({ toasts });
        },
        dismissSession(sessionId) {
          const current = store.getSnapshot().toasts;
          const toasts = current.filter((entry) => entry.sessionId !== sessionId);
          if (toasts.length !== current.length) store.set({ toasts });
        },
        open(sessionId) {
          guard('open session', () => {
            const uiWorkspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
            if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
              uiWorkspace.openSession(sessionId);
            }
          });
          actions.dismissSession(sessionId);
        },
        setMuted(muted) {
          const value = muted === true;
          store.set({ muted: value });
          savePrefs({ muted: value });
          if (!value) audio.play('test');
        },
        toggleMuted() {
          actions.setMuted(!store.getSnapshot().muted);
        },
        preview() {
          if (store.getSnapshot().muted) {
            // Enable first, without the extra confirmation tone: the preview
            // itself is the sound the user is testing.
            store.set({ muted: false });
            savePrefs({ muted: false });
          }
          pushNotice('test', null, t('notice.testBody'), t('preview.title'));
        },
        requestDelete({ sessionId, title }) {
          if (!sessionId) return;
          store.set({
            confirm: {
              sessionId,
              title: title || t('untitled'),
              moveToTrash: false,
              busy: false,
              error: null,
            },
          });
        },
        setMoveToTrash(value) {
          const request = store.getSnapshot().confirm;
          if (!request || request.busy) return;
          store.set({ confirm: { ...request, moveToTrash: value === true } });
        },
        cancelDelete() {
          const request = store.getSnapshot().confirm;
          if (request?.busy) return;
          store.set({ confirm: null });
        },
        async confirmDelete() {
          const request = store.getSnapshot().confirm;
          if (!request || request.busy) return;
          store.set({ confirm: { ...request, busy: true, error: null } });

          const fail = (message) => {
            store.set({
              confirm: { ...store.getSnapshot().confirm, busy: false, error: t('delete.failed', { message }) },
            });
          };

          let response;
          try {
            if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
            const url = new URL('session-manager/api/delete', document.baseURI).pathname;
            const payload = { sessionId: request.sessionId, confirm: true };
            if (request.moveToTrash === true) payload.moveToTrash = true;
            response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
            return;
          }

          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }

          if (body && body.code === 'restart-required') {
            store.set({ confirm: null });
            actions.dismissSession(request.sessionId);
            // No sessionId here: a scheduled toast must not offer "Open",
            // which would make the session live again before the restart.
            pushNotice('scheduled', null, t('delete.restartRequired'), request.title || t('untitled'));
            return;
          }

          if (!response.ok || !body || body.ok !== true) {
            let reason = body && typeof body.message === 'string' && body.message
              ? body.message
              : `HTTP ${response.status}`;
            if (body?.code === 'not-archived') reason = t('delete.notArchived');
            else if (body?.code === 'session-live') reason = t('delete.sessionLive');
            else if (body?.code === 'session-active') reason = t('delete.sessionActive');
            else if (response.status === 401 || response.status === 403) reason = t('delete.unauthorized');
            else if (response.status === 404 || response.status === 405) reason = t('delete.unavailable');
            fail(reason);
            return;
          }

          const keptCount = body.boundSchedules ? Number(body.boundSchedules.count) : 0;
          const childCount = Array.isArray(body.removedChildSessions) ? body.removedChildSessions.length : 0;
          const detail = [
            keptCount > 0 ? t('delete.keptSchedules', { count: keptCount }) : '',
            childCount > 0 ? t('delete.childSessions', { count: childCount }) : '',
          ].filter(Boolean).join(' ');
          const title = request.title || t('untitled');

          store.set({ confirm: null });
          actions.dismissSession(request.sessionId);
          // Show the result before the list refresh: a stuck list RPC must not
          // hide the fact that the irreversible deletion already succeeded.
          pushNotice('deleted', null, detail, title);
          if (Array.isArray(body.warnings) && body.warnings.length > 0) {
            pushNotice('warning', null, body.warnings.join('; '), t('delete.warningTitle'));
          }
          try {
            const refresh = ctx.sessions.refresh();
            void Promise.resolve(refresh).catch((error) => {
              console.warn('[session-manager] session list refresh failed', error);
            });
          } catch (error) {
            console.warn('[session-manager] session list refresh failed', error);
          }
        },
      };

      const batchStore = createStore({
        open: false,
        loading: false,
        error: null,
        ids: [],
        selected: [],
        filter: '',
        deleting: false,
        results: null,
        // Kept across opens on purpose: a repeated cleanup keeps the choice.
        moveToTrash: false,
      });
      const batchView = { subscribe: batchStore.subscribe, getSnapshot: batchStore.getSnapshot };

      const batchTitleOf = (sessionId) => {
        const row = sessionRow(sessionId);
        if (row && row.blank !== true) {
          if (typeof row.displayTitle === 'string' && row.displayTitle.trim() !== '') {
            return row.displayTitle.trim();
          }
          if (typeof row.title === 'string' && row.title.trim() !== '') {
            return row.title.trim();
          }
        }
        return sessionId || t('untitled');
      };

      const batchLoadError = (status, body) => {
        if (status === 401 || status === 403) return t('delete.unauthorized');
        if (status === 404 || status === 405) return t('delete.unavailable');
        if (body?.code === 'list-failed' && typeof body.message === 'string' && body.message) {
          return t('delete.failed', { message: body.message });
        }
        return t('batch.loadFailed');
      };

      const batchActions = {
        open() {
          if (batchStore.getSnapshot().open) return;
          batchStore.set({
            open: true,
            loading: true,
            error: null,
            ids: [],
            selected: [],
            filter: '',
            deleting: false,
            results: null,
          });
          void (async () => {
            let response;
            let body = null;
            try {
              if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
              const url = new URL('session-manager/api/archived', document.baseURI).pathname;
              response = await fetch(url, { headers: { accept: 'application/json' } });
              try {
                body = await response.json();
              } catch {
                body = null;
              }
              if (!response.ok) {
                batchStore.set({ loading: false, error: batchLoadError(response.status, body) });
                return;
              }
              const ids = Array.isArray(body?.sessions)
                ? body.sessions.filter((id) => typeof id === 'string' && id !== '')
                : [];
              batchStore.set({ loading: false, ids });
            } catch {
              batchStore.set({ loading: false, error: t('batch.loadFailed') });
            }
          })();
        },
        close() {
          if (batchStore.getSnapshot().deleting) return;
          batchStore.set({ open: false });
        },
        setFilter(filter) {
          batchStore.set({ filter: String(filter ?? '') });
        },
        toggle(sessionId) {
          const snapshot = batchStore.getSnapshot();
          if (snapshot.deleting) return;
          const selected = snapshot.selected.includes(sessionId)
            ? snapshot.selected.filter((id) => id !== sessionId)
            : [...snapshot.selected, sessionId];
          batchStore.set({ selected });
        },
        toggleAll(ids) {
          const snapshot = batchStore.getSnapshot();
          if (snapshot.deleting) return;
          const all = ids.length > 0 && ids.every((id) => snapshot.selected.includes(id));
          const selected = all
            ? snapshot.selected.filter((id) => !ids.includes(id))
            : [...new Set([...snapshot.selected, ...ids])];
          batchStore.set({ selected });
        },
        setMoveToTrash(value) {
          if (batchStore.getSnapshot().deleting) return;
          batchStore.set({ moveToTrash: value === true });
        },
        async deleteSelected() {
          const snapshot = batchStore.getSnapshot();
          if (snapshot.deleting || snapshot.selected.length === 0) return;
          const ids = snapshot.selected.slice();
          batchStore.set({ deleting: true, error: null });

          let response;
          let body = null;
          try {
            if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
            const url = new URL('session-manager/api/delete', document.baseURI).pathname;
            const payload = { sessionIds: ids, confirm: true };
            if (snapshot.moveToTrash === true) payload.moveToTrash = true;
            response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
            try {
              body = await response.json();
            } catch {
              body = null;
            }
          } catch (error) {
            batchStore.set({
              deleting: false,
              error: t('delete.failed', {
                message: error instanceof Error ? error.message : String(error),
              }),
            });
            return;
          }

          if (!response.ok || !body || body.ok !== true) {
            let reason = body && typeof body.message === 'string' && body.message
              ? body.message
              : `HTTP ${response.status}`;
            if (response.status === 401 || response.status === 403) reason = t('delete.unauthorized');
            else if (response.status === 404 || response.status === 405) reason = t('delete.unavailable');
            else reason = t('delete.failed', { message: reason });
            batchStore.set({ deleting: false, error: reason });
            return;
          }

          const items = Array.isArray(body.results) ? body.results : [];
          const deleted = items.filter((item) => item.status === 'deleted').length;
          const scheduled = items.filter((item) => item.status === 'scheduled').length;
          const skipped = items.filter((item) => item.status === 'skipped').length;
          const failed = items.filter((item) => item.status === 'failed').length;
          batchStore.set({
            deleting: false,
            results: { items, deleted, scheduled, skipped, failed },
            selected: [],
          });

          if (failed > 0) {
            pushNotice('warning', null, t('batch.partialToast', {
              deleted,
              scheduled,
              failed: failed + skipped,
            }), t('batch.title'));
          } else if (scheduled > 0) {
            pushNotice('scheduled', null, t('batch.scheduledToast', { count: scheduled }), t('batch.title'));
          } else if (deleted > 0) {
            pushNotice('deleted', null, t('batch.deletedToast', { count: deleted }), t('batch.title'));
          }
          for (const item of items) {
            if (item.status !== 'failed' && item.status !== 'skipped') continue;
            console.warn(
              `[session-manager] batch delete ${item.status} ${item.sessionId}: `
              + `${item.code || ''} ${item.message || ''}`.trim(),
            );
          }
          try {
            const refresh = ctx.sessions.refresh();
            void Promise.resolve(refresh).catch((error) => {
              console.warn('[session-manager] session list refresh failed', error);
            });
          } catch (error) {
            console.warn('[session-manager] session list refresh failed', error);
          }
        },
      };

      const cleanupStore = createStore({
        open: false,
        loading: false,
        error: null,
        items: [],
        selected: [],
        busy: false,
        results: null,
        truncated: false,
      });
      const cleanupView = { subscribe: cleanupStore.subscribe, getSnapshot: cleanupStore.getSnapshot };

      const cleanupLoadError = (status, body) => {
        if (status === 401 || status === 403) return t('delete.unauthorized');
        if (status === 404 || status === 405) return t('delete.unavailable');
        if (body?.code === 'cleanup-failed' && typeof body.message === 'string' && body.message) {
          return t('delete.failed', { message: body.message });
        }
        return t('cleanup.loadFailed');
      };

      const cleanupActions = {
        open() {
          if (cleanupStore.getSnapshot().open) return;
          cleanupStore.set({
            open: true,
            loading: true,
            error: null,
            items: [],
            selected: [],
            busy: false,
            results: null,
            truncated: false,
          });
          void (async () => {
            let response;
            let body = null;
            try {
              if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
              const url = new URL('session-manager/api/cleanup', document.baseURI).pathname;
              response = await fetch(url, { headers: { accept: 'application/json' } });
              try {
                body = await response.json();
              } catch {
                body = null;
              }
              if (!response.ok || !body || body.ok !== true) {
                cleanupStore.set({ loading: false, error: cleanupLoadError(response.status, body) });
                return;
              }
              const items = Array.isArray(body.items)
                ? body.items.filter((item) => item
                  && typeof item.path === 'string'
                  && item.path !== ''
                  && cleanupStore.getSnapshot().open)
                : [];
              cleanupStore.set({
                loading: false,
                items,
                selected: items.map((item) => item.path),
                truncated: body.truncated === true,
              });
            } catch {
              cleanupStore.set({ loading: false, error: t('cleanup.loadFailed') });
            }
          })();
        },
        close() {
          if (cleanupStore.getSnapshot().busy) return;
          cleanupStore.set({ open: false });
        },
        toggle(path) {
          const snapshot = cleanupStore.getSnapshot();
          if (snapshot.busy || typeof path !== 'string' || path === '') return;
          if (!snapshot.items.some((item) => item.path === path)) return;
          const selected = new Set(snapshot.selected);
          if (selected.has(path)) selected.delete(path);
          else selected.add(path);
          cleanupStore.set({ selected: [...selected] });
        },
        toggleAll() {
          const snapshot = cleanupStore.getSnapshot();
          if (snapshot.busy) return;
          const selected = new Set(snapshot.selected);
          const all = snapshot.items.length > 0
            && snapshot.items.every((item) => selected.has(item.path));
          cleanupStore.set({
            selected: all ? [] : snapshot.items.map((item) => item.path),
          });
        },
        async openLocation(path) {
          if (cleanupStore.getSnapshot().busy || typeof path !== 'string' || path === '') return;
          try {
            if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
            const url = new URL('session-manager/api/open-path', document.baseURI).pathname;
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (!response.ok) {
              console.warn('[session-manager] open location refused', path, response.status);
            }
          } catch (error) {
            console.warn('[session-manager] open location failed', error);
          }
        },
        async moveAll() {
          const snapshot = cleanupStore.getSnapshot();
          if (snapshot.busy || snapshot.loading) return;
          const selected = new Set(snapshot.selected);
          const paths = snapshot.items
            .map((item) => item.path)
            .filter((path) => selected.has(path));
          if (paths.length === 0) return;
          cleanupStore.set({ busy: true, error: null });
          let response;
          let body = null;
          try {
            if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
            const url = new URL('session-manager/api/cleanup', document.baseURI).pathname;
            response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ paths, confirm: true }),
            });
            try {
              body = await response.json();
            } catch {
              body = null;
            }
          } catch (error) {
            cleanupStore.set({
              busy: false,
              error: t('delete.failed', {
                message: error instanceof Error ? error.message : String(error),
              }),
            });
            return;
          }

          if (!response.ok || !body || body.ok !== true) {
            let reason = body && typeof body.message === 'string' && body.message
              ? body.message
              : `HTTP ${response.status}`;
            if (response.status === 401 || response.status === 403) reason = t('delete.unauthorized');
            else if (response.status === 404 || response.status === 405) reason = t('delete.unavailable');
            else reason = t('delete.failed', { message: reason });
            cleanupStore.set({ busy: false, error: reason });
            return;
          }

          const results = Array.isArray(body.results) ? body.results : [];
          const moved = results.filter((item) => item.status === 'moved').length;
          const failed = results.filter((item) => item.status === 'failed').length;
          cleanupStore.set({ busy: false, items: [], selected: [], results: { items: results, moved, failed } });
          if (failed > 0) {
            pushNotice('warning', null, t('cleanup.partialToast', { moved, failed }), t('cleanup.title'));
          } else if (moved > 0) {
            pushNotice('deleted', null, t('cleanup.toast', { moved }), t('cleanup.title'));
          }
          for (const item of results) {
            if (item.status !== 'failed') continue;
            console.warn(`[session-manager] cleanup failed ${item.path}: ${item.message || ''}`.trim());
          }
        },
      };

      // ── slots ──────────────────────────────────────────────────────────────

      guard('toast overlay', () => {
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-manager.toasts',
          order: 30,
          locale: NS,
          inject: () => ({ view, actions, canOpen: canOpenSession }),
        }, guardEntry('toasts', ToastEntry))), 'session-manager: toast overlay');
      });

      guard('confirm overlay', () => {
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-manager.confirm',
          order: 31,
          locale: NS,
          inject: () => ({ view, actions }),
        }, guardEntry('confirm', ConfirmEntry))), 'session-manager: delete dialog');
      });

      guard('batch overlay', () => {
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-manager.batch',
          order: 32,
          locale: NS,
          inject: () => ({ view: batchView, actions: batchActions, titleOf: batchTitleOf }),
        }, guardEntry('batch', BatchEntry))), 'session-manager: batch dialog');
      });

      guard('cleanup overlay', () => {
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-manager.cleanup',
          order: 33,
          locale: NS,
          inject: () => ({ view: cleanupView, actions: cleanupActions }),
        }, guardEntry('cleanup', CleanupEntry))), 'session-manager: cleanup dialog');
      });

      guard('footer actions', () => {
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'session-manager-sound',
          order: 20,
          locale: NS,
          label: () => (store.getSnapshot().muted ? t('sound.off') : t('sound.on')),
          inject: () => ({ view, actions, batch: batchActions, cleanup: cleanupActions }),
        }, guardEntry('sound', FooterActions))), 'session-manager: footer actions');
      });

      guard('delete menu row', () => {
        ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-manager.delete-archived',
          order: 500,
          locale: NS,
          label: () => t('delete.menu'),
          inject: () => ({ requestDelete: actions.requestDelete }),
        }, guardEntry('delete-row', DeleteArchivedRow))), 'session-manager: delete menu row');
      });

      // ── status subscriptions ───────────────────────────────────────────────

      let uiSessionWired = false;

      guard('ui session status', () => {
        if (typeof ctx.inject !== 'function') return;
        ctx.inject(['uiSession'], (scope) => {
          const source = scope.uiSession?.sessionStatus;
          if (!source || typeof source.subscribe !== 'function' || typeof source.getSnapshot !== 'function') {
            return;
          }
          guard('ui session status effect', () => {
            scope.effect(() => {
              let previous = new Map(source.getSnapshot());
              const off = source.subscribe(() => {
                try {
                  const next = new Map(source.getSnapshot());
                  for (const change of statusTransitions(previous, next)) {
                    if (change.type === 'pending') {
                      pushNotice(change.kind, change.sessionId, pendingDetailOf(change.interaction));
                    } else if (change.type === 'resolved') {
                      resolveSession(change.sessionId);
                    } else if (change.type === 'completed') {
                      if (isSubagentSession(change.sessionId)) continue;
                      if (hasRecentError(change.sessionId)) continue;
                      if (!(isCurrentMain(change.sessionId) && isWindowFocused())) {
                        pushNotice('completed', change.sessionId, '');
                      }
                    }
                  }
                  previous = next;
                } catch (error) {
                  console.error('[session-manager] status update failed', error);
                }
              });
              return () => {
                try {
                  off?.();
                } catch {
                  /* optional */
                }
              };
            }, 'session-manager: session status');
            uiSessionWired = true;
          });
        });
      });

      // Fallback for a composition without the Session UI plugin: only the
      // running->idle transition is observable, so approval alerts degrade.
      guard('status fallback', () => {
        const running = new Set();
        const seed = () => {
          try {
            for (const row of Object.values(ctx.sessions.list.getSnapshot().byId || {})) {
              if (row && row.running === true) running.add(row.id);
            }
          } catch {
            /* optional */
          }
        };
        seed();
        try {
          Promise.resolve(ctx.sessions.refresh()).then(seed, () => {});
        } catch {
          /* optional */
        }
        ctx.effect(() => {
          const offStatus = ctx.remote.$on('api-session/status', (sessionId, isRunning) => {
            try {
              if (uiSessionWired) return;
              if (isRunning) {
                running.add(sessionId);
                return;
              }
              if (!running.delete(sessionId)) return;
              if (isSubagentSession(sessionId)) return;
              if (hasRecentError(sessionId)) return;
              if (!(isCurrentMain(sessionId) && isWindowFocused())) {
                pushNotice('completed', sessionId, '');
              }
            } catch (error) {
              console.error('[session-manager] status event failed', error);
            }
          });
          const offReset = typeof ctx.on === 'function'
            ? ctx.on('connection/reset', () => {
              if (!uiSessionWired) seed();
            })
            : undefined;
          return () => {
            try {
              offStatus?.();
            } catch {
              /* optional */
            }
            try {
              offReset?.();
            } catch {
              /* optional */
            }
          };
        }, 'session-manager: status fallback');
      });

      guard('error events', () => {
        ctx.effect(() => {
          const off = ctx.remote.$on('api-session/error', (sessionId, message) => {
            try {
              pushNotice('error', sessionId, typeof message === 'string' ? message : '');
            } catch (error) {
              console.error('[session-manager] error event failed', error);
            }
          });
          return () => {
            try {
              off?.();
            } catch {
              /* optional */
            }
          };
        }, 'session-manager: session errors');
      });

      guard('audio lifetime', () => {
        ctx.effect(() => () => {
          audio.close();
        }, 'session-manager: audio lifetime');
      });

      // Deliberate test seam: the isolated browser E2E injects a toast with a
      // real session id and then clicks the card. Only present when the
      // harness asks for it, exactly like `plugin.__test`.
      guard('debug seam', () => {
        if (typeof globalThis !== 'undefined' && globalThis.__SESSION_MANAGER_TEST__ === true) {
          globalThis.__SESSION_MANAGER_DEBUG__ = {
            pushNotice: (kind, sessionId, detail, titleOverride) => (
              pushNotice(kind, sessionId, detail, titleOverride)
            ),
          };
        }
      });
    }

    const plugin = {
      inject: ['slots', 'locale', 'remote', 'sessions'],
      apply,
    };
    // Deliberate test seam, present only while the offline test harness asks
    // for it. The runtime plugin object stays a plain Cordis plugin.
    if (typeof globalThis !== 'undefined' && globalThis.__SESSION_MANAGER_TEST__ === true) {
      plugin.__test = {
        addNotice,
        statusTransitions,
        noticeKey,
        noticeOpenable,
        pendingKindOf,
        pendingKeyOf,
      };
    }
    return plugin;
  },
});
