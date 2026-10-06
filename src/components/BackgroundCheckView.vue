<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()

const STATUS_META = {
  reviewing: ['🔍', '复核中', '#4fc3f7'],
  passed: ['✅', '核查通过', 'var(--green)'],
  failed: ['⛔', '核查不通过', 'var(--red)'],
  cancelled: ['🚫', '已撤销', 'var(--muted)'],
  exempt: ['🗂️', '免核查（历史补录）', 'var(--purple)']
}
const ITEM_STATUS = { pending: ['待核查', 'var(--muted)'], ok: ['无异常', 'var(--green)'], issue: ['⚠️ 有疑点', 'var(--red)'] }

const tab = ref('active')
const detailId = ref(null)
const startAppId = ref(null)
const scopeNote = ref('')
const conclusionNote = ref('')
const failNote = ref('')
const revokeId = ref(null)
const revokeReason = ref('')
const cancelId = ref(null)
const cancelReason = ref('')
const passOpen = ref(false)
const failOpen = ref(false)

const isRecruiter = computed(() => store.myRole === 'recruiter')
const isHM = computed(() => store.myRole === 'hiring_manager')

const activeList = computed(() => store.backgroundChecks.filter(c => ['reviewing', 'passed', 'failed'].includes(c.status)))
const historyList = computed(() => store.backgroundChecks.filter(c => ['cancelled', 'exempt'].includes(c.status)))
const list = computed(() => tab.value === 'active' ? activeList.value : historyList.value)
const detail = computed(() => store.backgroundChecks.find(c => c.id === detailId.value) || null)

// 可发起背调：已录用、Offer 已接受（未入职）、且无进行中背调
const startable = computed(() => store.applications.filter(a =>
  a.stage === 'hired' && a.offer?.status === 'accepted' && !activeBgcOf(a.id)))
function activeBgcOf(appId) {
  return store.backgroundChecks.find(c => c.application_id === appId && ['reviewing', 'passed', 'failed'].includes(c.status))
}

function evTime(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : '' }
const busy = key => !!store.pending[key]

// ---------------- 发起 ----------------
function openStart(a) {
  if (!isRecruiter.value) { store.notify('error', '发起背调需「招聘负责人」身份'); return }
  startAppId.value = a.id
  scopeNote.value = ''
}
function confirmStart() {
  store.startBackgroundCheck(startAppId.value, scopeNote.value)
  startAppId.value = null
}

// ---------------- 核查项 ----------------
function setItem(it, status) {
  const c = detail.value
  if (!c || c.status !== 'reviewing' || !isRecruiter.value) return
  store.updateBackgroundCheckItems(c.id, [{ key: it.key, status, note: it.note || '' }])
}
function setItemNote(it, e) {
  const c = detail.value
  if (!c || c.status !== 'reviewing' || !isRecruiter.value) return
  store.updateBackgroundCheckItems(c.id, [{ key: it.key, status: it.status, note: e.target.value }])
}

// ---------------- 复核结论 ----------------
function openPass() { conclusionNote.value = ''; passOpen.value = true }
function openFail() { failNote.value = ''; failOpen.value = true }
function confirmPass() {
  const c = detail.value
  if (!conclusionNote.value.trim()) { store.notify('error', '请填写复核结论说明'); return }
  if (c.itemsIssue > 0) { store.notify('error', '存在「有疑点」核查项，请先处理或改判后再给出通过结论'); return }
  store.concludeBackgroundCheck(c.id, { conclusion: 'pass', note: conclusionNote.value, version: c.version })
  conclusionNote.value = ''
  passOpen.value = false
}
function confirmFail() {
  const c = detail.value
  if (!failNote.value.trim()) { store.notify('error', '请填写不通过原因'); return }
  store.concludeBackgroundCheck(c.id, { conclusion: 'fail', note: failNote.value, version: c.version })
  failNote.value = ''
  failOpen.value = false
}

// ---------------- 撤销结论 / 撤销核查 / 催办 ----------------
function openRevoke(c) { revokeId.value = c.id; revokeReason.value = '' }
function confirmRevoke() {
  if (!revokeReason.value.trim()) { store.notify('error', '撤销结论必须填写原因'); return }
  store.revokeBackgroundCheck(revokeId.value, detail.value.version, revokeReason.value)
  revokeId.value = null
}
function openCancel(c) { cancelId.value = c.id; cancelReason.value = '' }
function confirmCancel() {
  if (!cancelReason.value.trim()) { store.notify('error', '撤销背调必须填写原因'); return }
  store.cancelBackgroundCheck(cancelId.value, cancelReason.value)
  cancelId.value = null
}
function onRemind(c) { store.remindBackgroundCheck(c.id) }

function goOnboarding() { store.goView('onboarding') }
</script>

<template>
  <div class="bgc">
    <!-- 角色职责说明 -->
    <div class="role-banner card">
      <span v-if="isRecruiter">🧭 当前身份「招聘负责人」：候选人接受 Offer 后发起入职背调、逐项登记核查结果并催办用人经理复核；可撤销结论（同步关闭 Offer 入职/交接报到闸门）。</span>
      <span v-else-if="isHM">🏢 当前身份「用人经理」：复核招聘负责人提交的背调核查项并给出「通过/不通过」结论（必填说明）；<b>结论决定候选人能否报到入职</b>，结论被撤销后需重新复核。</span>
      <span v-else>💬 当前身份「面试官」不参与入职背调，请切换「招聘负责人」或「用人经理」身份处理。</span>
    </div>

    <div class="stat-row">
      <div class="card stat"><span>🔍</span><b>{{ activeList.filter(c => c.status === 'reviewing').length }}</b><em>复核中</em></div>
      <div class="card stat"><span>✅</span><b>{{ activeList.filter(c => c.status === 'passed').length }}</b><em>核查通过</em></div>
      <div class="card stat"><span>⛔</span><b>{{ activeList.filter(c => c.status === 'failed').length }}</b><em>核查不通过</em></div>
      <div class="card stat"><span>🗂️</span><b>{{ store.backgroundChecks.filter(c => c.status === 'exempt').length }}</b><em>免核查（历史已入职）</em></div>
    </div>

    <!-- 已录用待发起 -->
    <div class="card" v-if="startable.length && isRecruiter">
      <h3>🔍 已录用 · 待发起入职背调 <span class="tag">{{ startable.length }}</span></h3>
      <div class="start-list">
        <div class="start-item" v-for="a in startable" :key="a.id">
          <div class="si-main">
            <b>{{ a.candidate }}</b>
            <span class="muted">{{ a.position }} · {{ a.dept }} · {{ a.city }}</span>
          </div>
          <div class="si-acts">
            <em class="muted">背调通过后才能确认入职/报到</em>
            <button class="primary sm" @click="openStart(a)">发起背调</button>
          </div>
        </div>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'active' }" @click="tab = 'active'">🔄 进行中 <em class="cnt" v-if="activeList.length">{{ activeList.length }}</em></button>
      <button :class="{ on: tab === 'done' }" @click="tab = 'done'">🗂️ 历史记录</button>
    </div>

    <!-- 背调单列表 -->
    <div class="tlist">
      <div class="tcard card" v-for="c in list" :key="c.id">
        <div class="t-head">
          <span class="t-name">🔍 {{ c.candidate }}</span>
          <span class="status-chip" :style="{ color: STATUS_META[c.status][2], borderColor: STATUS_META[c.status][2] }">
            {{ STATUS_META[c.status][0] }} {{ STATUS_META[c.status][1] }}
          </span>
          <span class="gate-chip" v-if="c.status === 'passed'">🔓 入职闸门已开启</span>
          <span class="gate-chip locked" v-else-if="c.status === 'failed'">🔒 入职已拦截</span>
          <span class="gate-chip pending" v-else-if="c.status === 'reviewing'">🔒 待复核结论</span>
          <em class="muted">#{{ c.id }} · v{{ c.version }}</em>
        </div>
        <div class="t-main">
          <span class="muted">{{ c.position }} · {{ c.dept }} · {{ c.city }}</span>
          <span class="muted" v-if="c.status === 'reviewing'">核查项 {{ c.itemsDone }}/{{ c.items.length }}<template v-if="c.itemsIssue"> · <b class="warn-text">{{ c.itemsIssue }} 项有疑点</b></template></span>
          <span class="muted" v-if="c.initiated_at">发起 {{ evTime(c.initiated_at) }}</span>
          <span class="muted" v-if="c.reviewed_at">复核 {{ evTime(c.reviewed_at) }}</span>
          <span class="muted" v-if="c.backfilled">· 历史补录</span>
        </div>
        <div class="t-foot">
          <em class="muted">最近：{{ evTime(c.events?.at(-1)?.created_at) }} · {{ c.events?.at(-1)?.actor_name || '系统' }}</em>
          <div class="t-acts">
            <button class="ghost sm" @click="detailId = c.id">📂 详情/办理</button>
            <button v-if="c.status === 'reviewing' && isHM" class="primary sm" @click="detailId = c.id">复核结论</button>
            <button v-if="c.status === 'passed' && isRecruiter" class="ghost sm" @click="goOnboarding">🧳 去办理报到</button>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">{{ tab === 'active' ? '暂无进行中的背调。候选人接受 Offer 后由招聘负责人在此发起。' : '暂无历史背调记录。' }}</div>
    </div>

    <!-- ================= 背调详情抽屉 ================= -->
    <div class="modal" v-if="detail" @click.self="detailId = null">
      <div class="detail-box card">
        <div class="d-head">
          <div>
            <h3>🔍 {{ detail.candidate }} · {{ detail.position }}</h3>
            <div class="muted">{{ detail.dept }} · {{ detail.city }} · 背调单 #{{ detail.id }}（v{{ detail.version }}）</div>
          </div>
          <div class="d-head-acts">
            <span class="status-chip big" :style="{ color: STATUS_META[detail.status][2], borderColor: STATUS_META[detail.status][2] }">
              {{ STATUS_META[detail.status][0] }} {{ STATUS_META[detail.status][1] }}
            </span>
            <button class="ghost" @click="detailId = null">关闭</button>
          </div>
        </div>

        <!-- 闸门提示条 -->
        <div class="gate-bar pass" v-if="detail.status === 'passed'">
          ✅ 背调结论「通过」（{{ detail.reviewed_by_name }} · {{ evTime(detail.reviewed_at) }}）：候选人可以报到入职。撤销结论将同步拦截 Offer 入职与交接报到。
          <button class="succ sm" @click="goOnboarding">前往入职交接 →</button>
        </div>
        <div class="gate-bar fail" v-else-if="detail.status === 'failed'">
          ⛔ 背调结论「不通过」（{{ detail.reviewed_by_name }} · {{ evTime(detail.reviewed_at) }}）：{{ detail.conclusion_note }}。Offer「确认入职」与交接「确认报到」已被拦截。
        </div>
        <div class="gate-bar reviewing" v-else-if="detail.status === 'reviewing'">
          🔍 背调复核中：结论未出前，Offer「确认入职」与交接「确认报到」均不可办理。
        </div>
        <div class="gate-bar exempt" v-else-if="detail.status === 'exempt'">
          🗂️ 该候选人在背调功能上线前已入职，按历史记录补录为「免核查」，单独处理不追溯。
        </div>

        <!-- 核查范围 -->
        <div class="block" v-if="detail.scope_note || detail.status === 'reviewing'">
          <h4>核查范围与备注</h4>
          <div class="scope-text">{{ detail.scope_note || '按标准项核查（身份/学历/履历/访谈/证书/竞业/违法记录）' }}</div>
        </div>

        <!-- 核查项清单 -->
        <div class="block" v-if="detail.items.length">
          <h4>核查项 <span class="muted">（招聘负责人逐项登记，用人经理复核时参考）</span></h4>
          <div class="item-table">
            <div class="item-row item-head"><span>核查项</span><span>结果</span><span>说明 / 备注</span><span v-if="detail.status === 'reviewing' && isRecruiter">操作</span></div>
            <div class="item-row" v-for="it in detail.items" :key="it.key" :class="{ issue: it.status === 'issue' }">
              <span class="it-name">{{ it.name }}</span>
              <span :style="{ color: ITEM_STATUS[it.status]?.[1] }">{{ ITEM_STATUS[it.status]?.[0] || it.status }}</span>
              <span class="it-note">
                <input v-if="detail.status === 'reviewing' && isRecruiter"
                       :value="it.note" @change="setItemNote(it, $event)"
                       :placeholder="it.status === 'issue' ? '疑点描述（建议填写）' : '核查渠道/时间等'" />
                <em v-else class="muted">{{ it.note || '—' }}</em>
              </span>
              <span class="it-acts" v-if="detail.status === 'reviewing' && isRecruiter">
                <button class="sm" :class="{ on: it.status === 'ok' }" @click="setItem(it, 'ok')">无异常</button>
                <button class="sm danger-btn" :class="{ on: it.status === 'issue' }" @click="setItem(it, 'issue')">有疑点</button>
                <button class="sm" :class="{ on: it.status === 'pending' }" @click="setItem(it, 'pending')">待核查</button>
              </span>
            </div>
          </div>
        </div>

        <!-- 操作区 -->
        <div class="block acts-block" v-if="['reviewing', 'passed', 'failed'].includes(detail.status)">
          <!-- 复核中 -->
          <template v-if="detail.status === 'reviewing'">
            <div class="block-acts" v-if="isHM">
              <button class="succ" :disabled="busy(`bgc-conclude:${detail.id}`) || !!detail.itemsIssue"
                :title="detail.itemsIssue ? '存在有疑点的核查项，不能给出通过结论' : ''" @click="openPass">✅ 复核通过（可报到入职）</button>
              <button class="warn" :disabled="busy(`bgc-conclude:${detail.id}`)" @click="openFail">⛔ 复核不通过（拦截入职）</button>
            </div>
            <div class="block-acts" v-else-if="isRecruiter">
              <em class="muted">等待「用人经理」复核…</em>
              <button class="ghost" @click="onRemind(detail)">⏰ 催办用人经理</button>
              <button class="warn" @click="openCancel(detail)">撤销背调</button>
            </div>
            <em v-else class="muted">面试官无操作权限。</em>
          </template>
          <!-- 结论已出 -->
          <template v-else>
            <div class="conclusion-box" :class="detail.status">
              <b>{{ detail.status === 'passed' ? '✅ 复核通过' : '⛔ 复核不通过' }}</b>
              <span class="muted">{{ detail.reviewed_by_name }} · {{ evTime(detail.reviewed_at) }}</span>
              <p>{{ detail.conclusion_note }}</p>
            </div>
            <div class="block-acts" v-if="isRecruiter && detail.offer_status !== 'joined'">
              <button class="primary" @click="openRevoke(detail)">🔓 撤销结论并退回重新复核</button>
              <button class="warn" @click="openCancel(detail)">撤销背调</button>
              <button v-if="detail.status === 'passed'" class="ghost" @click="goOnboarding">🧳 去办理报到</button>
            </div>
            <div class="muted" v-if="detail.offer_status === 'joined'">候选人已完成入职报到，结论不可撤销（已入职记录单独处理）。</div>
          </template>
        </div>

        <!-- 时间线 -->
        <div class="tl-box">
          <h4>📜 背调记录（只追加）</h4>
          <div class="timeline">
            <div class="tl-item" v-for="e in detail.events" :key="e.id">
              <div class="tl-dot">{{ { create: '🔍', item_update: '✏️', conclude: '✅', revoke: '🔓', cancel: '🚫', remind: '⏰', system_cancel: '⏸️', migrate: '🗂️' }[e.action] || '•' }}</div>
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
        <p class="muted">候选人已接受 Offer（已录用）。发起后将通知<b>用人经理复核</b>，复核通过前 Offer 不能确认入职、入职交接不能确认报到。</p>
        <label class="muted">核查范围 / 备注（可选）</label>
        <textarea v-model="scopeNote" rows="3" placeholder="如：重点核实近两段履历与竞业限制；按标准项核查可留空"></textarea>
        <div class="acts">
          <button class="primary" @click="confirmStart">发起并提交复核</button>
          <button class="ghost" @click="startAppId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 复核通过 -->
    <div class="modal" v-if="passOpen" @click.self="passOpen = false">
      <div class="modal-box card">
        <h3>✅ 背调复核通过</h3>
        <p class="muted">通过后候选人即可办理报到入职（Offer accepted→joined 闸门开启）。</p>
        <textarea v-model="conclusionNote" rows="3" placeholder="复核结论说明（必填），如：七项核查均无异常"></textarea>
        <div class="warn-tip" v-if="detail.itemsIssue">⚠️ 存在 {{ detail.itemsIssue }} 个「有疑点」核查项，请先在清单中改判后再通过。</div>
        <div class="acts">
          <button class="succ" @click="confirmPass">确认通过</button>
          <button class="ghost" @click="passOpen = false; conclusionNote = ''">取消</button>
        </div>
      </div>
    </div>

    <!-- 复核不通过 -->
    <div class="modal" v-if="failOpen" @click.self="failOpen = false">
      <div class="modal-box card">
        <h3>⛔ 背调复核不通过</h3>
        <p class="muted">结论将同步拦截 Offer「确认入职」与入职交接「确认报到」，并通知招聘负责人。</p>
        <textarea v-model="failNote" rows="3" placeholder="不通过原因（必填），如：学历信息与背调结果不符"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmFail">确认不通过</button>
          <button class="ghost" @click="failOpen = false; failNote = ''">取消</button>
        </div>
      </div>
    </div>

    <!-- 撤销结论 -->
    <div class="modal" v-if="revokeId" @click.self="revokeId = null">
      <div class="modal-box card">
        <h3>🔓 撤销背调结论</h3>
        <p class="muted">结论撤销后背调回到「复核中」，<b>Offer 确认入职与交接报到将立即被拦截</b>，待用人经理重新复核。已入职候选人不可撤销。</p>
        <textarea v-model="revokeReason" rows="3" placeholder="撤销原因（必填）"></textarea>
        <div class="acts">
          <button class="primary" @click="confirmRevoke">确认撤销结论</button>
          <button class="ghost" @click="revokeId = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 撤销背调 -->
    <div class="modal" v-if="cancelId" @click.self="cancelId = null">
      <div class="modal-box card">
        <h3>🚫 撤销入职背调</h3>
        <p class="muted">整单撤销后该应聘可重新发起背调；已入职候选人不可撤销。</p>
        <textarea v-model="cancelReason" rows="3" placeholder="撤销原因（必填）"></textarea>
        <div class="acts">
          <button class="warn" @click="confirmCancel">确认撤销</button>
          <button class="ghost" @click="cancelId = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bgc { display: flex; flex-direction: column; gap: 14px; }
.role-banner { padding: 10px 14px; font-size: 12.5px; color: var(--muted); background: rgba(79,195,247,.07); border-color: rgba(79,195,247,.28); }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 13px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; color: #4fc3f7; }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.start-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.start-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; gap: 8px; }
.si-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.si-acts { display: flex; align-items: center; gap: 10px; }
.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .8; }
.tabs button.on { opacity: 1; border-color: #4fc3f7; background: rgba(79,195,247,.12); color: #4fc3f7; }
.cnt { font-style: normal; font-size: 10px; background: var(--red); color: #fff; border-radius: 8px; padding: 1px 6px; margin-left: 4px; }
.tlist { display: flex; flex-direction: column; gap: 12px; }
.tcard { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.t-head { display: flex; align-items: center; gap: 10px; }
.t-name { font-weight: 700; font-size: 15px; }
.t-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.t-main { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12.5px; }
.warn-text { color: var(--red); }
.status-chip { font-size: 11px; border: 1px solid; border-radius: 10px; padding: 2px 9px; white-space: nowrap; }
.status-chip.big { font-size: 12px; padding: 4px 11px; }
.gate-chip { font-size: 11px; border-radius: 10px; padding: 2px 9px; border: 1px solid rgba(87,214,160,.4); color: var(--green); background: rgba(87,214,160,.08); }
.gate-chip.locked { border-color: rgba(255,107,122,.4); color: var(--red); background: rgba(255,107,122,.08); }
.gate-chip.pending { border-color: rgba(79,195,247,.4); color: #4fc3f7; background: rgba(79,195,247,.08); }
button.sm { font-size: 11px; padding: 4px 9px; }
.t-foot { display: flex; justify-content: space-between; align-items: center; }
.t-acts { display: flex; gap: 8px; }
.empty { padding: 30px; text-align: center; color: var(--muted); }
.modal { position: fixed; inset: 0; background: rgba(4,8,18,.68); z-index: 50; display: flex; justify-content: flex-end; }
.detail-box { width: min(720px, 100%); height: 100%; border-radius: 0; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.d-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.d-head-acts { display: flex; gap: 8px; align-items: center; }
.gate-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border-radius: 10px; padding: 10px 13px; font-size: 12.5px; }
.gate-bar.pass { background: rgba(87,214,160,.09); border: 1px solid rgba(87,214,160,.35); color: var(--green); }
.gate-bar.fail { background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.35); color: var(--red); }
.gate-bar.reviewing { background: rgba(79,195,247,.08); border: 1px solid rgba(79,195,247,.3); color: #4fc3f7; }
.gate-bar.exempt { background: rgba(167,139,250,.08); border: 1px solid rgba(167,139,250,.3); color: var(--purple); }
.block { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; display: flex; flex-direction: column; gap: 11px; }
.block h4 { font-size: 14px; }
.scope-text { font-size: 12.5px; color: var(--muted); }
.item-table { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.item-row { display: grid; grid-template-columns: 1.6fr 80px 2fr auto; align-items: center; gap: 8px; padding: 8px 11px; font-size: 12.5px; background: rgba(13,18,32,.25); }
.item-row + .item-row { border-top: 1px solid var(--border); }
.item-row.issue { background: rgba(255,107,122,.07); }
.item-head { font-size: 11px; color: var(--muted); background: rgba(91,140,255,.08); }
.it-acts { display: flex; gap: 5px; }
.it-acts button { padding: 2px 8px; font-size: 11px; opacity: .75; }
.it-acts button.on { opacity: 1; border-color: var(--green); background: rgba(87,214,160,.15); color: var(--green); }
.it-acts button.danger-btn.on { border-color: var(--red); background: rgba(255,107,122,.15); color: var(--red); }
.it-note input { width: 100%; padding: 5px 8px; font-size: 12px; background: #101731; border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
.block-acts { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
.conclusion-box { border-radius: 9px; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.conclusion-box.passed { background: rgba(87,214,160,.08); border: 1px solid rgba(87,214,160,.3); }
.conclusion-box.failed { background: rgba(255,107,122,.07); border: 1px solid rgba(255,107,122,.3); }
.conclusion-box p { color: var(--muted); font-size: 12.5px; }
.tl-box { border-top: 1px dashed var(--border); padding-top: 12px; }
.tl-box h4 { font-size: 13px; margin-bottom: 10px; }
.timeline { display: flex; flex-direction: column; gap: 10px; }
.tl-item { display: flex; gap: 10px; position: relative; }
.tl-item:not(:last-child)::before { content: ''; position: absolute; left: 13px; top: 28px; bottom: -12px; width: 2px; background: var(--border); }
.tl-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--panel2); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; z-index: 1; flex-shrink: 0; font-size: 13px; }
.tl-body { flex: 1; min-width: 0; }
.tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }
.tl-party { font-size: 10px; color: #4fc3f7; border: 1px solid rgba(79,195,247,.35); background: rgba(79,195,247,.1); border-radius: 9px; padding: 1px 7px; }
.tl-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.tl-body p { font-size: 12px; color: var(--muted); margin-top: 2px; }
.modal-box { width: min(430px, 92vw); margin: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.modal-box label.muted { font-size: 12px; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
.warn-tip { font-size: 12px; color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.3); border-radius: 8px; padding: 7px 10px; }
.acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }
@media (max-width: 720px) { .stat-row { grid-template-columns: repeat(2, 1fr); } .item-row { grid-template-columns: 1fr 70px; } .it-note, .it-acts { grid-column: 1 / -1; } }
</style>
