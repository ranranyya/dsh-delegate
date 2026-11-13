// dsh-delegate — native DSH bundle-configuration page (browser half of the plugin).
//
// This file is the whole operator GUI. It is a *client plugin*, not a standalone
// dashboard and not a Codex surface: it registers the dsh-delegate bundle's
// configuration in the native **Plugins manager** (`plugins.bundle.config`,
// keyed by the bundle's npm package name), so it renders on this bundle's own
// details page inside that manager and disappears when the plugin is disabled.
// Desktop and Web both compose the same client-plugin/module system, so one
// `platform: "web"` client declaration serves both shells.
//
// Contract facts this file is written against (installed
// `@deepseek-ai/dsh-client-ui-plugin-manager` 0.2.1-rc.2,
// `lib/types/client/slot-contract.d.ts`):
//
//   * `plugins.bundle.config` is `kind: 'keyed'`, `scope: 'root'`, keyed by the
//     bundle package name, and is rendered only with `view: 'page'` (the manager's
//     bundle detail page calls `renderSlot(..., { view: 'page' }, { entryKey })`).
//     The slot's `owner` is `{ view }` plus an optional host `form`; this page
//     keeps its own controls and does not use the host form.
//   * `ctx.slots.inject(name, register)` runs `register` once the slot name is
//     declared by its owning entry and disposes the registration when it is not.
//     `ctx.slots.register(options, Component)` returns that disposer.
//   * A slot registration declaring `locale` receives a `t` seat and requires an
//     installed locale face. This page is deliberately Chinese-only and declares
//     no `locale`, so it does not depend on the locale plugin being composed; all
//     operator copy is written here once, in Chinese.
//   * `inject` on a registration is either a plain props object or a
//     `{ hooks, keyedHooks }` face. We return a plain object holding the store, so
//     the component subscribes to the store itself with `useSyncExternalStore`.
//   * A registrant merges the slot contract with `import type` and registers
//     through `ctx.slots`; it never imports the plugin-manager package at
//     runtime. Ordering comes from `dsh.client.inject` in package.json, which
//     names `@deepseek-ai/dsh-client-ui-plugin-manager` so its factory is
//     registered (and its slot declared) before this registration materializes.
//
// Security properties that must survive any edit of this file:
//
//   * No `dangerouslySetInnerHTML` anywhere: model output, diffs and host
//     diagnostics are rendered as text nodes only.
//   * Provider credentials are not entered here. New selections come from DSH's
//     registered provider list, so their existing credential configuration stays
//     inside DSH.
//   * Nothing here submits a task. The GUI controls local MCP access and settings;
//     the MCP host submits. The task panel offers cancel and retry guidance.
//
// React and `react/jsx-runtime` are the only module requests this bundle makes
// beyond `@deepseek-ai/*` platform modules, which is why the native loader can
// resolve every external against its frozen platform table.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  CONNECTIVITY_LAYERS,
  CONVERSATION_POLICY_LABEL,
  EFFORT_LABELS,
  EFFORT_UNSET,
  GRANT_KIND_LABELS,
  ISOLATION_LABELS,
  ISOLATION_MODES,
  KNOWN_EFFORTS,
  LIMITS,
  PERMISSION_DECISION_LABELS,
  PERMISSION_OUTCOME_LABELS,
  PERMISSION_STATE_LABELS,
  REVIEW_STATE_LABELS,
  REVIEW_VERDICT_LABELS,
  SUPPORTED_PROTOCOLS,
  TASK_STATES,
  boundedText,
  changedFiles,
  clone,
  codexMcpDriftText,
  codexTargetView,
  createApi,
  createStore,
  describeCodexOutcome,
  describeError,
  documentFromDraft,
  draftFromSettings,
  duplicateProviderIds,
  exportDocument,
  formatTime,
  grantState,
  isAwaitingPermission,
  isCancellable,
  hasLiveTasks,
  formatDuration,
  hostReviewLine,
  isLiveTask,
  minutesToSeconds,
  monitoringDraftOf,
  monitoringOf,
  pendingPermission,
  permissionSummary,
  precheckDraft,
  precheckMonitoring,
  previewEffective,
  repeatFailureLine,
  secondsToMinutes,
  SELF_CHECK_LABELS,
  taskActivity,
  taskOutcome,
  taskPhaseLabel,
  taskProgress,
  taskStateLabel,
  WAIT_REASON_LABELS,
} from './api.js';
import { injectStyles } from './styles.js';

/** Plugins-manager config slot this page occupies. */
export const PLUGIN_CONFIG_SLOT = 'plugins.bundle.config';

/**
 * Key of this bundle's configuration entry: exactly the bundle's npm package
 * name. The Plugins manager looks the entry up by `pkg.name`, so any other key
 * registers a page that never renders.
 */
export const PLUGIN_BUNDLE_KEY = 'dsh-taskbridge';

/** Required client services: slot registration only. */
export const inject = ['slots'];

/**
 * Register the bundle configuration page on a client context.
 *
 * Split out from {@link apply} so a test can drive it with a fake `ctx` and
 * assert the registration contract (slot name, key, inject face) without a
 * browser.
 * @param {object} ctx - client Cordis context providing `slots`.
 * @param {object} options - `store`.
 * @returns {Function} disposer releasing the registration.
 */
export function registerBundleConfiguration(ctx, options) {
  const store = options.store;
  const injectFace = () => ({ store });
  return ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({
    name: PLUGIN_CONFIG_SLOT,
    key: PLUGIN_BUNDLE_KEY,
    inject: injectFace,
  }, DelegateConfigPage));
}

/**
 * Client plugin body.
 * @param {object} ctx - client Cordis context.
 */
export function apply(ctx) {
  ctx.effect(() => injectStyles(globalThis.document), 'dsh-delegate: settings styles');
  const store = createStore({ api: createApi() });
  ctx.effect(() => () => store.dispose(), 'dsh-delegate: settings store');
  ctx.effect(() => registerBundleConfiguration(ctx, { store }), 'dsh-delegate: bundle configuration');
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object} */
function Badge({ tone = 'off', children }) {
  return <span className={`dshdg-badge dshdg-badge-${tone}`}>{children}</span>;
}

/** @param {object} props @returns {object} */
function Field({ label, hint, htmlFor, children }) {
  return (
    <div className="dshdg-field">
      {label === undefined ? null : <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint === undefined ? null : <span className="dshdg-hint">{hint}</span>}
    </div>
  );
}

/**
 * Integer input bounded by the host validator's limits.
 * @param {object} props - `label`, `value`, `min`, `max`, `onChange`, `hint`, `disabled`.
 * @returns {object} a numeric field.
 */
function IntegerField({ label, value, min, max, onChange, hint, disabled = false, id }) {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={Number.isFinite(Number(value)) ? String(value) : ''}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(raw === '' ? '' : Number(raw));
        }}
      />
    </Field>
  );
}

/**
 * Provider/model/effort selector triple.
 *
 * The effort list is derived from the *selected model's declared* capabilities,
 * never from a global list, so an unsupported combination cannot be produced by
 * the form in the first place. A model that declares no efforts shows only "不指定".
 * @param {object} props - `providers`, `value`, `onChange`, `idPrefix`, `modelCatalog`.
 * @returns {object} three fields.
 */
function SelectionFields(props) {
  const { providers, value, onChange, idPrefix } = props;
  const provider = providers.find((entry) => entry.id === value.providerId) ?? null;
  const models = provider === null ? [] : (provider.models ?? []);
  const model = models.find((entry) => entry.id === value.model) ?? null;
  const efforts = model === null ? [] : (model.efforts ?? []);
  return (
    <div className="dshdg-grid">
      <Field label="提供方" htmlFor={`${idPrefix}-provider`}>
        <select
          id={`${idPrefix}-provider`}
          value={value.providerId ?? ''}
          onChange={(event) => {
            onChange({ providerId: event.target.value === '' ? null : event.target.value, model: null, reasoningEffort: null });
          }}
        >
          <option value="">（未选择）</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name === '' ? entry.id : `${entry.name}（${entry.id}）`}</option>
          ))}
        </select>
      </Field>
      <Field label="模型" htmlFor={`${idPrefix}-model`}>
        <select
          id={`${idPrefix}-model`}
          value={value.model ?? ''}
          disabled={provider === null}
          onChange={(event) => {
            const nextModel = event.target.value === '' ? null : event.target.value;
            const declared = (models.find((entry) => entry.id === nextModel)?.efforts ?? []);
            const keep = value.reasoningEffort === null || declared.includes(value.reasoningEffort)
              ? value.reasoningEffort
              : null;
            onChange({ providerId: value.providerId ?? null, model: nextModel, reasoningEffort: keep });
          }}
        >
          <option value="">（未选择）</option>
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.id}</option>
          ))}
        </select>
      </Field>
      <Field
        label="推理强度"
        htmlFor={`${idPrefix}-effort`}
        hint={model === null
          ? '选择模型后显示该模型声明的推理强度'
          : (efforts.length === 0 ? '该模型未声明推理强度，只能不指定' : '仅列出该模型声明的能力')}
      >
        <select
          id={`${idPrefix}-effort`}
          value={value.reasoningEffort ?? EFFORT_UNSET}
          disabled={model === null || efforts.length === 0}
          onChange={(event) => {
            onChange({ ...value, reasoningEffort: event.target.value === EFFORT_UNSET ? null : event.target.value });
          }}
        >
          <option value={EFFORT_UNSET}>（不指定）</option>
          {efforts.map((effort) => (
            <option key={effort} value={effort}>{`${EFFORT_LABELS[effort] ?? effort}（${effort}）`}</option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/**
 * One connectivity layer row.
 * @param {object} props - `label`, `result`, `name`.
 * @returns {object} a row.
 */
function ConnectivityLayer({ label, name, result }) {
  const ok = result?.ok;
  const tone = ok === true ? 'dshdg-ok' : (ok === false ? 'dshdg-fail' : 'dshdg-unknown');
  const verdict = ok === true ? '通过' : (ok === false ? '未通过' : '未确认');
  const detail = result?.detail ?? null;
  const detailText = detail === null
    ? ''
    : (typeof detail === 'string' ? detail : `${detail.code ?? ''}${detail.message === undefined ? '' : ` · ${detail.message}`}`);
  return (
    <div className="dshdg-layer">
      <span>
        {label}
        {' '}
        <span className={tone}>{verdict}</span>
      </span>
      <span className="dshdg-layer-detail dshdg-mono" data-layer={name}>
        {detailText === '' ? '—' : detailText}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object|null} the notice strip. */
function Notices({ store, notices }) {
  if (notices.length === 0) return null;
  return (
    <div className="dshdg-notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={String(notice.id)} className={`dshdg-notice dshdg-notice-${notice.level}`}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => store.dismissNotice(notice.id)} aria-label="关闭提示">关闭</button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Authorization (rendered above the four areas)
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object} the authorization card. */
function AuthorizationPanel({ store, snapshot }) {
  const enabled = snapshot.status?.delegation?.mode === 'switch'
    ? snapshot.status.delegation.authorized === true
    : snapshot.settings?.delegationEnabled === true;
  const busy = snapshot.loading?.delegationSwitch === true;
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-auth-title">
      <div className="dshdg-row">
        <h3 id="dshdg-auth-title">本机调用授权</h3>
        <span className="dshdg-spacer" />
        <Badge tone={enabled ? 'on' : 'off'}>{enabled ? '已开启' : '已关闭'}</Badge>
      </div>
      <div className="dshdg-row">
        <label className="dshdg-switch" htmlFor="dshdg-delegation-switch">
          <input
            id="dshdg-delegation-switch"
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy || snapshot.status === null}
            onChange={(event) => { void store.setDelegationEnabled(event.target.checked); }}
          />
          允许本机 MCP 调用 DSH 委派
        </label>
        <span className="dshdg-spacer" />
        <span className="dshdg-hint">{busy ? '正在更新…' : (enabled ? '关闭后会拒绝新任务并停止运行中的任务' : '关闭状态会拒绝所有委派请求')}</span>
      </div>
    </section>
  );
}

function LegacyAuthorizationPanel({ store, snapshot }) {
  const [label, setLabel] = useState('codex');
  const [kind, setKind] = useState('task');
  const [workspacePath, setWorkspacePath] = useState('');
  const [ttlSeconds, setTtlSeconds] = useState('');
  const [copied, setCopied] = useState('');
  const posture = snapshot.status?.delegation ?? null;
  const connections = snapshot.connections ?? [];
  const live = connections.filter((entry) => entry.revoked !== true);
  const selected = live.find((entry) => entry.connectionId === snapshot.selectedConnectionId) ?? null;
  const grants = snapshot.grants ?? [];
  const now = Date.now();

  const busy = (key) => snapshot.loading?.[key] === true;
  // The engine reports `{ authorized, reason }`; `authorized` is the only
  // authority. The page never derives authorization from what it displays.
  const authorized = posture?.authorized === true;

  return (
    <section className="dshdg-card" aria-labelledby="dshdg-auth-title">
      <div className="dshdg-row">
        <h3 id="dshdg-auth-title">授权（外部连接）</h3>
        <span className="dshdg-spacer" />
        {posture === null
          ? <Badge tone="off">状态未知</Badge>
          : (authorized
            ? <Badge tone="on">已授权</Badge>
            : <Badge tone="off">默认关闭</Badge>)}
      </div>
      <p className="dshdg-muted">
        委托默认关闭，安装、重启或提到 DeepSeek 都不会自动开启。只有在这里给<strong>宿主签发的连接</strong>授权后，
        MCP 宿主才能提交任务；插件与 MCP 都无法自行授权。授权由服务端校验，界面只是入口。
      </p>
      <div className="dshdg-kv dshdg-mono">
        <dt>执行通道</dt>
        <dd>
          {snapshot.status?.runtime?.executionPlane ?? '—'}
          {snapshot.status?.runtime?.executionPlaneLocalOnly === true ? '（仅本机）' : '（非本机绑定，请确认暴露面）'}
        </dd>
        <dt>本机绑定</dt>
        <dd>{snapshot.status?.runtime?.bind ?? '—'}:{snapshot.status?.runtime?.port ?? '—'}</dd>
        <dt>宿主裁决</dt>
        <dd>{posture === null ? '—' : (authorized ? '当前存在有效授权' : (posture.reason ?? '未授权'))}</dd>
      </div>

      <div className="dshdg-row">
        <Field label="连接显示名" htmlFor="dshdg-conn-label" hint="仅用于你区分连接，不影响权限。">
          <input
            id="dshdg-conn-label"
            type="text"
            value={label}
            maxLength={60}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="dshdg-primary"
          disabled={busy('issueConnection')}
          onClick={() => { void store.issueConnection(label); }}
        >
          {busy('issueConnection') ? '签发中…' : '签发新连接'}
        </button>
      </div>

      {snapshot.token === null ? null : (
        <div className="dshdg-secret-warning">
          <strong>连接令牌只显示这一次</strong>
          <p className="dshdg-muted">
            请立即复制到 MCP 宿主配置（形如 <span className="dshdg-mono">Authorization: Bearer …</span>）。
            令牌仅保存在本页面内存中，不会写入地址栏、日志、localStorage 或 sessionStorage；关闭对话框或刷新后无法再次查看，只能重新签发。
          </p>
          <code className="dshdg-token dshdg-mono">{snapshot.token}</code>
          <div className="dshdg-row">
            <button
              type="button"
              onClick={async () => {
                try {
                  await globalThis.navigator?.clipboard?.writeText(snapshot.token);
                  setCopied('已复制到剪贴板');
                } catch {
                  setCopied('无法访问剪贴板，请手动选中复制');
                }
              }}
            >
              复制令牌
            </button>
            <button type="button" onClick={() => { setCopied(''); store.clearToken(); }}>我已完成，清除显示</button>
            {copied === '' ? null : <span className="dshdg-hint">{copied}</span>}
          </div>
        </div>
      )}

      <div className="dshdg-grid">
        <Field label="选择连接" htmlFor="dshdg-conn-select" hint="授权只能绑定宿主签发的连接身份，不接受手填身份。">
          <select
            id="dshdg-conn-select"
            value={snapshot.selectedConnectionId ?? ''}
            onChange={(event) => { void store.selectConnection(event.target.value === '' ? null : event.target.value); }}
          >
            <option value="">（未选择）</option>
            {live.map((entry) => (
              <option key={entry.connectionId} value={entry.connectionId}>
                {`${entry.label ?? '连接'} · ${entry.connectionId.slice(0, 8)}…`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="授权范围" htmlFor="dshdg-grant-kind">
          <select id="dshdg-grant-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="task">{GRANT_KIND_LABELS.task}</option>
            <option value="session">{GRANT_KIND_LABELS.session}</option>
          </select>
        </Field>
        <Field label="授权工作区（绝对路径）" htmlFor="dshdg-grant-workspace" hint="任务只能改这个目录；隔离方式在执行设置里。">
          <input
            id="dshdg-grant-workspace"
            type="text"
            value={workspacePath}
            placeholder="C:\\work\\project"
            onChange={(event) => setWorkspacePath(event.target.value)}
          />
        </Field>
        <Field
          label="有效期（秒，可留空用默认）"
          htmlFor="dshdg-grant-ttl"
          hint={kind === 'task'
            ? `${LIMITS.taskGrantTtlSecondsMin}–${LIMITS.taskGrantTtlSecondsMax} 秒`
            : `${LIMITS.sessionGrantTtlSecondsMin}–${LIMITS.sessionGrantTtlSecondsMax} 秒`}
        >
          <input
            id="dshdg-grant-ttl"
            type="number"
            min={kind === 'task' ? LIMITS.taskGrantTtlSecondsMin : LIMITS.sessionGrantTtlSecondsMin}
            max={kind === 'task' ? LIMITS.taskGrantTtlSecondsMax : LIMITS.sessionGrantTtlSecondsMax}
            step={1}
            value={ttlSeconds}
            onChange={(event) => setTtlSeconds(event.target.value)}
          />
        </Field>
      </div>

      <div className="dshdg-row">
        <button
          type="button"
          className="dshdg-primary"
          disabled={busy('issueGrant') || snapshot.selectedConnectionId === null}
          onClick={() => {
            void store.issueGrant({
              connectionId: snapshot.selectedConnectionId,
              kind,
              workspacePath,
              ttlSeconds: ttlSeconds === '' ? undefined : Number(ttlSeconds),
            });
          }}
        >
          {busy('issueGrant') ? '签发中…' : (kind === 'task' ? '授权一次任务' : '授权本连接会话')}
        </button>
        <button
          type="button"
          disabled={busy('issueGrant') || snapshot.selectedConnectionId === null}
          onClick={() => { void store.loadGrants(snapshot.selectedConnectionId); }}
        >
          刷新授权
        </button>
        <span className="dshdg-spacer" />
        <button
          type="button"
          className="dshdg-danger"
          disabled={busy('revokeAll')}
          onClick={() => { void store.revokeAll(); }}
        >
          {busy('revokeAll') ? '撤销中…' : '立即全部撤销'}
        </button>
      </div>

      {selected === null ? (
        <p className="dshdg-faint">还没有选择连接。先“签发新连接”，再把令牌配置到 MCP 宿主。</p>
      ) : (
        <div className="dshdg-list">
          <div className="dshdg-item-head">
            <strong>{selected.label ?? '连接'}</strong>
            <span className="dshdg-mono dshdg-faint">{selected.connectionId}</span>
            <span className="dshdg-spacer" />
            <button
              type="button"
              className="dshdg-danger"
              disabled={busy('revokeConnection')}
              onClick={() => { void store.revokeConnection(selected.connectionId); }}
            >
              撤销该连接
            </button>
          </div>
          {grants.length === 0 ? (
            <p className="dshdg-faint">该连接没有未撤销的授权；此时 MCP 提交任务会被拒绝。</p>
          ) : grants.map((grant) => {
            const gstate = grantState(grant, now);
            return (
              <div className="dshdg-item" key={grant.grantId}>
                <div className="dshdg-item-head">
                  <Badge tone={gstate.key === 'live' ? 'on' : 'off'}>{gstate.label}</Badge>
                  <span>{GRANT_KIND_LABELS[grant.kind] ?? grant.kind}</span>
                  <span className="dshdg-mono dshdg-faint">{grant.workspacePath}</span>
                  <span className="dshdg-spacer" />
                  <button
                    type="button"
                    className="dshdg-danger"
                    disabled={busy('revokeGrant') || gstate.key !== 'live'}
                    onClick={() => { void store.revokeGrant(grant.grantId); }}
                  >
                    撤销
                  </button>
                </div>
                <div className="dshdg-kv">
                  <dt>签发</dt>
                  <dd>{formatTime(grant.createdAt)}</dd>
                  <dt>到期</dt>
                  <dd>{formatTime(grant.expiresAt)}</dd>
                  {grant.consumedByTaskId === null || grant.consumedByTaskId === undefined ? null : (
                    <>
                      <dt>用掉于任务</dt>
                      <dd className="dshdg-mono">{grant.consumedByTaskId}</dd>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// API management
// ---------------------------------------------------------------------------

/**
 * One provider profile editor, including its separate credential seam.
 * @param {object} props - `provider`, `store`, `snapshot`, `index`.
 * @returns {object} an editor card.
 */
function ProviderEditor({ provider, store, snapshot, index }) {
  const providerId = provider.id;
  const credential = snapshot.credentials?.[providerId] ?? null;
  // The secret never leaves this component's local state. It is not part of the
  // draft, so it cannot be exported, saved with the document, or restored.
  const [secret, setSecret] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [checkModel, setCheckModel] = useState('');
  const [checkEffort, setCheckEffort] = useState('');
  const busyKey = snapshot.loading?.[`credential:${providerId}`] === true;
  const report = snapshot.connectivity?.[providerId] ?? null;
  const fetched = snapshot.modelCatalog?.[providerId] ?? null;
  const models = provider.models ?? [];

  const editProvider = useCallback((mutate) => {
    store.editDraft((draft) => {
      const target = draft.providers.find((entry) => entry.id === providerId);
      if (target !== undefined) mutate(target);
    });
  }, [store, providerId]);

  const selectedModel = models.find((entry) => entry.id === checkModel) ?? null;

  return (
    <div className="dshdg-item">
      <div className="dshdg-item-head">
        <strong>{provider.name === '' ? `提供方 ${index + 1}` : provider.name}</strong>
        <span className="dshdg-mono dshdg-faint">{provider.id || '（标识未填）'}</span>
        <span className="dshdg-spacer" />
        <button
          type="button"
          className="dshdg-danger"
          disabled={snapshot.dirty !== true}
          title="删除后需要保存才会生效"
          onClick={() => {
            store.editDraft((draft) => {
              draft.providers = draft.providers.filter((entry) => entry.id !== providerId);
            });
          }}
        >
          删除
        </button>
      </div>

      <div className="dshdg-grid">
        <Field label="标识" htmlFor={`dshdg-p${index}-id`} hint="3–40 位小写字母、数字、连字符；保存后用作路由 id。">
          <input
            id={`dshdg-p${index}-id`}
            type="text"
            value={provider.id}
            onChange={(event) => {
              const nextId = event.target.value.trim().toLowerCase();
              store.editDraft((draft) => {
                const target = draft.providers.find((entry) => entry.id === providerId);
                if (target === undefined) return;
                target.id = nextId;
                for (const block of [draft.worker, draft.review]) {
                  if (block?.providerId === providerId) block.providerId = nextId;
                }
              });
            }}
          />
        </Field>
        <Field label="显示名称" htmlFor={`dshdg-p${index}-name`}>
          <input
            id={`dshdg-p${index}-name`}
            type="text"
            value={provider.name}
            onChange={(event) => editProvider((target) => { target.name = event.target.value; })}
          />
        </Field>
        <Field label="协议" htmlFor={`dshdg-p${index}-protocol`}>
          <select
            id={`dshdg-p${index}-protocol`}
            value={provider.protocol}
            onChange={(event) => editProvider((target) => { target.protocol = event.target.value; })}
          >
            {SUPPORTED_PROTOCOLS.map((protocol) => (
              <option key={protocol} value={protocol}>OpenAI 兼容 Chat Completions（{protocol}）</option>
            ))}
          </select>
        </Field>
        <Field label="接口地址" htmlFor={`dshdg-p${index}-baseurl`} hint="http/https，不带账号密码、查询串或片段。">
          <input
            id={`dshdg-p${index}-baseurl`}
            type="text"
            value={provider.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => editProvider((target) => { target.baseUrl = event.target.value; })}
          />
        </Field>
        <Field label="凭据引用名（可选）" htmlFor={`dshdg-p${index}-ref`} hint="复用宿主环境变量/凭据引用；不要填密钥本身。">
          <input
            id={`dshdg-p${index}-ref`}
            type="text"
            value={provider.credentialRef ?? ''}
            placeholder="MY_PROVIDER_API_KEY"
            onChange={(event) => {
              const value = event.target.value.trim();
              editProvider((target) => { target.credentialRef = value === '' ? null : value; });
            }}
          />
        </Field>
      </div>

      <div className="dshdg-card">
        <div className="dshdg-row">
          <h4>密钥（独立通道）</h4>
          <span className="dshdg-spacer" />
          {credential === null || credential.loaded !== true ? (
            <Badge tone="off">未检查</Badge>
          ) : credential.unavailable === true ? (
            <Badge tone="warn">宿主未提供凭据接口</Badge>
          ) : credential.configured === true ? (
            <Badge tone="on">{`已配置${credential.source === undefined ? '' : `（${credential.source}）`}`}</Badge>
          ) : (
            <Badge tone="off">未配置</Badge>
          )}
          <button
            type="button"
            disabled={busyKey}
            onClick={() => { void store.credentialStatus(providerId); }}
          >
            检查状态
          </button>
        </div>
        <p className="dshdg-hint">
          密钥值不会进入设置文档、导出文本、任务历史或日志，也不会回显。保存成功后输入框会被清空。
        </p>
        {credential?.unavailable === true
          ? <p className="dshdg-fail">{credential.reason}</p>
          : null}
        <div className="dshdg-row">
          <input
            id={`dshdg-p${index}-secret`}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-label={`${provider.name || provider.id} 的密钥`}
            placeholder={credential?.configured === true ? '已配置；输入新值可覆盖' : '粘贴密钥'}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
          <button
            type="button"
            className="dshdg-primary"
            disabled={busyKey || secret.trim() === ''}
            onClick={async () => {
              const result = await store.setCredential(providerId, secret);
              // Clear on success only: a failed save keeps the operator's paste so
              // they can retry, and nothing has been stored either way.
              if (result.ok === true) setSecret('');
            }}
          >
            {busyKey ? '保存中…' : '保存密钥'}
          </button>
          {confirmRemove ? (
            <>
              <button
                type="button"
                className="dshdg-danger"
                disabled={busyKey}
                onClick={async () => {
                  setConfirmRemove(false);
                  await store.unsetCredential(providerId);
                }}
              >
                确认清除
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)}>取消</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)}>清除密钥</button>
          )}
        </div>
      </div>

      <div className="dshdg-card">
        <div className="dshdg-row">
          <h4>模型与推理强度</h4>
          <span className="dshdg-spacer" />
          <button
            type="button"
            disabled={snapshot.loading?.[`models:${providerId}`] === true}
            onClick={async () => {
              const result = await store.fetchModels(providerId);
              if (result.ok === true && Array.isArray(result.models)) store.mergeModelsIntoDraft(providerId, result.models);
            }}
          >
            {snapshot.loading?.[`models:${providerId}`] === true ? '获取中…' : '从提供方获取模型'}
          </button>
        </div>
        {fetched === null ? null : (
          <p className={fetched.discovery?.failed === true ? 'dshdg-fail' : 'dshdg-hint'}>
            {fetched.source === 'catalog'
              ? '宿主尚未提供从提供方获取模型的接口，以下结果来自宿主模型目录（不是远程模型列表）。'
              : fetched.discovery?.failed === true
                ? `未能从提供方获取模型：${describeError(fetched.error ?? fetched.discovery)} 已保留现有手工配置，可继续使用。`
                : `已从提供方接口获取 ${fetched.models.length} 个模型（${formatTime(fetched.fetchedAt)}）。`}
            {fetched.source === 'catalog' || fetched.discovery?.failed === true
              ? ''
              : ' 模型列表不代表推理能力：导入后仍需为每个模型勾选其实际支持的推理强度。'}
          </p>
        )}
        {models.length === 0 ? (
          <p className="dshdg-faint">还没有模型。可以自动获取，也可以手动添加。</p>
        ) : models.map((model, modelIndex) => (
          <div className="dshdg-item" key={`${model.id}-${String(modelIndex)}`}>
            <div className="dshdg-item-head">
              <input
                type="text"
                aria-label={`模型 ${modelIndex + 1} 的 ID`}
                value={model.id}
                onChange={(event) => {
                  editProvider((target) => {
                    const found = target.models[modelIndex];
                    if (found !== undefined) found.id = event.target.value.trim();
                  });
                }}
              />
              <span className="dshdg-spacer" />
              <button
                type="button"
                className="dshdg-danger"
                onClick={() => {
                  store.editDraft((draft) => {
                    const target = draft.providers.find((entry) => entry.id === providerId);
                    if (target === undefined) return;
                    const removed = target.models[modelIndex];
                    target.models.splice(modelIndex, 1);
                    // A selection pointing at the removed model would be
                    // unroutable; clear it here so the operator sees the
                    // consequence instead of saving an invalid pair.
                    if (removed !== undefined) {
                      for (const block of [draft.worker, draft.review]) {
                        if (block?.providerId === providerId && block?.model === removed.id) {
                          block.model = null;
                          block.reasoningEffort = null;
                        }
                      }
                    }
                  });
                }}
              >
                删除模型
              </button>
            </div>
            <div className="dshdg-check" role="group" aria-label={`模型 ${model.id} 支持的推理强度`}>
              {KNOWN_EFFORTS.map((effort) => (
                <label key={effort}>
                  <input
                    type="checkbox"
                    checked={(model.efforts ?? []).includes(effort)}
                    onChange={(event) => {
                      editProvider((target) => {
                        const found = target.models[modelIndex];
                        if (found === undefined) return;
                        const next = new Set(found.efforts ?? []);
                        if (event.target.checked) next.add(effort);
                        else next.delete(effort);
                        found.efforts = KNOWN_EFFORTS.filter((id) => next.has(id));
                      });
                    }}
                  />
                  {EFFORT_LABELS[effort]}（{effort}）
                </label>
              ))}
            </div>
          </div>
        ))}
        <div className="dshdg-row">
          <button
            type="button"
            onClick={() => {
              editProvider((target) => { target.models.push({ id: '', efforts: [] }); });
            }}
          >
            手动添加模型
          </button>
        </div>
      </div>

      <div className="dshdg-card">
        <div className="dshdg-row">
          <h4>连通性检查</h4>
          <span className="dshdg-spacer" />
          <select aria-label="检查用模型" value={checkModel} onChange={(event) => { setCheckModel(event.target.value); setCheckEffort(''); }}>
            <option value="">（用执行设置的模型）</option>
            {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
          </select>
          <select
            aria-label="检查用推理强度"
            value={checkEffort}
            disabled={selectedModel === null || (selectedModel.efforts ?? []).length === 0}
            onChange={(event) => setCheckEffort(event.target.value)}
          >
            <option value="">（不指定）</option>
            {(selectedModel?.efforts ?? []).map((effort) => (
              <option key={effort} value={effort}>{EFFORT_LABELS[effort] ?? effort}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={snapshot.loading?.[`connectivity:${providerId}`] === true}
            onClick={() => {
              void store.checkConnectivity({
                providerId,
                ...(checkModel === '' ? {} : { model: checkModel }),
                ...(checkEffort === '' ? {} : { reasoningEffort: checkEffort }),
              });
            }}
          >
            {snapshot.loading?.[`connectivity:${providerId}`] === true ? '检查中…' : '开始检查'}
          </button>
        </div>
        <p className="dshdg-hint">四层分别判定：地址可达、认证可用、目录可读、模型真的回了话。任何一层未通过都不会显示成“连通”。</p>
        {report === null ? <p className="dshdg-faint">尚未检查。</p> : (
          <div className="dshdg-layers">
            {CONNECTIVITY_LAYERS.map((layer) => (
              <ConnectivityLayer
                key={layer.key}
                name={layer.key}
                label={layer.label}
                result={report[layer.key] ?? null}
              />
            ))}
            {report.modelResponse?.response?.reasoningOnly === true
              ? <p className="dshdg-hint">模型只返回了推理内容（reasoning-only），已按协议视为有效响应。</p>
              : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** @param {object} props @returns {object} the API management panel. */
function ProvidersPanel({ store, snapshot }) {
  const providers = snapshot.draft?.providers ?? [];
  const selectedIds = new Set(providers.map((provider) => provider.id));
  const available = (snapshot.nativeProviders ?? []).filter((provider) => !selectedIds.has(provider.id));
  const [candidateId, setCandidateId] = useState('');
  const nativeProviders = snapshot.nativeProviders ?? [];

  function isUsed(id) {
    const draft = snapshot.draft ?? {};
    const selections = [draft.worker, draft.review, ...(draft.presets ?? []).flatMap((preset) => [preset.worker, preset.review])];
    for (const block of Object.values(draft.projectOverrides ?? {})) {
      selections.push(block?.worker, block?.review);
    }
    return selections.some((selection) => selection?.providerId === id);
  }

  return (
    <div className="dshdg-panel">
      <div className="dshdg-row">
        <Field label="DSH 已启用的接口" htmlFor="dshdg-native-provider">
          <select id="dshdg-native-provider" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}>
            <option value="">（选择已有接口）</option>
            {available.map((provider) => <option key={provider.id} value={provider.id}>{`${provider.name} (${provider.id})`}</option>)}
          </select>
        </Field>
        <button
          type="button"
          className="dshdg-primary"
          disabled={candidateId === ''}
          onClick={() => {
            const provider = nativeProviders.find((entry) => entry.id === candidateId);
            if (provider === undefined) return;
            store.editDraft((draft) => {
              if (draft.providers.some((entry) => entry.id === provider.id)) return;
              draft.providers.push({
                id: provider.id,
                name: provider.name,
                source: 'native',
                protocol: null,
                baseUrl: null,
                credentialRef: null,
                models: (provider.models ?? []).map((model) => ({ ...model, efforts: [...(model.efforts ?? [])] })),
              });
            });
            setCandidateId('');
          }}
        >
          添加所选接口
        </button>
        <button type="button" disabled={snapshot.loading?.nativeProviders === true} onClick={() => { void store.loadNativeProviders(); }}>
          {snapshot.loading?.nativeProviders === true ? '刷新中…' : '刷新接口列表'}
        </button>
      </div>
      {snapshot.nativeProvidersError ? <p className="dshdg-fail">{snapshot.nativeProvidersError}</p> : null}
      {nativeProviders.length === 0 ? <p className="dshdg-muted">DSH 当前没有可选的已启用接口。先在 DSH 的模型设置中配置并启用接口。</p> : null}
      {providers.length === 0 ? <p className="dshdg-muted">尚未选择委派可用的接口。</p> : null}
      {providers.map((provider) => {
        const current = nativeProviders.find((entry) => entry.id === provider.id);
        const legacy = provider.source !== 'native';
        const used = isUsed(provider.id);
        return (
          <div className="dshdg-item" key={provider.id}>
            <div className="dshdg-item-head">
              <strong>{provider.name}</strong>
              <span className="dshdg-mono dshdg-faint">{provider.id}</span>
              <Badge tone={legacy ? 'warn' : 'on'}>{legacy ? '旧版自定义接口' : 'DSH 接口'}</Badge>
              <span className="dshdg-spacer" />
              {current !== undefined && !legacy ? (
                <button
                  type="button"
                  disabled={snapshot.loading?.nativeProviders === true || (current.models ?? []).length === 0}
                  onClick={() => store.editDraft((draft) => {
                    const target = draft.providers.find((entry) => entry.id === provider.id);
                    if (target === undefined) return;
                    target.name = current.name;
                    target.models = current.models.map((model) => ({ ...model, efforts: [...(model.efforts ?? [])] }));
                  })}
                >
                  同步模型
                </button>
              ) : null}
              <button
                type="button"
                className="dshdg-danger"
                disabled={used}
                title={used ? '先将执行、审查和预设中的该接口改为其他接口' : undefined}
                onClick={() => store.editDraft((draft) => { draft.providers = draft.providers.filter((entry) => entry.id !== provider.id); })}
              >
                移除
              </button>
            </div>
            {legacy ? <p className="dshdg-hint">此接口来自旧版插件配置。新接口请从上方 DSH 列表选择。</p> : null}
            {current?.error ? <p className="dshdg-fail">{current.error}</p> : null}
            <div className="dshdg-list">
              {(current?.models ?? provider.models ?? []).map((model) => (
                <div className="dshdg-item-head" key={model.id}>
                  <span className="dshdg-mono">{model.id}</span>
                  <span className="dshdg-spacer" />
                  <span className="dshdg-hint">{(model.efforts ?? []).map((effort) => EFFORT_LABELS[effort] ?? effort).join('、') || '未声明思考强度'}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LegacyProvidersPanel({ store, snapshot }) {
  const providers = snapshot.draft?.providers ?? [];
  const duplicates = duplicateProviderIds(snapshot.draft);
  const [nextId, setNextId] = useState('');

  return (
    <div className="dshdg-panel">
      {duplicates.length > 0 ? (
        <p className="dshdg-fail">{`提供方标识重复：${duplicates.join('、')}`}</p>
      ) : null}
      {providers.length === 0 ? (
        <p className="dshdg-muted">还没有接口配置。至少添加一个 OpenAI 兼容提供方，才能选择模型。</p>
      ) : providers.map((provider, index) => (
        <ProviderEditor
          key={`${provider.id}-${String(index)}`}
          provider={provider}
          store={store}
          snapshot={snapshot}
          index={index}
        />
      ))}
      <div className="dshdg-row">
        <input
          type="text"
          aria-label="新提供方标识"
          placeholder="新提供方标识，例如 deepseek-relay"
          value={nextId}
          onChange={(event) => setNextId(event.target.value)}
        />
        <button
          type="button"
          className="dshdg-primary"
          disabled={providers.length >= LIMITS.providers}
          onClick={() => {
            const id = nextId.trim().toLowerCase();
            if (id === '') return;
            store.editDraft((draft) => {
              draft.providers.push({
                id,
                name: id,
                protocol: SUPPORTED_PROTOCOLS[0],
                baseUrl: '',
                credentialRef: null,
                models: [],
              });
            });
            setNextId('');
          }}
        >
          添加提供方
        </button>
        <span className="dshdg-hint">{`最多 ${LIMITS.providers} 个`}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution settings
// ---------------------------------------------------------------------------

/**
 * Read-only view of the configuration a job would actually use.
 * @param {object} props - `label`, `effective`, `note`.
 * @returns {object} a description list.
 */
function EffectiveSummary({ label, effective, note }) {
  const worker = effective?.worker ?? {};
  const review = effective?.review ?? {};
  return (
    <div className="dshdg-card">
      <h4>{label}</h4>
      <dl className="dshdg-kv">
        <dt>执行提供方</dt>
        <dd className="dshdg-mono">{worker.providerId ?? worker.providerRoute ?? '（未配置）'}</dd>
        <dt>执行模型</dt>
        <dd className="dshdg-mono">{worker.model ?? '（未配置）'}</dd>
        <dt>执行推理强度</dt>
        <dd className="dshdg-mono">{worker.reasoningEffort ?? '（不指定）'}</dd>
        <dt>超时</dt>
        <dd>{worker.timeoutSeconds === undefined ? '—' : `${worker.timeoutSeconds} 秒`}</dd>
        <dt>最大并发</dt>
        <dd>{worker.maxParallelism ?? '—'}</dd>
        <dt>工作区隔离</dt>
        <dd>{ISOLATION_LABELS[worker.isolation] ?? worker.isolation ?? '—'}</dd>
        <dt>对话</dt>
        <dd>{CONVERSATION_POLICY_LABEL}</dd>
        <dt>附加审查</dt>
        <dd>
          {review.enabled === true
            ? `开启 · ${review.providerId ?? '（未配置）'} / ${review.model ?? '（未配置）'} / ${review.reasoningEffort ?? '不指定'}`
            : '关闭'}
        </dd>
        <dt>静默监控</dt>
        <dd>
          {effective?.monitoring === null || effective?.monitoring === undefined
            ? '未采集到'
            : `自检 ${formatDuration(effective.monitoring.selfCheckSeconds * 1000)} · 提醒 ${formatDuration(effective.monitoring.attentionSeconds * 1000)}`}
        </dd>
      </dl>
      {note === undefined ? null : <p className="dshdg-hint">{note}</p>}
    </div>
  );
}

/**
 * Presets, non-secret export and project overrides.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the sharing card.
 */
function PresetsCard({ store, snapshot }) {
  const draft = snapshot.draft;
  const presets = draft?.presets ?? [];
  const overrides = draft?.projectOverrides ?? {};
  const [presetName, setPresetName] = useState('');
  const [presetId, setPresetId] = useState('');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [exportCopied, setExportCopied] = useState('');
  const [overridePath, setOverridePath] = useState('');
  const [overrideJson, setOverrideJson] = useState('');
  const [overrideError, setOverrideError] = useState('');
  const [editingPath, setEditingPath] = useState('');

  const exportText = useMemo(() => (draft === null ? '' : exportDocument(draft)), [draft]);

  return (
    <div className="dshdg-card">
      <h4>预设、导出与项目覆盖</h4>
      <p className="dshdg-hint">
        预设只包含执行/审查组合；导出内容全部是非敏感配置，任何密钥都不会出现（密钥只存在宿主的凭据存储里）。
        正在运行的任务保留它自己的生效快照，之后的修改不会改写历史。
      </p>

      <div className="dshdg-row">
        <input
          type="text"
          aria-label="预设名称"
          placeholder="预设标识，例如 fast-local"
          value={presetId}
          onChange={(event) => setPresetId(event.target.value.trim().toLowerCase())}
        />
        <input
          type="text"
          aria-label="预设显示名"
          placeholder="显示名"
          value={presetName}
          onChange={(event) => setPresetName(event.target.value)}
        />
        <button
          type="button"
          disabled={presetId === ''}
          onClick={() => {
            store.editDraft((current) => {
              const existing = current.presets.find((entry) => entry.id === presetId);
              const snapshotWorker = clone(current.worker);
              const snapshotReview = current.review?.enabled === true ? clone(current.review) : null;
              if (existing === undefined) {
                current.presets.push({
                  id: presetId,
                  name: presetName === '' ? presetId : presetName,
                  worker: snapshotWorker,
                  ...(snapshotReview === null ? {} : { review: snapshotReview }),
                });
              } else {
                existing.name = presetName === '' ? existing.name : presetName;
                existing.worker = snapshotWorker;
                existing.review = snapshotReview;
              }
            });
            setPresetId('');
            setPresetName('');
          }}
        >
          用当前设置保存预设
        </button>
      </div>

      {presets.length === 0 ? <p className="dshdg-faint">还没有预设。</p> : (
        <div className="dshdg-list">
          {presets.map((preset) => (
            <div className="dshdg-item" key={preset.id}>
              <div className="dshdg-item-head">
                <strong>{preset.name}</strong>
                <span className="dshdg-mono dshdg-faint">{preset.id}</span>
                <span className="dshdg-spacer" />
                <button
                  type="button"
                  onClick={() => {
                    store.editDraft((current) => {
                      if (preset.worker !== null && preset.worker !== undefined) current.worker = { ...preset.worker };
                      if (preset.review !== null && preset.review !== undefined) current.review = { ...preset.review };
                    });
                  }}
                >
                  应用到草稿
                </button>
                <button
                  type="button"
                  className="dshdg-danger"
                  onClick={() => {
                    store.editDraft((current) => {
                      current.presets = current.presets.filter((entry) => entry.id !== preset.id);
                    });
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Field label="导出（非敏感）" htmlFor="dshdg-export" hint="复制这段文本即可备份或在另一台机器恢复。">
        <textarea id="dshdg-export" readOnly rows={6} value={exportText} />
      </Field>
      <div className="dshdg-row">
        <button
          type="button"
          onClick={async () => {
            try {
              await globalThis.navigator?.clipboard?.writeText(exportText);
              setExportCopied('已复制');
            } catch {
              setExportCopied('无法访问剪贴板，请手动复制');
            }
          }}
        >
          复制导出内容
        </button>
        {exportCopied === '' ? null : <span className="dshdg-hint">{exportCopied}</span>}
        <span className="dshdg-spacer" />
        <button
          type="button"
          onClick={async () => {
            try {
              const text = await globalThis.navigator?.clipboard?.readText?.();
              if (typeof text === 'string') setImportText(text);
            } catch {
              setExportCopied('无法访问剪贴板，请手动粘贴');
            }
          }}
        >
          从剪贴板粘贴
        </button>
      </div>

      <Field
        label="导入（覆盖草稿，保存后才生效）"
        htmlFor="dshdg-import"
        hint="只接受本插件导出的非敏感文档；包含密钥的字段会被宿主拒绝。"
      >
        <textarea
          id="dshdg-import"
          rows={6}
          value={importText}
          onChange={(event) => { setImportText(event.target.value); setImportError(''); }}
        />
      </Field>
      <div className="dshdg-row">
        <button
          type="button"
          onClick={() => {
            try {
              const parsed = JSON.parse(importText);
              const next = draftFromSettings(parsed);
              store.editDraft((current) => {
                current.providers = next.providers;
                current.worker = next.worker;
                current.review = next.review;
                current.authorization = next.authorization;
                current.projectOverrides = next.projectOverrides;
                current.presets = next.presets;
              });
              setImportError('');
            } catch (error) {
              setImportError(`无法解析：${String(error?.message ?? error).slice(0, 160)}`);
            }
          }}
          disabled={importText.trim() === ''}
        >
          解析并应用到草稿
        </button>
        {importError === '' ? null : <span className="dshdg-fail">{importError}</span>}
      </div>

      <h4>项目覆盖</h4>
      <p className="dshdg-hint">为某个绝对路径单独指定执行/审查覆盖；任务生效值会显示实际用了哪一层。</p>
      {Object.keys(overrides).length === 0 ? <p className="dshdg-faint">还没有项目覆盖。</p> : (
        <div className="dshdg-list">
          {Object.entries(overrides).map(([path, block]) => (
            <div className="dshdg-item" key={path}>
              <div className="dshdg-item-head">
                <span className="dshdg-mono">{path}</span>
                <span className="dshdg-spacer" />
                <button
                  type="button"
                  onClick={() => {
                    setEditingPath(path);
                    setOverridePath(path);
                    setOverrideJson(`${JSON.stringify(block, null, 2)}\n`);
                    setOverrideError('');
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="dshdg-danger"
                  onClick={() => {
                    store.editDraft((current) => {
                      const copy = { ...current.projectOverrides };
                      delete copy[path];
                      current.projectOverrides = copy;
                    });
                    if (editingPath === path) setEditingPath('');
                  }}
                >
                  删除
                </button>
              </div>
              <pre className="dshdg-pre">{boundedText(block, 4000)}</pre>
            </div>
          ))}
        </div>
      )}
      <Field
        label={editingPath === '' ? '新增覆盖：绝对路径' : `编辑覆盖：${editingPath}`}
        htmlFor="dshdg-override-path"
      >
        <input
          id="dshdg-override-path"
          type="text"
          value={overridePath}
          readOnly={editingPath !== ''}
          placeholder="C:\\work\\project"
          onChange={(event) => setOverridePath(event.target.value)}
        />
      </Field>
      <Field
        label={`覆盖内容（JSON，仅允许 worker / review）`}
        htmlFor="dshdg-override-json"
        hint={'例如 {"worker":{"model":"deepseek-chat","reasoningEffort":"high"},"review":{"enabled":false}}'}
      >
        <textarea
          id="dshdg-override-json"
          rows={5}
          value={overrideJson}
          onChange={(event) => { setOverrideJson(event.target.value); setOverrideError(''); }}
        />
      </Field>
      <div className="dshdg-row">
        <button
          type="button"
          disabled={overridePath.trim() === ''}
          onClick={() => {
            let parsed;
            try {
              parsed = overrideJson.trim() === '' ? {} : JSON.parse(overrideJson);
            } catch (error) {
              setOverrideError(`无法解析：${String(error?.message ?? error).slice(0, 160)}`);
              return;
            }
            const unknown = Object.keys(parsed).filter((key) => key !== 'worker' && key !== 'review');
            if (unknown.length > 0) {
              setOverrideError(`不支持的字段：${unknown.join('、')}`);
              return;
            }
            setOverrideError('');
            const path = overridePath.trim().replace(/[\\/]+$/, '');
            store.editDraft((current) => {
              const copy = { ...current.projectOverrides };
              if (editingPath !== '' && editingPath !== path) delete copy[editingPath];
              copy[path] = parsed;
              current.projectOverrides = copy;
            });
            setEditingPath('');
            setOverrideJson('');
            setOverridePath('');
          }}
        >
          {editingPath === '' ? '添加覆盖' : '保存覆盖'}
        </button>
        {editingPath === '' ? null : (
          <button type="button" onClick={() => { setEditingPath(''); setOverrideJson(''); setOverridePath(''); setOverrideError(''); }}>
            取消编辑
          </button>
        )}
        {overrideError === '' ? null : <span className="dshdg-fail">{overrideError}</span>}
      </div>
    </div>
  );
}

/**
 * Advanced monitoring controls for a running task's silence.
 *
 * What this card deliberately does NOT do: it does not submit work, does not read a
 * task, does not call a model, and does not create a monitoring process of its own.
 * It edits two numbers and, on the operator's click, sends them to the one narrow
 * authenticated route. Everything it says about the behaviour is a statement about
 * the engine, not a control here.
 *
 * Units: the operator thinks in minutes, the document stores whole seconds. Each
 * field converts on the way in and out (`minutesToSeconds` / `secondsToMinutes`), so a
 * stored value of 300 s shows as 5 and a value of 90 s shows as 1.5 rather than being
 * rounded into a different setting.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the monitoring card.
 */
function MonitoringCard({ store, snapshot }) {
  const draft = snapshot.draft;
  // The RAW block is what the inputs display and what the save validates. Binding the
  // inputs to the display-normalized block instead would make a cleared field
  // immediately re-render as the documented default, hiding the edit.
  const raw = monitoringDraftOf(draft);
  const saved = monitoringOf(snapshot.settings);
  const [saving, setSaving] = useState(false);
  const problems = precheckMonitoring(raw);
  const dirty = raw.selfCheckSeconds !== saved.selfCheckSeconds
    || raw.attentionSeconds !== saved.attentionSeconds
    || raw.repeatFailureThreshold !== saved.repeatFailureThreshold;

  /**
   * Write one field, converting minutes back to the stored unit.
   *
   * The block is spread from the RAW draft, not from `monitoringOf`: normalizing here
   * would rewrite the operator's other half-typed fields (for example a cleared count)
   * back to their defaults on every keystroke.
   * @param {'selfCheckSeconds' | 'attentionSeconds'} field - target field.
   * @param {unknown} rawMinutes - operator input, in minutes.
   * @returns {void}
   */
  const edit = (field, rawMinutes) => {
    store.editDraft((current) => {
      current.monitoring = { ...monitoringDraftOf(current), [field]: minutesToSeconds(rawMinutes) };
    });
  };

  /**
   * Write the repeated-failure count. A blank field becomes `''`, which the precheck
   * reports rather than turning into an accidental default.
   * @param {unknown} value - operator input, a count.
   * @returns {void}
   */
  const editFailureCount = (value) => {
    store.editDraft((current) => {
      current.monitoring = {
        ...monitoringDraftOf(current),
        repeatFailureThreshold: value === '' ? '' : Number(value),
      };
    });
  };

  return (
    <div className="dshdg-card" data-dshdg-monitoring="">
      <h4>进阶：静默监控间隔</h4>
      <p className="dshdg-hint">
        任务长时间没有新输出时，插件自己会看一眼执行器还在不在（程序自检），再过一段时间才提醒你。
        <strong>这些检查完全在本机进行，不会调用任何大模型，也不消耗 token。</strong>
      </p>
      <div className="dshdg-grid">
        <Field
          label="程序自检间隔（分钟）"
          htmlFor="dshdg-monitoring-selfcheck"
          hint={`${LIMITS.selfCheckSecondsMin / 60}–${LIMITS.selfCheckSecondsMax / 60} 分钟；存成整秒（当前 ${raw.selfCheckSeconds === '' ? '未填' : `${raw.selfCheckSeconds} 秒`}）`}
        >
          <input
            id="dshdg-monitoring-selfcheck"
            type="number"
            inputMode="decimal"
            min={LIMITS.selfCheckSecondsMin / 60}
            max={LIMITS.selfCheckSecondsMax / 60}
            step={0.5}
            value={String(Number.isFinite(secondsToMinutes(raw.selfCheckSeconds)) ? secondsToMinutes(raw.selfCheckSeconds) : '')}
            onChange={(event) => {
              const value = event.target.value;
              edit('selfCheckSeconds', value === '' ? '' : value);
            }}
          />
        </Field>
        <Field
          label="提醒你的间隔（分钟）"
          htmlFor="dshdg-monitoring-attention"
          hint={`${LIMITS.attentionSecondsMin / 60}–${LIMITS.attentionSecondsMax / 60} 分钟，且必须大于自检间隔；存成整秒（当前 ${raw.attentionSeconds === '' ? '未填' : `${raw.attentionSeconds} 秒`}）`}
        >
          <input
            id="dshdg-monitoring-attention"
            type="number"
            inputMode="decimal"
            min={LIMITS.attentionSecondsMin / 60}
            max={LIMITS.attentionSecondsMax / 60}
            step={0.5}
            value={String(Number.isFinite(secondsToMinutes(raw.attentionSeconds)) ? secondsToMinutes(raw.attentionSeconds) : '')}
            onChange={(event) => {
              const value = event.target.value;
              edit('attentionSeconds', value === '' ? '' : value);
            }}
          />
        </Field>
        <Field
          label="重复失败提醒（次）"
          htmlFor="dshdg-monitoring-repeat"
          hint={`同一工具、同一操作、同一失败连续这么多次时提醒一次；${LIMITS.repeatFailureThresholdMin} 表示关闭（当前 ${raw.repeatFailureThreshold === '' ? '未填' : `${raw.repeatFailureThreshold} 次`}）`}
        >
          <input
            id="dshdg-monitoring-repeat"
            type="number"
            inputMode="numeric"
            min={LIMITS.repeatFailureThresholdMin}
            max={LIMITS.repeatFailureThresholdMax}
            step={1}
            value={String(raw.repeatFailureThreshold)}
            onChange={(event) => { editFailureCount(event.target.value); }}
          />
        </Field>
      </div>
      {problems.length === 0 ? null : <p className="dshdg-fail">{problems.join('；')}</p>}
      <ul className="dshdg-hint">
        <li>「没有新进展」本身不等于失败：插件不会因为安静、也不会因为单个工具跑得久就判定任务失败。</li>
        <li>只有确实没有进展、并且超过「提醒你的间隔」之后，才会把这件事报告给派工方。</li>
        <li>重复失败提醒与上面两个间隔<strong>互相独立</strong>：它数的是同一操作连续失败了几次，而不是安静了多久，所以正在忙碌地反复失败也会被提醒。它只提醒一次，不会自动取消任务、更换模型或改动超时。</li>
        <li>修改只影响<strong>之后新提交</strong>的任务；已经运行的任务保留它开始时的那份间隔快照。</li>
        <li>程序自检只读取本机已有的事实（任务是否还在、当前阶段、有没有待决定的调用、正在跑哪个工具），不读取代码差异，也不会读取你的文件内容。</li>
      </ul>
      <div className="dshdg-row">
        <button
          type="button"
          disabled={!dirty || saving || snapshot.loading?.monitoring === true || problems.length > 0}
          onClick={async () => {
            setSaving(true);
            try {
              // Send exactly what was validated. The button is disabled while
              // `problems` is non-empty, so this is a well-formed block by construction.
              await store.saveMonitoring(monitoringDraftOf(draft));
            } finally {
              setSaving(false);
            }
          }}
        >
          {snapshot.loading?.monitoring === true || saving ? '保存中…' : '只保存监控间隔'}
        </button>
        <span className="dshdg-hint">
          {dirty ? '与已保存的值不同。' : `已保存：自检 ${saved.selfCheckSeconds} 秒，提醒 ${saved.attentionSeconds} 秒。`}
        </span>
      </div>
      <p className="dshdg-hint">
        也可以点页面底部的「保存设置」一起保存；保存的是同一个设置文档。
      </p>
    </div>
  );
}

/** @param {object} props @returns {object} the execution settings panel. */
function ExecutionPanel({ store, snapshot }) {
  const draft = snapshot.draft;
  const providers = draft?.providers ?? [];
  const worker = draft?.worker ?? {};
  // There is no conversation-mode control any more: the policy is per submission
  // (new by default, continue only the task named by `continueFromTaskId`), so the
  // panel states it instead of offering a setting that no longer exists.
  // Global preview only: which project a task will run in is decided at submit
  // time, so previewing against an arbitrary override key would be a guess.
  const preview = draft === null ? null : previewEffective(draft, null);
  const served = snapshot.catalog?.effective ?? null;
  if (draft === null) return <p className="dshdg-faint">正在读取设置…</p>;
  return (
    <div className="dshdg-panel">
      <SelectionFields
        providers={providers}
        idPrefix="dshdg-worker"
        value={{ providerId: worker.providerId ?? null, model: worker.model ?? null, reasoningEffort: worker.reasoningEffort ?? null }}
        onChange={(next) => {
          store.editDraft((current) => {
            current.worker.providerId = next.providerId;
            current.worker.model = next.model;
            current.worker.reasoningEffort = next.reasoningEffort;
          });
        }}
      />
      <div className="dshdg-grid">
        <IntegerField
          id="dshdg-worker-timeout"
          label="超时（秒）"
          value={worker.timeoutSeconds}
          min={LIMITS.timeoutSecondsMin}
          max={LIMITS.timeoutSecondsMax}
          hint={`${LIMITS.timeoutSecondsMin}–${LIMITS.timeoutSecondsMax}`}
          onChange={(value) => {
            store.editDraft((current) => { current.worker.timeoutSeconds = value; });
          }}
        />
        <IntegerField
          id="dshdg-worker-parallelism"
          label="最大并发"
          value={worker.maxParallelism}
          min={LIMITS.maxParallelismMin}
          max={LIMITS.maxParallelismMax}
          hint={`${LIMITS.maxParallelismMin}–${LIMITS.maxParallelismMax}，超出会被拒绝而不是自动调整`}
          onChange={(value) => {
            store.editDraft((current) => { current.worker.maxParallelism = value; });
          }}
        />
        <Field label="工作区隔离" htmlFor="dshdg-worker-isolation" hint="默认独立工作树；共享工作区需要你明确选择。">
          <select
            id="dshdg-worker-isolation"
            value={worker.isolation ?? ISOLATION_MODES[0]}
            onChange={(event) => {
              store.editDraft((current) => { current.worker.isolation = event.target.value; });
            }}
          >
            {ISOLATION_MODES.map((mode) => (
              <option key={mode} value={mode}>{ISOLATION_LABELS[mode]}</option>
            ))}
          </select>
        </Field>
        <Field
          label="对话"
          htmlFor="dshdg-conversation-policy"
          hint="固定的按任务策略：每个新提交在执行目录对应的 Workspace 里新开一条会话；只有显式带 continueFromTaskId 的跟进任务才续接那一条会话。"
        >
          <p id="dshdg-conversation-policy" className="dshdg-hint">
            {CONVERSATION_POLICY_LABEL}
          </p>
        </Field>
      </div>
      <p className="dshdg-hint">
        不会自动回退到别的模型，也不会隐式使用 Harness 默认模型：选中的组合不可路由时任务直接拒绝。
      </p>
      <p className="dshdg-hint">
        目录级的「复用上一对话」设置已移除：它曾经让同目录的第二个任务自动接续上一次会话，现在不会发生。
        需要续接时由派工方在 <code>delegate_submit</code> 里带上 <code>continueFromTaskId</code>，
        指向要继续的那条任务历史；隔离工作树的跟进任务必须回到同一棵工作树，否则会被拒绝。
      </p>
      {preview === null ? null : (
        <EffectiveSummary
          label="保存后生效（当前草稿预览）"
          effective={preview}
          note={preview.applied.length === 0
            ? '未命中项目覆盖。'
            : `已应用：${preview.applied.join('；')}`}
        />
      )}
      <MonitoringCard store={store} snapshot={snapshot} />
      {served === null ? (
        <p className="dshdg-faint">宿主尚未回报实际生效值（模型目录不可用或尚未加载）。</p>
      ) : (
        <EffectiveSummary
          label="宿主当前实际生效"
          effective={served}
          note="这是任务真正会用的配置快照；模型目录无法解析时会在这里显示拒绝原因。"
        />
      )}
      <PresetsCard store={store} snapshot={snapshot} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Additional review
// ---------------------------------------------------------------------------

/** @param {object} props @returns {object} the review panel. */
function ReviewPanel({ store, snapshot }) {
  const draft = snapshot.draft;
  const providers = draft?.providers ?? [];
  const review = draft?.review ?? { enabled: false };
  const enabled = review.enabled === true;
  const worker = draft?.worker ?? {};
  const sameRoute = enabled
    && review.providerId === (worker.providerId ?? null)
    && review.model === (worker.model ?? null);
  if (draft === null) return <p className="dshdg-faint">正在读取设置…</p>;
  return (
    <div className="dshdg-panel">
      <div className="dshdg-card">
        <div className="dshdg-row">
          <label htmlFor="dshdg-review-enabled">
            <input
              id="dshdg-review-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                store.editDraft((current) => { current.review.enabled = event.target.checked; });
              }}
            />
            {' '}启用附加模型审查（默认关闭）
          </label>
          <span className="dshdg-spacer" />
          <Badge tone={enabled ? 'on' : 'off'}>{enabled ? '已启用' : '关闭'}</Badge>
        </div>
        <p className="dshdg-muted">
          附加审查是独立的只读检查：它读交付的 diff 与证据，给出建议，但<strong>不能</strong>代替宿主验收、不能修改文件、
          也不会触发自动修复循环。它和本机调用开关相互独立。
        </p>
        {sameRoute ? (
          <p className="dshdg-fail">
            审查与执行的提供方/模型相同，独立性问题无法保证；建议换一个模型。宿主可能会拒绝这种组合。
          </p>
        ) : null}
      </div>
      {enabled ? (
        <SelectionFields
          providers={providers}
          idPrefix="dshdg-review"
          value={{
            providerId: review.providerId ?? null,
            model: review.model ?? null,
            reasoningEffort: review.reasoningEffort ?? null,
          }}
          onChange={(next) => {
            store.editDraft((current) => {
              current.review.providerId = next.providerId;
              current.review.model = next.model;
              if ('reasoningEffort' in next) current.review.reasoningEffort = next.reasoningEffort;
            });
          }}
        />
      ) : (
        <p className="dshdg-faint">关闭时不创建审查代理，也不发出任何审查请求。</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task records
// ---------------------------------------------------------------------------

/**
 * One task's details: effective config, diff, evidence, usage, review outcome.
 * @param {object} props - `store`, `task`.
 * @returns {object} the detail card.
 */
function TaskDetail({ store, task }) {
  const outcome = taskOutcome(task);
  const files = changedFiles(task);
  // A bounded read of the task's own activity metadata. `available: false` means the
  // record carries none (an old record, or a task that never reached execution), and
  // that is stated as "未采集到" rather than as "idle" or "healthy".
  const progress = taskProgress(task);
  const activity = taskActivity(task);
  // `view()` freezes the configuration that actually ran; a later settings edit
  // does not retroactively change what a finished task reports.
  const worker = task.effective?.worker ?? {};
  const review = task.review ?? null;
  const reviewState = review === null ? 'not_run' : (review.state ?? 'not_run');
  const diff = task.diff ?? null;
  const execution = task.execution ?? null;
  const error = task.error ?? execution?.error ?? null;
  const permission = permissionSummary(task);
  const pending = pendingPermission(task);
  const evidence = Array.isArray(task.permission?.evidence) ? task.permission.evidence : [];
  // The detail header uses the SAME headline as the list, so a task that was reviewed
  // never still says "等待宿主审查" here while the list says "审查通过".
  const badgeTone = isAwaitingPermission(task) ? 'warn' : outcome.tone;
  return (
    <div className="dshdg-item">
      <div className="dshdg-item-head">
        <strong>{task.title || task.taskId}</strong>
        <Badge tone={badgeTone}>
          {outcome.label}
        </Badge>
        {isAwaitingPermission(task) ? <Badge tone="warn">{PERMISSION_STATE_LABELS.pending}</Badge> : null}
        <span className="dshdg-spacer" />
        <button
          type="button"
          className="dshdg-danger"
          disabled={!isCancellable(task.state)}
          onClick={() => { void store.cancelTask(task.taskId); }}
        >
          取消任务
        </button>
      </div>
      <p className="dshdg-muted">{outcome.note}</p>

      <div className="dshdg-card" data-dshdg-task-progress="">
        <h4>进展</h4>
        <p className="dshdg-mono">{progress.headline}</p>
        <p className="dshdg-hint">{progress.detail}</p>
      </div>

      <dl className="dshdg-kv">
        <dt>生效提供方</dt>
        <dd className="dshdg-mono">{worker.providerId ?? '—'}</dd>
        <dt>生效模型</dt>
        <dd className="dshdg-mono">{worker.model ?? '—'}</dd>
        <dt>推理强度</dt>
        <dd className="dshdg-mono">{worker.reasoningEffort ?? '（不指定）'}</dd>
        <dt>工作区</dt>
        <dd className="dshdg-mono">{task.workspacePath ?? '—'}</dd>
        <dt>隔离</dt>
        <dd>{ISOLATION_LABELS[task.isolation ?? worker.isolation] ?? task.isolation ?? worker.isolation ?? '—'}</dd>
        <dt>对话</dt>
        <dd>
          {execution?.conversation === null || execution?.conversation === undefined
            ? (task.continueFromTaskId === null || task.continueFromTaskId === undefined
              ? '（未放置对话）'
              : `（未放置对话；本任务声明续接 ${task.continueFromTaskId}）`)
            : (execution.conversation.reused === true
              ? `续接 ${execution.conversation.continuedFromTaskId ?? '上一任务'} · 工作区 ${execution.conversation.workspaceId ?? '—'}`
              : `新开 · 工作区 ${execution.conversation.workspaceId ?? '—'}`)}
        </dd>
        <dt>阶段</dt>
        <dd>
          {/* A finished/reviewed run never says "waiting for host review" here: that is the
              headline's job. What remains true is that the execution is over. */}
          {outcome.decided || task.state === 'awaiting-host-review' ? '执行已结束' : taskPhaseLabel(task.phase)}
        </dd>
        <dt>最近进展</dt>
        <dd>
          {activity === null || activity.lastActivityAt === null
            ? '未采集到'
            : `${formatTime(activity.lastActivityAt)}（距上次进展 ${formatDuration(activity.idleForMs)}）`}
        </dd>
        <dt>当前工具</dt>
        <dd>
          {activity === null || activity.currentTool === null
            ? (activity === null ? '未采集到' : '当前没有正在运行的工具')
            : `${activity.currentTool.name} · 已运行 ${formatDuration(activity.currentTool.elapsedMs)}`}
        </dd>
        <dt>无进展诊断</dt>
        <dd>
          {activity === null || activity.selfCheck === null || activity.selfCheck.verdict === null
            ? (activity === null ? '未采集到' : '尚未触发程序自检（安静时间还没到自检间隔）')
            : `${SELF_CHECK_LABELS[activity.selfCheck.verdict] ?? activity.selfCheck.verdict}`
              + (activity.selfCheck.checkedAt === null ? '' : `（${formatTime(activity.selfCheck.checkedAt)}）`)}
        </dd>
        <dt>监控间隔</dt>
        <dd>
          {activity === null || activity.selfCheckSeconds === null
            ? '未采集到'
            : `自检 ${formatDuration(activity.selfCheckSeconds * 1000)} · 提醒 ${formatDuration((activity.attentionSeconds ?? 0) * 1000)}`}
        </dd>
        <dt>重复失败提醒</dt>
        <dd>{repeatFailureLine(activity)}</dd>
        <dt>创建</dt>
        <dd>{formatTime(task.createdAt)}</dd>
        <dt>结束</dt>
        <dd>{formatTime(task.endedAt)}</dd>
        <dt>用量</dt>
        <dd>{execution?.usage === null || execution?.usage === undefined ? '不可用' : boundedText(execution.usage, 600)}</dd>
        <dt>附加审查</dt>
        <dd>
          {REVIEW_STATE_LABELS[reviewState] ?? reviewState}
          {review?.verdict === null || review?.verdict === undefined
            ? ''
            : ` · ${REVIEW_VERDICT_LABELS[review.verdict] ?? review.verdict}`}
        </dd>
        <dt>宿主验收</dt>
        <dd>{hostReviewLine(task, formatTime)}</dd>
      </dl>

      <h4>改动文件</h4>
      {files === null
        ? <p className="dshdg-faint">宿主未回报可识别的文件摘要，请以下方原始 diff 为准。</p>
        : <ul className="dshdg-mono">{files.map((file) => <li key={file}>{file}</li>)}</ul>}
      {diff?.patchWithheld === true
        ? <p className="dshdg-fail">宿主判定这批改动不宜展示内容（命中敏感路径或超出上限），只给出说明。</p>
        : null}
      {diff?.patchTruncated === true ? <p className="dshdg-hint">diff 已截断。</p> : null}

      <h4>diff</h4>
      <pre className="dshdg-pre">{boundedText(diff?.patchText ?? '（无 diff 内容）')}</pre>

      <h4>验证证据</h4>
      <pre className="dshdg-pre">{boundedText(execution?.text ?? execution ?? '（无验证证据）')}</pre>

      {error === null ? null : (
        <>
          <h4>错误</h4>
          <pre className="dshdg-pre">{boundedText(error, 4000)}</pre>
        </>
      )}

      {review?.text === undefined || review?.text === null || review.text === '' ? null : (
        <>
          <h4>审查发现</h4>
          <pre className="dshdg-pre">{boundedText(review.text, 8000)}</pre>
        </>
      )}

      <h4>本次调用授权</h4>
      <p className={isAwaitingPermission(task) ? 'dshdg-hint' : 'dshdg-faint'}>{permission.note}</p>
      {permission.detail === '' ? null : <p className="dshdg-faint dshdg-mono">{permission.detail}</p>}
      {pending === null ? null : (
        <dl className="dshdg-kv">
          <dt>工具</dt>
          <dd className="dshdg-mono">{pending.toolName ?? '—'}</dd>
          <dt>调用编号</dt>
          <dd className="dshdg-mono">{pending.callId ?? '—'}</dd>
          <dt>请求的权限</dt>
          <dd className="dshdg-mono">{pending.requestedAccess?.mode ?? '（该工具自身的调用）'}</dd>
          <dt>实际参数（已脱敏）</dt>
          <dd className="dshdg-mono">{boundedText(pending.arguments ?? '（不可读）', 2000)}</dd>
          <dt>工作进程给出的理由</dt>
          <dd>{pending.reason ?? '（未给出）'}（这是工作进程自己的说法，不是被决定的操作本身）</dd>
          <dt>截止</dt>
          <dd>{formatTime(pending.deadlineAt)}</dd>
        </dl>
      )}
      {evidence.length === 0 ? null : (
        <>
          <h4>授权决定记录</h4>
          <ul className="dshdg-mono">
            {evidence.slice().reverse().map((entry) => (
              <li key={entry.requestId}>
                {`${entry.requestId} · ${entry.toolName ?? '—'} · `
                  + `${PERMISSION_STATE_LABELS[entry.state] ?? entry.state ?? '—'} · `
                  + `${PERMISSION_OUTCOME_LABELS[entry.outcome] ?? entry.outcome ?? '—'}`
                  + `${entry.decidedBy === 'commander' ? ` · ${PERMISSION_DECISION_LABELS[entry.outcome === 'allowed-once' ? 'allow-once' : 'reject'] ?? '本机指挥官'}` : ''}`}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="dshdg-hint">
        逐次授权桥只决定“这一次调用”。它不能创建或扩大任何长期有效的授权（“长期有效”指跨调用、跨会话持久的授权），不能修改设置、凭据、本机调用开关、提供方、模型或隔离方式，
        也不能预先批准后续调用；工作进程的常规沙箱权限始终保持 workspace-write。此界面不提供手工批准按钮，决定由本机 MCP 指挥官通过
        delegate_permission_decide 作出。
      </p>

      <p className="dshdg-hint">
        重试前请确认顶部的本机调用开关已开启，然后在 MCP 宿主重新提交任务。本界面不会直接提交任务。
      </p>
    </div>
  );
}

/** @param {object} props @returns {object} the task records panel. */
/**
 * Bounded, program-driven task refresh.
 *
 * Every condition here exists to keep a *visible page* from doing work on its own:
 *
 *  * it runs ONLY while the tasks tab is mounted (the effect lives in `TasksPanel`),
 *    so switching tabs or unmounting clears the timer;
 *  * it runs ONLY while there is something that can change — a live task in the list
 *    or a live selected detail. A page full of terminal records never polls;
 *  * it skips a hidden document (`document.hidden`) and registers a
 *    `visibilitychange` listener so returning to the tab reads immediately instead
 *    of waiting out the interval;
 *  * it never overlaps: a refresh in flight suppresses the next tick, and the
 *    interval is reset after each attempt, so a slow host cannot accumulate calls;
 *  * it is a pure read of the task list — no model call, no task action, no settings
 *    write — so it cannot disturb an unsaved draft or the selected task.
 *
 * The interval is deliberately much slower than the host's 5 s suggestion is worth
 * fighting over: 5 s of list reads costs nothing and keeps the page truthful.
 * @param {object} props - `store`, `snapshot`, `intervalMs`.
 * @returns {object | null} nothing (side effects only).
 */
function useTaskAutoRefresh({ store, snapshot, intervalMs = 5000 }) {
  const live = hasLiveTasks(snapshot.tasks) || (snapshot.taskDetail !== null && isLiveTask(snapshot.taskDetail));
  // Read through a ref so the effect does not restart on every store revision: a
  // restarted effect would reset the timer constantly and effectively poll far
  // faster than the interval.
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!live) return undefined;
    let timer = null;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    };

    const tick = () => {
      timer = null;
      if (disposed) return;
      // A hidden tab is not watching anything: skip the read entirely, and let the
      // visibility listener below schedule the next one when it comes back.
      if (globalThis.document?.hidden === true) return;
      if (!liveRef.current) return;
      void store.refreshTasks('auto').finally(() => { schedule(); });
    };

    const onVisibility = () => {
      if (globalThis.document?.hidden === true) return;
      if (!liveRef.current) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      void store.refreshTasks('auto').finally(() => { schedule(); });
    };

    schedule();
    const doc = globalThis.document;
    doc?.addEventListener?.('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
    };
  }, [store, live, intervalMs]);
}

function TasksPanel({ store, snapshot }) {
  const tasks = snapshot.tasks ?? [];
  const detail = snapshot.taskDetail;
  useTaskAutoRefresh({ store, snapshot });
  const liveCount = tasks.filter(isLiveTask).length;
  return (
    <div className="dshdg-panel">
      <div className="dshdg-row">
        <p className="dshdg-muted">这里只记录执行事实。执行完成不等于被接受：“等待宿主审查”要由宿主（例如 Codex）单独给出结论。</p>
        <span className="dshdg-spacer" />
        <span className="dshdg-hint">
          {liveCount === 0 && !(detail !== null && isLiveTask(detail))
            ? '当前没有运行中的任务，不会自动刷新。'
            : `有 ${liveCount} 个进行中的任务，页面可见时每 5 秒自动刷新一次（只读，不调用模型）。`}
        </span>
        <button type="button" disabled={snapshot.loading?.tasks === true} onClick={() => { void store.refreshTasks('manual'); }}>
          {snapshot.loading?.tasks === true ? '读取中…' : '刷新'}
        </button>
      </div>
      {tasks.length === 0 ? <p className="dshdg-faint">还没有任务记录。</p> : (
        <div className="dshdg-list">
          {tasks.map((task) => {
            const progress = taskProgress(task);
            // The ONE headline for this task: it already reflects a recorded review, so
            // the raw state label can never sit next to a "审查通过" badge contradicting it.
            const outcome = taskOutcome(task);
            // Only a phase that says something DIFFERENT is shown (a live run); a finished
            // or reviewed task would otherwise repeat its own headline.
            const phase = outcome.phaseLabel;
            return (
              <div className="dshdg-item" key={task.taskId}>
                <div className="dshdg-item-head">
                  <span>{task.title || task.taskId}</span>
                  <Badge tone={isAwaitingPermission(task) ? 'warn' : outcome.tone}>
                    {outcome.label}
                  </Badge>
                  {phase === null ? null : <Badge tone={progress.tone}>{phase}</Badge>}
                  {isAwaitingPermission(task) ? <Badge tone="warn">{PERMISSION_STATE_LABELS.pending}</Badge> : null}
                  <span className="dshdg-mono dshdg-faint">
                    {task.config?.worker?.model ?? task.effective?.worker?.model ?? '—'}
                    {' / '}
                    {task.config?.worker?.reasoningEffort ?? task.effective?.worker?.reasoningEffort ?? '不指定'}
                  </span>
                  <span className="dshdg-spacer" />
                  <span className="dshdg-faint">{formatTime(task.createdAt)}</span>
                  <button
                    type="button"
                    disabled={snapshot.loading?.taskDetail === true}
                    onClick={() => { void store.openTask(task.taskId); }}
                  >
                    详情
                  </button>
                  <button
                    type="button"
                    className="dshdg-danger"
                    disabled={!isCancellable(task.state)}
                    onClick={() => { void store.cancelTask(task.taskId); }}
                  >
                    取消
                  </button>
                </div>
                <p className="dshdg-hint">{progress.headline}</p>
                {isAwaitingPermission(task)
                  ? <p className="dshdg-hint">{permissionSummary(task).note}</p>
                  : null}
              </div>
            );
          })}
        </div>
      )}
      {detail === null ? null : <TaskDetail store={store} task={detail} />}
      <p className="dshdg-faint">{`状态集合：${TASK_STATES.map(taskStateLabel).join(' / ')}`}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Codex integration
// ---------------------------------------------------------------------------

/**
 * One target row: a single fact, with its own badge.
 *
 * The three targets are separate rows because they are separate facts. The page
 * must never let an operator read "agent installed" as "delegation authorized".
 * @param {object} props - `view`, a value from `codexTargetView`.
 * @returns {object} the row.
 */
function CodexTargetRow({ view }) {
  const paths = Array.isArray(view.paths) ? view.paths : [];
  return (
    <div className="dshdg-item">
      <div className="dshdg-item-head">
        <strong>{view.label}</strong>
        <Badge tone={view.tone}>{view.detail}</Badge>
        <span className="dshdg-spacer" />
        <span className="dshdg-mono dshdg-faint">{paths[0] ?? ''}</span>
      </div>
      {paths.length > 1 ? <p className="dshdg-mono dshdg-faint">{paths.slice(1).join('；')}</p> : null}
    </div>
  );
}

/**
 * The Codex integration card.
 *
 * Only explicit clicks write anything: `install` / `repair` / `remove` are the
 * plugin's own buttons and nothing else in `init()` or a save calls them. The card
 * also states, in the panel itself, what Codex has to do afterwards (reload) and
 * that the plugin does not claim any particular `@`-selection behaviour for a Codex
 * surface.
 * @param {object} props - `store`, `snapshot`.
 * @returns {object} the card.
 */
function CodexPanel({ store, snapshot }) {
  const codex = snapshot.codex ?? null;
  const error = snapshot.codexError ?? null;
  const busy = snapshot.loading?.codexAction === true;
  const refreshing = snapshot.loading?.codexStatus === true;
  const agentView = codexTargetView(codex, null, 'agent');
  const mcpView = codexTargetView(codex, null, 'mcp');
  // The switch is reported from the delegation posture the page already reads. It
  // is displayed here so "files installed" is never confused with "dispatch allowed";
  // this card never turns it on.
  const switchAuthorized = snapshot.status?.delegation?.authorized === true
    || snapshot.settings?.delegationEnabled === true;
  const switchView = codexTargetView(codex, { authorized: switchAuthorized }, 'switch');
  const ready = codex?.ready === true;
  const notes = Array.isArray(codex?.notes) ? codex.notes : [];
  const disabled = busy || refreshing || codex === null;
  return (
    <section className="dshdg-card" aria-labelledby="dshdg-codex-title">
      <div className="dshdg-row">
        <h3 id="dshdg-codex-title">Codex 集成（子智能体 + MCP）</h3>
        <span className="dshdg-spacer" />
        <Badge tone={ready ? 'on' : 'off'}>{ready ? '已就绪' : '未就绪'}</Badge>
      </div>
      <p className="dshdg-muted">
        {'点下面的按钮，把 '}
        <span className="dshdg-mono">agents/dsh-taskbridge.toml</span>
        {' 装进 Codex 目录，并在 Codex 的 '}
        <span className="dshdg-mono">config.toml</span>
        {' 里登记本插件的 stdio MCP 服务（delegate_status / delegate_submit / delegate_result / delegate_wait / delegate_cancel）。'
          + '首次安装只会由你点击触发：打开本页、安装或升级本插件都不会自动创建子智能体文件或 MCP 条目。'
          + '已经安装过的情况下，插件下次启动会把本插件自己写入的过期托管条目就地更新（例如补上 tool_timeout_sec）；'
          + '它不会改写非托管、被你改过的条目，也不会触碰 Codex 的其他设置。下面会显示当前条目缺了什么。'}
      </p>
      {error === null ? null : <p className="dshdg-fail">{error}</p>}
      {codex === null ? (
        <p className="dshdg-faint">正在读取 Codex 状态…</p>
      ) : (
        <>
          <p className="dshdg-faint">
            {'Codex 目录：'}
            <span className="dshdg-mono">{String(codex.codexHome ?? '')}</span>
            {'（设置环境变量 CODEX_HOME 可改到别处）'}
          </p>
          <div className="dshdg-list" data-dshdg-codex-targets="">
            <CodexTargetRow view={agentView} />
            <CodexTargetRow view={mcpView} />
            <CodexTargetRow view={switchView} />
          </div>
          {codex.mcp?.state === 'outdated' ? (
            <p className="dshdg-hint" data-dshdg-codex-drift="">
              {'这个托管 MCP 条目已经过期：'}
              {codexMcpDriftText(codex.mcp)}
              {'。插件下次启动会自动在原地更新；也可以点上面的「安装 / 更新 TaskBridge 智能体」。'}
            </p>
          ) : null}
          {notes.length === 0 ? null : (
            <ul className="dshdg-hint">
              {notes.map((note) => <li key={note.code}>{note.text}</li>)}
            </ul>
          )}
          <div className="dshdg-row">
            <button type="button" disabled={busy || refreshing} onClick={() => { void store.refreshCodexStatus(); }}>
              {refreshing ? '读取中…' : '刷新状态'}
            </button>
            <button type="button" className="dshdg-primary" disabled={disabled} onClick={() => { void store.runCodexAction('install'); }}>
              {busy ? '处理中…' : '安装 / 更新 TaskBridge 智能体'}
            </button>
            <button type="button" disabled={disabled} onClick={() => { void store.runCodexAction('repair'); }}>
              仅修复 MCP 配置
            </button>
            <button type="button" className="dshdg-danger" disabled={disabled} onClick={() => { void store.runCodexAction('remove'); }}>
              移除插件托管项
            </button>
          </div>
          {snapshot.codexOutcome === null || snapshot.codexOutcome === undefined
            ? null
            : <p className="dshdg-hint">{describeCodexOutcome(snapshot.codexOutcome)}</p>}
        </>
      )}
      <p className="dshdg-hint">
        {'安装后需要让 Codex 重新载入：新开会话或重启 Codex，才会读到新的子智能体和 MCP 条目。'
          + '本插件不宣称当前 Codex 桌面版/CLI 能在输入框用 @dsh-taskbridge 直接选中该子智能体——这取决于 Codex 版本自身是否提供提及选择；'
          + '这里只保证子智能体文件与 MCP 工具存在，并由你在 Codex 提供的选择方式中指派它。'
          + '子智能体只在明确指派时派发任务，并在提交前先检查上面的本机调用开关；本页不会替你打开该开关。'
          + '同名的自定义 agent 会被保留并报告为冲突；没有本插件托管标记注释的同名 MCP 条目也视为你自己写的，不会被覆盖或删除。'}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------

/** Tab definitions: authorization is not a tab — it renders above all four. */
const TABS = Object.freeze([
  { key: 'providers', label: '接口管理' },
  { key: 'execution', label: '执行设置' },
  { key: 'review', label: '附加审查' },
  { key: 'tasks', label: '任务记录' },
  { key: 'codex', label: 'Codex 集成' },
]);

/**
 * The page registered as this bundle's configuration in the Plugins manager.
 *
 * Props arrive from the slot registration's `inject` face: `{ store }`, plus the
 * slot owner props `{ view }` (always `'page'` here) and the optional host
 * `form`, which this page deliberately ignores — its save control belongs to
 * the plugin's own user-plane store, not to the host config form.
 * @param {object} props - `store`, and the slot owner props.
 * @returns {object} the page.
 */
export function DelegateConfigPage(props) {
  const store = props.store;
  const snapshot = useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  );
  const [tab, setTab] = useState(TABS[0].key);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void store.init();
  }, [store]);

  const problems = useMemo(
    () => (snapshot.draft === null ? [] : precheckDraft(snapshot.draft)),
    [snapshot.draft],
  );
  const tabRefs = useRef(new Map());

  return (
    <div className="dshdg-root">
      <Notices store={store} notices={snapshot.notices ?? []} />

      <AuthorizationPanel store={store} snapshot={snapshot} />

      <div className="dshdg-tabs" role="tablist" aria-label="DSH 委托设置">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            className="dshdg-tab"
            id={`dshdg-tab-${entry.key}`}
            aria-selected={tab === entry.key}
            aria-controls={`dshdg-panel-${entry.key}`}
            tabIndex={tab === entry.key ? 0 : -1}
            ref={(node) => {
              if (node === null) tabRefs.current.delete(entry.key);
              else tabRefs.current.set(entry.key, node);
            }}
            onClick={() => setTab(entry.key)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = TABS.findIndex((candidate) => candidate.key === tab);
              const step = event.key === 'ArrowRight' ? 1 : -1;
              const next = TABS[(index + step + TABS.length) % TABS.length];
              setTab(next.key);
              tabRefs.current.get(next.key)?.focus?.();
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        className="dshdg-panel"
        role="tabpanel"
        id={`dshdg-panel-${tab}`}
        aria-labelledby={`dshdg-tab-${tab}`}
        tabIndex={-1}
      >
        {tab === 'providers' ? <ProvidersPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'execution' ? <ExecutionPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'review' ? <ReviewPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'tasks' ? <TasksPanel store={store} snapshot={snapshot} /> : null}
        {tab === 'codex' ? <CodexPanel store={store} snapshot={snapshot} /> : null}
      </div>

      <div className="dshdg-row">
        <span className="dshdg-hint">
          {snapshot.dirty === true ? '有未保存的修改。' : '所有修改已保存。'}
          {problems.length === 0 ? '' : ` 待修正：${problems[0]}${problems.length > 1 ? ` 等 ${problems.length} 项` : ''}`}
        </span>
        <span className="dshdg-spacer" />
        <button
          type="button"
          disabled={snapshot.dirty !== true || snapshot.loading?.save === true}
          onClick={() => { store.resetDraft(); }}
        >
          放弃修改
        </button>
        <button
          type="button"
          className="dshdg-primary"
          disabled={snapshot.dirty !== true || snapshot.loading?.save === true || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await store.saveSettings();
            } finally {
              setSaving(false);
            }
          }}
        >
          {snapshot.loading?.save === true || saving ? '保存中…' : '保存设置'}
        </button>
      </div>
      <p className="dshdg-faint">
        保存会整体替换设置文档；正在运行的任务保留它自己的快照。密钥从不随设置保存或导出。
      </p>
    </div>
  );
}

/** Re-exported so the documented contract and tests share one name for the body document. */
export { documentFromDraft, describeError, exportDocument };
