// Browser half of dsh-user-memory: the sidebar entry and the 长期记忆 panel.
// Loaded by the Harness client module loader; `id` must equal the package name.
window.__ModuleLoader__.load({
  id: 'dsh-user-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const ROUTE = '/api/dsh-user-memory';
    const PANEL_ID = 'user-memory';
    const PANEL_ORDER = 40;
    // A pseudo-tab: no file behind it, it shows the suggestion waiting area.
    const PENDING_KEY = '__pending__';

    // Chinese-first labels: the user should never have to read a filename.
    const FILES = [
      { file: 'rules-must.md', title: '必须遵守', hint: '硬性要求，我会按字面执行' },
      { file: 'agent.md', title: '行为设定', hint: '我面对你时的做事方式' },
      { file: 'profile.md', title: '用户画像', hint: '关于你的背景，用来调整我的表达' },
      { file: 'rules-should.md', title: '可选遵守', hint: '酌情执行，优先级低于上面' },
      { file: 'log.md', title: '变更日志', hint: '只给你自己记账，不注入' },
    ];

    // Tabs = the editable files, plus the waiting area where I propose and only
    // the user's click decides.
    const TABS = FILES.concat([
      { file: PENDING_KEY, title: '待确认', hint: '我提议，你点「采纳」才会写进记忆；采纳后到我下一轮开跑之前可以撤销' },
    ]);

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
      '.umem-hintbar{padding:8px 24px 0;font-size:12px;color:var(--dsw-alias-label-tertiary);}',
      '.umem-body{flex:1;min-height:0;padding:10px 24px;display:flex;}',
      '.umem-editor{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:12px 14px;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:13px;line-height:1.65;}',
      '.umem-editor:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
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

    function Panel() {
      const [status, setStatus] = useState('loading');
      const [dir, setDir] = useState('');
      const [saved, setSaved] = useState({});
      const [drafts, setDrafts] = useState({});
      const [active, setActive] = useState(FILES[0].file);
      const [message, setMessage] = useState(null);
      const [saving, setSaving] = useState(false);
      const [suggestions, setSuggestions] = useState([]);
      const [notes, setNotes] = useState({});
      const [busyId, setBusyId] = useState('');
      // The auto-capture switch. `null` = still loading, so the button never
      // flashes a wrong state before the first response arrives.
      const [capture, setCapture] = useState(null);
      const [captureBusy, setCaptureBusy] = useState(false);

      const load = useCallback(async () => {
        setStatus('loading');
        try {
          const data = await call('load');
          if (!data || data.ok !== true) throw new Error((data && data.error) || '读取失败');
          const map = {};
          for (const entry of data.files) map[entry.file] = entry.content;
          setSaved(map);
          setDrafts(map);
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

      useEffect(() => {
        void load();
        void loadSuggestions();
      }, [load, loadSuggestions]);

      // While the waiting area is open, pick up a suggestion I make mid-turn.
      useEffect(
        function () {
          if (active !== PENDING_KEY) return undefined;
          const handle = setInterval(function () {
            void loadSuggestions();
          }, 5000);
          return function () {
            clearInterval(handle);
          };
        },
        [active, loadSuggestions],
      );

      const dirty = FILES.some((entry) => (drafts[entry.file] || '') !== (saved[entry.file] || ''));

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
                ? '记忆采集已开启：我从下一轮对话起会主动提议值得长期记住的偏好（仍然只进「待确认」，要你点「采纳」才写）。'
                : '记忆采集已关闭：我不再主动提议，系统提示词回到逐字节和以前一样。',
          });
        } catch (error) {
          setMessage({ kind: 'err', text: '设置失败：' + String(error && error.message ? error.message : error) });
        } finally {
          setCaptureBusy(false);
        }
      }, []);

      const save = useCallback(async () => {
        setSaving(true);
        setMessage(null);
        try {
          const data = await call('save', { file: active, content: drafts[active] || '' });
          if (!data || data.ok !== true) throw new Error((data && data.error) || '保存失败');
          setSaved(function (prev) {
            const next = Object.assign({}, prev);
            next[active] = drafts[active] || '';
            return next;
          });
          setMessage({ kind: 'ok', text: '已保存。' + (data.injection || '') });
        } catch (error) {
          setMessage({
            kind: 'err',
            text: '保存失败：' + String(error && error.message ? error.message : error),
          });
        } finally {
          setSaving(false);
        }
      }, [active, drafts]);

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
                  ? '已采纳 #' + id + '。我下一轮会收到通知，然后把它总结进记忆。' +
                    (wrote ? '你写的补充会一起交给我（和原文冲突时以补充为准）。' : '') +
                    '在我下一轮开跑之前，这里随时可以撤销。'
                  : decision === 'revoke'
                    ? '已撤销 #' + id + '。它回到「等你决定」：可以改补充，也可以重新采纳。'
                    : '已忽略 #' + id + '，它不会被写入。',
            });
          } catch (error) {
            setMessage({
              kind: 'err',
              text: '操作失败：' + String(error && error.message ? error.message : error),
            });
          } finally {
            setBusyId('');
            // 成功失败都刷新：撤销正好撞上「我下一轮已开始」时，面板必须立刻
            // 显示真实状态，而不是让用户以为撤销成功了。
            await loadSuggestions();
          }
        },
        [loadSuggestions],
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
      const current = isPending
        ? TABS[TABS.length - 1]
        : FILES.find((entry) => entry.file === active) || FILES[0];
      const isDirty = isPending ? false : (drafts[active] || '') !== (saved[active] || '');
      const waiting = suggestions.filter((item) => item.status === 'pending').length;

      // A memory file's Chinese name, for a suggestion's target.
      function targetTitle(file) {
        const hit = FILES.find((entry) => entry.file === file);
        return (hit ? hit.title : file) + '（' + file + '）';
      }

      const STAGE = {
        pending: '等你决定',
        accepted: '已采纳 · 可撤销，等我下一轮写入',
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
                '我只有在提议时才会往这里放东西——放进来也不会自动写入，必须你点「采纳」。',
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
              // 补充框只给「等你决定」的卡片：落盘只发生在点「采纳」那一刻。
              isOpen
                ? h('textarea', {
                    className: 'umem-note',
                    rows: 2,
                    spellCheck: false,
                    disabled: busyId !== '',
                    placeholder:
                      '补充说明（可选）：你想额外加的要求。点「采纳」时它和我提议的原文一起交给我，冲突时以你的补充为准。',
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
                  ? h('div', { className: 'umem-note-ro' }, '你的补充：' + recorded)
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
                        '已采纳，还没交到我下一轮。撤销后它回到「等你决定」，可以改完补充再采纳。',
                      ),
                    )
                  : isDelivered
                    ? h(
                        'div',
                        { className: 'umem-cardfoot' },
                        h(
                          'span',
                          { className: 'umem-msg' },
                          '这条已经交到我下一轮了，撤销来不及；要改就在对话里直接跟我说。',
                        ),
                      )
                    : null,
            );
          }),
        );
      }

      return h(
        'div',
        { className: 'umem-root' },
        style,
        h(
          'div',
          { className: 'umem-head' },
          h('div', { className: 'umem-title' }, '长期记忆'),
          h('div', { className: 'umem-sub' }, '文件位置：' + (dir || '（未知）')),
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
              '自动采集记忆：' + (capture === null ? '读取中…' : capture.on ? '已开启' : '已关闭'),
            ),
            h(
              'div',
              { className: 'umem-switch-note' },
              capture && capture.source === 'config'
                ? '当前状态来自插件配置（配置文件里写了 autoCapture），点一下就用面板的设置覆盖它。'
                : '开启后，我会在对话里主动提议值得长期记住的偏好——提议只进「待确认」，你点「采纳」才会写进记忆。',
            ),
          ),
        ),
        h(
          'div',
          { className: 'umem-tabs' },
          TABS.map(function (entry) {
            const entryDirty =
              entry.file === PENDING_KEY
                ? false
                : (drafts[entry.file] || '') !== (saved[entry.file] || '');
            return h(
              'button',
              {
                key: entry.file,
                className: 'umem-tab',
                'data-on': entry.file === active ? '1' : '0',
                onClick: function () {
                  setActive(entry.file);
                  setMessage(null);
                  if (entry.file === PENDING_KEY) void loadSuggestions();
                },
              },
              entry.title,
              entryDirty ? h('span', { className: 'umem-dot' }) : null,
              entry.file === PENDING_KEY && waiting > 0
                ? h('span', { className: 'umem-count' }, waiting)
                : null,
            );
          }),
        ),
        h(
          'div',
          { className: 'umem-hintbar' },
          current.hint + (isPending ? '' : '　|　' + current.file),
        ),
        h(
          'div',
          { className: 'umem-body', 'data-flat': isPending ? '1' : '0' },
          isPending
            ? waitingArea()
            : h('textarea', {
                className: 'umem-editor',
                spellCheck: false,
                value: drafts[active] || '',
                onChange: function (event) {
                  const value = event.target.value;
                  setDrafts(function (prev) {
                    const next = Object.assign({}, prev);
                    next[active] = value;
                    return next;
                  });
                },
              }),
        ),
        h(
          'div',
          { className: 'umem-foot' },
          isPending
            ? h(
                'button',
                {
                  className: 'umem-btn',
                  onClick: function () {
                    void loadSuggestions();
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
          isPending
            ? null
            : h(
                'button',
                {
                  className: 'umem-btn',
                  disabled: !dirty,
                  onClick: function () {
                    setDrafts(Object.assign({}, saved));
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
                ? '「采纳」只是通知我下一轮来写；左下角补充框里的字，也是点「采纳」那一刻才存下来。采纳后到我下一轮开跑之前，可以「撤销采纳」。'
                : '保存后立即生效，无需重启。注释 <!-- --> 不会注入给我。',
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
              { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: '长期记忆' },
              Icon,
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
