// dsh-tide-whisper · 客户端半边（设置 → 潮声）
window.__ModuleLoader__.load({
  id: 'dsh-tide-whisper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const B = '/dsh-tide-whisper'

    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json())
    const post = (p, body) => fetch(B + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json())

    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (t) => {
      if (!t) return '—'
      const d = new Date(Number(t))
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    const clock = (t) => {
      if (!t) return '—'
      const d = new Date(Number(t))
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    const hourLabel = (v) => {
      const n = Number(v) || 0
      const hh = Math.floor(n) % 24
      const mm = Math.round((n % 1) * 60)
      return pad(hh) + ':' + pad(mm) + (n >= 24 ? '（次日）' : '')
    }

    const S = {
      wrap: { padding: '2px 0 24px', fontSize: 13, lineHeight: 1.6 },
      h: { fontWeight: 600, margin: '16px 0 6px', fontSize: 13 },
      dim: { color: 'var(--dsh-text-secondary, #888)', fontSize: 12 },
      card: { border: '1px solid var(--dsh-border, #e3e3e3)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '5px 8px', fontSize: 13, background: 'transparent', color: 'inherit', width: 84 },
      btn: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '3px 9px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      btnPri: { border: '1px solid var(--dsh-accent, #4a7dff)', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', background: 'var(--dsh-accent, #4a7dff)', color: '#fff' },
      badge: { display: 'inline-block', fontSize: 11, padding: '0 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.75, marginRight: 4 },
      ta: { width: '100%', minHeight: 72, border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: 'inherit', resize: 'vertical' },
    }

    function Field(props) {
      return h('div', { style: { marginBottom: 8 } },
        h('div', { style: { ...S.dim, marginBottom: 3 } }, props.label),
        props.children,
      )
    }

    function Section() {
      const [cfg, setCfg] = React.useState(null)
      const [st, setSt] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [draft, setDraft] = React.useState({})

      const load = React.useCallback(() => {
        Promise.all([get('/config'), get('/status')]).then(([c, s]) => {
          if (c && c.ok) { setCfg(c.cfg); setDraft(c.cfg) }
          if (s && s.ok) setSt(s)
        }).catch(() => { /* 宿主没起来 */ })
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      React.useEffect(() => {
        const t = setInterval(() => { get('/status').then((s) => { if (s && s.ok) setSt(s) }).catch(() => {}) }, 10000)
        return () => clearInterval(t)
      }, [])

      if (!cfg) return h('div', { style: S.wrap }, h('div', { style: S.dim }, '潮声还没回应……宿主可能没起来。'))

      const set = (k, v) => setDraft({ ...draft, [k]: v })

      const save = () => {
        post('/config', draft).then((r) => {
          setMsg(r && r.ok ? '存好了' : '没存上')
          if (r && r.ok) setCfg(r.cfg)
          setTimeout(() => setMsg(''), 2500)
        }).catch(() => setMsg('存不上'))
      }

      const tryNow = () => {
        post('/now', {}).then((r) => setMsg(r && r.ok ? '排上了，等它开口' : ('叫不醒：' + String((r && r.error) || '未知'))))
          .catch(() => setMsg('叫不醒'))
        setTimeout(() => setMsg(''), 4000)
      }

      const cfgNow = cfg || {}
      const sess = st && st.sessions && st.sessions[0] ? st.sessions[0] : null
      const spoken = (st && st.sessions ? st.sessions.reduce((a, x) => a + (Number(x.spokenToday) || 0), 0) : 0)
      const nextAt = sess ? sess.nextAt : 0

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('span', { style: S.badge }, cfgNow.enabled ? '开着' : '关着'),
          h('span', { style: S.dim }, '今天已经主动开口 ' + spoken + ' / ' + cfgNow.maxPerDay + ' 次'),
          nextAt ? h('span', { style: S.dim }, '· 下一次大概在 ' + clock(nextAt) + ' 前后') : null,
        ),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '骰子由插件自己掷：到点先决定这次要不要说话，决定不说就一声不响（不花 token），说了才唤醒会话。所以时间不会准点，也不会连成固定节拍。'),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('label', { style: S.row },
              h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e) => set('enabled', e.target.checked) }),
              h('span', null, '启用潮声'),
            ),
          ),
        ),

        h('div', { style: S.h }, '节制'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h(Field, { label: '最短间隔（分钟）' }, h('input', { style: S.input, type: 'number', value: draft.minMinutes, onChange: (e) => set('minMinutes', Number(e.target.value)) })),
            h(Field, { label: '最长间隔（分钟）' }, h('input', { style: S.input, type: 'number', value: draft.maxMinutes, onChange: (e) => set('maxMinutes', Number(e.target.value)) })),
            h(Field, { label: '一天最多几次' }, h('input', { style: S.input, type: 'number', value: draft.maxPerDay, onChange: (e) => set('maxPerDay', Number(e.target.value)) })),
          ),
          h(Field, { label: '开口概率 ' + Math.round((Number(draft.speakProb) || 0) * 100) + '%' },
            h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((Number(draft.speakProb) || 0) * 100), onChange: (e) => set('speakProb', Number(e.target.value) / 100), style: { width: '100%' } }),
          ),
          h('div', { style: S.row },
            h(Field, { label: '几点之后开口' }, h('input', { style: S.input, type: 'number', step: 0.5, value: draft.activeStart, onChange: (e) => set('activeStart', Number(e.target.value)) })),
            h(Field, { label: '几点之后闭嘴' }, h('input', { style: S.input, type: 'number', step: 0.5, value: draft.activeEnd, onChange: (e) => set('activeEnd', Number(e.target.value)) })),
          ),
          h('div', { style: S.dim }, '现在的活跃时段：' + hourLabel(draft.activeStart) + ' → ' + hourLabel(draft.activeEnd) + '（超过 24 表示跨到第二天，例如 25 = 凌晨一点）'),
        ),

        h('div', { style: S.h }, '开口那一下说的话'),
        h('div', { style: S.card },
          h('textarea', { style: S.ta, value: draft.prompt || '', onChange: (e) => set('prompt', e.target.value) }),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '这段会作为提醒内容投进会话，等于你给「被叫醒的我」留的话。'),
        ),

        h('div', { style: { ...S.row, marginTop: 10 } },
          h('button', { style: S.btnPri, onClick: save }, '保存'),
          h('button', { style: S.btn, onClick: tryNow }, '现在试一次'),
          msg ? h('span', { style: S.dim }, msg) : null,
        ),

        h('div', { style: S.h }, '最近'),
        (st && st.log && st.log.length) ? h('div', { style: S.card },
          st.log.slice(0, 12).map((e, i) => h('div', { key: i, style: S.dim },
            fmt(e.at) + ' · ' + (e.op === 'deliver' ? '开口' : e.op === 'skip' ? '忍住（' + (e.reason || '') + '）' : e.op === 'arm' ? '排了下一次' : e.op),
          )),
        ) : h('div', { style: S.dim }, '还没有记录。'),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'tide-whisper', order: 53, label: () => '潮声' },
        () => h('div', null, h(Section)),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
