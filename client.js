// Browser half of dsh-user-memory: the sidebar entry and the 多功能记忆 panel.
// Also the two session chips beside the composer (工作流 / 短期目标), which is why
// this half also registers into `conversation.input.left`.
window.__ModuleLoader__.load({
  id: 'dsh-user-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    // The harness' own menu primitive, so the chip looks and behaves like the
    // agent-preset seat instead of hand-rolling a popover. Missing (older shell,
    // or a profile that did not inject it) is survivable: ModeChip then renders a
    // plain <select>, which still switches modes.
    let Menu = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      Menu = typeof primitives?.Menu === 'function' ? primitives.Menu : null;
    } catch (error) {
      Menu = null;
    }

    const ROUTE = '/api/dsh-user-memory';
    const PANEL_ID = 'user-memory';
    const PANEL_ORDER = 40;
    // A pseudo-tab: no file behind it, it shows the suggestion waiting area.
    const PENDING_KEY = '__pending__';
    // The other pseudo-tab: the temporary working set. Same shape as the other
    // keys on purpose — the panel's dirty/active logic keys off `file`.
    const TEMP_KEY = '__temp__';
    // The third pseudo-tab: the two lists the session chips pick from.
    const MODES_KEY = '__modes__';
    // Where the panel opens, and where it comes back to. 临时记忆 is the tab the
    // user acts on most of the time; landing on 必须遵守 is just the first file in
    // the list, not a decision. The last tab the user chose is remembered so a
    // reopened panel does not silently jump back to the first file.
    const DEFAULT_TAB = TEMP_KEY;
    const ACTIVE_TAB_KEY = 'dsh-user-memory:active-tab';
    // 面板显隐设置（0.8.2）。只影响面板看不看得到，绝不影响注入——隐藏一个
    // 标签页不等于把它从上下文里拿掉，这条边界写在设置页上，也写进 README。
    const SETTINGS_KEY = '__settings__';
    const UI_KEY = 'dsh-user-memory:ui';
    const PRESETS = [
      { id: 'all', title: '全部', hidden: [] },
      { id: 'simple', title: '简洁', hidden: ['log.md', MODES_KEY, TEMP_KEY] },
      { id: 'work', title: '工作', hidden: ['log.md'] },
      { id: 'game', title: '游戏', hidden: ['log.md', 'rules-must.md', 'agent.md', 'rules-should.md'] },
    ];
    const readUi = () => {
      try {
        const raw = window.localStorage.getItem(UI_KEY);
        const parsed = raw === null ? null : JSON.parse(raw);
        if (parsed && Array.isArray(parsed.hidden)) {
          return { hidden: parsed.hidden.filter((value) => typeof value === 'string'), preset: typeof parsed.preset === 'string' ? parsed.preset : 'custom' };
        }
      } catch (error) {
        /* no storage: every tab stays visible */
      }
      return { hidden: [], preset: 'all' };
    };
    const writeUi = (ui) => {
      try {
        window.localStorage.setItem(UI_KEY, JSON.stringify(ui));
      } catch (error) {
        /* no storage: the setting lasts for this session only */
      }
    };

    // 条目模型的客户端一半：服务端 parseDoc 产出的结构，面板只做局部改写，保存时
    // 整份 doc 发回去由 composeDoc 重新串成 markdown（逐字节可逆，手改的记录文件
    // 不会因为面板保存而被整体重排）。全局 entryIndex 的口径与服务端 flattenDoc
    // 一致：先 preamble 的段落，再按组顺序的条目。
    const emptyDoc = () => ({ title: '', comments: [], preamble: [], groups: [] });
    const cloneDoc = (doc) => JSON.parse(JSON.stringify(doc || emptyDoc()));
    const docSignature = (doc) => (doc ? JSON.stringify(doc) : '');
    const entryLists = (doc) => [doc.preamble || []].concat((doc.groups || []).map((group) => group.entries || []));
    function entryAt(doc, index) {
      let rest = index;
      for (const list of entryLists(doc)) {
        if (rest < list.length) return { list: list, at: rest };
        rest -= list.length;
      }
      return null;
    }
    const entryCount = (doc) => entryLists(doc).reduce((sum, list) => sum + list.length, 0);
    // 设置页永远可见：它是把别的页重新放出来的唯一入口。
    const isKnownVisible = (tab, hidden) => tab === SETTINGS_KEY || hidden.indexOf(tab) < 0;

    // The two chip slots' registry ids and orders. Workflow sits left of the goal
    // because it is the one with a default and the one picked in most sessions.
    const WORKFLOW_CHIP_ID = 'user-memory-workflow';
    const GOAL_CHIP_ID = 'user-memory-goal';
    const WORKFLOW_CHIP_ORDER = 20;
    const GOAL_CHIP_ORDER = 21;
    // The server's sentinel for "deliberately no workflow", as opposed to "" =
    // follow the deployment default. A goal uses "" and this value alike: no goal.
    const NONE_PICK = '__none__';

    // Chinese-first labels: the user should never have to read a filename.
    const FILES = [
      { file: 'rules-must.md', title: '必须遵守', hint: '硬性要求，AI 按字面执行' },
      { file: 'agent.md', title: '行为设定', hint: 'AI 面对用户时的做事方式' },
      { file: 'profile.md', title: '用户画像', hint: '关于用户的背景，用来调整 AI 的表达' },
      { file: 'rules-should.md', title: '可选遵守', hint: '酌情执行，优先级低于上面' },
      { file: 'log.md', title: '变更日志', hint: '只给用户自己记账，不注入' },
    ];

    // Tabs = the editable files, plus the two pseudo-tabs: the temporary
    // working set, and the waiting area where I propose and only the user's
    // click decides.
    const TABS = FILES.concat([
      {
        file: TEMP_KEY,
        title: '临时记忆',
        hint: '跨对话交接、阶段目标、等待项。只在用户要求时写入；标成完成后立刻从注入里消失（数据留在归档里，可恢复）',
      },
      { file: MODES_KEY, title: '工作流 / 目标', hint: '这里写多套工作流和短期目标，会话里用输入框上方的两个小按钮选；工作流可设默认，短期目标不选就不注入' },
      { file: PENDING_KEY, title: '待确认', hint: 'AI 提议，用户点「采纳」才会写进记忆；采纳后到 AI 下一轮开跑之前可以撤销' },
      { file: SETTINGS_KEY, title: '设置', hint: '标签页显隐与预设。只改变面板看不看得到，不影响注入——藏起来的记忆照样会进上下文' },
    ]);

    // localStorage may be missing or throw (private mode, embedded webview), and
    // a panel that cannot remember a tab is a nuisance, not an error: every
    // access degrades to the default instead of breaking the render.
    const isKnownTab = (value) => TABS.some((entry) => entry.file === value);
    const readActiveTab = () => {
      try {
        const saved = window.localStorage.getItem(ACTIVE_TAB_KEY);
        if (typeof saved === 'string' && isKnownTab(saved)) return saved;
      } catch (error) {
        /* no storage: fall through to the default */
      }
      return DEFAULT_TAB;
    };
    const writeActiveTab = (file) => {
      if (!isKnownTab(file)) return;
      try {
        window.localStorage.setItem(ACTIVE_TAB_KEY, file);
      } catch (error) {
        /* no storage: the panel still switches, it just forgets next time */
      }
    };

    const CSS = [
      '.umem-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}',
      '.umem-head{padding:18px 24px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
      '.umem-title{font-size:16px;font-weight:600;margin:0 0 4px;}',
      '.umem-sub{font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all;}',
      '.umem-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:12px 24px 0;}',
      '.umem-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer;font-family:inherit;}',
      '.umem-tab:hover{background:var(--dsw-alias-interactive-hover);}',
      '.umem-tab[data-on="1"]{background:var(--dsw-alias-interactive-selected);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);}',
      '.umem-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);margin-left:6px;vertical-align:middle;}',
      '.umem-cut{display:inline-flex;align-items:center;justify-content:center;min-width:14px;height:14px;border-radius:7px;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base);font-size:10px;font-weight:700;margin-left:4px;line-height:1;}',
      '.umem-hintbar{padding:8px 24px 0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.umem-body{flex:1;min-height:0;padding:10px 24px;display:flex;}',
      '.umem-editor{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:12px 14px;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:13px;line-height:1.65;}',
      '.umem-editor:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.umem-entries{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-bottom:8px;}',
      '.umem-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);}',
      '.umem-grouphead{display:flex;gap:8px;align-items:center;}',
      '.umem-gtitle{flex:1;font-weight:600;font-size:13px;background:transparent;border:none;color:inherit;padding:2px 4px;border-radius:6px;font-family:inherit;}',
      '.umem-gtitle:focus{outline:1px solid var(--dsw-alias-brand-primary);}',
      '.umem-entry{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-base);}',
      '.umem-entry[data-fit="dropped"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.umem-entry[data-fit="partial"]{border-color:var(--dsw-alias-state-warn-primary);}',
      '.umem-entryhead{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px;}',
      '.umem-entry textarea{width:100%;box-sizing:border-box;border:none;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.55;resize:vertical;min-height:34px;padding:0;}',
      '.umem-entry textarea:focus{outline:none;}',
      '.umem-chip{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);}',
      '.umem-chip[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
      '.umem-chip[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);}',
      '.umem-mini{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;}',
      '.umem-mini:hover{background:var(--dsw-alias-interactive-hover);}',
      '.umem-meter{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.umem-meterbar{width:110px;height:6px;border-radius:3px;background:var(--dsw-alias-border-l1);overflow:hidden;}',
      '.umem-meterfill{height:100%;background:var(--dsw-alias-state-success-primary);}',
      '.umem-settings{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:14px;max-width:680px;}',
      '.umem-stale{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;max-width:860px;font-size:13px;line-height:1.6;}',
      '.umem-stale-title{font-weight:600;}',
      '.umem-raw{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-l1);white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;max-height:52vh;overflow:auto;}',
      '.umem-label{display:flex;align-items:center;gap:8px;font-size:13px;}',
      '.umem-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.umem-foot{display:flex;align-items:center;gap:12px;padding:0 24px 18px;flex-wrap:wrap;}',
      '.umem-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 16px;font-size:13px;font-family:inherit;cursor:pointer;background:var(--dsw-specific-button-secondary-fill);color:var(--dsw-alias-label-primary);}',
      '.umem-btn:hover:not(:disabled){background:var(--dsw-specific-button-secondary-fill-hover);}',
      '.umem-btn:disabled{opacity:.5;cursor:default;}',
      '.umem-msg{font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.umem-msg[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);}',
      '.umem-msg[data-kind="err"]{color:var(--dsw-alias-state-error-primary);}',
      '.umem-center{flex:1;display:flex;align-items:center;justify-content:center;padding:40px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;line-height:1.9;}',
      '.umem-count{display:inline-block;min-width:16px;margin-left:6px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse,#fff);font-size:11px;line-height:16px;text-align:center;}',
      '.umem-body[data-flat="1"]{padding:10px 24px 0;}',
      '.umem-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;}',
      '.umem-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);}',
      '.umem-card[data-open="1"]{border-color:var(--dsw-alias-brand-primary);}',
      '.umem-cardhead{display:flex;align-items:center;gap:10px;font-size:12px;margin-bottom:8px;}',
      '.umem-id{font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-tertiary);}',
      '.umem-target{font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.umem-stage{margin-left:auto;color:var(--dsw-alias-label-tertiary);}',
      '.umem-text{margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);}',
      '.umem-why{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.umem-cardfoot{display:flex;gap:10px;margin-top:12px;align-items:flex-start;}',
      '.umem-cardfoot .umem-msg{flex:1;line-height:1.6;}',
      '.umem-note{margin-top:10px;width:100%;box-sizing:border-box;min-height:46px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:inherit;font-size:12px;line-height:1.65;}',
      '.umem-note:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.umem-note:disabled{opacity:.6;}',
      '.umem-note::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.umem-note-ro{margin-top:10px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;border-left:2px solid var(--dsw-alias-border-l1);padding-left:8px;}',
      '.umem-switch{display:flex;align-items:flex-start;gap:10px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1);}',
      '.umem-switch .umem-btn{flex:none;}',
      '.umem-switch-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary);}',
      '.umem-form{flex:none;display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);}',
      '.umem-formrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.umem-input,.umem-select{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;font-family:inherit;font-size:13px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}',
      '.umem-input:focus,.umem-select:focus,.umem-bigt:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.umem-input:disabled,.umem-select:disabled,.umem-btn:disabled{opacity:.5;}',
      '.umem-bigt{min-height:120px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.65;}',
      '.umem-badge{font-size:11px;padding:1px 8px;border-radius:9px;background:var(--dsw-alias-interactive-selected);color:var(--dsw-alias-label-secondary);}',
      '.umem-card[data-muted="1"] .umem-text{opacity:.62;}',
      '.umem-arch{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      // The two composer chips. Sized and coloured like the agent-preset seat so
      // they read as control, not as content. The label is the only text; the
      // prefix says which one it is, so a truncation still leaves it identifiable.
      '.umem-chip{display:inline-flex;align-items:center;gap:6px;max-width:180px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;}',
      '.umem-chip:hover{background:var(--dsw-alias-interactive-hover);color:var(--dsw-alias-label-primary);}',
      '.umem-chip[data-on="1"]{color:var(--dsw-alias-label-primary);}',
      '.umem-chip[data-on="1"] .umem-chip-dot{background:var(--dsw-alias-brand-primary);}',
      '.umem-chip:disabled{opacity:.55;cursor:default;}',
      '.umem-chip-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));}',
      '.umem-chip-kind{flex:none;color:var(--dsw-alias-label-tertiary);}',
      '.umem-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.umem-chip-select{max-width:180px;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;}',
      // The 工作流 / 目标 tab: two sections of cards, each card open in place.
      '.umem-modes{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:18px;}',
      '.umem-modesec{display:flex;flex-direction:column;gap:10px;}',
      '.umem-sectitle{display:flex;align-items:baseline;gap:10px;font-size:13px;font-weight:600;margin:0;}',
      '.umem-sectitle .umem-sub{font-weight:400;}',
      '.umem-modebody{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);}',
      '.umem-modecard[data-on="1"]{border-color:var(--dsw-alias-brand-primary);}',
      '.umem-btnRow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.umem-mini{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:5px;}',
      '.umem-mini:hover{background:var(--dsw-alias-interactive-hover);color:var(--dsw-alias-label-primary);}',
      '.umem-mini[data-danger="1"]:hover{color:var(--dsw-alias-state-error-primary);}',
    ].join('\n');

    async function call(action, extra) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, extra || {})),
      });
      return await response.json();
    }

    function Icon(props) {
      const size = typeof props.size === 'number' ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8 7.5h7M8 11h5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      );
    }

    // One chip, one kind. Reads the session's pick and the current default on
    // mount (and after every choice), writes through `sessionMode`, and never
    // blocks the composer: a failed load leaves a quiet "工作流" button behind.
    function ModeChip(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const kind = props.kind === 'goal' ? 'goal' : 'workflow';
      const label = kind === 'goal' ? '短期目标' : '工作流';
      const [open, setOpen] = useState(false);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        if (sessionId === '') return;
        try {
          const result = await call('modesLoad', { sessionId: sessionId });
          if (result?.ok) setData(result);
        } catch (error) {
          /* the chip is optional: stay on the label */
        }
      }, [sessionId]);

      useEffect(() => {
        void load();
      }, [load]);

      const choose = async (id) => {
        setOpen(false);
        if (sessionId === '' || busy) return;
        setBusy(true);
        try {
          const result = await call('sessionMode', { sessionId: sessionId, kind: kind, id: id });
          if (result?.ok) setData(result);
        } catch (error) {
          /* leave the previous choice in place */
        } finally {
          setBusy(false);
        }
      };

      const selected = data?.selected ?? {};
      const currentName = kind === 'goal' ? selected.goalName ?? '' : selected.workflowName ?? '';
      // "跟随默认" is shown as the default's own name, because that is what the
      // model will actually receive; an explicit none reads as "不用".
      const shown = currentName !== '' ? currentName : kind === 'workflow' ? '不用' : '不选';

      const items = [];
      if (kind === 'workflow') {
        items.push({ id: '', label: data?.defaultWorkflow ? '跟随默认' : '不用（没有默认）' });
        items.push({ id: NONE_PICK, label: '不用（本次显式关闭）' });
      } else {
        items.push({ id: NONE_PICK, label: '不选（不加目标）' });
      }
      for (const item of kind === 'goal' ? data?.goals ?? [] : data?.workflows ?? []) {
        items.push({ id: item.id, label: item.name });
      }

      const anchor = h(
        'button',
        {
          type: 'button',
          className: 'umem-chip',
          'data-on': currentName !== '' ? '1' : '0',
          title: kind === 'goal' ? '这个会话的短期目标' : '这个会话的工作流',
          disabled: sessionId === '' || busy,
          onClick: () => {
            if (Menu !== null) setOpen((value) => !value);
          },
        },
        h('span', { className: 'umem-chip-dot' }),
        h('span', { className: 'umem-chip-kind' }, label),
        h('span', { className: 'umem-chip-name' }, shown),
      );

      // Fallback without the primitive: a native select does the same job with
      // worse looks, and it is better than a button that opens nothing.
      if (Menu === null) {
        return h(
          'select',
          {
            className: 'umem-chip-select',
            title: label,
            value: kind === 'goal' ? (data?.session?.goal ?? '') : (data?.session?.workflow ?? ''),
            disabled: sessionId === '' || busy,
            onChange: (event) => {
              void choose(event.target.value);
            },
          },
          items.map((item) => h('option', { key: `chip-${kind}-${item.id}`, value: item.id }, `${label}：${item.label}`)),
        );
      }

      return h(Menu, {
        open: open,
        onClose: () => setOpen(false),
        items: items,
        selectedId: kind === 'goal' ? (data?.session?.goal ?? '') : (data?.session?.workflow ?? ''),
        onSelect: (id) => {
          void choose(id);
        },
        align: 'start',
        side: 'top',
        portal: true,
        anchor: anchor,
      });
    }

    function Panel() {
      const [status, setStatus] = useState('loading');
      const [dir, setDir] = useState('');
      // 0.8.2：文件不再是一个大文本框，而是「组 + 条目」。`docs` 是工作副本，
      // `savedJson` 是上次落盘时的快照（比较 JSON 就够判断未保存，「放弃改动」
      // 也只需要把 docs 换回saved 的那一份）。
      const [docs, setDocs] = useState({});
      const [savedDocs, setSavedDocs] = useState({});
      // 宿主还跑着旧版插件时（改了 index.js 但没重启 DSH），`load` 不会带
      // `doc`，面板若默默按空文档渲染，看起来就像长期记忆被清空了。这里把
      // 原文留在 `raws` 里，并明确告诉人「文件在，是进程旧」，别让人误判。
      const [raws, setRaws] = useState({});
      const [staleHost, setStaleHost] = useState(false);
      // 上一次 render() 的结果：哪一条进了上下文、哪一条没进。失真度提示全靠它。
      const [report, setReport] = useState(null);
      const [ui, setUi] = useState(readUi);
      const [active, setActive] = useState(readActiveTab);
      const [message, setMessage] = useState(null);
      const [saving, setSaving] = useState(false);
      const [suggestions, setSuggestions] = useState([]);
      const [notes, setNotes] = useState({});
      const [busyId, setBusyId] = useState('');
      // The auto-capture switch. `null` = still loading, so the button never
      // flashes a wrong state before the first response arrives.
      const [capture, setCapture] = useState(null);
      const [captureBusy, setCaptureBusy] = useState(false);
      // 临时记忆（活跃工作集）。它不落任何 .md 文件，所以状态全在这里。
      // `tempForm.id === ''` = 表单处于「新增」；否则是在编辑那一条。
      const [temps, setTemps] = useState([]);
      const [tempPath, setTempPath] = useState('');
      const [tempEnabled, setTempEnabled] = useState(true);
      // False until the host has answered once: the tab fallback below must not
      // fire on the optimistic `true` above and fight the user for one frame.
      const [tempKnown, setTempKnown] = useState(false);
      const [tempForm, setTempForm] = useState({ id: '', kind: 'handoff', title: '', body: '' });
      const [tempBusy, setTempBusy] = useState('');
      // 工作流 / 短期目标：两套列表住在同一个 modes.json 里，面板是唯一编辑处。
      // `modeForm === null` 表示表单收着；会话里的选择不在这里改，在芯片里改。
      const [modes, setModes] = useState({ workflows: [], goals: [], defaultWorkflow: '' });
      const [modePath, setModePath] = useState('');
      const [modeForm, setModeForm] = useState(null);
      const [modeBusy, setModeBusy] = useState('');

      const loadModes = useCallback(async () => {
        try {
          const data = await call('modesLoad', {});
          if (data && data.ok === true) {
            setModes({
              workflows: Array.isArray(data.workflows) ? data.workflows : [],
              goals: Array.isArray(data.goals) ? data.goals : [],
              defaultWorkflow: typeof data.defaultWorkflow === 'string' ? data.defaultWorkflow : '',
            });
            setModePath(typeof data.path === 'string' ? data.path : '');
          }
        } catch (error) {
          /* keep whatever we already had */
        }
      }, []);

      const load = useCallback(async () => {
        setStatus('loading');
        try {
          const data = await call('load');
          if (!data || data.ok !== true) throw new Error((data && data.error) || '读取失败');
          const docMap = {};
          const savedMap = {};
          const rawMap = {};
          let stale = false;
          for (const entry of data.files) {
            if (!entry.doc || typeof entry.doc !== 'object') {
              stale = true;
              rawMap[entry.file] = entry.content || '';
            }
            const doc = entry.doc || { title: '', comments: [], preamble: [], groups: [] };
            docMap[entry.file] = doc;
            savedMap[entry.file] = JSON.stringify(doc);
          }
          setDocs(docMap);
          setSavedDocs(savedMap);
          setRaws(rawMap);
          setStaleHost(stale);
          setReport(data.injection || null);
          setDir(data.dir || '');
          setCapture(
            data.autoCapture && typeof data.autoCapture.on === 'boolean'
              ? { on: data.autoCapture.on, source: data.autoCapture.source || '' }
              : { on: false, source: '' },
          );
          setStatus('ready');
        } catch (error) {
          setStatus('error');
          setMessage({
            kind: 'err',
            text:
              '读取失败：' + String(error && error.message ? error.message : error) +
              '（若刚装好，插件宿主端还没重启加载——重启 DeepSeek Harness 后即可。）',
          });
        }
      }, []);

      // The waiting area is server state that only I add to; the panel mirrors it.
      const loadSuggestions = useCallback(async () => {
        try {
          const data = await call('suggestions');
          if (data && data.ok === true) {
            const items = data.items || [];
            setSuggestions(items);
            // Seed each 补充框 from what the server recorded (written when the
            // user clicked 采纳). A box the user is already typing in keeps its
            // draft — the 5s poll must never wipe half-written text.
            setNotes(function (prev) {
              const next = Object.assign({}, prev);
              for (const item of items) {
                if (typeof next[item.id] !== 'string') {
                  next[item.id] = typeof item.userNote === 'string' ? item.userNote : '';
                }
              }
              return next;
            });
          }
        } catch (error) {
          /* keep whatever we already had */
        }
      }, []);

      // 临时记忆是宿主侧的 store，面板只是镜子：读、写、归档都过路由。
      const loadTemp = useCallback(async () => {
        try {
          const data = await call('tempLoad');
          if (data && data.ok === true) {
            setTemps(Array.isArray(data.items) ? data.items : []);
            setTempPath(typeof data.path === 'string' ? data.path : '');
            setTempEnabled(data.enabled !== false);
            setTempKnown(true);
          }
        } catch (error) {
          /* keep whatever we already had */
        }
      }, []);

      useEffect(() => {
        void load();
        void loadSuggestions();
        void loadTemp();
        void loadModes();
      }, [load, loadSuggestions, loadTemp, loadModes]);

      // Both mirrored tabs are polled on one timer, whatever tab is showing: the
      // badge counts on the tab strip are how the user notices that a temp entry
      // was written or archived mid-turn, so they must stay live while another
      // tab is open. Both reads are cheap (local files, the host's in-process
      // store), and a poll never overwrites half-typed text: the 补充草稿 keeps
      // its draft, the editor keeps its own state.
      useEffect(
        function () {
          const handle = setInterval(function () {
            void loadSuggestions();
            void loadTemp();
          }, 5000);
          return function () {
            clearInterval(handle);
          };
        },
        [loadSuggestions, loadTemp],
      );

      // 一个 profile 把 tempMemory 关掉时，这个标签页仍然留着：点进去会说明
      // 为什么用不了、开关在哪。这里曾经把 active 弹回第一个文件页，结果点一下
      // 就被弹回去，看起来像「点不进」——比直接说明原因更糟，所以不弹了。

      const dirty = FILES.some((entry) => docSignature(docs[entry.file]) !== (savedDocs[entry.file] || ''));

      // 视图设置：藏起来的标签页只是不画出来，文件照旧加载、照旧注入。设置页
      // 本身永远可见，否则一旦把入口藏了就没有地方改回来。
      const visibleTabs = TABS.filter(
        (entry) => entry.file === SETTINGS_KEY || ui.hidden.indexOf(entry.file) < 0,
      );
      useEffect(
        function () {
          if (isKnownVisible(active, ui.hidden)) return;
          const fallback = visibleTabs.length > 0 ? visibleTabs[0].file : SETTINGS_KEY;
          setActive(fallback);
          writeActiveTab(fallback);
        },
        [active, ui.hidden],
      );

      // The switch is the only control that must act the moment it is clicked:
      // it writes the state file on the host and the host re-publishes the
      // injected block from it, with no restart in between.
      const flipCapture = useCallback(async function (next) {
        setCaptureBusy(true);
        try {
          const data = await call('autoCapture', { on: next });
          if (!data || data.ok !== true) throw new Error((data && data.error) || '设置失败');
          setCapture({ on: data.autoCapture.on, source: data.autoCapture.source || '' });
          setMessage({
            kind: 'ok',
            text:
              next
                ? '自动提议提醒已开启：AI 从下一轮对话起会主动提议值得长期记住的偏好（仍然只进「待确认」，要用户点「采纳」才写）。'
                : '自动提议提醒已关闭：AI 不再主动提议，系统提示词回到逐字节和以前一样。',
          });
        } catch (error) {
          setMessage({ kind: 'err', text: '设置失败：' + String(error && error.message ? error.message : error) });
        } finally {
          setCaptureBusy(false);
        }
      }, []);

      const save = useCallback(async () => {
        if (staleHost) {
          setMessage({
            kind: 'warn',
            text: '宿主还是旧版：现在保存会用空文档覆盖这一节。先重启 DeepSeek Harness，记忆文件本身没有丢。',
          });
          return;
        }
        setSaving(true);
        setMessage(null);
        try {
          const data = await call('saveDoc', { file: active, doc: docs[active] });
          if (!data || data.ok !== true) throw new Error((data && data.error) || '保存失败');
          const doc = data.doc || docs[active];
          setDocs(function (prev) {
            const next = Object.assign({}, prev);
            next[active] = doc;
            return next;
          });
          setSavedDocs(function (prev) {
            const next = Object.assign({}, prev);
            next[active] = JSON.stringify(doc);
            return next;
          });
          if (data.report) setReport(data.report);
          setMessage({ kind: 'ok', text: '已保存。' + (data.injection || '') });
        } catch (error) {
          setMessage({
            kind: 'err',
            text: '保存失败：' + String(error && error.message ? error.message : error),
          });
        } finally {
          setSaving(false);
        }
      }, [active, docs, staleHost]);

      // The one action the model can never take: deciding.
      const resolve = useCallback(
        async (id, decision, extra) => {
          setBusyId(id);
          setMessage(null);
          try {
            const data = await call(
              'resolveSuggestion',
              Object.assign({ id: id, decision: decision }, extra || {}),
            );
            if (!data || data.ok !== true) throw new Error((data && data.error) || '操作失败');
            const wrote = Boolean(extra) && typeof extra.note === 'string' && extra.note.trim() !== '';
            setMessage({
              kind: 'ok',
              text:
                decision === 'accept'
                  ? '已采纳 #' + id + '。AI 下一轮会收到通知，然后把它总结进记忆。' +
                    (wrote ? '用户写的补充会一起交给 AI（和原文冲突时以补充为准）。' : '') +
                    '在 AI 下一轮开跑之前，这里随时可以撤销。'
                  : decision === 'revoke'
                    ? '已撤销 #' + id + '。它回到「待用户决定」：可以改补充，也可以重新采纳。'
                    : '已忽略 #' + id + '，它不会被写入。',
            });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '操作失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setBusyId('');
            // 成功失败都刷新：撤销正好撞上「AI 下一轮已开始」时，面板必须立刻
            // 显示真实状态，而不是让用户以为撤销成功了。
            await loadSuggestions();
          }
        },
        [loadSuggestions],
      );

      // ---- 临时记忆面板动作 -------------------------------------------------
      // 四个动作共用一套 busy 标记：连点时按钮是禁用的，不会重复提交。
      const tempAction = useCallback(
        async function (action, extra, okText) {
          setTempBusy(action + ':' + (extra.id || ''));
          setMessage(null);
          try {
            const data = await call(action, extra);
            if (!data || data.ok !== true) throw new Error((data && data.error) || '操作失败');
            setTemps(Array.isArray(data.items) ? data.items : []);
            if (typeof okText === 'string' && okText !== '') setMessage({ kind: 'ok', text: okText });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '操作失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setTempBusy('');
            await loadTemp();
          }
        },
        [loadTemp],
      );

      const tempSubmit = useCallback(
        async function () {
          const editing = tempForm.id !== '';
          if (tempForm.title.trim() === '' || tempForm.body.trim() === '') {
            setMessage({ kind: 'err', text: '标题和正文都要填。' });
            return;
          }
          setTempBusy('save');
          setMessage(null);
          try {
            const data = await call('tempSave', {
              id: tempForm.id,
              kind: tempForm.kind,
              title: tempForm.title,
              body: tempForm.body,
            });
            if (!data || data.ok !== true) throw new Error((data && data.error) || '保存失败');
            setTemps(Array.isArray(data.items) ? data.items : []);
            setTempForm({ id: '', kind: tempForm.kind, title: '', body: '' });
            setMessage({
              kind: 'ok',
              text: editing
                ? '已更新 #' + tempForm.id + '，AI 下一步就能看到新内容。'
                : '已新增 #' + data.id + '：AI 下一轮开始时就带着它。做完跟 AI 说一声，或者回来点「标记完成」——它会立刻从注入里消失。',
            });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '保存失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setTempBusy('');
            await loadTemp();
          }
        },
        [tempForm, loadTemp],
      );

      const tempEdit = useCallback(function (item) {
        setTempForm({ id: item.id, kind: item.kind, title: item.title, body: item.body });
        setMessage({ kind: 'ok', text: '正在编辑 #' + item.id + '：改完点「保存修改」才生效。' });
      }, []);

      const tempReset = useCallback(function () {
        setTempForm({ id: '', kind: 'handoff', title: '', body: '' });
        setMessage(null);
      }, []);

      // ---- 工作流 / 短期目标 面板动作 ---------------------------------------
      // 列表只有四种写操作：存一条、删一条、设默认、开关一次会话的选择。
      // 每次写完都重读，面板显示的就是磁盘上的东西，而不是客户端的推测。
      const modeSubmit = useCallback(
        async function () {
          if (modeForm === null) return;
          if (modeForm.name.trim() === '' || modeForm.body.trim() === '') {
            setMessage({ kind: 'err', text: '名称和正文都要填。' });
            return;
          }
          const editing = modeForm.id !== '';
          setModeBusy('save');
          setMessage(null);
          try {
            const data = await call('modeSave', {
              kind: modeForm.kind,
              id: modeForm.id,
              name: modeForm.name,
              body: modeForm.body,
            });
            if (!data || data.ok !== true) throw new Error((data && data.error) || '保存失败');
            setModes({
              workflows: Array.isArray(data.workflows) ? data.workflows : [],
              goals: Array.isArray(data.goals) ? data.goals : [],
              defaultWorkflow: typeof data.defaultWorkflow === 'string' ? data.defaultWorkflow : '',
            });
            setModePath(typeof data.path === 'string' ? data.path : '');
            setModeForm(null);
            setMessage({
              kind: 'ok',
              text: editing
                ? '已保存修改。正在进行的会话下一步就会用新正文。'
                : '已新增。去输入框上方的小按钮里把它选给某个会话。',
            });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '保存失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setModeBusy('');
          }
        },
        [modeForm],
      );

      const modeRemove = useCallback(
        async function (kind, item) {
          if (!window.confirm('删除「' + item.name + '」？删除后，选了它的会话会回到默认（工作流）或不再有目标（短期目标）。')) {
            return;
          }
          setModeBusy('delete:' + item.id);
          setMessage(null);
          try {
            const data = await call('modeDelete', { kind: kind, id: item.id });
            if (!data || data.ok !== true) throw new Error((data && data.error) || '删除失败');
            setModes({
              workflows: Array.isArray(data.workflows) ? data.workflows : [],
              goals: Array.isArray(data.goals) ? data.goals : [],
              defaultWorkflow: typeof data.defaultWorkflow === 'string' ? data.defaultWorkflow : '',
            });
            if (modeForm !== null && modeForm.id === item.id) setModeForm(null);
            setMessage({ kind: 'ok', text: '已删除「' + item.name + '」。' });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '删除失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setModeBusy('');
          }
        },
        [modeForm],
      );

      const modeDefault = useCallback(
        async function (item) {
          const next = modes.defaultWorkflow === item.id ? '' : item.id;
          setModeBusy('default:' + item.id);
          setMessage(null);
          try {
            const data = await call('modeDefault', { id: next });
            if (!data || data.ok !== true) throw new Error((data && data.error) || '设置失败');
            setModes({
              workflows: Array.isArray(data.workflows) ? data.workflows : [],
              goals: Array.isArray(data.goals) ? data.goals : [],
              defaultWorkflow: typeof data.defaultWorkflow === 'string' ? data.defaultWorkflow : '',
            });
            setMessage({
              kind: 'ok',
              text: next === '' ? '已取消默认工作流：没显式选过的会话不再带工作流。' : '已把「' + item.name + '」设为默认工作流。',
            });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '设置失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setModeBusy('');
          }
        },
        [modes.defaultWorkflow],
      );

      const style = h('style', { key: 'umem-style' }, CSS);

      if (status === 'loading') {
        return h('div', { className: 'umem-root' }, style, h('div', { className: 'umem-center' }, '正在读取记忆…'));
      }

      if (status === 'error') {
        return h(
          'div',
          { className: 'umem-root' },
          style,
          h(
            'div',
            { className: 'umem-center' },
            h('div', null, h('div', null, message ? message.text : '读取失败'), h('div', { style: { marginTop: 16 } },
              h('button', { className: 'umem-btn', onClick: function () { void load(); } }, '重试'))),
          ),
        );
      }

      const isPending = active === PENDING_KEY;
      const isTemp = active === TEMP_KEY;
      const isModes = active === MODES_KEY;
      const isSettings = active === SETTINGS_KEY;
      // 四个伪标签页背后都没有记忆文件：没有编辑器，也没有「未保存」可言。
      const isPseudo = isPending || isTemp || isModes || isSettings;
      const current = isPseudo
        ? TABS.find((entry) => entry.file === active) || TABS[TABS.length - 1]
        : FILES.find((entry) => entry.file === active) || FILES[0];
      const isDirty = isPseudo ? false : docSignature(docs[active]) !== (savedDocs[active] || '');
      const waiting = suggestions.filter((item) => item.status === 'pending').length;
      const tempOpen = temps.filter((item) => item.status === 'open').length;

      // A memory file's Chinese name, for a suggestion's target.
      function targetTitle(file) {
        const hit = FILES.find((entry) => entry.file === file);
        return (hit ? hit.title : file) + '（' + file + '）';
      }

      const STAGE = {
        pending: '待用户决定',
        accepted: '已采纳 · 可撤销，等 AI 下一轮写入',
        delivered: '通知已送达 · 处理中',
        done: '已完成',
        dismissed: '已忽略',
      };

      function waitingArea() {
        const live = suggestions.filter(
          (item) => item.status !== 'dismissed' && item.status !== 'done',
        );
        const archived = suggestions.filter((item) => item.status === 'done').slice(-5);
        const visible = live.concat(archived);
        if (visible.length === 0) {
          return h(
            'div',
            { className: 'umem-center' },
            h(
              'div',
              null,
              '待确认区是空的。',
              h(
                'div',
                { style: { marginTop: 10 } },
                'AI 只有在提议时才会往这里放东西——放进来也不会自动写入，必须用户点「采纳」。',
              ),
            ),
          );
        }
        return h(
          'div',
          { className: 'umem-list' },
          visible.map(function (item) {
            const isOpen = item.status === 'pending';
            const isAccepted = item.status === 'accepted';
            const isDelivered = item.status === 'delivered';
            const recorded = typeof item.userNote === 'string' ? item.userNote.trim() : '';
            return h(
              'div',
              { key: item.id, className: 'umem-card', 'data-open': isOpen ? '1' : '0' },
              h(
                'div',
                { className: 'umem-cardhead' },
                h('span', { className: 'umem-id' }, '#' + item.id),
                h('span', { className: 'umem-target' }, targetTitle(item.file)),
                h('span', { className: 'umem-stage' }, STAGE[item.status] || item.status),
              ),
              h('pre', { className: 'umem-text' }, item.text),
              item.why ? h('div', { className: 'umem-why' }, '理由：' + item.why) : null,
              item.note ? h('div', { className: 'umem-why' }, '结果：' + item.note) : null,
              // 补充框只给「待用户决定」的卡片：落盘只发生在点「采纳」那一刻。
              isOpen
                ? h('textarea', {
                    className: 'umem-note',
                    rows: 2,
                    spellCheck: false,
                    disabled: busyId !== '',
                    placeholder:
                      '补充说明（可选）：用户想额外加的要求。点「采纳」时它和 AI 提议的原文一起交给 AI，冲突时以用户填写的补充为准。',
                    value: notes[item.id] || '',
                    onChange: function (event) {
                      const value = event.target.value;
                      setNotes(function (prev) {
                        const next = Object.assign({}, prev);
                        next[item.id] = value;
                        return next;
                      });
                    },
                  })
                : recorded !== ''
                  ? h('div', { className: 'umem-note-ro' }, '用户的补充：' + recorded)
                  : null,
              isOpen
                ? h(
                    'div',
                    { className: 'umem-cardfoot' },
                    h(
                      'button',
                      {
                        className: 'umem-btn',
                        disabled: busyId !== '',
                        onClick: function () {
                          void resolve(item.id, 'accept', { note: notes[item.id] || '' });
                        },
                      },
                      busyId === item.id ? '处理中…' : '采纳',
                    ),
                    h(
                      'button',
                      {
                        className: 'umem-btn',
                        disabled: busyId !== '',
                        onClick: function () {
                          void resolve(item.id, 'dismiss');
                        },
                      },
                      '忽略',
                    ),
                  )
                : isAccepted
                  ? h(
                      'div',
                      { className: 'umem-cardfoot' },
                      h(
                        'button',
                        {
                          className: 'umem-btn',
                          disabled: busyId !== '',
                          onClick: function () {
                            void resolve(item.id, 'revoke');
                          },
                        },
                        busyId === item.id ? '撤销中…' : '撤销采纳',
                      ),
                      h(
                        'span',
                        { className: 'umem-msg' },
                        '已采纳，还没交给 AI 下一轮。撤销后它回到「待用户决定」，可以改完补充再采纳。',
                      ),
                    )
                  : isDelivered
                    ? h(
                        'div',
                        { className: 'umem-cardfoot' },
                        h(
                          'span',
                          { className: 'umem-msg' },
                          '这条已经交给 AI 下一轮了，撤销来不及；要改就在对话里直接跟 AI 说。',
                        ),
                      )
                    : null,
            );
          }),
        );
      }

      const KIND_LABEL = { handoff: '交接', stage: '阶段目标', waiting: '等待项' };
      const KIND_NOTE = {
        handoff: '交接：写给「另一个对话」的交付信息——目标、现状、下一步、关键路径、怎么算验收通过。',
        stage: '阶段目标：AI 最近在替用户做的事。写清楚，AI 就不用每次重讲一遍。',
        waiting: '等待项：等某个条件满足再执行的任务（通常就是本对话自己等）。',
      };

      // 时间戳直接截断显示：面板只用来认人，不需要精确到秒。
      function shortTime(value) {
        if (typeof value !== 'string' || value === '') return '（无时间）';
        return value.replace('T', ' ').slice(0, 16);
      }

      function tempArea() {
        if (!tempEnabled) {
          return h(
            'div',
            { className: 'umem-center' },
            h(
              'div',
              null,
              '临时记忆没有启用。',
              h(
                'div',
                { style: { marginTop: 10 } },
                '它的开关在插件配置里：把 tempMemory 设为 true 并重载插件（改 profile 的 cordis.patch.yml 之后要重启 DeepSeek Harness）后，注入的「临时记忆」一节、temp_memory / temp_memory_done 两个工具，以及这个面板才会挂上。',
              ),
            ),
          );
        }
        const open = temps.filter((item) => item.status === 'open');
        const archived = temps.filter((item) => item.status === 'done').slice(-8).reverse();
        const busy = tempBusy !== '';
        const card = function (item) {
          const isOpen = item.status === 'open';
          const id = item.id;
          return h(
            'div',
            {
              key: id,
              className: 'umem-card',
              'data-open': isOpen ? '1' : '0',
              'data-muted': isOpen ? '0' : '1',
            },
            h(
              'div',
              { className: 'umem-cardhead' },
              h('span', { className: 'umem-id' }, '#' + id),
              h('span', { className: 'umem-target' }, item.title),
              h(
                'span',
                { className: 'umem-stage' },
                (KIND_LABEL[item.kind] || item.kind) + (isOpen ? '' : ' · 已归档'),
              ),
            ),
            h('pre', { className: 'umem-text' }, item.body),
            item.note ? h('div', { className: 'umem-why' }, '结果：' + item.note) : null,
            h(
              'div',
              { className: 'umem-why' },
              (isOpen ? '创建于 ' : '归档于 ') +
                shortTime(isOpen ? item.createdAt : item.doneAt || item.updatedAt),
            ),
            h(
              'div',
              { className: 'umem-cardfoot' },
              h(
                'button',
                {
                  className: 'umem-btn',
                  disabled: busy,
                  onClick: function () {
                    // `done` is the target state, not a toggle: an open card
                    // archives, an archived card goes back to open.
                    void tempAction(
                      'tempDone',
                      { id: id, done: isOpen },
                      isOpen
                        ? '已归档 #' + id + '：它立刻从注入里消失，数据还在下面，随时能恢复。'
                        : '已把 #' + id + ' 恢复为活跃：AI 下一轮又能看到它了。',
                    );
                  },
                },
                isOpen ? '标记完成' : '恢复为活跃',
              ),
              h(
                'button',
                { className: 'umem-btn', disabled: busy, onClick: function () { tempEdit(item); } },
                '编辑',
              ),
              h(
                'button',
                {
                  className: 'umem-btn',
                  disabled: busy,
                  onClick: function () {
                    void tempAction('tempDelete', { id: id }, '已删除 #' + id + '（连归档一起）。');
                  },
                },
                '删除',
              ),
              isOpen
                ? h('span', { className: 'umem-msg' }, '「标记完成」= 从注入里拿掉；「删除」= 连存档一起删。')
                : null,
            ),
          );
        };
        return h(
          'div',
          { className: 'umem-list' },
          h(
            'div',
            { className: 'umem-form' },
            h(
              'div',
              { className: 'umem-formrow' },
              h(
                'select',
                {
                  className: 'umem-select',
                  disabled: busy,
                  value: tempForm.kind,
                  onChange: function (event) {
                    const value = event.target.value;
                    setTempForm((prev) => Object.assign({}, prev, { kind: value }));
                  },
                },
                ['handoff', 'stage', 'waiting'].map((kind) =>
                  h('option', { key: kind, value: kind }, KIND_LABEL[kind]),
                ),
              ),
              h('input', {
                className: 'umem-input',
                style: { flex: 1, minWidth: 220 },
                spellCheck: false,
                disabled: busy,
                placeholder: '一句话标题：这是什么、交给谁（等什么）',
                value: tempForm.title,
                onChange: function (event) {
                  const value = event.target.value;
                  setTempForm((prev) => Object.assign({}, prev, { title: value }));
                },
              }),
              tempForm.id !== ''
                ? h('span', { className: 'umem-badge' }, '编辑 #' + tempForm.id)
                : null,
            ),
            h('textarea', {
              className: 'umem-note umem-bigt',
              spellCheck: false,
              disabled: busy,
              placeholder:
                '正文（markdown）。交接条目请当成交付文档写：现在到哪一步、下一步做什么、关键路径、怎么算验收通过。',
              value: tempForm.body,
              onChange: function (event) {
                const value = event.target.value;
                setTempForm((prev) => Object.assign({}, prev, { body: value }));
              },
            }),
            h(
              'div',
              { className: 'umem-formrow' },
              h(
                'button',
                { className: 'umem-btn', disabled: busy, onClick: function () { void tempSubmit(); } },
                tempBusy === 'save' ? '保存中…' : tempForm.id === '' ? '新增一条' : '保存修改',
              ),
              tempForm.id !== ''
                ? h('button', { className: 'umem-btn', disabled: busy, onClick: tempReset }, '取消编辑')
                : null,
              h('span', { className: 'umem-msg' }, KIND_NOTE[tempForm.kind] || ''),
            ),
            h(
              'div',
              { className: 'umem-arch' },
              '存储位置：' + (tempPath || '（未知）') + '　|　当前活跃 ' + tempOpen + ' 条',
            ),
          ),
          open.length === 0 && archived.length === 0
            ? h(
                'div',
                { className: 'umem-center' },
                h(
                  'div',
                  null,
                  '临时记忆是空的。',
                  h(
                    'div',
                    { style: { marginTop: 10 } },
                    '这里放的是「还没做完的事」：跨对话的交接、阶段目标、等待项。它不会自动增长——AI 只在被明确要求时才写。',
                  ),
                ),
              )
            : null,
          open.map(card),
          archived.length > 0
            ? h(
                'div',
                { className: 'umem-formrow' },
                h(
                  'span',
                  { className: 'umem-msg', style: { flex: 1 } },
                  '归档 ' + archived.length + ' 条（不再注入）',
                ),
                h(
                  'button',
                  {
                    className: 'umem-btn',
                    disabled: busy,
                    onClick: function () {
                      void tempAction('tempCleanup', {}, '已清理全部已归档条目。');
                    },
                  },
                  '清空归档',
                ),
              )
            : null,
          archived.map(card),
        );
      }

      // 工作流 / 短期目标。两套列表在同一页，因为它们的生命周期一样：写一次，
      // 然后在每个会话里各选各的。卡片直接展开正文——这些是给模型看的指令，
      // 不是标题清单，看不懂正文就没法判断该选哪一条。
      function modeArea() {
        const busy = modeBusy !== '';
        const section = function (kind, title, note) {
          const list = kind === 'workflow' ? modes.workflows : modes.goals;
          const card = function (item) {
            const isDefault = kind === 'workflow' && modes.defaultWorkflow === item.id;
            if (modeForm !== null && modeForm.kind === kind && modeForm.id !== '' && modeForm.id === item.id) {
              return h(
                'div',
                { key: item.id, className: 'umem-form' },
                h(
                  'div',
                  { className: 'umem-formrow' },
                  h('input', {
                    className: 'umem-input',
                    style: { flex: 1 },
                    spellCheck: false,
                    disabled: busy,
                    placeholder: '名称（会话里的小按钮上显示这几个字）',
                    value: modeForm.name,
                    onChange: function (event) {
                      const value = event.target.value;
                      setModeForm((prev) => Object.assign({}, prev, { name: value }));
                    },
                  }),
                  h('span', { className: 'umem-badge' }, '编辑中'),
                ),
                h('textarea', {
                  className: 'umem-note umem-bigt',
                  spellCheck: false,
                  disabled: busy,
                  placeholder: '正文：AI 该怎么做。写具体规则、顺序、边界条件，别写口号。',
                  value: modeForm.body,
                  onChange: function (event) {
                    const value = event.target.value;
                    setModeForm((prev) => Object.assign({}, prev, { body: value }));
                  },
                }),
                h(
                  'div',
                  { className: 'umem-formrow' },
                  h(
                    'button',
                    { className: 'umem-btn', disabled: busy, onClick: function () { void modeSubmit(); } },
                    modeBusy === 'save' ? '保存中…' : '保存修改',
                  ),
                  h('button', { className: 'umem-btn', disabled: busy, onClick: function () { setModeForm(null); } }, '取消'),
                ),
              );
            }
            return h(
              'div',
              { key: item.id, className: 'umem-card umem-modecard', 'data-on': isDefault ? '1' : '0' },
              h(
                'div',
                { className: 'umem-cardhead' },
                h('span', { className: 'umem-target' }, item.name),
                isDefault ? h('span', { className: 'umem-badge' }, '默认') : null,
                h('span', { className: 'umem-stage' }, item.body.length + ' 字'),
              ),
              h('pre', { className: 'umem-modebody' }, item.body.length > 220 ? item.body.slice(0, 220) + '…' : item.body),
              h(
                'div',
                { className: 'umem-cardfoot' },
                h(
                  'button',
                  {
                    className: 'umem-btn',
                    disabled: busy,
                    onClick: function () {
                      setModeForm({ kind: kind, id: item.id, name: item.name, body: item.body });
                      setMessage(null);
                    },
                  },
                  '编辑',
                ),
                kind === 'workflow'
                  ? h(
                      'button',
                      {
                        className: 'umem-btn',
                        disabled: busy || modeBusy === 'default:' + item.id,
                        onClick: function () { void modeDefault(item); },
                      },
                      isDefault ? '取消默认' : '设为默认',
                    )
                  : null,
                h(
                  'button',
                  {
                    className: 'umem-btn',
                    disabled: busy || modeBusy === 'delete:' + item.id,
                    onClick: function () { void modeRemove(kind, item); },
                  },
                  '删除',
                ),
              ),
            );
          };
          const creating = modeForm !== null && modeForm.kind === kind && modeForm.id === '';
          return h(
            'div',
            { className: 'umem-modesec', key: kind },
            h('div', { className: 'umem-sectitle' }, title, h('span', { className: 'umem-sub' }, note)),
            list.length === 0 && !creating
              ? h('div', { className: 'umem-msg' }, '还没有。点下面的按钮写第一条；不写就什么都不影响。')
              : null,
            list.map(card),
            creating
              ? h(
                  'div',
                  { className: 'umem-form' },
                  h(
                    'div',
                    { className: 'umem-formrow' },
                    h('input', {
                      className: 'umem-input',
                      style: { flex: 1 },
                      spellCheck: false,
                      disabled: busy,
                      placeholder: kind === 'workflow' ? '工作流名称，例如：硬件模块验证' : '短期目标名称，例如：第 3 届光电赛 A 题',
                      value: modeForm.name,
                      onChange: function (event) {
                        const value = event.target.value;
                        setModeForm((prev) => Object.assign({}, prev, { name: value }));
                      },
                    }),
                    h('span', { className: 'umem-badge' }, '新建'),
                  ),
                  h('textarea', {
                    className: 'umem-note umem-bigt',
                    spellCheck: false,
                    disabled: busy,
                    placeholder: '正文：AI 在这个模式下该怎么干活／这个会话要完成什么。写具体约束与验收标准。',
                    value: modeForm.body,
                    onChange: function (event) {
                      const value = event.target.value;
                      setModeForm((prev) => Object.assign({}, prev, { body: value }));
                    },
                  }),
                  h(
                    'div',
                    { className: 'umem-formrow' },
                    h(
                      'button',
                      { className: 'umem-btn', disabled: busy, onClick: function () { void modeSubmit(); } },
                      modeBusy === 'save' ? '保存中…' : '保存',
                    ),
                    h('button', { className: 'umem-btn', disabled: busy, onClick: function () { setModeForm(null); } }, '取消'),
                  ),
                )
              : h(
                  'div',
                  { className: 'umem-btnRow' },
                  h(
                    'button',
                    {
                      className: 'umem-btn',
                      disabled: busy,
                      onClick: function () {
                        setModeForm({ kind: kind, id: '', name: '', body: '' });
                        setMessage(null);
                      },
                    },
                    kind === 'workflow' ? '＋ 新建工作流' : '＋ 新建短期目标',
                  ),
                ),
          );
        };
        return h(
          'div',
          { className: 'umem-modes' },
          section('workflow', '工作流', '可设一个默认；会话里没选过的就跟随默认'),
          section('goal', '短期目标', '没有默认，不选就完全不加——不会拿上一次的目标凑数'),
          h(
            'div',
            { className: 'umem-arch' },
            '存储位置：' + (modePath || '（保存第一条时才创建）') + '　|　会话里的选择记在同一个文件里',
          ),
        );
      }

      // ---- 0.8.2：条目编辑器 -------------------------------------------------
      // 一份 doc 就是这一节的全部内容。编辑只改 doc（局部），保存时整份发回服务端
      // 重新 compose，所以面板永远不会把用户手写的记录文件重排。
      const activeDoc = docs[active] || null;
      const sectionReport =
        report && Array.isArray(report.sections)
          ? report.sections.find(function (item) {
              return item.file === active;
            }) || null
          : null;

      // 有未保存改动时不显示「未注入」：那份 report 描述的是磁盘上的旧内容，拿它
      // 标新编辑的条目会撒谎。保存成功后 report 会刷新。
      const fitOf = function (index) {
        if (isDirty || !sectionReport || !Array.isArray(sectionReport.entries)) return 'full';
        const hit = sectionReport.entries.find(function (item) {
          return item.entryIndex === index;
        });
        return hit ? hit.fitted : 'full';
      };

      const editDoc = function (mutator) {
        setDocs(function (prev) {
          const next = Object.assign({}, prev);
          const doc = cloneDoc(prev[active]);
          mutator(doc);
          next[active] = doc;
          return next;
        });
      };

      const newEntry = function (list) {
        const prev = list.length > 0 ? list[list.length - 1] : null;
        return {
          kind: 'bullet',
          text: '新的一条记忆',
          sep: prev && prev.kind === 'bullet' ? '\n' : '\n\n',
        };
      };

      const entryCard = function (entry, index) {
        const fit = fitOf(index);
        const size = Array.from(String(entry.text || '')).length;
        const lines = String(entry.text || '').split('\n').length;
        return h(
          'div',
          { key: 'entry-' + index, className: 'umem-entry', 'data-fit': fit },
          h(
            'div',
            { className: 'umem-entryhead' },
            h('span', null, '#' + (index + 1)),
            fit === 'dropped'
              ? h('span', { className: 'umem-chip', 'data-kind': 'warn' }, '这次没进上下文')
              : null,
            h('span', null, size + ' 字'),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              {
                className: 'umem-mini',
                onClick: function () {
                  editDoc(function (doc) {
                    const hit = entryAt(doc, index);
                    if (hit) hit.list.splice(hit.at, 1);
                  });
                },
              },
              '删除',
            ),
          ),
          h('textarea', {
            spellCheck: false,
            rows: Math.min(16, Math.max(2, lines)),
            value: entry.text || '',
            onChange: function (event) {
              const value = event.target.value;
              editDoc(function (doc) {
                const hit = entryAt(doc, index);
                if (hit) hit.list[hit.at].text = value;
              });
            },
          }),
        );
      };

      function entryArea() {
        if (staleHost) {
          return h(
            'div',
            { className: 'umem-stale' },
            h('div', { className: 'umem-stale-title' }, '记忆文件都在，只是面板比宿主新。'),
            h(
              'div',
              null,
              '浏览器里的面板已经是新版的按条编辑器，但 DeepSeek Harness 进程里跑的仍是旧版插件，' +
                '旧版读出来的数据没有「条目」结构，所以这里先显示原文、暂时不能按条编辑。' +
                '重启 DeepSeek Harness 之后就恢复正常；文件本身一个字节没动。',
            ),
            h('pre', { className: 'umem-raw' }, raws[active] || ''),
            h('div', { className: 'umem-stale-title' }, '目录：' + (dir || '（见 memory_suggest 的 dir）')),
          );
        }
        if (!activeDoc) {
          return h('div', { className: 'umem-center' }, h('div', null, '读取中…'));
        }
        const indexRef = { value: 0 };
        const cards = [];
        const preamble = activeDoc.preamble || [];
        preamble.forEach(function (entry) {
          cards.push(entryCard(entry, indexRef.value));
          indexRef.value += 1;
        });
        (activeDoc.groups || []).forEach(function (group, groupIndex) {
          const groupCards = [];
          (group.entries || []).forEach(function (entry) {
            groupCards.push(entryCard(entry, indexRef.value));
            indexRef.value += 1;
          });
          cards.push(
            h(
              'div',
              { key: 'group-' + groupIndex, className: 'umem-group' },
              h(
                'div',
                { className: 'umem-grouphead' },
                h('input', {
                  className: 'umem-gtitle',
                  spellCheck: false,
                  value: group.title || '',
                  placeholder: '组名（## 行）',
                  onChange: function (event) {
                    const value = event.target.value;
                    editDoc(function (doc) {
                      doc.groups[groupIndex].title = value;
                    });
                  },
                }),
                h(
                  'button',
                  {
                    className: 'umem-mini',
                    onClick: function () {
                      editDoc(function (doc) {
                        doc.groups.splice(groupIndex, 1);
                      });
                    },
                  },
                  '删掉这组',
                ),
              ),
              groupCards,
              h(
                'button',
                {
                  className: 'umem-mini',
                  onClick: function () {
                    editDoc(function (doc) {
                      doc.groups[groupIndex].entries.push(newEntry(doc.groups[groupIndex].entries));
                    });
                  },
                },
                '＋ 这一组再加一条',
              ),
            ),
          );
        });
        const total = sectionReport ? sectionReport.chars : null;
        const got = sectionReport ? sectionReport.injectedChars : null;
        const percent = total ? Math.round((got / total) * 100) : null;
        return h(
          'div',
          { className: 'umem-entries' },
          sectionReport && !isDirty
            ? h(
                'div',
                { className: 'umem-meter' },
                sectionReport.fitted === 'full'
                  ? '这一节 ' + sectionReport.entries.length + ' 条全部会进上下文（' + got + ' / ' + total + ' 字）'
                  : '这一节 ' + sectionReport.entries.length + ' 条里只有部分进上下文（' + got + ' / ' + total + ' 字，保留 ' + percent + '%）',
                h(
                  'div',
                  { className: 'umem-meterbar' },
                  h('div', {
                    className: 'umem-meterfill',
                    style: { width: Math.max(2, Math.min(100, percent || 0)) + '%' },
                  }),
                ),
              )
            : null,
          h('input', {
            className: 'umem-gtitle',
            style: { fontSize: '15px' },
            spellCheck: false,
            value: activeDoc.title || '',
            placeholder: '文件标题（# 行，不注入给 AI）',
            onChange: function (event) {
              const value = event.target.value;
              editDoc(function (doc) {
                doc.title = value;
              });
            },
          }),
          cards,
          h(
            'button',
            {
              className: 'umem-mini',
              style: { alignSelf: 'flex-start' },
              onClick: function () {
                editDoc(function (doc) {
                  const entries = [];
                  entries.push(newEntry(entries));
                  doc.groups.push({ title: '新的一组', entries: entries, sep: '\n\n' });
                });
              },
            },
            '＋ 新增一组',
          ),
        );
      }

      function settingsArea() {
        const apply = function (hidden, preset) {
          const next = { hidden: hidden.slice(), preset: preset };
          setUi(next);
          writeUi(next);
          setMessage(null);
        };
        return h(
          'div',
          { className: 'umem-settings' },
          h('div', { className: 'umem-sectitle' }, '预设'),
          h(
            'div',
            { className: 'umem-row' },
            PRESETS.map(function (preset) {
              return h(
                'button',
                {
                  key: preset.id,
                  className: 'umem-btn',
                  'data-on': ui.preset === preset.id ? '1' : '0',
                  onClick: function () {
                    apply(preset.hidden, preset.id);
                  },
                },
                preset.title,
              );
            }),
          ),
          h(
            'div',
            { className: 'umem-msg' },
            '预设只是把下面的勾选一次填好；勾完还可以单独改，改过就记为「自定义」。',
          ),
          h('div', { className: 'umem-sectitle' }, '标签页'),
          TABS.map(function (entry) {
            const locked = entry.file === SETTINGS_KEY;
            const shown = locked || ui.hidden.indexOf(entry.file) < 0;
            return h(
              'label',
              { key: entry.file, className: 'umem-label' },
              h('input', {
                type: 'checkbox',
                checked: shown,
                disabled: locked,
                onChange: function (event) {
                  const nextHidden = ui.hidden.filter(function (file) {
                    return file !== entry.file;
                  });
                  if (!event.target.checked) nextHidden.push(entry.file);
                  apply(nextHidden, 'custom');
                },
              }),
              entry.title,
              h('span', { className: 'umem-sub' }, locked ? '（永远可见）' : entry.file),
            );
          }),
          h(
            'div',
            { className: 'umem-msg' },
            '隐藏只影响面板看不看得到，不影响注入：藏起来的记忆照样每轮都会进上下文。要让它真的不注入，只能改文件内容。',
          ),
          h(
            'div',
            { className: 'umem-arch' },
            '设置存在浏览器 localStorage（' + UI_KEY + '），不写记忆目录，也不进上下文，换台机器就回到默认。',
          ),
        );
      }

      return h(
        'div',
        { className: 'umem-root' },
        style,
        h(
          'div',
          { className: 'umem-head' },
          h('div', { className: 'umem-title' }, '多功能记忆'),
          h(
            'div',
            { className: 'umem-sub' },
            '文件位置：' + (dir || '（未知）') +
              (report
                ? '　|　整块注入 ' + report.injectedChars + ' / ' + report.totalChars + ' 字（保留 ' +
                  (report.totalChars ? Math.round((report.injectedChars / report.totalChars) * 100) : 100) +
                  '%，预算 ' + report.budget + ' 字）'
                : ''),
          ),
          h(
            'div',
            { className: 'umem-switch' },
            h(
              'button',
              {
                className: 'umem-btn',
                disabled: capture === null || captureBusy,
                onClick: function () {
                  if (capture === null) return;
                  void flipCapture(!capture.on);
                },
              },
              h('span', {
                className: 'umem-dot',
                style: capture && capture.on ? { background: 'var(--dsw-alias-state-success-primary)' } : null,
              }),
              '自动提议提醒：' + (capture === null ? '读取中…' : capture.on ? '已开启' : '已关闭'),
            ),
            h(
              'div',
              { className: 'umem-switch-note' },
              capture && capture.source === 'config'
                ? '当前状态来自插件配置（配置文件里写了 autoCapture），点一下就用面板的设置覆盖它。'
                : '开启后，AI 会在对话里主动提议值得长期记住的偏好——提议只进「待确认」，用户点「采纳」才会写进记忆。',
            ),
          ),
        ),
        h(
          'div',
          { className: 'umem-tabs' },
          visibleTabs.map(function (entry) {
            const pseudo =
              entry.file === PENDING_KEY ||
              entry.file === TEMP_KEY ||
              entry.file === MODES_KEY ||
              entry.file === SETTINGS_KEY;
            const entryDirty = pseudo ? false : docSignature(docs[entry.file]) !== (savedDocs[entry.file] || '');
            const badge =
              entry.file === PENDING_KEY ? waiting : entry.file === TEMP_KEY ? tempOpen : 0;
            const section = report && Array.isArray(report.sections)
              ? report.sections.find(function (item) { return item.file === entry.file; })
              : null;
            const cut = section && section.fitted !== 'full' ? section : null;
            return h(
              'button',
              {
                key: entry.file,
                className: 'umem-tab',
                'data-on': entry.file === active ? '1' : '0',
                onClick: function () {
                  setActive(entry.file);
                  writeActiveTab(entry.file);
                  setMessage(null);
                  if (entry.file === PENDING_KEY) void loadSuggestions();
                  if (entry.file === TEMP_KEY) void loadTemp();
                  if (entry.file === MODES_KEY) void loadModes();
                },
              },
              entry.title,
              entryDirty ? h('span', { className: 'umem-dot' }) : null,
              cut
                ? h(
                    'span',
                    {
                      className: 'umem-cut',
                      title:
                        '这一节有 ' +
                        (section.fitted === 'dropped' ? '全部' : '部分') +
                        '条目这次没有进上下文，点开看是哪几条',
                    },
                    '!',
                  )
                : null,
              badge > 0 ? h('span', { className: 'umem-count' }, badge) : null,
            );
          }),
        ),
        h(
          'div',
          { className: 'umem-hintbar' },
          current.hint + (isPseudo ? '' : '　|　' + current.file),
        ),
        h(
          'div',
          { className: 'umem-body', 'data-flat': isPseudo ? '1' : '0' },
          isPending
            ? waitingArea()
            : isTemp
              ? tempArea()
              : isModes
                ? modeArea()
                : isSettings
                  ? settingsArea()
                  : entryArea(),
        ),
        h(
          'div',
          { className: 'umem-foot' },
          isPseudo
            ? h(
                'button',
                {
                  className: 'umem-btn',
                  onClick: function () {
                    if (isTemp) void loadTemp();
                    else if (isModes) void loadModes();
                    else void loadSuggestions();
                  },
                },
                '刷新',
              )
            : h(
                'button',
                {
                  className: 'umem-btn',
                  disabled: !isDirty || saving,
                  onClick: function () {
                    void save();
                  },
                },
                saving ? '保存中…' : isDirty ? '保存这一节' : '没有改动',
              ),
          isPseudo
            ? null
            : h(
                'button',
                {
                  className: 'umem-btn',
                  disabled: !dirty,
                  onClick: function () {
                    const next = {};
                    FILES.forEach(function (entry) {
                      const snapshot = savedDocs[entry.file];
                      if (typeof snapshot === 'string' && snapshot !== '') {
                        next[entry.file] = JSON.parse(snapshot);
                      }
                    });
                    setDocs(next);
                    setMessage({ kind: 'ok', text: '已放弃全部未保存的改动。' });
                  },
                },
                '放弃改动',
              ),
          h(
            'span',
            { className: 'umem-msg', 'data-kind': message ? message.kind : '' },
            message
              ? message.text
              : isPending
                ? '「采纳」只是通知 AI 下一轮来写；左下角补充框里的字，也是点「采纳」那一刻才存下来。采纳后到 AI 下一轮开跑之前，可以「撤销采纳」。'
                : isTemp
                  ? '临时记忆有自己的预算（默认 1200 字符），不吃长期记忆的额度。只在被明确要求时才新增；标成完成的条目立刻从注入里消失——「完成即清理」，数据留在这里可恢复。'
                  : isModes
                    ? '工作流有默认，短期目标没有：没选目标的会话不会带任何目标。改完不用重启；选过的会话下一步就用新正文。'
                    : isSettings
                      ? '这里的开关只改变面板，不改变注入；想让它真的不进上下文，得删改文件内容。'
                      : '每条是一个条目：整条进上下文，或整条不进。保存后立即生效，无需重启。',
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = [];
        const own = function (result) {
          if (typeof result === 'function') disposers.push(result);
        };
        own(
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel);
          }),
        );
        own(
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: '多功能记忆' },
              Icon,
            );
          }),
        );
        // The two session chips. `conversation.input.left` is the compact control
        // strip on the composer's tool row (session-scoped), which is exactly where
        // a per-conversation choice belongs — the agent-preset seat is new-session
        // only, so it cannot carry these.
        own(
          ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register(
              { name: 'conversation.input.left', id: WORKFLOW_CHIP_ID, order: WORKFLOW_CHIP_ORDER },
              function WorkflowChip(props) {
                return h(ModeChip, { sessionId: props.sessionId, kind: 'workflow' });
              },
            );
          }),
        );
        own(
          ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register(
              { name: 'conversation.input.left', id: GOAL_CHIP_ID, order: GOAL_CHIP_ORDER },
              function GoalChip(props) {
                return h(ModeChip, { sessionId: props.sessionId, kind: 'goal' });
              },
            );
          }),
        );
        return function () {
          for (const dispose of disposers) {
            if (typeof dispose === 'function') dispose();
          }
        };
      },
    };
  },
});
