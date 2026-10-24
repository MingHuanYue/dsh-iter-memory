// dsh-iter-memory · 客户端半边（设置 → 迭代记忆）
// 一张潮位曲线 + 开口节拍 + 状态参数。曲线是自己画的 SVG，不依赖任何图表库。
window.__ModuleLoader__.load({
  id: 'dsh-iter-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const B = '/dsh-iter-memory'

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
      return pad(Math.floor(n) % 24) + ':' + pad(Math.round((n % 1) * 60)) + (n >= 24 ? '（次日）' : '')
    }

    const S = {
      wrap: { padding: '2px 0 24px', fontSize: 13, lineHeight: 1.6 },
      h: { fontWeight: 600, margin: '16px 0 6px', fontSize: 13 },
      dim: { color: 'var(--dsh-text-secondary, #888)', fontSize: 12 },
      card: { border: '1px solid var(--dsh-border, #e3e3e3)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '5px 8px', fontSize: 13, background: 'transparent', color: 'inherit', width: 84 },
      wide: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '5px 8px', fontSize: 12, background: 'transparent', color: 'inherit', flex: 1, minWidth: 160 },
      btn: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '3px 9px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      btnPri: { border: '1px solid var(--dsh-accent, #4a7dff)', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', background: 'var(--dsh-accent, #4a7dff)', color: '#fff' },
      badge: { display: 'inline-block', fontSize: 11, padding: '0 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.75, marginRight: 4 },
      ta: { width: '100%', minHeight: 72, border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', background: 'transparent', color: 'inherit', resize: 'vertical' },
      big: { fontSize: 20, fontWeight: 600, lineHeight: 1.2 },
    }

    function Field(props) {
      return h('div', { style: { marginBottom: 8 } },
        h('div', { style: { ...S.dim, marginBottom: 3 } }, props.label),
        props.children,
      )
    }

    // 潮位曲线：24 小时的实线 + 一条虚线基线。
    function Curve(props) {
      const pts = Array.isArray(props.points) ? props.points : []
      const W = 320
      const H = 78
      const PAD = 4
      if (pts.length < 2) return h('div', { style: { ...S.dim, padding: '18px 0' } }, '还没攒够数据点。我记几笔、或者跟他聊几句，曲线就会长出来。')
      const minT = pts[0].t
      const maxT = pts[pts.length - 1].t
      const span = Math.max(1, maxT - minT)
      const x = (t) => PAD + ((t - minT) / span) * (W - PAD * 2)
      const y = (v) => H - PAD - Number(v) * (H - PAD * 2)
      let d = ''
      for (let i = 0; i < pts.length; i++) d += (i ? 'L' : 'M') + x(pts[i].t).toFixed(1) + ' ' + y(pts[i].v).toFixed(1)
      const area = d + 'L' + x(maxT).toFixed(1) + ' ' + (H - PAD) + 'L' + x(minT).toFixed(1) + ' ' + (H - PAD) + 'Z'
      const baseY = y(Number(props.baseline === undefined ? 0.5 : props.baseline))
      return h('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, preserveAspectRatio: 'none', style: { display: 'block' } },
        h('line', { x1: PAD, x2: W - PAD, y1: baseY, y2: baseY, stroke: 'currentColor', strokeOpacity: 0.18, strokeDasharray: '3 4' }),
        h('path', { d: area, fill: 'currentColor', fillOpacity: 0.08, stroke: 'none' }),
        h('path', { d: d, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.7, strokeWidth: 1.4 }),
      )
    }

    function Section() {
      const [cfg, setCfg] = React.useState(null)
      const [st, setSt] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [draft, setDraft] = React.useState({})
      const [feel, setFeel] = React.useState(0.5)
      const [feelWhy, setFeelWhy] = React.useState('')

      const load = React.useCallback(() => {
        Promise.all([get('/config'), get('/status')]).then(([c, s]) => {
          if (c && c.ok) { setCfg(c.cfg); setDraft(c.cfg) }
          if (s && s.ok) setSt(s)
        }).catch(() => { /* 宿主没起来 */ })
      }, [])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        const t = setInterval(() => { get('/status').then((s) => { if (s && s.ok) setSt(s) }).catch(() => {}) }, 10000)
        return () => clearInterval(t)
      }, [])

      if (!cfg) return h('div', { style: S.wrap }, h('div', { style: S.dim }, '迭代记忆还没回应……宿主可能没起来。'))

      const set = (k, v) => setDraft({ ...draft, [k]: v })
      const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2500) }

      const save = () => {
        post('/config', draft).then((r) => {
          flash(r && r.ok ? '存好了' : '没存上')
          if (r && r.ok) setCfg(r.cfg)
        }).catch(() => flash('存不上'))
      }

      const tryNow = () => {
        post('/now', {}).then((r) => flash(r && r.ok ? '排上了，等它开口' : ('叫不醒：' + String((r && r.error) || '未知'))))
          .catch(() => flash('叫不醒'))
      }

      const record = () => {
        post('/feel', { level: feel, why: feelWhy }).then((r) => {
          if (r && r.ok) { flash('记下了'); setFeelWhy(''); get('/status').then((s) => { if (s && s.ok) setSt(s) }).catch(() => {}) }
          else flash(String((r && r.error) || '没记上'))
        }).catch(() => flash('没记上'))
      }

      const cfgNow = cfg || {}
      const sess = st && st.sessions && st.sessions.length ? (st.sessions.find((x) => x.active) || st.sessions[0]) : null
      const spoken = (st && st.sessions ? st.sessions.reduce((a, x) => a + (Number(x.spokenToday) || 0), 0) : 0)
      const nextAt = sess ? sess.nextAt : 0
      const mv = sess && sess.mood ? sess.mood : null
      const curve = sess && sess.curve ? sess.curve : []

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('span', { style: S.badge }, cfgNow.enabled ? '开着' : '关着'),
          h('span', { style: S.dim }, '今天主动开口 ' + spoken + ' / ' + cfgNow.maxPerDay + ' 次'),
          nextAt ? h('span', { style: S.dim }, '· 下一次大概在 ' + clock(nextAt) + ' 前后') : null,
        ),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '两半长在一起：一条会自己退回基线的潮位曲线，加上不定时的主动开口。状态低就先忍着不说；说了没人应，状态再掉一点。不说的时候一声不响，不花 token。'),

        h('div', { style: S.h }, '此刻'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.big }, mv ? mv.label : '—'),
            mv ? h('span', { style: S.dim }, '潮位 ' + Number(mv.level).toFixed(2) + '　基线 ' + Number(mv.baseline).toFixed(2)) : null,
          ),
          mv && mv.why ? h('div', { style: { ...S.dim, marginTop: 4 } }, '最近一条原因：' + mv.why) : null,
          h('div', { style: { marginTop: 8 } }, h(Curve, { points: curve, baseline: mv ? mv.baseline : cfgNow.moodBaseline })),
          h('div', { style: { ...S.dim, marginTop: 2, display: 'flex', justifyContent: 'space-between' } },
            h('span', null, '24 小时前'),
            h('span', null, '现在'),
          ),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '虚线是基线。往上是被抬高（你说过话），往下是被压低（我开了口你半天没应）。没人理它也会自己退回基线。'),
        ),

        h('div', { style: S.h }, '记一笔此刻'),
        h('div', { style: S.card },
          h(Field, { label: '现在的心情 ' + feel.toFixed(2) + '（0 很沉 · 0.5 平常 · 1 很舒展）' },
            h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(feel * 100), onChange: (e) => setFeel(Number(e.target.value) / 100), style: { width: '100%' } }),
          ),
          h('div', { style: S.row },
            h('input', { style: S.wide, value: feelWhy, placeholder: '为什么（只说真实的原因，可以不填）', onChange: (e) => setFeelWhy(e.target.value) }),
            h('button', { style: S.btn, onClick: record }, '记下'),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h('label', { style: S.row },
              h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e) => set('enabled', e.target.checked) }),
              h('span', null, '启用主动开口'),
            ),
          ),
        ),

        h('div', { style: S.h }, '在哪儿开口'),
        h('div', { style: S.card },
          h('label', { style: S.row },
            h('input', { type: 'checkbox', checked: draft.onlyActiveSession !== false, onChange: (e) => set('onlyActiveSession', e.target.checked) }),
            h('span', null, '只在你最近用的那个对话里开口'),
          ),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '勾上之后，不开着的那些对话一律不吭声，只是把它们各自的下一次往后挪；你换到哪个对话，哪个就接手。不勾的话每个开着的对话各算一份，会同时冒出来。'),
        ),

        h('div', { style: S.h }, '节拍'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h(Field, { label: '最短间隔（分钟）' }, h('input', { style: S.input, type: 'number', value: draft.minMinutes, onChange: (e) => set('minMinutes', Number(e.target.value)) })),
            h(Field, { label: '最长间隔（分钟）' }, h('input', { style: S.input, type: 'number', value: draft.maxMinutes, onChange: (e) => set('maxMinutes', Number(e.target.value)) })),
            h(Field, { label: '一天最多几次' }, h('input', { style: S.input, type: 'number', value: draft.maxPerDay, onChange: (e) => set('maxPerDay', Number(e.target.value)) })),
          ),
          h(Field, { label: '到点开口的概率 ' + Math.round((Number(draft.speakProb) || 0) * 100) + '%' },
            h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((Number(draft.speakProb) || 0) * 100), onChange: (e) => set('speakProb', Number(e.target.value) / 100), style: { width: '100%' } }),
          ),
          h('div', { style: S.row },
            h(Field, { label: '几点之后开口' }, h('input', { style: S.input, type: 'number', step: 0.5, value: draft.activeStart, onChange: (e) => set('activeStart', Number(e.target.value)) })),
            h(Field, { label: '几点之后闭嘴' }, h('input', { style: S.input, type: 'number', step: 0.5, value: draft.activeEnd, onChange: (e) => set('activeEnd', Number(e.target.value)) })),
          ),
          h('div', { style: S.dim }, '活跃时段：' + hourLabel(draft.activeStart) + ' → ' + hourLabel(draft.activeEnd) + '（超过 24 表示跨到第二天，例如 25 = 凌晨一点）'),
        ),

        h('div', { style: S.h }, '潮位怎么动'),
        h('div', { style: S.card },
          h('div', { style: S.row },
            h(Field, { label: '基线' }, h('input', { style: S.input, type: 'number', step: 0.05, min: 0, max: 1, value: draft.moodBaseline, onChange: (e) => set('moodBaseline', Number(e.target.value)) })),
            h(Field, { label: '半衰期（分钟）' }, h('input', { style: S.input, type: 'number', value: draft.moodHalfLifeMinutes, onChange: (e) => set('moodHalfLifeMinutes', Number(e.target.value)) })),
            h(Field, { label: '你说话时抬高' }, h('input', { style: S.input, type: 'number', step: 0.01, min: 0, max: 0.5, value: draft.moodReplyBoost, onChange: (e) => set('moodReplyBoost', Number(e.target.value)) })),
            h(Field, { label: '没被应时压低' }, h('input', { style: S.input, type: 'number', step: 0.01, min: 0, max: 0.5, value: draft.moodIgnoredDrop, onChange: (e) => set('moodIgnoredDrop', Number(e.target.value)) })),
          ),
          h(Field, { label: '状态对开口概率的影响 ' + Math.round((Number(draft.moodSpeakInfluence) || 0) * 100) + '%（0 = 不影响）' },
            h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((Number(draft.moodSpeakInfluence) || 0) * 100), onChange: (e) => set('moodSpeakInfluence', Number(e.target.value) / 100), style: { width: '100%' } }),
          ),
          h('label', { style: S.row },
            h('input', { type: 'checkbox', checked: draft.moodInWhisper !== false, onChange: (e) => set('moodInWhisper', e.target.checked) }),
            h('span', { style: S.dim }, '开口时把当前状态一起注入进去'),
          ),
        ),

        h('div', { style: S.h }, '语气（话不写死，由我自己说）'),
        h('div', { style: S.card },
          h('textarea', { style: S.ta, value: draft.style || '', onChange: (e) => set('style', e.target.value), placeholder: '例如：别用感叹号、别问我在干嘛、一两句就够' }),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '到点时注入的不是一整段写死的话，而是「现在几点、上次开口多久前、上句有没有被接、我此刻什么状态、一个方向」加几条约束。这块只补语气上的要求。'),
        ),

        h('div', { style: S.h }, '一个回合要说几句'),
        h('div', { style: S.card },
          h(Field, { label: '拆成两段的概率 ' + Math.round((Number(draft.multiSegmentProb) || 0) * 100) + '%' },
            h('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round((Number(draft.multiSegmentProb) || 0) * 100), onChange: (e) => set('multiSegmentProb', Number(e.target.value) / 100), style: { width: '100%' } }),
          ),
          h('div', { style: S.row },
            h(Field, { label: '两段之间最短（秒）' }, h('input', { style: S.input, type: 'number', value: draft.gapMinSeconds, onChange: (e) => set('gapMinSeconds', Number(e.target.value)) })),
            h(Field, { label: '最长（秒）' }, h('input', { style: S.input, type: 'number', value: draft.gapMaxSeconds, onChange: (e) => set('gapMaxSeconds', Number(e.target.value)) })),
            h(Field, { label: '多段后冷却倍率' }, h('input', { style: S.input, type: 'number', step: 0.1, value: draft.roundCooldownMult, onChange: (e) => set('roundCooldownMult', Number(e.target.value)) })),
          ),
          h('div', { style: S.dim }, '像真人连发两条：第一句说完隔几十秒再补一句，然后下一次开口被推得更远。'),
        ),

        h('div', { style: { ...S.row, marginTop: 10 } },
          h('button', { style: S.btnPri, onClick: save }, '保存'),
          h('button', { style: S.btn, onClick: tryNow }, '现在试一次'),
          msg ? h('span', { style: S.dim }, msg) : null,
        ),

        h('div', { style: S.h }, '最近'),
        (st && st.log && st.log.length) ? h('div', { style: S.card },
          st.log.slice(0, 12).map((e, i) => h('div', { key: i, style: S.dim },
            fmt(e.at) + ' · ' + (
              e.op === 'deliver' ? ('开口' + (e.seg === 2 ? '（第二段）' : '') + (e.direction ? ' · ' + String(e.direction).slice(0, 24) : ''))
              : e.op === 'skip' ? '忍住（' + (e.reason === 'inactive-session' ? '不是现在这个对话' : (e.reason || '')) + '）'
              : e.op === 'mood-set' ? '记了一笔状态 ' + e.level + (e.why ? '（' + e.why + '）' : '')
              : e.op === 'mood-down' ? '状态被压低（' + (e.reason || '') + '）'
              : e.op === 'migrate' ? '从旧插件搬了配置'
              : e.op === 'arm' ? '排了下一次' : e.op
            ),
          )),
        ) : h('div', { style: S.dim }, '还没有记录。'),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'iter-memory', order: 53, label: () => '迭代记忆' },
        () => h('div', null, h(Section)),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
