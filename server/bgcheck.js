// 入职背调模块
// 已录用（Offer 已接受）候选人由 招聘负责人 发起核查、登记核查项与结论，用人经理 复核后结论生效：
//   核查中(pending) → 待复核(reviewing) → 通过(passed)/未通过(failed)  ⇒  撤销结论(revoked) / 取消(cancelled)
// - 发起/核查项/提交结论/催办/撤销/取消限招聘负责人；复核限用人经理；越权 403
// - 复核提醒：提交结论即按角色提醒用人经理，待复核期间招聘负责人可再手动催办
// - 入职门槛：生效结论决定能否报到——Offer「确认入职」统一核心 markOfferJoined 实时校验
//   该应聘最新一单为 passed；撤销结论后门槛立即重新拦截（Offer 页与入职交接·报到两条路径同源）
// - 历史兼容：功能上线前已确认入职（offer=joined）的记录启动时补录为「已通过」，不参与核查流程
import express from 'express'
import db, { ts } from './db.js'
import { auditPassive } from './crisis.js'

export const router = express.Router()

// ---------------- 通用工具（与入职交接模块同一套约定） ----------------
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

const ACTIVE_STATUS = ['pending', 'reviewing']
export const STATUS_LABEL = {
  pending: '核查中', reviewing: '待复核', passed: '通过', failed: '未通过',
  revoked: '已撤销', cancelled: '已取消'
}
const ACTION_LABEL = {
  create: '发起背调', items_update: '更新核查项', submit: '提交复核',
  review_approve: '复核通过（结论生效）', review_return: '复核退回', remind: '催办提醒',
  revoke: '撤销结论', cancel: '取消背调', migrate: '历史数据补录'
}
const PARTY_LABEL = { recruiter: '招聘负责人', hiring_manager: '用人经理', system: '系统' }
const ITEM_STATUS_LABEL = { pending: '待核实', verified: '已核实', flagged: '有异常' }

// 默认核查项清单（信用记录可选，其余必核）
const DEFAULT_ITEMS = [
  { key: 'identity', name: '身份信息核验', required: 1, status: 'pending', note: '' },
  { key: 'edu_verify', name: '学历/学位验证', required: 1, status: 'pending', note: '' },
  { key: 'work_history', name: '工作履历核实', required: 1, status: 'pending', note: '' },
  { key: 'resign_reason', name: '离职原因核实', required: 1, status: 'pending', note: '' },
  { key: 'non_compete', name: '竞业限制排查', required: 1, status: 'pending', note: '' },
  { key: 'criminal', name: '违法犯罪记录核查', required: 1, status: 'pending', note: '' },
  { key: 'credit', name: '信用记录核查', required: 0, status: 'pending', note: '' }
]

function notifyRole(role, type, title, body, appId = 0) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,0,?)`).run(role, type, title, body, num(appId), ts())
}

function addEvent(checkId, { status = '', action, party = 'system', actor = null, note = '', detail = {} }) {
  db.prepare(`INSERT INTO bg_check_events(check_id,status,action,party,actor_id,actor_name,actor_role,note,detail,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(num(checkId), status, action, party, actor?.id || '', actor?.name || '', actor?.role || '',
      note, JSON.stringify(detail || {}), ts())
}

function getCheck(id) {
  return db.prepare('SELECT * FROM bg_checks WHERE id=?').get(num(id)) || null
}
function latestCheckOfApp(appId) {
  return db.prepare('SELECT * FROM bg_checks WHERE application_id=? ORDER BY id DESC LIMIT 1').get(num(appId)) || null
}
function activeCheckOfApp(appId) {
  return db.prepare("SELECT * FROM bg_checks WHERE application_id=? AND status IN ('pending','reviewing') ORDER BY id DESC LIMIT 1")
    .get(num(appId)) || null
}
function assertVersion(row, expected) {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(row.version)) {
    conflict('背调单状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}
function appWho(applicationId) {
  const a = db.prepare('SELECT candidate_id, position_id FROM applications WHERE id=?').get(num(applicationId))
  const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
  const pos = a && db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
  return { a, cand, pos, who: `「${cand?.name || ''} · ${pos?.name || ''}」` }
}

// ---------------- 报到/入职统一门槛 ----------------
// 由主流程 Offer「确认入职」核心 markOfferJoined 调用（Offer 页与入职交接·报到同源）：
// 该应聘最新一单背调必须为「复核通过」；未发起/核查中/待复核/不通过/已撤销/已取消均实时拦截。
// 历史已入职（offer=joined）记录在 markOfferJoined 中幂等先行返回，不经此门槛。
export function assertBgCheckPassed(applicationId) {
  const latest = latestCheckOfApp(applicationId)
  if (!latest) conflict('该候选人尚未发起入职背调，不能确认入职；请先在「入职背调」发起核查并经用人经理复核通过', 'bg_check_required')
  if (latest.status === 'passed') return latest
  if (latest.status === 'pending') conflict('入职背调核查中，尚无结论，不能确认入职', 'bg_check_pending')
  if (latest.status === 'reviewing') conflict('背调结论待用人经理复核，生效后才能确认入职', 'bg_check_reviewing')
  if (latest.status === 'failed') conflict('背调结论为「不通过」，不能确认入职；如需继续请先撤销结论并重新核查', 'bg_check_failed')
  if (latest.status === 'revoked') conflict(`背调结论已撤销（${latest.revoke_reason || '未填原因'}），不能确认入职；请重新发起背调并经复核通过`, 'bg_check_revoked')
  conflict('背调已取消，不能确认入职；请重新发起背调', 'bg_check_cancelled')
}

// ================= 发起核查 =================
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
    if (activeCheckOfApp(a.id)) conflict('该候选人已有进行中的背调，请勿重复发起', 'bg_check_duplicate')
    const latest = latestCheckOfApp(a.id)
    if (latest && latest.status === 'passed') {
      conflict('该候选人背调已通过，无需重新核查；如需拦截入职请使用「撤销结论」', 'bg_check_passed')
    }
    const stamp = ts()
    const items = DEFAULT_ITEMS.map(x => ({ ...x }))
    const r = db.prepare(`INSERT INTO bg_checks
      (application_id,candidate_id,position_id,status,items,note,created_by,created_by_name,created_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,1)`)
      .run(a.id, a.candidate_id, a.position_id, 'pending', JSON.stringify(items), String(b.note || ''),
        user.id, user.name, stamp, stamp)
    const id = Number(r.lastInsertRowid)
    const { cand, pos } = appWho(a.id)
    addEvent(id, {
      status: 'pending', action: 'create', party: 'recruiter', actor: user,
      note: b.note ? `发起入职背调：${b.note}` : '发起入职背调',
      detail: { candidate: cand?.name || '', position: pos?.name || '' }
    })
    notifyRole('recruiter', 'bg_started', '新的入职背调待核查',
      `「${cand?.name || ''} · ${pos?.name || ''}」背调已发起，请逐项核查并登记结论`, a.id)
    return { ok: true, id, status: 'pending' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '应聘记录不存在' })
  res.json(out)
}))

// ================= 核查项维护（核查中） =================
// body: { items:[{key,status,note}] }；status ∈ pending/verified/flagged
router.put('/:id/items', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('核查项由「招聘负责人」维护', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const c = getCheck(id)
    if (!c) return { notFound: true }
    if (c.status !== 'pending') conflict('仅核查中的背调可以更新核查项', 'status_locked')
    const items = parseJSON(c.items, [])
    const changes = []
    if (Array.isArray(b.items)) {
      b.items.forEach(upd => {
        const it = items.find(x => x.key === upd.key)
        if (!it) return
        if (['pending', 'verified', 'flagged'].includes(upd.status) && upd.status !== it.status) {
          it.status = upd.status
          changes.push(`${it.name}:${ITEM_STATUS_LABEL[upd.status]}`)
        }
        if (upd.note !== undefined) it.note = String(upd.note)
      })
    }
    db.prepare('UPDATE bg_checks SET items=?, updated_at=?, version=version+1 WHERE id=?')
      .run(JSON.stringify(items), ts(), id)
    addEvent(id, {
      status: 'pending', action: 'items_update', party: 'recruiter', actor: user,
      note: changes.length ? `核查项更新：${changes.join('、')}` : '更新核查项',
      detail: { changes }
    })
    return { ok: true, version: num(c.version) + 1 }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 提交复核（登记结论） =================
// 必核项全部核实后才能提交；登记「通过」时不允许存在异常项
router.post('/:id/submit', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('提交背调结论需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const c = getCheck(id)
    if (!c) return { notFound: true }
    assertVersion(c, b.version)
    if (c.status !== 'pending') conflict('仅核查中的背调可以提交复核', 'status_locked')
    const conclusion = String(b.conclusion || '')
    if (!['pass', 'fail'].includes(conclusion)) badRequest('结论仅支持 通过/不通过', 'conclusion_invalid')
    const items = parseJSON(c.items, [])
    const pendingItems = items.filter(i => i.required && i.status === 'pending').map(i => i.name)
    if (pendingItems.length) badRequest(`以下必核项尚未核实：${pendingItems.join('、')}`, 'items_pending')
    const flagged = items.filter(i => i.status === 'flagged').map(i => i.name)
    if (conclusion === 'pass' && flagged.length) {
      badRequest(`存在异常核查项（${flagged.join('、')}），不能登记「通过」结论`, 'items_flagged')
    }
    const stamp = ts()
    const note = String(b.conclusion_note || '')
    db.prepare(`UPDATE bg_checks SET status='reviewing', conclusion=?, conclusion_note=?, submitted_at=?,
                reviewed_by='', reviewed_by_name='', reviewed_at='', review_note='', updated_at=?, version=version+1 WHERE id=?`)
      .run(conclusion, note, stamp, stamp, id)
    addEvent(id, {
      status: 'reviewing', action: 'submit', party: 'recruiter', actor: user,
      note: `背调结论登记为「${conclusion === 'pass' ? '通过' : '不通过'}」，提交用人经理复核${note ? `：${note}` : ''}`,
      detail: { conclusion, flagged }
    })
    const { who } = appWho(c.application_id)
    notifyRole('hiring_manager', 'bg_submitted', '新的背调结论待复核',
      `${who}背调结论「${conclusion === 'pass' ? '通过' : '不通过'}」已提交，请复核`, c.application_id)
    return { ok: true, status: 'reviewing' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 用人经理复核 =================
// approve：结论生效（passed/failed），同步决定能否报到；return：退回核查中（意见必填）
router.post('/:id/review', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'hiring_manager') forbidden('背调复核由「用人经理」处理', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const out = tx(() => {
    const c = getCheck(id)
    if (!c) return { notFound: true }
    assertVersion(c, b.version)
    if (c.status !== 'reviewing') conflict('该背调当前不在待复核状态', 'not_reviewing')
    const note = String(b.note || '')
    const stamp = ts()
    const { who } = appWho(c.application_id)

    if (b.action === 'return') {
      if (!note.trim()) badRequest('退回必须填写复核意见', 'note_required')
      db.prepare(`UPDATE bg_checks SET status='pending', reviewed_by=?, reviewed_by_name=?, reviewed_at=?, review_note=?,
                  updated_at=?, version=version+1 WHERE id=?`)
        .run(user.id, user.name, stamp, note, stamp, id)
      addEvent(id, {
        status: 'pending', action: 'review_return', party: 'hiring_manager', actor: user, note,
        detail: { back_to: 'pending' }
      })
      notifyRole('recruiter', 'bg_returned', '背调复核被退回，请补充后重提',
        `${who}背调复核被 ${user.name} 退回：${note}`, c.application_id)
      return { ok: true, status: 'pending' }
    }
    if (b.action !== 'approve') badRequest('未知复核动作', 'unknown_action')

    const effective = c.conclusion === 'pass' ? 'passed' : 'failed'
    db.prepare(`UPDATE bg_checks SET status=?, reviewed_by=?, reviewed_by_name=?, reviewed_at=?, review_note=?,
                effective_at=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(effective, user.id, user.name, stamp, note, stamp, stamp, id)
    addEvent(id, {
      status: effective, action: 'review_approve', party: 'hiring_manager', actor: user,
      note: `复核通过，背调结论「${c.conclusion === 'pass' ? '通过' : '不通过'}」生效${note ? `：${note}` : ''}`,
      detail: { conclusion: c.conclusion, effective_at: stamp }
    })
    auditPassive({
      category: 'action', action: 'bgcheck.conclude', actor: user, applicationId: c.application_id,
      refType: 'bgcheck', refId: id,
      summary: `入职背调 #${id} 结论生效：${c.conclusion === 'pass' ? '通过' : '不通过'}`,
      detail: { conclusion: c.conclusion, review_note: note }
    })
    if (effective === 'passed') {
      notifyRole('recruiter', 'bg_passed', '背调复核通过，可安排报到',
        `${who}背调结论「通过」已生效（${user.name} 复核），现在可以确认报到/入职`, c.application_id)
    } else {
      notifyRole('recruiter', 'bg_failed', '背调结论不通过已生效',
        `${who}背调结论「不通过」已生效（${user.name} 复核），入职已拦截，请评估后续处理`, c.application_id)
    }
    return { ok: true, status: effective }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 催办提醒（招聘负责人 → 用人经理） =================
router.post('/:id/remind', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('催办提醒由「招聘负责人」发起', 'role_not_allowed')
  const id = num(req.params.id)
  const out = tx(() => {
    const c = getCheck(id)
    if (!c) return { notFound: true }
    if (c.status !== 'reviewing') conflict('仅待复核的背调可以催办', 'not_reviewing')
    addEvent(id, {
      status: 'reviewing', action: 'remind', party: 'recruiter', actor: user,
      note: '催办：请用人经理尽快复核背调结论', detail: {}
    })
    const { who } = appWho(c.application_id)
    notifyRole('hiring_manager', 'bg_remind', '⏰ 背调复核催办',
      `${who}背调结论「${c.conclusion === 'pass' ? '通过' : '不通过'}」待您复核（${user.name} 催办）`, c.application_id)
    return { ok: true }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 撤销结论（招聘负责人；已生效结论） =================
// 撤销后最新一单不再是 passed，markOfferJoined 门槛立即重新拦截 Offer 入职/报到（同步拦住）；
// 若 Offer 已入职（joined），门槛幂等先行返回，此处仅通知提示人工跟进，不自动回写 Offer
router.post('/:id/revoke', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('撤销背调结论需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const reason = String(b.reason || '')
  const out = tx(() => {
    const c = getCheck(id)
    if (!c) return { notFound: true }
    assertVersion(c, b.version)
    if (!['passed', 'failed'].includes(c.status)) conflict('仅已生效的背调结论可以撤销', 'not_effective')
    if (!reason.trim()) badRequest('撤销结论必须填写原因', 'reason_required')
    const stamp = ts()
    db.prepare(`UPDATE bg_checks SET status='revoked', revoked_at=?, revoked_by=?, revoked_by_name=?, revoke_reason=?,
                updated_at=?, version=version+1 WHERE id=?`)
      .run(stamp, user.id, user.name, reason, stamp, id)
    addEvent(id, {
      status: 'revoked', action: 'revoke', party: 'recruiter', actor: user,
      note: `撤销背调结论（原结论：${c.conclusion === 'pass' ? '通过' : '不通过'}）：${reason}`,
      detail: { from_status: c.status, reason }
    })
    auditPassive({
      category: 'action', action: 'bgcheck.revoke', actor: user, applicationId: c.application_id,
      refType: 'bgcheck', refId: id,
      summary: `入职背调 #${id} 结论被撤销（原：${STATUS_LABEL[c.status]}），Offer 入职同步拦截`,
      detail: { from_status: c.status, reason }
    })
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(c.application_id)
    const joined = of?.status === 'joined'
    const { who } = appWho(c.application_id)
    const body = `${who}背调结论被 ${user.name} 撤销：${reason}。该应聘已不可确认入职/报到，需重新发起背调并复核通过`
      + (joined ? '；⚠️ 该候选人 Offer 已是「已入职」，请人工跟进处理' : '')
    notifyRole('hiring_manager', 'bg_revoked', '背调结论已撤销，入职已拦截', body, c.application_id)
    notifyRole('recruiter', 'bg_revoked', '背调结论已撤销，入职已拦截', body, c.application_id)
    return { ok: true, status: 'revoked', offer_joined: joined }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 取消背调（招聘负责人；结论未生效前） =================
router.post('/:id/cancel', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('取消背调需「招聘负责人」身份', 'role_not_allowed')
  const id = num(req.params.id)
  const b = req.body || {}
  const reason = String(b.reason || '')
  const out = tx(() => {
    const c = getCheck(id)
    if (!c) return { notFound: true }
    if (!ACTIVE_STATUS.includes(c.status)) conflict('该背调已结案，无法取消', 'status_closed')
    if (!reason.trim()) badRequest('取消背调必须填写原因', 'reason_required')
    const stamp = ts()
    const wasReviewing = c.status === 'reviewing'
    db.prepare(`UPDATE bg_checks SET status='cancelled', cancel_reason=?, cancelled_at=?, updated_at=?, version=version+1 WHERE id=?`)
      .run(reason, stamp, stamp, id)
    addEvent(id, {
      status: 'cancelled', action: 'cancel', party: 'recruiter', actor: user,
      note: `取消入职背调：${reason}`, detail: { from_status: c.status, reason }
    })
    auditPassive({
      category: 'action', action: 'bgcheck.cancel', actor: user, applicationId: c.application_id,
      refType: 'bgcheck', refId: id,
      summary: `入职背调 #${id} 由招聘负责人取消（原状态：${STATUS_LABEL[c.status]}）`,
      detail: { from_status: c.status, reason }
    })
    if (wasReviewing) {
      const { who } = appWho(c.application_id)
      notifyRole('hiring_manager', 'bg_cancelled', '背调已取消，无需复核',
        `${who}背调被 ${user.name} 取消：${reason}`, c.application_id)
    }
    return { ok: true, status: 'cancelled' }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ---------------- 历史数据兼容：已有入职记录单独处理 ----------------
// 功能上线前已确认入职（offer=joined）且无背调记录的应聘，补录一条「已通过」背调（backfilled=1），
// 核查明细不迁移；这些记录不再走核查流程，也不受入职门槛影响（markOfferJoined 幂等先行返回）
function backfillBgChecks() {
  const need = db.prepare("SELECT * FROM applications WHERE stage='hired'").all().filter(a => {
    const has = db.prepare('SELECT COUNT(*) c FROM bg_checks WHERE application_id=?').get(a.id).c
    if (has) return false
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
    return of && of.status === 'joined'
  })
  if (!need.length) return
  tx(() => {
    need.forEach(a => {
      const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(a.id)
      const stamp = of.joined_at && /^\d{4}/.test(of.joined_at) ? of.joined_at : ts()
      const r = db.prepare(`INSERT INTO bg_checks
        (application_id,candidate_id,position_id,status,items,note,conclusion,conclusion_note,
         created_by_name,created_at,submitted_at,reviewed_by_name,reviewed_at,effective_at,backfilled,updated_at,version)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,1)`)
        .run(a.id, a.candidate_id, a.position_id, 'passed', '[]', '历史已入职数据补录，核查明细未迁移',
          'pass', '历史补录：功能上线前已确认入职',
          '系统迁移', stamp, stamp, '系统迁移', stamp, stamp, stamp)
      const id = Number(r.lastInsertRowid)
      addEvent(id, {
        status: 'passed', action: 'migrate', party: 'system', actor: { id: 'system', name: '系统迁移' },
        note: '该候选人在背调功能上线前已确认入职，按历史数据补录为「通过」，核查明细不再追溯',
        detail: { joined_at: of.joined_at }
      })
    })
  })
  console.log(`[HR] backfilled bg checks for ${need.length} joined hires`)
}
backfillBgChecks()

// ---------------- 状态聚合（供 /api/state 合并返回） ----------------
export function getBgCheckState() {
  const eventsAll = db.prepare('SELECT * FROM bg_check_events ORDER BY id ASC').all()
    .map(e => ({ ...e, detail: parseJSON(e.detail, {}), action_label: ACTION_LABEL[e.action] || e.action, party_label: PARTY_LABEL[e.party] || e.party }))
  const bgChecks = db.prepare('SELECT * FROM bg_checks ORDER BY id DESC').all().map(c => {
    const a = db.prepare(`SELECT ap.*, c.name candidate_name, p.name position_name, p.dept position_dept, p.city position_city
                          FROM applications ap
                          JOIN candidates c ON c.id=ap.candidate_id
                          JOIN positions p ON p.id=ap.position_id
                          WHERE ap.id=?`).get(c.application_id)
    const of = db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(c.application_id)
    const items = parseJSON(c.items, [])
    return {
      ...c,
      version: num(c.version),
      backfilled: !!c.backfilled,
      candidate: a?.candidate_name || '',
      position: a?.position_name || '',
      dept: a?.position_dept || '',
      city: a?.position_city || '',
      app_stage: a?.stage || '',
      offer_status: of?.status || '',
      status_label: STATUS_LABEL[c.status] || c.status,
      conclusion_label: c.conclusion === 'pass' ? '通过' : c.conclusion === 'fail' ? '不通过' : '',
      items,
      itemsReady: items.length > 0 && items.filter(i => i.required).every(i => i.status !== 'pending'),
      flaggedCount: items.filter(i => i.status === 'flagged').length,
      events: eventsAll.filter(e => e.check_id === c.id)
    }
  })
  return {
    bgChecks,
    bgCheckMeta: {
      statusLabels: STATUS_LABEL,
      actionLabels: ACTION_LABEL,
      partyLabels: PARTY_LABEL,
      itemStatusLabels: ITEM_STATUS_LABEL,
      defaultItems: DEFAULT_ITEMS
    }
  }
}
