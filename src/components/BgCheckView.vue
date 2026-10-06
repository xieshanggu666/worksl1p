<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()

const STATUS_META = {
  pending: ['🔍', '核查中', 'var(--accent)'],
  reviewing: ['⏳', '待复核', 'var(--accent2)'],
  passed: ['✅', '通过', 'var(--green)'],
  failed: ['❌', '未通过', 'var(--red)'],
  revoked: ['↩️', '已撤销', 'var(--purple)'],
  cancelled: ['🚫', '已取消', 'var(--muted)']
}
const ITEM_META = {
  pending: ['待核实', 'var(--muted)'],
  verified: ['已核实', 'var(--green)'],
  flagged: ['有异常', 'var(--red)']
}

const tab = ref('active')
const detailId = ref(null)
const startAppId = ref(null)
const startNote = ref('')
const conclusion = ref('pass')
const conclusionNote = ref('')
const returnId = ref(null)
const returnNote = ref('')
const revokeId = ref(null)
const revokeReason = ref('')
const cancelId = ref(null)
const cancelReason = ref('')

const isRecruiter = computed(() => store.myRole === 'recruiter')
const isHM = computed(() => store.myRole === 'hiring_manager')

const activeList = computed(() => store.bgChecks.filter(c => ['pending', 'reviewing'].includes(c.status)))
const closedList = computed(() => store.bgChecks.filter(c => !['pending', 'reviewing'].includes(c.status)))
const list = computed(() => tab.value === 'active' ? activeList.value : closedList.value)
const detail = computed(() => store.bgChecks.find(c => c.id === detailId.value) || null)

// 可发起背调：已录用（Offer 已接受/已入职）且无进行中背调、最新一单未通过生效中
const startable = computed(() => store.applications.filter(a => {
  if (a.stage !== 'hired' || !['accepted', 'joined'].includes(a.offer?.status)) return false
  const latest = store.latestBgCheckOf(a.id)
  return !store.activeBgCheckOf(a.id) && latest?.status !== 'passed'
}))

const busy = key => !!store.pending[key]
function evTime(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : '' }

// ---------------- 发起背调 ----------------
function openStart(a) {
  if (!isRecruiter.value) { store.notify('error', '发起入职背调需「招聘负责人」身份'); return }
  startAppId.value = a.id
  startNote.value = ''
}
function confirmStart() {
  store.startBgCheck(startAppId.value, startNote.value)
  startAppId.value = null
}

// ---------------- 核查项 ----------------
function openDetail(c) {
  detailId.value = c.id
  conclusion.value = c.flaggedCount ? 'fail' : 'pass'
  conclusionNote.value = ''
}
function setItem(it, status) {
  const c = detail.value
  if (!c || c.status !== 'pending' || !isRecruiter.value) return
  store.updateBgCheckItems(c.id, [{ key: it.key, status, note: it.note || '' }])
}

// ---------------- 提交复核 ----------------
function onSubmit() {
  const c = detail.value
  if (!c || !isRecruiter.value) return
  if (!c.itemsReady) { store.notify('error', '必核项需全部核实（已核实/有异常）后才能提交'); return }
  if (conclusion.value === 'pass' && c.flaggedCount) { store.notify('error', '存在异常核查项，不能登记「通过」结论'); return }
  store.submitBgCheck(c.id, conclusion.value, conclusionNote.value, c.version)
}

// ---------------- 复核 ----------------
function onReviewApprove(c) {
  store.reviewBgCheck(c.id, { action: 'approve', version: c.version })
}
function openReturn(c) { returnId.value = c.id; returnNote.value = '' }
function confirmReturn() {
  if (!returnNote.value.trim()) { store.notify('error', '退回必须填写复核意见'); return }
  store.reviewBgCheck(returnId.value, { action: 'return', note: returnNote.value, version: detail.value.version })
  returnId.value = null
}
function onRemind(c) { store.remindBgCheck(c.id) }

// ---------------- 撤销 / 取消 ----------------
function openRevoke(c) { revokeId.value = c.id; revokeReason.value = '' }
function confirmRevoke() {
  if (!revokeReason.value.trim()) { store.notify('error', '撤销结论必须填写原因'); return }
  store.revokeBgCheck(revokeId.value, revokeReason.value, detail.value.version)
  revokeId.value = null
}
function openCancel(c) { cancelId.value = c.id; cancelReason.value = '' }
function confirmCancel() {
  if (!cancelReason.value.trim()) { store.notify('error', '取消背调必须填写原因'); return }
  store.cancelBgCheck(cancelId.value, cancelReason.value)
  cancelId.value = null
}

function goOnboarding() { store.goView('onboarding') }
</script>

<template>
  <div class="bgc">
    <!-- 角色职责说明 -->
    <div class="role-banner card">
      <span v-if="isRecruiter">🧭 当前身份「招聘负责人」：发起背调、逐项登记核查结果、提交结论、催办复核、撤销/取消。结论「通过」生效后候选人才可确认报到/入职。</span>
      <span v-else-if="isHM">🏢 当前身份「用人经理」：复核招聘负责人提交的背调结论（通过即生效，可退回附意见）；提交与催办都会提醒您。</span>
      <span v-else>💬 当前身份「面试官」不参与入职背调，请切换「招聘负责人」或「用人经理」身份处理。</span>
    </div>

    <div class="stat-row">
      <div class="card stat"><span>🔍</span><b>{{ store.bgChecks.filter(c => c.status === 'pending').length }}</b><em>核查中</em></div>
      <div class="card stat"><span>⏳</span><b>{{ store.bgChecks.filter(c => c.status === 'reviewing').length }}</b><em>待复核</em></div>
      <div class="card stat"><span>✅</span><b>{{ store.bgChecks.filter(c => c.status === 'passed').length }}</b><em>已通过</em></div>
      <div class="card stat"><span>❌</span><b>{{ store.bgChecks.filter(c => c.status === 'failed').length }}</b><em>未通过</em></div>
      <div class="card stat"><span>↩️</span><b>{{ store.bgChecks.filter(c => c.status === 'revoked').length }}</b><em>已撤销</em></div>
    </div>

    <!-- 已录用待发起 -->
    <div class="card" v-if="startable.length && isRecruiter">
      <h3>🔍 已录用 · 待发起背调 <span class="tag">{{ startable.length }}</span></h3>
      <div class="start-list">
        <div class="start-item" v-for="a in startable" :key="a.id">
          <div class="si-main">
            <b>{{ a.candidate }}</b>
            <span class="muted">{{ a.position }} · {{ a.dept }} · {{ a.city }}</span>
            <span class="re-chip" v-if="store.latestBgCheckOf(a.id)">上次：{{ store.latestBgCheckOf(a.id).status_label }}，可重新发起</span>
          </div>
          <div class="si-acts">
            <button class="primary sm" @click="openStart(a)">发起背调</button>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'active' }" @click="tab = 'active'">🔄 进行中 <em class="cnt" v-if="activeList.length">{{ activeList.length }}</em></button>
      <button :class="{ on: tab === 'closed' }" @click="tab = 'closed'">🗂️ 已结案</button>
    </div>

    <!-- 背调单列表 -->
    <div class="tlist">
      <div class="tcard card" v-for="c in list" :key="c.id">
        <div class="t-head">
          <span class="t-name">🔍 {{ c.candidate }}</span>
          <span class="st-chip" :style="{ color: STATUS_META[c.status][2], borderColor: STATUS_META[c.status][2] }">
            {{ STATUS_META[c.status][0] }} {{ STATUS_META[c.status][1] }}
          </span>
          <span class="cc-chip" v-if="c.conclusion && ['reviewing','passed','failed','revoked'].includes(c.status)"
            :class="c.conclusion === 'pass' ? 'ok' : 'bad'">结论：{{ c.conclusion_label }}</span>
          <span class="flag-chip" v-if="c.flaggedCount">⚠️ 异常项 {{ c.flaggedCount }}</span>
          <em class="muted">#{{ c.id }} · v{{ c.version }}</em>
        </div>
        <div class="t-main">
          <span class="muted">{{ c.position }} · {{ c.dept }} · {{ c.city }}</span>
          <span class="muted">发起 {{ evTime(c.created_at) }} · {{ c.created_by_name }}</span>
          <span class="muted" v-if="c.effective_at">生效 {{ evTime(c.effective_at) }} · {{ c.reviewed_by_name }} 复核</span>
          <span class="muted" v-if="c.revoked_at">撤销 {{ evTime(c.revoked_at) }}：{{ c.revoke_reason }}</span>
          <span class="muted" v-if="c.backfilled">· 历史补录</span>
        </div>
        <div class="t-foot">
          <em class="muted">最近：{{ evTime(c.events?.at(-1)?.created_at) }} · {{ c.events?.at(-1)?.actor_name || '系统' }}</em>
          <div class="t-acts">
            <button class="ghost sm" @click="openDetail(c)">📂 详情/办理</button>
            <button v-if="c.status === 'reviewing' && isRecruiter" class="ghost sm" :disabled="busy(`bg-remind:${c.id}`)" @click="onRemind(c)">⏰ 催办</button>
            <button v-if="['passed','failed'].includes(c.status) && isRecruiter && !c.backfilled" class="warn sm" @click="openRevoke(c)">撤销结论</button>
            <button v-if="['pending','reviewing'].includes(c.status) && isRecruiter" class="warn sm" @click="openCancel(c)">取消背调</button>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">{{ tab === 'active' ? '暂无进行中的背调。' : '暂无已结案的背调记录。' }}</div>
    </div>

    <!-- ================= 背调详情抽屉 ================= -->
    <div class="modal" v-if="detail" @click.self="detailId = null">
      <div class="detail-box card">
        <div class="d-head">
          <div>
            <h3>🔍 {{ detail.candidate }} · {{ detail.position }}</h3>
            <div class="muted">{{ detail.dept }} · {{ detail.city }} · 背调单 #{{ detail.id }}（v{{ detail.version }}）{{ detail.backfilled ? ' · 历史补录' : '' }}</div>
          </div>
          <div class="d-head-acts">
            <span class="st-chip big" :style="{ color: STATUS_META[detail.status][2], borderColor: STATUS_META[detail.status][2] }">
              {{ STATUS_META[detail.status][0] }} {{ STATUS_META[detail.status][1] }}
            </span>
            <button class="ghost" @click="detailId = null">关闭</button>
          </div>
        </div>

        <!-- 历史补录说明 -->
        <div class="block" v-if="detail.backfilled">
          <h4>🗂️ 历史已入职记录</h4>
          <div class="info-line">该候选人在背调功能上线前已确认入职，按历史数据补录为「通过」，核查明细不再追溯。</div>
        </div>

        <template v-else>
          <!-- 核查项 -->
          <div class="block">
            <h4>① 核查项 <span class="muted">（必核项全部核实后才能提交结论；登记「通过」不允许存在异常项）</span></h4>
            <div class="back-tip" v-if="detail.status === 'pending' && detail.review_note">
              ↩️ 用人经理退回意见：{{ detail.review_note }}。请补充核查后重新提交。
            </div>
            <div class="mat-table">
              <div class="mat-row mat-head"><span>核查项</span><span>必核</span><span>结果</span><span>操作</span></div>
              <div class="mat-row" v-for="it in detail.items" :key="it.key">
                <span>{{ it.name }}</span>
                <span :class="it.required ? 'req' : 'muted'">{{ it.required ? '必核' : '可选' }}</span>
                <span :style="{ color: ITEM_META[it.status]?.[1] }">{{ ITEM_META[it.status]?.[0] || it.status }}</span>
                <span class="mat-acts" v-if="isRecruiter && detail.status === 'pending'">
                  <button class="sm" :class="{ on: it.status === 'verified' }" @click="setItem(it, 'verified')">已核实</button>
                  <button class="sm" :class="{ on: it.status === 'flagged' }" @click="setItem(it, 'flagged')">有异常</button>
                  <button class="sm" :class="{ on: it.status === 'pending' }" @click="setItem(it, 'pending')">重置</button>
                </span>
                <span v-else class="muted">—</span>
              </div>
            </div>
          </div>

          <!-- 提交复核（核查中） -->
          <div class="block" v-if="detail.status === 'pending'">
            <h4>② 登记结论并提交复核</h4>
            <div class="cc-picker">
              <label class="cc-opt" :class="{ on: conclusion === 'pass' }">
                <input type="radio" value="pass" v-model="conclusion" :disabled="!isRecruiter" /> ✅ 通过
              </label>
              <label class="cc-opt bad" :class="{ on: conclusion === 'fail' }">
                <input type="radio" value="fail" v-model="conclusion" :disabled="!isRecruiter" /> ❌ 不通过
              </label>
            </div>
            <input class="cc-note" v-model="conclusionNote" placeholder="结论说明（可选）：核查渠道/异常摘要等" :disabled="!isRecruiter" />
            <div class="block-acts">
              <em class="muted" v-if="!detail.itemsReady">仍有必核项待核实</em>
              <em class="muted" v-else-if="conclusion === 'pass' && detail.flaggedCount">存在异常项，不能登记「通过」</em>
              <button class="primary" :disabled="!isRecruiter || !detail.itemsReady || (conclusion === 'pass' && !!detail.flaggedCount) || busy(`bg-submit:${detail.id}`)"
                @click="onSubmit">提交用人经理复核 →</button>
            </div>
          </div>

          <!-- 复核（待复核） -->
          <div class="block" v-if="detail.status === 'reviewing'">
            <h4>② 用人经理复核</h4>
            <div class="approval-chain">
              <div class="ac-node done"><i>📨</i><span>招聘负责人提交<br><em class="muted">{{ detail.created_by_name }} · {{ evTime(detail.submitted_at) }}</em></span></div>
              <em>→</em>
              <div class="ac-node current"><i>⏳</i><span>用人经理复核</span></div>
            </div>
            <div class="mat-summary">
              登记结论：<b :class="detail.conclusion === 'pass' ? 'ok-t' : 'bad-t'">{{ detail.conclusion_label }}</b>
              <template v-if="detail.conclusion_note">；说明：{{ detail.conclusion_note }}</template>
              <template v-if="detail.flaggedCount">；⚠️ 异常项 {{ detail.flaggedCount }} 个</template>
            </div>
            <div class="block-acts">
              <template v-if="isHM">
                <button class="succ" :disabled="busy(`bg-review:${detail.id}`)" @click="onReviewApprove(detail)">✅ 复核通过（结论生效）</button>
                <button class="warn" @click="openReturn(detail)">↩️ 退回补充</button>
              </template>
              <template v-else-if="isRecruiter">
                <em class="muted">等待「用人经理」复核…</em>
                <button class="ghost" :disabled="busy(`bg-remind:${detail.id}`)" @click="onRemind(detail)">⏰ 催办提醒</button>
              </template>
              <em v-else class="muted">等待「用人经理」复核…</em>
            </div>
          </div>

          <!-- 生效结论 -->
          <div class="block" v-if="['passed','failed'].includes(detail.status)">
            <h4>② 结论已生效</h4>
            <div class="eff-line" :class="detail.status">
              {{ detail.status === 'passed' ? '✅' : '❌' }}
              背调结论「{{ detail.conclusion_label }}」已于 {{ evTime(detail.effective_at) }} 经 {{ detail.reviewed_by_name }} 复核生效。
              {{ detail.status === 'passed' ? '该候选人现在可以确认报到/入职。' : '该候选人入职已被拦截，如需继续请先撤销结论并重新核查。' }}
            </div>
            <div class="block-acts" v-if="isRecruiter">
              <button class="warn" @click="openRevoke(detail)">↩️ 撤销结论</button>
              <button class="ghost" v-if="detail.status === 'passed'" @click="goOnboarding">🧳 前往入职交接</button>
            </div>
          </div>

          <!-- 已撤销 / 已取消 -->
          <div class="block" v-if="detail.status === 'revoked'">
            <h4>↩️ 结论已撤销</h4>
            <div class="cancel-info">原结论「{{ detail.conclusion_label }}」被 {{ detail.revoked_by_name }} 撤销（{{ evTime(detail.revoked_at) }}）：{{ detail.revoke_reason }}。该应聘入职/报到已同步拦截，可重新发起背调。</div>
          </div>
          <div class="block" v-if="detail.status === 'cancelled'">
            <h4>🚫 背调已取消</h4>
            <div class="cancel-info">{{ detail.cancel_reason }}（{{ evTime(detail.cancelled_at) }}）。同一应聘可重新发起背调。</div>
          </div>
        </template>

        <!-- 全程时间线 -->
        <div class="tl-box">
          <h4>📜 背调记录（只追加）</h4>
          <div class="timeline">
            <div class="tl-item" v-for="e in detail.events" :key="e.id">
              <div class="tl-dot">{{ { create: '🔍', items_update: '✏️', submit: '📨', review_approve: '✅', review_return: '↩️', remind: '⏰', revoke: '🚫', cancel: '🚫', migrate: '🗂️' }[e.action] || '•' }}</div>
              <div class="tl-body">
                <div class="tl-head">
                  <b>{{ e.action_label }}</b>
                  <span class="tl-party">{{ e.party_label }}</span>
                  <em class="muted">{{ evTime(e.created_at) }} · {{ e.actor_name || '系统' }}</em>
                </div>
                <p v-if="e.note">{{ e.note }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 发起背调 -->
    <div class="modal" v-if="startAppId" @click.self="startAppId = null">
      <div class="modal-box card">
        <h3>🔍 发起入职背调</h3>
        <p class="muted">候选人已接受 Offer（已录用）。背调结论经用人经理复核「通过」后，候选人才可确认报到/入职。</p>
        <label class="muted">备注（可选）</label>
        <textarea v-model="startNote" rows="2" placeholder="核查重点/渠道要求等"></textarea>
        <div class="acts">
          <button class="primary" @click="confirmStart">发起背调</button>
          <button class="ghost" @click="startAppId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 复核退回 -->
    <div class="modal" v-if="returnId" @click.self="returnId = null">
      <div class="modal-box card">
        <h3>↩️ 退回背调复核</h3>
        <textarea v-model="returnNote" rows="3" placeholder="复核意见（必填），招聘负责人补充核查后可重新提交"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmReturn">确认退回</button>
          <button class="ghost" @click="returnId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 撤销结论 -->
    <div class="modal" v-if="revokeId" @click.self="revokeId = null">
      <div class="modal-box card">
        <h3>↩️ 撤销背调结论</h3>
        <p class="muted">撤销后该应聘将<strong>立即不可确认入职/报到</strong>（Offer 页与入职交接同步拦截），需重新发起背调并经复核通过。</p>
        <textarea v-model="revokeReason" rows="3" placeholder="撤销原因（必填）"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmRevoke">确认撤销</button>
          <button class="ghost" @click="revokeId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 取消背调 -->
    <div class="modal" v-if="cancelId" @click.self="cancelId = null">
      <div class="modal-box card">
        <h3>🚫 取消背调</h3>
        <textarea v-model="cancelReason" rows="3" placeholder="取消原因（必填）"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmCancel">确认取消</button>
          <button class="ghost" @click="cancelId = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bgc { display: flex; flex-direction: column; gap: 14px; }
.role-banner { padding: 10px 14px; font-size: 12.5px; color: var(--muted); background: rgba(91,140,255,.07); border-color: rgba(91,140,255,.28); }
.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 13px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; color: var(--accent); }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.start-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.start-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; gap: 8px; }
.si-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.si-acts { display: flex; align-items: center; gap: 10px; }
.re-chip { font-size: 10px; color: var(--accent2); border: 1px solid rgba(255,209,102,.4); border-radius: 9px; padding: 1px 7px; }
.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .8; }
.tabs button.on { opacity: 1; border-color: var(--accent); background: rgba(91,140,255,.12); color: var(--accent); }
.cnt { font-style: normal; font-size: 10px; background: var(--red); color: #fff; border-radius: 8px; padding: 1px 6px; margin-left: 4px; }
.tlist { display: flex; flex-direction: column; gap: 12px; }
.tcard { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.t-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.t-name { font-weight: 700; font-size: 15px; }
.t-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.t-main { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; }
.st-chip { font-size: 11px; border: 1px solid; border-radius: 10px; padding: 2px 9px; white-space: nowrap; }
.st-chip.big { font-size: 12px; padding: 4px 11px; }
.cc-chip { font-size: 11px; border-radius: 10px; padding: 2px 9px; border: 1px solid; }
.cc-chip.ok { color: var(--green); border-color: rgba(87,214,160,.4); }
.cc-chip.bad { color: var(--red); border-color: rgba(255,107,122,.4); }
.flag-chip { font-size: 11px; color: var(--accent2); border: 1px solid rgba(255,209,102,.4); border-radius: 10px; padding: 2px 8px; }
button.sm { font-size: 11px; padding: 4px 9px; }
.t-foot { display: flex; justify-content: space-between; align-items: center; }
.t-acts { display: flex; gap: 8px; }
.empty { padding: 30px; text-align: center; color: var(--muted); }
.modal { position: fixed; inset: 0; background: rgba(4,8,18,.68); z-index: 50; display: flex; justify-content: flex-end; }
.detail-box { width: min(680px, 100%); height: 100%; border-radius: 0; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.d-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.d-head-acts { display: flex; gap: 8px; align-items: center; }
.block { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; display: flex; flex-direction: column; gap: 11px; }
.block h4 { font-size: 14px; }
.info-line { font-size: 12.5px; color: var(--muted); }
.back-tip { font-size: 12px; color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.3); border-radius: 8px; padding: 7px 10px; }
.mat-table { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.mat-row { display: grid; grid-template-columns: 2fr 60px 80px 1fr; align-items: center; gap: 8px; padding: 7px 11px; font-size: 12.5px; background: rgba(13,18,32,.25); }
.mat-row + .mat-row { border-top: 1px solid var(--border); }
.mat-head { font-size: 11px; color: var(--muted); background: rgba(91,140,255,.08); }
.mat-acts { display: flex; gap: 5px; }
.mat-acts button { padding: 2px 8px; font-size: 11px; opacity: .75; }
.mat-acts button.on { opacity: 1; border-color: var(--green); background: rgba(87,214,160,.15); color: var(--green); }
.req { color: var(--red); }
.cc-picker { display: flex; gap: 10px; }
.cc-opt { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 8px 14px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; }
.cc-opt.on { border-color: var(--green); background: rgba(87,214,160,.1); color: var(--green); }
.cc-opt.bad.on { border-color: var(--red); background: rgba(255,107,122,.1); color: var(--red); }
.cc-note { width: 100%; padding: 8px 10px; font-size: 13px; }
.block-acts { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
.approval-chain { display: flex; align-items: center; gap: 12px; }
.ac-node { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 9px 13px; border-radius: 12px; border: 1px solid var(--border); background: rgba(13,18,32,.3); }
.ac-node.done { border-color: rgba(87,214,160,.4); color: var(--green); }
.ac-node.current { border-color: rgba(255,209,102,.5); color: var(--accent2); box-shadow: 0 0 0 2px rgba(255,209,102,.12); }
.ac-node i { font-style: normal; }
.ac-node em { font-style: normal; font-size: 11px; font-weight: 400; }
.approval-chain > em { font-style: normal; color: var(--muted); }
.mat-summary { font-size: 12.5px; color: var(--muted); background: rgba(13,18,32,.3); border-radius: 8px; padding: 9px 11px; }
.ok-t { color: var(--green); }
.bad-t { color: var(--red); }
.eff-line { font-size: 12.5px; border-radius: 8px; padding: 9px 11px; }
.eff-line.passed { color: var(--green); background: rgba(87,214,160,.08); border: 1px solid rgba(87,214,160,.3); }
.eff-line.failed { color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.3); }
.cancel-info { font-size: 12.5px; color: var(--muted); }
.tl-box { border-top: 1px dashed var(--border); padding-top: 12px; }
.tl-box h4 { font-size: 13px; margin-bottom: 10px; }
.timeline { display: flex; flex-direction: column; gap: 10px; }
.tl-item { display: flex; gap: 10px; position: relative; }
.tl-item:not(:last-child)::before { content: ''; position: absolute; left: 13px; top: 28px; bottom: -12px; width: 2px; background: var(--border); }
.tl-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--panel2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; z-index: 1; flex-shrink: 0; font-size: 13px; }
.tl-body { flex: 1; min-width: 0; }
.tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.tl-party { font-size: 10px; color: var(--purple); border: 1px solid rgba(167,139,250,.35); background: rgba(167,139,250,.1); border-radius: 9px; padding: 1px 7px; }
.tl-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.tl-body p { font-size: 12px; color: var(--muted); margin-top: 2px; }
.modal-box { width: min(430px, 92vw); margin: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.modal-box label.muted { font-size: 12px; }
.modal-box input { width: 100%; padding: 9px; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }
@media (max-width: 720px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .mat-row { grid-template-columns: 1fr; } }
</style>
