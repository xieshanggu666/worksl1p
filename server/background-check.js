// 入职背调模块
// 候选人接受 Offer（进入「录用」阶段）后：
//   招聘负责人发起核查（背调项逐项登记）→ 提交用人经理复核 → 用人经理给出「通过/不通过」结论；
//   结论「通过」是候选人报到 / Offer 确认入职（accepted→joined）的统一前置闸门；
//   撤销结论（pass/fail → reviewing）立即关闭闸门，Offer 入职与交接报到同步被拦截；
//   主动撤销核查 / 录用流程异常回退（Offer 撤回）在同一事务内被动撤销，之后可重新发起。
// 历史「已入职（offer=joined）」但无背调记录的，启动时补录一条 exempt（免核查）记录单独处理。
import express from 'express'
import db, { ts } from './db.js'
import { auditPassive } from './crisis.js'

export const router = express.Router()

// ---------------- 通用工具 ----------------
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }
const wrap = fn => (req, res, next) => { try { return fn(req, res, next) } catch (e) { next(e) } }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}

export const STATUSES = ['reviewing', 'passed', 'failed', 'cancelled', 'exempt']
const ACTIVE_STATUSES = ['reviewing', 'passed', 'failed']
export const STATUS_LABEL = {
  reviewing: '复核中', passed: '核查通过', failed: '核查不通过',
  cancelled: '已撤销', exempt: '免核查（历史补录）'
}
const ACTION_LABEL = {
  create: '发起背调', item_update: '核查项更新', submit: '提交复核',
  conclude: '复核结论', revoke: '撤销结论', cancel: '撤销核查',
  remind: '催办提醒', system_cancel: '流程回退撤销', migrate: '历史数据补录'
}
const PARTY_LABEL = { recruiter: '招聘负责人', hiring_manager: '用人经理', system: '系统' }

// 默认核查项：结果 ok 通过 / issue 有疑点 / pending 待核查（仅作复核参考，不强制）
const DEFAULT_ITEMS = [
  { key: 'identity', name: '身份信息核验', status: 'pending', note: '' },
  { key: 'education', name: '学历学位真实性', status: 'pending', note: '' },
  { key: 'employment', name: '过往履历与入离职时间', status: 'pending', note: '' },
  { key: 'work_perf', name: '工作表现与离职原因（背调访谈）', status: 'pending', note: '' },
  { key: 'certificate', name: '职业资格/技能证书', status: 'pending', note: '' },
  { key: 'conflict', name: '竞业限制与利益冲突', status: 'pending', note: '' },
  { key: 'legal', name: '违法犯罪/失信记录', status: 'pending', note: '' }
]
const ITEM_STATUS = { pending: '待核查', ok: '无异常', issue: '有疑点' }

function notifyRole(role, type, title, body, appId = 0) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,0,?)`).run(role, type, title, body, num(appId), ts())
}

function addEvent(checkId, { phase = '', action, party = 'system', actor = null, note = '', detail = {} }) {
  db.prepare(`INSERT INTO background_check_events(check_id,phase,action,party,actor_id,actor_name,actor_role,note,detail,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(num(checkId), phase, action, party, actor?.id || '', actor?.name || '', actor?.role || '',
      note, JSON.stringify(detail || {}), ts())
}

function getCheck(id) {
  return db.prepare('SELECT * FROM background_checks WHERE id=?').get(num(id)) || null
}
function activeCheckOfApp(appId) {
  return db.prepare(`SELECT * FROM background_checks WHERE application_id=? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
    .get(num(appId), ...ACTIVE_STATUSES) || null
}
// 闸门：仅「已通过且未撤销」的背调放行（exempt 为历史补录，同样放行）
export function getCheckGate(appId) {
  const chk = db.prepare(`SELECT * FROM background_checks WHERE application_id=? ORDER BY id DESC LIMIT 1`).get(num(appId)) || null
  if (!chk) return { ok: false, status: '', check: null, reason: 'missing' }
  if (chk.status === 'passed') return { ok: true, status: 'passed', check: chk, reason: '' }
  if (chk.status === 'exempt') return { ok: true, status: 'exempt', check: chk, reason: '' }
  if (chk.status === 'reviewing') return { ok: false, status: 'reviewing', check: chk, reason: 'reviewing' }
  if (chk.status === 'failed') return { ok: false, status: 'failed', check: chk, reason: 'failed' }
  return { ok: false, status: chk.status, check: chk, reason: chk.status }
}
function assertVersion(row, expected) {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(row.version)) {
    conflict('背调单状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}

function candPosOf(appId) {
  const row = db.prepare(`SELECT c.name candidate_name, p.name position_name
                          FROM applications a
                          JOIN candidates c ON c.id=a.candidate_id
                          JOIN positions p ON p.id=a.position_id
                          WHERE a.id=?`).get(num(appId))
  return row || { candidate_name: '', position_name: '' }
}

// ================= 发起背调 =================
router.post('/', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('发起入职背调需「招聘负责人」身份', 'role_not_allowed')
  const b = req.body || {}
  const out = tx(() => {
    const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(b.application_id))
    if (!a) return { notFound: true }
    if (a.stage !== 'hired') conflict('仅已录用（候选人已接受 Offer）的候选人可以发起入职背调', 'not_hired')
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
    if (!of || !['accepted', 'joined'].includes(of.status)) {
      conflict('候选人接受 Offer 后才能发起入职背调', 'offer_not_accepted')
    }
    if (of.status === 'joined') conflict('该候选人已完成入职报到，不能再发起背调（历史记录单独处理）', 'already_joined')
    if (activeCheckOfApp(a.id)) conflict('该候选人已有进行中的背调单，请勿重复发起', 'bgc_duplicate')

    const stamp = ts()
    const { candidate_name: cand, position_name: pos } = candPosOf(a.id)
    const r = db.prepare(`INSERT INTO background_checks
      (application_id,candidate_id,position_id,status,items,scope_note,
       initiated_by,initiated_by_name,initiated_at,created_at,updated_at,version)
      VALUES(?,?,?, 'reviewing',?,?, ?,?,?,?,?, 1)`)
      .run(a.id, a.candidate_id, a.position_id,
        JSON.stringify(DEFAULT_ITEMS.map(i => ({ ...i }))), String(b.scope_note || ''),
        user.id, user.name, stamp, stamp, stamp)
    const id = Number(r.lastInsertRowid)
    addEvent(id, {
      phase: 'reviewing', action: 'create', party: 'recruiter', actor: user,
      note: `发起入职背调，提交用人经理复核：${b.scope_note || '按标准项核查'}`,
      detail: { candidate: cand, position: pos, scope_note: String(b.scope_note || '') }
    })
    notifyRole('hiring_manager', 'bgc_submitted', '新的入职背调待复核',
      `「${cand} · ${pos}」背调已发起，请复核核查项并给出结论；结论决定候选人能否报到入职`, a.id)
    return { ok: true, id, status: 'reviewing' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '应聘记录不存在' })
  res.json(out)
}))

// ================= 核查项更新（招聘负责人，复核中可随时补充） =================
router.put('/:id/items', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('背调核查由「招聘负责人」登记', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const chk = getCheck(id)
    if (!chk) return { notFound: true }
    if (chk.status !== 'reviewing') conflict('当前背调状态不能更新核查项（结论已出/已撤销）', 'status_locked')
    const items = parseJSON(chk.items, [])
    const changes = []
    if (Array.isArray(b.items)) {
      b.items.forEach(upd => {
        const it = items.find(x => x.key === upd.key)
        if (!it) return
        if (['pending', 'ok', 'issue'].includes(upd.status) && upd.status !== it.status) {
          it.status = upd.status
          changes.push(`${it.name}:${ITEM_STATUS[upd.status] || upd.status}`)
        }
        if (upd.note !== undefined) it.note = String(upd.note)
      })
    }
    db.prepare('UPDATE background_checks SET items=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(items), ts(), id)
    addEvent(id, {
      phase: 'reviewing', action: 'item_update', party: 'recruiter', actor: user,
      note: changes.length ? `核查项更新：${changes.join('、')}` : '更新核查项',
      detail: { changes }
    })
    return { ok: true, version: num(chk.version) }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 用人经理复核：通过 / 不通过（必填结论说明） =================
router.post('/:id/conclude', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'hiring_manager') forbidden('背调复核由「用人经理」处理', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const chk = getCheck(id)
    if (!chk) return { notFound: true }
    assertVersion(chk, b.version)
    if (chk.status !== 'reviewing') conflict('该背调单当前不在待复核状态（可能结论已被撤销）', 'not_reviewing')
    const conclusion = String(b.conclusion || '')
    if (!['pass', 'fail'].includes(conclusion)) badRequest('结论仅支持「通过/不通过」', 'conclusion_invalid')
    const note = String(b.note || '')
    if (!note.trim()) badRequest('请填写复核结论说明', 'note_required')

    const status = conclusion === 'pass' ? 'passed' : 'failed'
    const stamp = ts()
    db.prepare(`UPDATE background_checks SET status=?, conclusion=?, conclusion_note=?,
                reviewed_by=?, reviewed_by_name=?, reviewed_at=?, revoked_at='', revoked_by='', revoked_by_name='', revoke_reason='',
                updated_at=?, version=version+1 WHERE id=?`)
      .run(status, conclusion, note, user.id, user.name, stamp, stamp, id)
    addEvent(id, {
      phase: status, action: 'conclude', party: 'hiring_manager', actor: user,
      note: conclusion === 'pass' ? `背调复核通过：${note}` : `背调复核不通过：${note}`,
      detail: { conclusion, note }
    })
    auditPassive({
      category: 'action',
      action: conclusion === 'pass' ? 'background_check.pass' : 'background_check.fail',
      actor: user, applicationId: chk.application_id,
      refType: 'background_check', refId: id,
      summary: `入职背调 #${id} 复核结论：${conclusion === 'pass' ? '通过，允许报到入职' : '不通过，拦截报到入职'}`,
      detail: { conclusion, note }
    })
    const { candidate_name: cand, position_name: pos } = candPosOf(chk.application_id)
    if (conclusion === 'pass') {
      notifyRole('recruiter', 'bgc_passed', '✅ 背调通过，可以安排候选人报到',
        `「${cand} · ${pos}」背调已通过（${user.name}），请在入职交接中继续办理报到`, chk.application_id)
    } else {
      notifyRole('recruiter', 'bgc_failed', '⛔ 背调不通过，候选人不能报到',
        `「${cand} · ${pos}」背调结论为不通过（${user.name}）：${note}；Offer 入职已被拦截，请按招聘政策处理`, chk.application_id)
    }
    return { ok: true, status }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 撤销结论：已通过/已不通过 → 复核中，立即关闭报到闸门 =================
router.post('/:id/revoke', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('撤销背调结论需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const reason = String(b.reason || '')
  const out = tx(() => {
    const chk = getCheck(id)
    if (!chk) return { notFound: true }
    assertVersion(chk, b.version)
    if (!['passed', 'failed'].includes(chk.status)) conflict('仅已出具结论（通过/不通过）的背调可以撤销结论', 'not_concluded')
    if (!reason.trim()) badRequest('撤销结论必须填写原因', 'reason_required')

    const a = db.prepare('SELECT stage FROM applications WHERE id=?').get(chk.application_id)
    // 候选人已经报到（Offer 已入职）：结论不可撤销——已入职记录只能单独处理，避免历史事实被改写
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(chk.application_id)
    if (of?.status === 'joined') conflict('该候选人已完成入职报到，背调结论不能撤销（已入职记录请单独处理）', 'already_joined')

    const stamp = ts()
    db.prepare(`UPDATE background_checks SET status='reviewing', conclusion='',
                revoked_by=?, revoked_by_name=?, revoked_at=?, revoke_reason=?,
                updated_at=?, version=version+1 WHERE id=?`)
      .run(user.id, user.name, stamp, reason, stamp, id)
    addEvent(id, {
      phase: 'reviewing', action: 'revoke', party: 'recruiter', actor: user,
      note: `撤销背调结论（原「${STATUS_LABEL[chk.status]}」），退回重新复核：${reason}；Offer 入职/交接报到同步拦截`,
      detail: { from_status: chk.status, reason, app_stage: a?.stage || '' }
    })
    auditPassive({
      category: 'action', action: 'background_check.revoke', actor: user,
      applicationId: chk.application_id, refType: 'background_check', refId: id,
      summary: `入职背调 #${id} 结论被撤销（原：${STATUS_LABEL[chk.status]}），报到闸门重新关闭`,
      detail: { from_status: chk.status, reason }
    })
    const { candidate_name: cand, position_name: pos } = candPosOf(chk.application_id)
    notifyRole('hiring_manager', 'bgc_revoked', '背调结论已撤销，请重新复核',
      `「${cand} · ${pos}」的背调结论被 ${user.name} 撤销：${reason}。候选人入职已被拦截，待您重新给出结论`, chk.application_id)
    return { ok: true, status: 'reviewing' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 撤销核查（招聘负责人；复核中/结论已出但尚未入职均可整单撤销） =================
router.post('/:id/cancel', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('撤销背调需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const reason = String(b.reason || '')
  const out = tx(() => {
    const chk = getCheck(id)
    if (!chk) return { notFound: true }
    if (!ACTIVE_STATUSES.includes(chk.status)) conflict('该背调单已结案，无法撤销', 'status_closed')
    if (!reason.trim()) badRequest('撤销背调必须填写原因', 'reason_required')
    const of = db.prepare('SELECT status FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(chk.application_id)
    if (of?.status === 'joined') conflict('该候选人已完成入职报到，背调单不能撤销（已入职记录请单独处理）', 'already_joined')

    const stamp = ts()
    db.prepare(`UPDATE background_checks SET status='cancelled', cancel_kind='cancel', cancel_reason=?,
                cancelled_at=?, cancelled_by=?, cancelled_by_name=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(reason, stamp, user.id, user.name, stamp, id)
    addEvent(id, {
      phase: 'cancelled', action: 'cancel', party: 'recruiter', actor: user,
      note: `撤销入职背调：${reason}`, detail: { from_status: chk.status, reason }
    })
    auditPassive({
      category: 'action', action: 'background_check.cancel', actor: user,
      applicationId: chk.application_id, refType: 'background_check', refId: id,
      summary: `入职背调 #${id} 由招聘负责人撤销（原状态：${STATUS_LABEL[chk.status] || chk.status}）`,
      detail: { from_status: chk.status, reason }
    })
    const { candidate_name: cand, position_name: pos } = candPosOf(chk.application_id)
    notifyRole('hiring_manager', 'bgc_cancelled', '入职背调已撤销',
      `「${cand} · ${pos}」的背调被 ${user.name} 撤销：${reason}`, chk.application_id)
    return { ok: true, status: 'cancelled' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 催办提醒（招聘负责人；复核中可再次提醒用人经理） =================
router.post('/:id/remind', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('催办需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const out = tx(() => {
    const chk = getCheck(id)
    if (!chk) return { notFound: true }
    if (chk.status !== 'reviewing') conflict('仅复核中的背调可以催办', 'not_reviewing')
    const { candidate_name: cand, position_name: pos } = candPosOf(chk.application_id)
    addEvent(id, {
      phase: 'reviewing', action: 'remind', party: 'recruiter', actor: user,
      note: '招聘负责人催办背调复核'
    })
    notifyRole('hiring_manager', 'bgc_remind', '⏰ 背调复核催办提醒',
      `「${cand} · ${pos}」背调正等待您复核（发起：${chk.initiated_by_name}），结论决定候选人能否报到，请尽快处理`, chk.application_id)
    return { ok: true }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ---------------- 主流程被动钩子：已录用流程回退（Offer 撤回/录用异常回退）时撤销进行中的背调 ----------------
// 与入职交接的被动中止同一模式：由主流程在其事务内调用，通知/上链与业务同生共死。
export function cancelBackgroundCheckForApp(applicationId, { reason = '已录用流程回退（Offer 撤回）', actor = null } = {}) {
  const appId = num(applicationId)
  // 取该应聘「进行中」的最新背调单（旧的已撤销单不影响新单）；ORDER BY 放在 IN 过滤之后
  const chk = db.prepare(`SELECT * FROM background_checks
                          WHERE application_id=? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
                          ORDER BY id DESC LIMIT 1`)
    .get(appId, ...ACTIVE_STATUSES)
  if (!chk) return null
  const stamp = ts()
  db.prepare(`UPDATE background_checks SET status='cancelled', cancel_kind='system', cancel_reason=?,
              cancelled_at=?, cancelled_by=?, cancelled_by_name=?, updated_at=?, version=version+1 WHERE id=?`)
    .run(reason, stamp, actor?.id || 'system', actor?.name || '系统', stamp, chk.id)
  addEvent(chk.id, {
    phase: 'cancelled', action: 'system_cancel', party: 'system',
    actor: actor || { id: 'system', name: '系统' },
    note: reason, detail: { from_status: chk.status, reason }
  })
  auditPassive({
    category: 'rollback', action: 'background_check.system_cancel',
    actor: actor || { id: 'system', name: '系统' },
    applicationId: appId, refType: 'background_check', refId: chk.id,
    summary: `入职背调 #${chk.id} 随已录用流程回退自动撤销（原状态：${STATUS_LABEL[chk.status] || chk.status}）`,
    detail: { from_status: chk.status, reason }
  })
  notifyRole('recruiter', 'bgc_cancelled', '背调已随流程回退自动撤销',
    `背调单 #${chk.id}：${reason}`, appId)
  notifyRole('hiring_manager', 'bgc_cancelled', '背调已随流程回退自动撤销',
    `背调单 #${chk.id}：${reason}`, appId)
  return chk
}

// ---------------- 历史数据兼容：已入职（offer joined）但无背调记录的，补录为「免核查」 ----------------
function backfillBackgroundChecks() {
  const joinedApps = db.prepare(`SELECT a.* FROM applications a
                                 JOIN offers o ON o.application_id=a.id
                                 WHERE o.status='joined'
                                 GROUP BY a.id`).all()
  const need = joinedApps.filter(a =>
    db.prepare('SELECT COUNT(*) c FROM background_checks WHERE application_id=?').get(a.id).c === 0)
  if (!need.length) return
  tx(() => {
    need.forEach(a => {
      const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
      const stamp = of.joined_at && /^\d{4}/.test(of.joined_at) ? of.joined_at : ts()
      const r = db.prepare(`INSERT INTO background_checks
        (application_id,candidate_id,position_id,status,items,scope_note,
         initiated_by_name,initiated_at,reviewed_by_name,reviewed_at,conclusion,conclusion_note,
         cancel_kind,backfilled,created_at,updated_at,version)
        VALUES(?,?,?, 'exempt','[]','功能上线前已入职，补录免核查',
         '系统迁移',?, '系统迁移',?, 'pass','历史已入职记录，背调免核查（单独处理）',
         '',1,?,?,1)`)
        .run(a.id, a.candidate_id, a.position_id, stamp, stamp, stamp, stamp)
      const id = Number(r.lastInsertRowid)
      addEvent(id, {
        phase: 'exempt', action: 'migrate', party: 'system', actor: { id: 'system', name: '系统迁移' },
        note: '该候选人在背调功能上线前已确认入职，按历史数据补录为「免核查」，不再追溯核查项',
        detail: { joined_at: of.joined_at }
      })
    })
  })
  console.log(`[HR] backfilled background checks for ${need.length} joined hires`)
}
backfillBackgroundChecks()

// ---------------- 状态聚合（供 /api/state 合并返回） ----------------
export function getBackgroundCheckState() {
  const eventsAll = db.prepare('SELECT * FROM background_check_events ORDER BY id ASC').all()
    .map(e => ({ ...e, detail: parseJSON(e.detail, {}), action_label: ACTION_LABEL[e.action] || e.action, party_label: PARTY_LABEL[e.party] || e.party }))
  const checks = db.prepare('SELECT * FROM background_checks ORDER BY id DESC').all().map(chk => {
    const a = db.prepare(`SELECT ap.*, c.name candidate_name, p.name position_name, p.dept position_dept, p.city position_city
                          FROM applications ap
                          JOIN candidates c ON c.id=ap.candidate_id
                          JOIN positions p ON p.id=ap.position_id
                          WHERE ap.id=?`).get(chk.application_id)
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(chk.application_id)
    const items = parseJSON(chk.items, [])
    return {
      ...chk,
      version: num(chk.version),
      backfilled: !!chk.backfilled,
      candidate: a?.candidate_name || '',
      position: a?.position_name || '',
      dept: a?.position_dept || '',
      city: a?.position_city || '',
      app_stage: a?.stage || '',
      offer_id: num(of?.id || 0),
      offer_status: of?.status || '',
      status_label: STATUS_LABEL[chk.status] || chk.status,
      items,
      itemsDone: items.filter(i => i.status !== 'pending').length,
      itemsIssue: items.filter(i => i.status === 'issue').length,
      canJoin: chk.status === 'passed' || chk.status === 'exempt',
      events: eventsAll.filter(e => e.check_id === chk.id)
    }
  })
  return {
    backgroundChecks: checks,
    backgroundCheckMeta: {
      statuses: STATUSES.map(k => ({ k, label: STATUS_LABEL[k] })),
      actionLabels: ACTION_LABEL, partyLabels: PARTY_LABEL,
      defaultItems: DEFAULT_ITEMS, itemStatus: ITEM_STATUS
    }
  }
}
