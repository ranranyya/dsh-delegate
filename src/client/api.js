// dsh-delegate settings UI — user-plane client, shared vocabulary and store.
//
// This module is deliberately framework-free: it is the part of the browser
// half that can be reasoned about (and tested) without React. It owns
//
//   1. the transport to the authenticated user plane (`/api/dsh-delegate/*`),
//   2. the operator-facing vocabulary (Chinese labels, state/effort names),
//   3. the editable settings draft and its non-secret projections, and
//   4. a small observable store the React page subscribes to.
//
// Two rules shape everything here, and both are security properties rather than
// style preferences:
//
//   * A credential value and a connection token are *never* part of persisted or
//     rendered state. The credential value travels from a controlled input
//     straight into one request and is dropped. The connection token lives in
//     this in-memory store only until the operator dismisses it; it is not
//     written to a URL, storage, log or clipboard unless the operator explicitly
//     presses copy.
//   * The user plane's authentication is the native browser-session carrier, not
//     something this client adds. Requests therefore carry no `Authorization`
//     header; they rely on `credentials: 'same-origin'`.
//
// Nothing here decides whether a provider/model/effort combination is legal:
// the settings service on the host is the authority, and its refusals are shown
// verbatim. The few checks below exist to keep the operator from submitting an
// obviously broken form, and every one of them is re-checked server-side.

/** User-plane prefix. Mirrors `USER_PLANE_PREFIX` in `src/http/user-plane.js`. */
export const USER_PLANE_PREFIX = '/api/dsh-delegate';

/**
 * Exact user-plane routes the page drives.
 *
 * Every route here is served by `src/http/user-plane.js`; the list is the client
 * half of one contract, not a wish list. The page still degrades explicitly when
 * a host predates a route (a 404 becomes "the host does not serve this yet"
 * rather than a fabricated success), because an older plugin version can be
 * mounted against a newer page.
 */
export const ROUTES = Object.freeze({
  status: `${USER_PLANE_PREFIX}/status`,
  delegation: `${USER_PLANE_PREFIX}/delegation`,
  nativeProviders: `${USER_PLANE_PREFIX}/native-providers`,
  settings: `${USER_PLANE_PREFIX}/settings`,
  catalog: `${USER_PLANE_PREFIX}/catalog`,
  connections: `${USER_PLANE_PREFIX}/connections`,
  connectionsRevoke: `${USER_PLANE_PREFIX}/connections/revoke`,
  grants: `${USER_PLANE_PREFIX}/grants`,
  grantsRevoke: `${USER_PLANE_PREFIX}/grants/revoke`,
  revokeAll: `${USER_PLANE_PREFIX}/authorization/revoke-all`,
  tasks: `${USER_PLANE_PREFIX}/tasks`,
  tasksGet: `${USER_PLANE_PREFIX}/tasks/get`,
  tasksCancel: `${USER_PLANE_PREFIX}/tasks/cancel`,
  models: `${USER_PLANE_PREFIX}/models`,
  credentialsStatus: `${USER_PLANE_PREFIX}/credentials/status`,
  credentialsSet: `${USER_PLANE_PREFIX}/credentials/set`,
  credentialsUnset: `${USER_PLANE_PREFIX}/credentials/unset`,
  connectivity: `${USER_PLANE_PREFIX}/connectivity`,
  // One path, two methods: `GET` diagnoses, `POST` performs one explicit action.
  codex: `${USER_PLANE_PREFIX}/codex`,
});

/** A refusal or transport failure carrying the contract's stable code. */
export class ApiError extends Error {
  /**
   * @param {string} code - stable machine code (`SETTINGS_INVALID`, `HTTP_404`, ...).
   * @param {string} message - short English diagnostic from the host.
   * @param {object} [options] - `status`, `details`.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? 0;
    this.details = options.details ?? {};
  }
}

/**
 * Create the user-plane transport.
 *
 * URLs are document-relative (`api/dsh-delegate/...`, not `/api/...`) for the
 * same reason the native change routes are: the web app may be mounted under a
 * sub-path, and an absolute path would escape the mount.
 * @param {object} [options] - `fetchImpl` for tests, `base` for a fixed prefix.
 * @returns {object} one method per user-plane route.
 */
export function createApi(options = {}) {
  const fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const base = typeof options.base === 'string' ? options.base : '';

  /**
   * Send one request and unwrap the contract envelope.
   * @param {string} method - `GET` or `POST`.
   * @param {string} route - route from {@link ROUTES}.
   * @param {object} [body] - JSON body; omitted for a body-less `GET`.
   * @returns {Promise<object>} the parsed `ok:true` body.
   * @throws {ApiError} on transport failure, non-2xx, or `ok:false`.
   */
  async function request(method, route, body) {
    const url = `${base}${route.replace(/^\//, '')}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        // The browser session cookie is the user plane's credential. Sending it
        // cross-origin is impossible here, and the native carrier fences Host and
        // Origin before any handler runs.
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiError('USER_PLANE_UNREACHABLE', 'the delegation settings service could not be reached', {
        details: { detail: String(error?.message ?? error).slice(0, 200) },
      });
    }

    let text = '';
    try {
      text = typeof response.text === 'function' ? await response.text() : '';
    } catch {
      text = '';
    }
    let parsed = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok || parsed === null || parsed.ok !== true) {
      const failure = parsed !== null && typeof parsed === 'object' ? parsed.error : undefined;
      const code = typeof failure?.code === 'string'
        ? failure.code
        : (response.ok ? 'USER_PLANE_MALFORMED' : `HTTP_${response.status}`);
      const message = typeof failure?.message === 'string'
        ? failure.message
        : `the settings service answered HTTP ${response.status}`;
      throw new ApiError(code, message, {
        status: response.status,
        details: typeof failure?.details === 'object' && failure.details !== null ? failure.details : {},
      });
    }
    return parsed;
  }

  return {
    /** @returns {Promise<object>} plugin/delegation posture. */
    async getStatus() {
      return await request('GET', ROUTES.status);
    },
    /** @param {boolean} enabled - master dispatch switch. */
    async setDelegationEnabled(enabled) {
      return await request('POST', ROUTES.delegation, { enabled });
    },
    /** @returns {Promise<object>} DSH's already registered providers and models. */
    async getNativeProviders() {
      return await request('GET', ROUTES.nativeProviders);
    },
    /** @returns {Promise<object>} `{ settings, secrets }`. */
    async getSettings() {
      return await request('GET', ROUTES.settings);
    },
    /**
     * Replace the whole settings document.
     * @param {object} settings - full document (never carrying a secret).
     * @returns {Promise<object>} `{ settings }`.
     */
    async putSettings(settings) {
      return await request('POST', ROUTES.settings, { settings });
    },
    /**
     * Resolve provider models/efforts plus the composed effective config.
     * @param {object} [body] - `{ projectPath }`.
     * @returns {Promise<object>} `{ catalog, effective }`.
     */
    async getCatalog(body = {}) {
      return await request('POST', ROUTES.catalog, body);
    },
    /** @returns {Promise<object>} `{ connections }`. */
    async listConnections() {
      return await request('GET', ROUTES.connections);
    },
    /**
     * Issue a connection. The response is the only place a token is ever visible.
     * @param {string} label - display label.
     * @returns {Promise<object>} `{ connection, token, tokenReturnedOnce }`.
     */
    async issueConnection(label) {
      return await request('POST', ROUTES.connections, { label });
    },
    /**
     * Revoke one connection and its grants.
     * @param {string} connectionId - server-issued identity.
     * @returns {Promise<object>} `{ grantsRevoked }`.
     */
    async revokeConnection(connectionId) {
      return await request('POST', ROUTES.connectionsRevoke, { connectionId });
    },
    /**
     * List one connection's grants.
     * @param {string} connectionId - server-issued identity.
     * @returns {Promise<object>} `{ grants }`.
     */
    async listGrants(connectionId) {
      return await request('GET', `${ROUTES.grants}?${new URLSearchParams({ connectionId })}`);
    },
    /**
     * Issue one grant.
     * @param {object} body - `{ connectionId, kind, workspacePath, ttlSeconds? }`.
     * @returns {Promise<object>} `{ grant }`.
     */
    async issueGrant(body) {
      return await request('POST', ROUTES.grants, body);
    },
    /**
     * Revoke one grant.
     * @param {string} grantId - grant identity.
     * @returns {Promise<object>} `{ grant }`.
     */
    async revokeGrant(grantId) {
      return await request('POST', ROUTES.grantsRevoke, { grantId });
    },
    /** @returns {Promise<object>} `{ grantsRevoked }`. */
    async revokeAll() {
      return await request('POST', ROUTES.revokeAll, {});
    },
    /**
     * List tasks (never carrying a prompt).
     * @param {string | null} [connectionId] - optional filter.
     * @returns {Promise<object>} `{ tasks }`.
     */
    async listTasks(connectionId = null) {
      const suffix = connectionId === null ? '' : `?${new URLSearchParams({ connectionId })}`;
      return await request('GET', `${ROUTES.tasks}${suffix}`);
    },
    /**
     * Read one task including its prompt.
     * @param {string} taskId - task identity.
     * @returns {Promise<object>} `{ task }`.
     */
    async getTask(taskId) {
      return await request('POST', ROUTES.tasksGet, { taskId });
    },
    /**
     * Cancel a task as the operator.
     * @param {string} taskId - task identity.
     * @returns {Promise<object>} `{ task }`.
     */
    async cancelTask(taskId) {
      return await request('POST', ROUTES.tasksCancel, { taskId });
    },
    /**
     * Discover one provider's model list from its own API (remote discovery).
     *
     * The host performs one authenticated request to the provider's configured
     * base URL with *that profile's* credential reference, so this answers "what
     * does the endpoint say it serves" — not "what can the harness resolve" (that
     * is `getCatalog`). A failed discovery still answers `ok: true` with
     * `models: []` and a `discovery` diagnosis, so a caller must read
     * `body.discovery?.failed` and `body.error` rather than treating an empty list
     * as "the provider has no models".
     * @param {string} providerId - configured provider id.
     * @returns {Promise<object>} `{ models: [{ id, efforts }], source, discovery, error }`.
     */
    async fetchModels(providerId) {
      return await request('POST', ROUTES.models, { providerId });
    },
    /**
     * Read whether a provider's credential is configured (target route).
     * @param {string} providerId - configured provider id.
     * @returns {Promise<object>} `{ credential: { configured, source?, writable? } }`.
     */
    async credentialStatus(providerId) {
      return await request('POST', ROUTES.credentialsStatus, { providerId });
    },
    /**
     * Store a credential value through the separate authenticated seam.
     * @param {string} providerId - configured provider id.
     * @param {string} value - the literal value; never retained by the caller.
     * @returns {Promise<object>} `{ credential }`.
     */
    async setCredential(providerId, value) {
      return await request('POST', ROUTES.credentialsSet, { providerId, value });
    },
    /**
     * Remove a stored credential value.
     * @param {string} providerId - configured provider id.
     * @returns {Promise<object>} `{ credential }`.
     */
    async unsetCredential(providerId) {
      return await request('POST', ROUTES.credentialsUnset, { providerId });
    },
    /**
     * Run the layered connectivity check.
     * @param {object} body - `{ providerId, model?, reasoningEffort? }`.
     * @returns {Promise<object>} `{ report }`.
     */
    async checkConnectivity(body) {
      return await request('POST', ROUTES.connectivity, body);
    },
    /**
     * Diagnose the Codex integration. Read-only on the host.
     * @returns {Promise<object>} `{ codex, switch }`.
     */
    async getCodexStatus() {
      return await request('GET', ROUTES.codex);
    },
    /**
     * Perform one explicit Codex action.
     *
     * Only an operator click reaches this: there is no load-time or save-time
     * caller, so visiting the page never writes into the Codex home.
     * @param {'install'|'repair'|'remove'} action - the action to perform.
     * @returns {Promise<object>} `{ action, changed, refused, codex, switch }`.
     */
    async runCodexAction(action) {
      return await request('POST', ROUTES.codex, { action });
    },
  };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Reasoning-effort ids this build understands, weakest first.
 *
 * This is a *display* mirror of `KNOWN_EFFORTS` in `src/config/defaults.js`; the
 * authority for what a particular model supports is the catalog the host serves,
 * and the authority for what a document may contain is the host's validator.
 */
export const KNOWN_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Chinese labels for effort ids. */
export const EFFORT_LABELS = Object.freeze({
  off: '关闭推理',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
});

/** Sentinel used by a `<select>` for "no explicit effort". */
export const EFFORT_UNSET = '';

/** Workspace isolation modes, strongest first. */
export const ISOLATION_MODES = Object.freeze(['worktree', 'shared']);

/** Chinese labels for isolation modes. */
export const ISOLATION_LABELS = Object.freeze({
  worktree: '独立工作树（临时 git worktree，不碰当前检出）',
  shared: '共享工作区（直接修改所选目录）',
});

/**
 * The retired directory-level conversation modes, kept for display compatibility.
 *
 * They are no longer a choice. A new submission always starts a new DSH
 * conversation, and a follow-up continues only the task thread named by
 * `continueFromTaskId`. The values remain here so a page can still render a task
 * record or a stored document written by an earlier build, and so the migration
 * note can name what went away.
 */
export const CONVERSATION_MODES = Object.freeze(['new', 'reuse']);

/** Chinese labels for the retired conversation modes. */
export const CONVERSATION_LABELS = Object.freeze({
  new: '每个任务新开对话',
  reuse: '复用同一执行目录最近的对话（已移除）',
});

/** Chinese explanation of the conversation policy that replaced the mode setting. */
export const CONVERSATION_POLICY_LABEL = '每次提交默认新开对话；只有带上 continueFromTaskId 的跟进任务才续接同一条对话';

/**
 * The conversation block a draft/request should carry.
 *
 * The value is inert: it is preserved so saving a page never rewrites an operator's
 * stored document into a state it did not choose, and it never influences what a
 * run does. A stored `reuse` is kept verbatim and still means nothing on dispatch.
 * @param {object} [draft] - editable document.
 * @returns {{ mode: string }} conversation block.
 */
export function conversationOf(draft) {
  const requested = draft?.conversation?.mode;
  return { mode: CONVERSATION_MODES.includes(requested) ? requested : CONVERSATION_MODES[0] };
}

/**
 * Chinese label for one conversation mode.
 * @param {string} mode - mode id.
 * @returns {string} label, falling back to the raw id.
 */
export function conversationModeLabel(mode) {
  return CONVERSATION_LABELS[mode] ?? String(mode ?? '未设置');
}

/** Grant scopes. */
export const GRANT_KINDS = Object.freeze(['task', 'session']);

/** Chinese labels for grant scopes. */
export const GRANT_KIND_LABELS = Object.freeze({
  task: '单次任务（用掉即失效）',
  session: '本连接会话（限时、可撤销）',
});

/**
 * Chinese labels for the per-call permission states a task can report.
 *
 * The wording is deliberately about ONE call: a decision here never grants a
 * standing permission, and the panel must not read like an approval workflow.
 */
export const PERMISSION_STATE_LABELS = Object.freeze({
  pending: '等待本机指挥官决定（仅这一次调用）',
  decided: '已决定',
  expired: '已超时（未决定即为拒绝）',
  cancelled: '已撤回',
  unavailable: '无法建立请求身份（已按拒绝处理）',
});

/** Chinese labels for the two decisions the commander may take. */
export const PERMISSION_DECISION_LABELS = Object.freeze({
  'allow-once': '仅本次允许',
  reject: '拒绝',
});

/** Chinese labels for the four closed native approval outcomes. */
export const PERMISSION_OUTCOME_LABELS = Object.freeze({
  'allowed-once': '仅本次允许',
  rejected: '已拒绝',
  cancelled: '已撤回',
  unavailable: '无可用审批通道',
});

/** Chinese label for a task phase, falling back to the raw phase. */
export const TASK_PHASE_LABELS = Object.freeze({
  created: '已创建',
  workspace: '解析工作区',
  authorization: '校验授权',
  settings: '读取设置',
  providers: '确认提供方',
  worktree: '准备工作树',
  audit: '记录基线',
  'before-create': '即将创建执行器',
  execute: '执行中',
  'awaiting-permission': '等待本次调用授权决定',
  review: '附加审查中',
  'awaiting-host-review': '等待宿主审查',
  failed: '已失败',
  cancelled: '已取消',
});

/** Task states, exactly as the engine reports them. */
export const TASK_STATES = Object.freeze(['pending', 'running', 'awaiting-host-review', 'failed', 'cancelled']);

/**
 * Chinese labels for task states.
 *
 * `awaiting-host-review` is deliberately *not* "已完成" or "已接受": execution
 * finished, and acceptance belongs to the host.
 */
export const TASK_STATE_LABELS = Object.freeze({
  pending: '排队中',
  running: '执行中',
  'awaiting-host-review': '等待宿主审查',
  failed: '执行失败',
  cancelled: '已取消',
});

/** Chinese labels for task review states. */
export const REVIEW_STATE_LABELS = Object.freeze({
  disabled: '未启用附加审查',
  not_run: '未运行',
  completed: '已完成',
  failed: '审查失败（与任务成败无关）',
});

/** Chinese labels for review verdicts. */
export const REVIEW_VERDICT_LABELS = Object.freeze({
  approve: '建议通过',
  'changes-requested': '建议修改',
  unknown: '未给出结论',
});

/** Chinese labels for the four connectivity layers. */
export const CONNECTIVITY_LAYERS = Object.freeze([
  { key: 'transport', label: '传输（地址可达）' },
  { key: 'authentication', label: '认证（凭据可用）' },
  { key: 'catalog', label: '模型目录' },
  { key: 'modelResponse', label: '模型实际响应' },
]);

/** Bounds mirrored from the host validator, used for input attributes only. */
export const LIMITS = Object.freeze({
  timeoutSecondsMin: 30,
  timeoutSecondsMax: 7200,
  maxParallelismMin: 1,
  maxParallelismMax: 8,
  taskGrantTtlSecondsMin: 30,
  taskGrantTtlSecondsMax: 3600,
  sessionGrantTtlSecondsMin: 60,
  sessionGrantTtlSecondsMax: 43200,
  providers: 32,
});

/**
 * Actions the Codex panel may send.
 *
 * `status` is deliberately absent: it is a `GET`, so a page that only renders the
 * panel can never be mistaken for one that changes files.
 */
export const CODEX_ACTIONS = Object.freeze(['install', 'repair', 'remove']);

/**
 * The three states the panel reports separately.
 *
 * They are independent on purpose: an agent can be installed while MCP is not
 * configured, and both can be ready while the local-call switch is still off.
 */
export const CODEX_TARGETS = Object.freeze([
  { key: 'agent', label: 'Codex 子智能体文件' },
  { key: 'mcp', label: 'Codex MCP 条目' },
  { key: 'switch', label: 'DSH 本机调用开关' },
]);

/** Chinese labels for the managed-file states the host reports. */
export const CODEX_STATE_LABELS = Object.freeze({
  'not-installed': '未安装',
  installed: '已安装',
  outdated: '旧版本，可更新',
  modified: '不属于已知版本（插件不会改动）',
  conflict: '存在冲突（插件不会改动）',
  'not-configured': '未配置',
  configured: '已配置',
  unreadable: '无法读取（不会写入）',
});

/**
 * Read one target's status out of a served Codex document, in the panel's terms.
 *
 * Kept as a pure function so the UI and its tests agree on exactly one mapping,
 * and so an older/newer host that omits a block yields "未知" instead of a crash.
 * @param {object | null} codex - served `codex` document.
 * @param {object | null} switchState - served `switch` block, when present.
 * @param {'agent'|'mcp'|'switch'} target - which state to describe.
 * @returns {{ key: string, label: string, state: string, tone: string, detail: string }} description.
 */
export function codexTargetView(codex, switchState, target) {
  const label = CODEX_TARGETS.find((entry) => entry.key === target)?.label ?? target;
  if (target === 'switch') {
    const authorized = switchState?.authorized === true;
    return {
      key: 'switch',
      label,
      state: authorized ? 'on' : 'off',
      tone: authorized ? 'on' : 'off',
      detail: authorized
        ? '已开启：Codex 可以通过 MCP 提交任务。'
        : '已关闭：Codex 可以查询状态，但新任务会被拒绝；本页不会替你打开它。',
    };
  }
  const block = target === 'agent' ? codex?.agent : codex?.mcp;
  if (block === null || block === undefined || typeof block !== 'object') {
    return { key: target, label, state: 'unknown', tone: 'off', detail: '宿主尚未回报该状态。' };
  }
  const state = String(block.state ?? 'unknown');
  const done = target === 'agent' ? block.installed === true : block.configured === true;
  const detailParts = [];
  if (typeof block.path === 'string' && block.path !== '') detailParts.push(block.path);
  if (target === 'mcp' && typeof block.script === 'string' && block.script !== '') {
    detailParts.push(`入口：${block.script}`);
  }
  // The executable Codex will launch. `node === null` means this host could not prove
  // one — a desktop application executable is never used and a bare `node` is never
  // written — so the row states the missing fact instead of showing a blank.
  if (target === 'mcp') {
    if (typeof block.node === 'string' && block.node !== '') detailParts.push(`Node：${block.node}`);
    else if (block.nodeResolved === false) detailParts.push('Node：未确定（不会写入桌面应用自身的 exe）');
  }
  return {
    key: target,
    label,
    state,
    tone: done ? 'on' : (state === 'conflict' || state === 'unreadable' || state === 'modified') ? 'warn' : 'off',
    detail: CODEX_STATE_LABELS[state] ?? state,
    path: typeof block.path === 'string' ? block.path : '',
    paths: detailParts,
  };
}

/**
 * One-line summary of an action outcome, for the notice strip.
 * @param {object | null} outcome - `{ action, changed, refused }` from the host.
 * @returns {string} Chinese summary; empty when there was no action.
 */
export function describeCodexOutcome(outcome) {
  if (outcome === null || outcome === undefined) return '';
  const names = { agent: '子智能体文件', mcp: 'MCP 条目' };
  const changed = Array.isArray(outcome.changed) ? outcome.changed.map((key) => names[key] ?? key) : [];
  const refused = Array.isArray(outcome.refused) ? outcome.refused : [];
  const parts = [];
  if (changed.length > 0) parts.push(`已写入：${changed.join('、')}`);
  if (refused.length > 0) parts.push(`未改动：${refused.map((entry) => names[entry?.target] ?? entry?.target ?? '未知').join('、')}`);
  if (parts.length === 0) {
    return outcome.action === 'remove' ? '没有需要移除的插件托管文件。' : '已是最新，没有需要写入的内容。';
  }
  return parts.join('；') + '。';
}

/** Provider protocols this stage supports. */
export const SUPPORTED_PROTOCOLS = Object.freeze(['openai-chat']);

// ---------------------------------------------------------------------------
// Settings draft
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {object} deep JSON clone. */
export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * The document shape a fresh install stores.
 * @returns {object} default editable document.
 */
export function defaultDraft() {
  return {
    schemaVersion: 1,
    delegationEnabled: false,
    providers: [],
    worker: {
      providerId: null,
      model: null,
      reasoningEffort: null,
      timeoutSeconds: 1800,
      maxParallelism: 1,
      isolation: 'worktree',
    },
    review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 14400 },
    projectOverrides: {},
    presets: [],
    // Deprecated and inert, kept only so a save round-trips the stored document
    // instead of rewriting it. There is no conversation-mode control: a submission
    // starts a new DSH conversation unless it names `continueFromTaskId`.
    conversation: { mode: CONVERSATION_MODES[0] },
  };
}

/**
 * Turn a served public settings document into an editable draft.
 *
 * The `secrets` block the host adds is documentation, not settings, and is
 * dropped here so it can never be echoed back in a write.
 * @param {object | null} document - `settings` from `GET /settings`.
 * @returns {object} editable document.
 */
export function draftFromSettings(document) {
  const source = document ?? {};
  const base = defaultDraft();
  return {
    schemaVersion: typeof source.schemaVersion === 'number' ? source.schemaVersion : base.schemaVersion,
    delegationEnabled: source.delegationEnabled === true,
    providers: Array.isArray(source.providers)
      ? source.providers.map((provider) => ({
        id: String(provider.id ?? ''),
        name: String(provider.name ?? ''),
        source: provider.source ?? 'custom',
        protocol: provider.source === 'native' ? null : String(provider.protocol ?? 'openai-chat'),
        baseUrl: provider.source === 'native' ? null : String(provider.baseUrl ?? ''),
        credentialRef: provider.source === 'native' ? null : (provider.credentialRef ?? null),
        models: Array.isArray(provider.models)
          ? provider.models.map((model) => ({
            id: String(model.id ?? ''),
            efforts: Array.isArray(model.efforts) ? [...model.efforts] : [],
          }))
          : [],
      }))
      : [],
    worker: { ...base.worker, ...(source.worker ?? {}) },
    review: { ...base.review, ...(source.review ?? {}) },
    authorization: { ...base.authorization, ...(source.authorization ?? {}) },
    projectOverrides: clone(source.projectOverrides ?? {}),
    presets: Array.isArray(source.presets)
      ? source.presets.map((preset) => ({
        id: String(preset.id ?? ''),
        name: String(preset.name ?? preset.id ?? ''),
        worker: preset.worker === null || preset.worker === undefined ? null : { ...preset.worker },
        review: preset.review === null || preset.review === undefined ? null : { ...preset.review },
      }))
      : [],
    // Read back through the same resolver the save path uses, so a document written
    // before this field existed opens with the default and an inert stored `reuse`
    // is preserved verbatim rather than silently rewritten.
    conversation: conversationOf(source),
  };
}

/**
 * Project a draft onto the exact document `POST /settings` accepts.
 * @param {object} draft - editable document.
 * @returns {object} write body value (no `secrets`, no UI-only fields).
 */
export function documentFromDraft(draft) {
  const source = draft ?? defaultDraft();
  return {
    schemaVersion: source.schemaVersion ?? 1,
    delegationEnabled: source.delegationEnabled === true,
    providers: (source.providers ?? []).map((provider) => {
      const common = {
        id: provider.id,
        name: provider.name,
        source: provider.source ?? 'custom',
        models: (provider.models ?? []).map((model) => ({ id: model.id, efforts: [...(model.efforts ?? [])] })),
      };
      if (common.source === 'native') return common;
      return {
        ...common,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        credentialRef: provider.credentialRef === '' ? null : (provider.credentialRef ?? null),
      };
    }),
    worker: { ...source.worker },
    review: { ...source.review },
    authorization: { ...source.authorization },
    projectOverrides: clone(source.projectOverrides ?? {}),
    presets: (source.presets ?? []).map((preset) => ({
      id: preset.id,
      name: preset.name,
      ...(preset.worker === null ? {} : { worker: { ...preset.worker } }),
      ...(preset.review === null ? {} : { review: { ...preset.review } }),
    })),
    // Sent on every save only so the round-trip is faithful. It is inert: the host
    // validates it as a retired value and no run consults it.
    conversation: conversationOf(source),
  };
}

/**
 * Nonsecret export text: exactly the public document, formatted for reading.
 *
 * There is no credential value anywhere in a settings document, so an export is
 * safe by construction; the label says so to stop anyone assuming otherwise.
 * @param {object} draft - editable document.
 * @returns {string} JSON text with a trailing newline.
 */
export function exportDocument(draft) {
  return `${JSON.stringify(documentFromDraft(draft), null, 2)}\n`;
}

/**
 * Compose the effective execution snapshot for display.
 *
 * This mirrors `resolveEffectiveConfig` closely enough to show the operator what
 * a save will produce. It is a *preview*: the host composes the snapshot it
 * actually runs with, `catalog.effective` shows that, and job details show the
 * immutable snapshot a running job took.
 * @param {object} draft - editable document.
 * @param {string | null} [projectPath] - optional project layer.
 * @returns {{ worker: object, review: object, applied: string[] }} preview.
 */
export function previewEffective(draft, projectPath = null) {
  const applied = [];
  let worker = { ...(draft?.worker ?? {}) };
  let review = { ...(draft?.review ?? {}) };
  const overrides = draft?.projectOverrides ?? {};
  if (typeof projectPath === 'string' && projectPath.trim() !== '') {
    const wanted = projectPath.trim().replace(/[\\/]+$/, '');
    const key = Object.keys(overrides).find((candidate) => (
      candidate === wanted || candidate.toLowerCase() === wanted.toLowerCase()
    ));
    if (key !== undefined) {
      const block = overrides[key] ?? {};
      if (block.worker !== undefined && block.worker !== null) {
        worker = { ...worker, ...block.worker };
        applied.push('项目覆盖：执行设置');
      }
      if (block.review !== undefined && block.review !== null) {
        review = { ...review, ...block.review };
        applied.push('项目覆盖：附加审查');
      }
    }
  }
  if (review.enabled !== true) review = { enabled: false, providerId: null, model: null, reasoningEffort: null };
  return {
    worker: { ...worker, providerRoute: worker.providerId ?? null },
    review: { ...review, providerRoute: review.providerId ?? null },
    applied,
  };
}

/**
 * Reusable presets and project overrides live inside the same settings document,
 * so the export above already carries them.

 * @param {object} draft - editable document.
 * @returns {string[]} duplicate provider ids.
 */
export function duplicateProviderIds(draft) {
  const seen = new Set();
  const duplicates = new Set();
  for (const provider of draft?.providers ?? []) {
    if (seen.has(provider.id)) duplicates.add(provider.id);
    seen.add(provider.id);
  }
  return [...duplicates];
}

/**
 * Pre-flight checks for the write button.
 *
 * These are *operator convenience*: they catch a blank field or a numeric field
 * that is not a number before a round trip. They are not the authority — the
 * host re-validates everything and its refusal is what the page reports.
 * @param {object} draft - editable document.
 * @returns {string[]} Chinese problem descriptions; empty when plausible.
 */
export function precheckDraft(draft) {
  const problems = [];
  const providers = draft?.providers ?? [];
  const ids = new Set();
  for (const provider of providers) {
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(provider.id ?? ''))) {
      problems.push(`提供方标识「${provider.id || '（空）'}」需为 3–40 位小写字母、数字或连字符`);
    }
    if (ids.has(provider.id)) problems.push(`提供方标识「${provider.id}」重复`);
    ids.add(provider.id);
    if (!String(provider.name ?? '').trim()) problems.push(`提供方「${provider.id}」缺少显示名称`);
    if (provider.source !== 'native' && !String(provider.baseUrl ?? '').trim()) {
      problems.push(`提供方「${provider.id}」缺少接口地址`);
    }
    const modelIds = new Set();
    for (const model of provider.models ?? []) {
      if (!String(model.id ?? '').trim()) problems.push(`提供方「${provider.id}」存在空的模型 ID`);
      if (modelIds.has(model.id)) problems.push(`提供方「${provider.id}」的模型「${model.id}」重复`);
      modelIds.add(model.id);
    }
  }
  for (const [role, block] of [['执行设置', draft?.worker], ['附加审查', draft?.review]]) {
    if (role === '附加审查' && block?.enabled !== true) continue;
    if (block?.providerId === null || block?.providerId === undefined) {
      if (role === '执行设置' && providers.length > 0) problems.push('执行设置尚未选择提供方');
      continue;
    }
    const provider = providers.find((entry) => entry.id === block.providerId);
    if (provider === undefined) {
      problems.push(`${role}选择了未配置的提供方「${block.providerId}」`);
      continue;
    }
    const model = (provider.models ?? []).find((entry) => entry.id === block.model);
    if (model === undefined) {
      problems.push(`${role}的模型「${block.model ?? '（空）'}」不在提供方「${provider.id}」的模型列表中`);
    } else if (block.reasoningEffort !== null && block.reasoningEffort !== undefined
      && !(model.efforts ?? []).includes(block.reasoningEffort)) {
      problems.push(`${role}的推理强度「${block.reasoningEffort}」不是模型「${model.id}」声明的能力`);
    }
  }
  const timeout = Number(draft?.worker?.timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < LIMITS.timeoutSecondsMin || timeout > LIMITS.timeoutSecondsMax) {
    problems.push(`超时需为 ${LIMITS.timeoutSecondsMin}–${LIMITS.timeoutSecondsMax} 秒之间的整数`);
  }
  const parallelism = Number(draft?.worker?.maxParallelism);
  if (!Number.isInteger(parallelism) || parallelism < LIMITS.maxParallelismMin || parallelism > LIMITS.maxParallelismMax) {
    problems.push(`最大并发需为 ${LIMITS.maxParallelismMin}–${LIMITS.maxParallelismMax} 之间的整数`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

/**
 * Chinese label for a task state, falling back to the raw state.
 * @param {string} state - engine state.
 * @returns {string} label.
 */
export function taskStateLabel(state) {
  return TASK_STATE_LABELS[state] ?? String(state ?? '未知状态');
}

/**
 * Whether a task may still be cancelled.
 * @param {string} state - engine state.
 * @returns {boolean} true for non-terminal states.
 */
export function isCancellable(state) {
  return state === 'pending' || state === 'running';
}

/**
 * Chinese label for a task phase, falling back to the raw value.
 * @param {string} phase - engine phase.
 * @returns {string} label.
 */
export function taskPhaseLabel(phase) {
  if (typeof phase !== 'string' || phase === '') return '—';
  return TASK_PHASE_LABELS[phase] ?? phase;
}

/**
 * Whether a task is currently waiting for a per-call permission decision.
 *
 * Read from the task's own permission block when it is present and from the phase
 * otherwise (an older host reports only the phase). It is a WAIT, not a failure and
 * not an execution result, which is what the panel has to say.
 * @param {object} task - task view.
 * @returns {boolean} true when a decision is outstanding.
 */
export function isAwaitingPermission(task) {
  if (task?.permission?.waiting === true) return true;
  return task?.phase === 'awaiting-permission';
}

/**
 * The pending per-call permission request of one task, or `null`.
 * @param {object} task - task view.
 * @returns {object | null} the pending request.
 */
export function pendingPermission(task) {
  const pending = task?.permission?.pending ?? null;
  return pending !== null && typeof pending === 'object' ? pending : null;
}

/**
 * One-line, plain-Chinese summary of what a task's permission state means.
 *
 * It never says "已批准" for a task, because a decision covers one call and not the
 * task: an `allow-once` is reported as "仅本次调用可继续", and a rejection as "该调用
 * 被拒绝", with the task itself still running.
 * @param {object} task - task view.
 * @returns {{ waiting: boolean, label: string, note: string, detail: string }} summary.
 */
export function permissionSummary(task) {
  const permission = task?.permission ?? null;
  const waiting = isAwaitingPermission(task);
  if (waiting) {
    const pending = pendingPermission(task);
    const tool = pending?.toolName ?? '未知工具';
    const access = pending?.requestedAccess?.mode;
    return {
      waiting: true,
      label: '等待本次调用授权决定',
      note: access === null || access === undefined
        ? `工作进程暂停在 ${tool} 这一次调用上，等待本机指挥官决定。任务仍在运行，未失败，也未完成。`
        : `工作进程暂停在 ${tool} 这一次调用上，请求把该次调用的沙箱权限提升到 ${access}，等待本机指挥官决定。`
          + '无论是否允许，会话的常规权限（workspace-write）保持不变。',
      detail: `请求编号 ${pending?.requestId ?? '—'} · 调用 ${pending?.callId ?? '—'}`,
    };
  }
  if (permission === null || permission === undefined) {
    return { waiting: false, label: '未使用逐次授权桥', note: '本次任务未挂载逐次授权桥：工作进程的提权请求会被直接拒绝，不会等待。', detail: '' };
  }
  const evidence = Array.isArray(permission.evidence) ? permission.evidence : [];
  if (evidence.length === 0) {
    return { waiting: false, label: '本次任务尚无授权请求', note: '暂无。请求出现时，该次调用会暂停，并在这里显示。', detail: '' };
  }
  const last = evidence[evidence.length - 1];
  const outcome = PERMISSION_OUTCOME_LABELS[last?.outcome] ?? last?.outcome ?? '未知结果';
  return {
    waiting: false,
    label: '最近一次决定',
    note: `最近一次调用授权请求：${outcome}。该决定只对那一次调用有效，不构成常规权限，也不会被后续调用复用。`,
    detail: `请求编号 ${last?.requestId ?? '—'}（共 ${evidence.length} 条记录）`,
  };
}

/**
 * Honest execution/acceptance summary for one task.
 *
 * The engine reports `awaiting-host-review` after successful execution. That is
 * not acceptance: `selfApproved` is always false and `hostAcceptance` is null
 * until the host records its own decision, so the summary never says "验收通过".
 * @param {object} task - task view.
 * @returns {{ label: string, executed: boolean, accepted: boolean, note: string }} summary.
 */
export function taskOutcome(task) {
  const state = String(task?.state ?? '');
  const accepted = task?.hostAcceptance !== null && task?.hostAcceptance !== undefined;
  const executed = state === 'awaiting-host-review' || accepted === true;
  const note = state === 'awaiting-host-review'
    ? '执行已完成，等待宿主（Codex）审查；插件不会自行验收。'
    : accepted === true
      ? '宿主已记录验收结论。'
      : state === 'failed'
        ? '执行失败；错误详情见下方证据。'
        : state === 'cancelled'
          ? '任务已取消，未产生验收结论。'
          : '任务尚未产生结果。';
  return { label: taskStateLabel(state), executed, accepted, note };
}

/**
 * Discoverable changed-file list in a task's diff payload.
 *
 * The engine's `diff.files` entries carry `{ code, path, from, status, sensitive }`;
 * older or partial payloads may carry plain strings instead. Anything else
 * returns `null`, and the page then shows the bounded raw diff rather than
 * inventing a summary.
 * @param {object} task - task view.
 * @returns {string[] | null} one display line per changed file, or null.
 */
export function changedFiles(task) {
  const candidates = [task?.diff?.files, task?.diff?.changedFiles, task?.changedFiles];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const files = [];
    for (const entry of candidate) {
      if (typeof entry === 'string') {
        if (entry !== '') files.push(entry);
        continue;
      }
      const path = entry?.path ?? entry?.file;
      if (typeof path !== 'string' || path === '') continue;
      const code = typeof entry?.status === 'string' && entry.status !== ''
        ? entry.status
        : (typeof entry?.code === 'string' && entry.code !== '' ? entry.code : null);
      const from = typeof entry?.from === 'string' && entry.from !== '' ? entry.from : null;
      const label = from === null ? path : `${from} → ${path}`;
      // A withheld file is flagged rather than hidden: the operator must be able
      // to see that something changed without seeing its content.
      const mark = entry?.sensitive === true ? '（内容已扣留）' : '';
      files.push(code === null ? `${label}${mark}` : `${code} ${label}${mark}`);
    }
    if (files.length > 0) return files;
  }
  return null;
}

/**
 * Bounded, single-line-safe text for a monospace block.
 * @param {unknown} value - any server text.
 * @param {number} [max] - maximum characters kept.
 * @returns {string} text.
 */
export function boundedText(value, max = 20_000) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

/**
 * Format a millisecond timestamp for display.
 * @param {number | null | undefined} value - epoch milliseconds.
 * @returns {string} local time, or an em dash.
 */
export function formatTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return new Date(value).toISOString();
  }
}

/**
 * State of one grant, derived from its four timestamps.
 * @param {object} grant - grant view.
 * @param {number} now - current epoch milliseconds.
 * @returns {{ key: string, label: string }} state.
 */
export function grantState(grant, now = Date.now()) {
  if (grant?.revokedAt !== null && grant?.revokedAt !== undefined) return { key: 'revoked', label: '已撤销' };
  if (grant?.consumedAt !== null && grant?.consumedAt !== undefined) return { key: 'consumed', label: '已使用（单次授权已用完）' };
  if (typeof grant?.expiresAt === 'number' && grant.expiresAt <= now) return { key: 'expired', label: '已过期' };
  return { key: 'live', label: '有效' };
}

/**
 * Chinese, actionable description of one failure.
 * @param {unknown} error - `ApiError` or anything else.
 * @returns {string} message with the stable code appended for support purposes.
 */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const messages = {
    USER_PLANE_UNREACHABLE: '无法连接宿主设置接口：请确认 DSH 网页仍在运行，并刷新页面后重试。',
    USER_PLANE_MALFORMED: '宿主返回了无法识别的内容。',
    SETTINGS_MISSING: '请求中没有设置文档。',
    SETTINGS_INVALID: '设置内容不合法，已保留你的草稿。',
    SETTINGS_NO_PROVIDERS: '至少需要配置一个提供方。',
    SETTINGS_SCHEMA_UNSUPPORTED: '设置文档版本不被当前插件支持。',
    PROVIDER_ID_INVALID: '提供方标识格式不合法。',
    PROVIDER_NAME_INVALID: '提供方显示名称不合法。',
    PROVIDER_BASE_URL_INVALID: '接口地址不合法（需为 http/https，且不得包含账号密码、查询串或片段）。',
    PROVIDER_CREDENTIAL_REF_INVALID: '凭据引用名不合法（需为环境变量风格名称）。',
    PROVIDER_PROTOCOL_UNSUPPORTED: '该协议当前不受支持。',
    PROVIDER_SECRET_IN_SETTINGS: '设置文档中不能包含密钥；请使用单独的凭据输入框。',
    PROVIDER_DUPLICATE: '提供方标识重复。',
    PROVIDER_IN_USE: '该提供方仍被当前设置引用，无法删除。',
    MODEL_INVALID: '模型条目不合法。',
    MODEL_DUPLICATE: '模型 ID 重复。',
    MODEL_EFFORTS_INVALID: '模型的推理强度声明不合法。',
    SELECTION_PROVIDER_REQUIRED: '请选择提供方。',
    SELECTION_PROVIDER_UNKNOWN: '所选提供方未配置。',
    SELECTION_MODEL_REQUIRED: '请选择模型。',
    SELECTION_MODEL_UNKNOWN: '所选模型不在该提供方的模型列表中。',
    SELECTION_EFFORT_UNKNOWN: '推理强度取值不存在。',
    SELECTION_EFFORT_UNSUPPORTED: '该模型未声明此推理强度。',
    WORKER_TIMEOUT_INVALID: '超时时间超出允许范围。',
    WORKER_PARALLELISM_INVALID: '最大并发超出允许范围。',
    WORKER_ISOLATION_INVALID: '工作区隔离方式不受支持。',
    AUTHORIZATION_INVALID: '授权有效期取值不合法。',
    PRESET_INVALID: '预设内容不合法。',
    PRESET_DUPLICATE: '预设标识重复。',
    PROJECT_OVERRIDE_INVALID: '项目覆盖内容不合法。',
    PROJECT_OVERRIDE_DUPLICATE: '同一项目存在重复覆盖。',
    CONNECTION_ID_REQUIRED: '缺少连接标识。',
    CONNECTION_UNKNOWN: '该连接不存在或已失效。',
    CONNECTION_LIMIT: '连接数量已达上限，请先撤销不用的连接。',
    GRANT_ID_REQUIRED: '缺少授权标识。',
    GRANT_UNKNOWN: '该授权不存在。',
    GRANT_KIND_INVALID: '授权范围不合法。',
    GRANT_TTL_INVALID: '授权有效期不合法。',
    GRANT_LIMIT: '授权数量已达上限。',
    GRANT_MISMATCH: '该授权不适用于当前连接或工作区。',
    JOB_TASK_NOT_FOUND: '任务不存在或已被清理。',
    PROVIDER_ID_REQUIRED: '请选择一个提供方。',
    PROVIDER_UNKNOWN: '该提供方不在当前设置中，请先保存配置文件。',
    PROVIDER_CREDENTIAL_REF_MISSING: '该提供方未声明凭据引用名，无法保存密钥；请先在提供方设置中填写引用名。',
    CREDENTIAL_EMPTY: '请先输入密钥内容。',
    CREDENTIAL_VALUE_REQUIRED: '请先输入密钥内容；如需删除请使用「清除密钥」。',
    CREDENTIAL_VALUE_TOO_LARGE: '密钥内容超出长度上限。',
    CREDENTIAL_OPERATION_FAILED: '宿主凭据服务拒绝了本次操作。',
    CREDENTIAL_READ_ONLY: '该凭据引用为只读（由外部环境提供），无法在此修改。',
    CREDENTIAL_REF_INVALID: '凭据引用名不合法。',
    CREDENTIAL_SEAM_UNAVAILABLE: '当前宿主尚未提供凭据写入接口，密钥无法保存。',
    ROUTING_PROVIDER_NOT_REGISTERED: '该提供方尚未注册到宿主模型路由中。',
    ROUTING_MODEL_UNRESOLVED: '该模型无法在宿主模型路由中解析。',
    ROUTING_EFFORT_UNSUPPORTED: '该模型不支持所选推理强度。',
    ROUTING_SERVICE_UNAVAILABLE: '宿主模型服务当前不可用。',
    // Remote model discovery: each code is a different fix, so each gets its own
    // sentence. None of them can quote the endpoint, the credential or the body.
    DISCOVERY_PROVIDER_UNKNOWN: '未找到该提供方配置。',
    DISCOVERY_BASE_URL_INVALID: '接口地址不可用于获取模型列表（需为 http/https，且不含账号密码、查询串或片段）。',
    DISCOVERY_CREDENTIAL_REF_MISSING: '该提供方未设置凭据引用名，无法向提供方取模型；请先填写引用名并保存。',
    DISCOVERY_CREDENTIAL_SEAM_UNAVAILABLE: '当前宿主未提供凭据服务，无法带上密钥向提供方取模型。',
    DISCOVERY_CREDENTIAL_UNAVAILABLE: '宿主凭据服务无法读取该引用名对应的密钥。',
    DISCOVERY_CREDENTIAL_NOT_CONFIGURED: '该凭据引用名尚未保存密钥，请先在「密钥」处保存。',
    DISCOVERY_CREDENTIAL_EMPTY: '该凭据引用名的密钥内容为空，请重新保存。',
    DISCOVERY_AUTH_REFUSED: '提供方拒绝了该密钥（401/403）：请确认密钥是否有效、是否属于该接口地址。',
    DISCOVERY_HTTP_ERROR: '提供方返回了错误状态码；详情见上方诊断。',
    DISCOVERY_REDIRECT_REFUSED: '提供方返回了重定向，为保护密钥没有跟随；请直接填写最终接口地址。',
    DISCOVERY_NETWORK_FAILED: '无法连接提供方接口地址：请检查地址、端口与网络。',
    DISCOVERY_TIMEOUT: '提供方在规定时间内没有响应，请稍后重试。',
    DISCOVERY_CANCELLED: '获取模型的请求已被取消。',
    DISCOVERY_MALFORMED_RESPONSE: '提供方返回的内容不是可识别的模型列表（需要 OpenAI 兼容的 {"data":[{"id":...}]}）。',
    DISCOVERY_BODY_TOO_LARGE: '提供方返回的内容超过大小上限，已中止读取。',
    USER_PLANE_METHOD_NOT_ALLOWED: '该请求方法不被允许。',
  };
  const known = messages[code];
  if (known !== undefined) return `${known}（${code}）`;
  if (code.startsWith('HTTP_')) return `宿主返回 ${code.slice(5)}，请刷新后重试。`;
  const detail = typeof error?.message === 'string' && error.message !== '' ? error.message.slice(0, 200) : '未知错误';
  return code === '' ? detail : `${detail}（${code}）`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Create the page store.
 *
 * The store owns the served data, the editable draft, and the transients an
 * operator asked for (a model catalog, a connectivity report, a one-time token).
 * It never owns a credential value: {@link DelegateStore#setCredential} forwards
 * one and forgets it.
 * @param {object} options - `api` transport, `now` clock.
 * @returns {object} store with `subscribe`, `getSnapshot` and action methods.
 */
export function createStore(options = {}) {
  const api = options.api ?? createApi();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let state = {
    revision: 0,
    loading: {},
    notices: [],
    status: null,
    nativeProviders: [],
    nativeProvidersError: null,
    settings: null,
    draft: null,
    dirty: false,
    catalog: null,
    catalogError: null,
    modelCatalog: {},
    connections: [],
    selectedConnectionId: null,
    grants: [],
    tasks: [],
    taskDetail: null,
    token: null,
    tokenConnectionId: null,
    credentials: {},
    connectivity: {},
    // Codex integration. `codex` holds the last served status document,
    // `codexError` its last refusal, `codexOutcome` the last action's result. None
    // of them is a credential: the status document is a file/config diagnosis.
    codex: null,
    codexError: null,
    codexOutcome: null,
  };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  let disposed = false;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A subscriber's own render error must not break the store.
      }
    }
  }

  function patch(next) {
    if (disposed) return;
    state = { ...state, ...next, revision: state.revision + 1 };
    emit();
  }

  /**
   * Append one operator-facing message.
   * @param {'info'|'error'|'success'} level - severity.
   * @param {string} text - Chinese text.
   * @returns {number} notice id.
   */
  function notify(level, text) {
    const id = state.revision + 1 + Math.random();
    patch({ notices: [...state.notices, { id, level, text }].slice(-6) });
    return id;
  }

  function dismissNotice(id) {
    patch({ notices: state.notices.filter((notice) => notice.id !== id) });
  }

  async function track(key, work) {
    patch({ loading: { ...state.loading, [key]: true } });
    try {
      return await work();
    } finally {
      if (!disposed) patch({ loading: { ...state.loading, [key]: false } });
    }
  }

  const store = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return state;
    },
    notify,
    dismissNotice,

    /** Read the delegation posture. */
    async refreshStatus() {
      return await track('status', async () => {
        try {
          const body = await api.getStatus();
          patch({ status: body });
          return { ok: true, body };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Load configured provider connections from the native DSH registry. */
    async loadNativeProviders() {
      return await track('nativeProviders', async () => {
        try {
          const body = await api.getNativeProviders();
          patch({ nativeProviders: Array.isArray(body.providers) ? body.providers : [], nativeProvidersError: body.error ?? null });
          return { ok: true, providers: body.providers ?? [], error: body.error ?? null };
        } catch (error) {
          patch({ nativeProvidersError: describeError(error) });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Persist and immediately apply the single authorization switch. */
    async setDelegationEnabled(enabled) {
      if (typeof enabled !== 'boolean') return { ok: false };
      return await track('delegationSwitch', async () => {
        try {
          const body = await api.setDelegationEnabled(enabled);
          const settings = state.settings === null ? null : { ...state.settings, delegationEnabled: enabled };
          const draft = state.draft === null ? null : { ...state.draft, delegationEnabled: enabled };
          patch({ status: { ...(state.status ?? {}), delegation: body.delegation }, settings, draft });
          notify('success', enabled ? '本机 DSH 委派已开启。' : '本机 DSH 委派已关闭，运行中的任务已请求停止。');
          return { ok: true, delegation: body.delegation };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Read the committed document (and reset the draft unless it is dirty). */
    async loadSettings() {
      return await track('settings', async () => {
        try {
          const body = await api.getSettings();
          patch({
            settings: body.settings ?? null,
            draft: state.dirty && state.draft !== null ? state.draft : draftFromSettings(body.settings),
            ...(state.dirty && state.draft !== null ? {} : { dirty: false }),
          });
          return { ok: true, settings: body.settings ?? null };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Read the served catalog (models, effort capabilities, effective config). */
    async loadCatalog(projectPath = null) {
      return await track('catalog', async () => {
        try {
          const body = await api.getCatalog(projectPath === null ? {} : { projectPath });
          patch({ catalog: body, catalogError: null });
          return { ok: true, catalog: body };
        } catch (error) {
          patch({ catalogError: { code: error?.code ?? '', text: describeError(error) } });
          return { ok: false, error };
        }
      });
    },

    /** Read the connection list. */
    async loadConnections() {
      return await track('connections', async () => {
        try {
          const body = await api.listConnections();
          const connections = Array.isArray(body.connections) ? body.connections : [];
          const live = connections.filter((entry) => entry.revoked !== true);
          const selected = connections.some((entry) => entry.connectionId === state.selectedConnectionId && entry.revoked !== true)
            ? state.selectedConnectionId
            : (live[0]?.connectionId ?? null);
          patch({ connections, selectedConnectionId: selected });
          if (selected !== null && selected !== state.selectedConnectionId) await store.loadGrants(selected);
          return { ok: true, connections };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Issue a connection. The token is kept in memory, tied to its connection id.
     * @param {string} label - display label.
     */
    async issueConnection(label) {
      return await track('issueConnection', async () => {
        try {
          const body = await api.issueConnection(String(label ?? '').trim() || 'codex');
          patch({
            token: typeof body.token === 'string' ? body.token : null,
            tokenConnectionId: body.connection?.connectionId ?? null,
            selectedConnectionId: body.connection?.connectionId ?? state.selectedConnectionId,
          });
          await store.loadConnections();
          notify('success', '连接已签发。授权令牌只显示这一次，请立即复制到 MCP 宿主配置。');
          return { ok: true, connection: body.connection, token: body.token };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Drop the one-time token from memory. */
    clearToken() {
      patch({ token: null, tokenConnectionId: null });
    },

    /**
     * Revoke one connection (and every grant it holds).
     * @param {string} connectionId - server-issued identity.
     */
    async revokeConnection(connectionId) {
      return await track('revokeConnection', async () => {
        try {
          const body = await api.revokeConnection(connectionId);
          if (state.tokenConnectionId === connectionId) patch({ token: null, tokenConnectionId: null });
          await store.loadConnections();
          await store.refreshStatus();
          notify('success', `已撤销该连接及其授权（${body.grantsRevoked ?? 0} 条授权）。`);
          return { ok: true, grantsRevoked: body.grantsRevoked ?? 0 };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Revoke every grant and connection ("stop everything now"). */
    async revokeAll() {
      return await track('revokeAll', async () => {
        try {
          const body = await api.revokeAll();
          patch({ token: null, tokenConnectionId: null, grants: [] });
          await store.loadConnections();
          await store.refreshStatus();
          notify('success', `已撤销全部授权与连接（${body.grantsRevoked ?? 0} 条授权）。当前委托已关闭。`);
          return { ok: true, grantsRevoked: body.grantsRevoked ?? 0 };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Select a server-issued connection identity and load its grants.
     * @param {string} connectionId - connection id from the served list.
     */
    async selectConnection(connectionId) {
      patch({ selectedConnectionId: connectionId, grants: [] });
      return await store.loadGrants(connectionId);
    },

    /**
     * Load the grants of one connection.
     * @param {string} connectionId - connection id.
     */
    async loadGrants(connectionId) {
      return await track('grants', async () => {
        try {
          const body = await api.listGrants(connectionId);
          patch({ grants: Array.isArray(body.grants) ? body.grants : [] });
          return { ok: true, grants: body.grants ?? [] };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Issue one grant for the selected connection.
     * @param {object} form - `{ connectionId, kind, workspacePath, ttlSeconds }`.
     */
    async issueGrant(form) {
      const connectionId = form?.connectionId ?? state.selectedConnectionId;
      const workspacePath = String(form?.workspacePath ?? '').trim();
      const kind = form?.kind === 'session' ? 'session' : 'task';
      if (typeof connectionId !== 'string' || connectionId === '') {
        notify('error', '请先签发并选择一个连接，授权只能绑定到宿主签发的连接身份。');
        return { ok: false };
      }
      if (workspacePath === '') {
        notify('error', '请填写授权的绝对工作区路径。');
        return { ok: false };
      }
      return await track('issueGrant', async () => {
        try {
          const body = {
            connectionId,
            kind,
            workspacePath,
          };
          const ttl = Number(form?.ttlSeconds);
          if (Number.isInteger(ttl) && ttl > 0) body.ttlSeconds = ttl;
          const answer = await api.issueGrant(body);
          await store.loadGrants(connectionId);
          await store.refreshStatus();
          notify('success', kind === 'task' ? '已签发单次任务授权（用掉即失效）。' : '已签发本连接会话授权（限时、可撤销）。');
          return { ok: true, grant: answer.grant };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Revoke one grant.
     * @param {string} grantId - grant identity.
     */
    async revokeGrant(grantId) {
      return await track('revokeGrant', async () => {
        try {
          await api.revokeGrant(grantId);
          if (state.selectedConnectionId !== null) await store.loadGrants(state.selectedConnectionId);
          await store.refreshStatus();
          notify('success', '已撤销该授权。');
          return { ok: true };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Apply an edit to the draft.
     * @param {(draft: object) => void} mutate - edits the cloned draft in place.
     */
    editDraft(mutate) {
      const draft = clone(state.draft ?? defaultDraft());
      mutate(draft);
      patch({ draft, dirty: true });
    },

    /** Discard uncommitted edits. */
    resetDraft() {
      patch({ draft: draftFromSettings(state.settings), dirty: false });
    },

    /**
     * Validate the draft locally, then replace the stored document.
     * @returns {Promise<{ ok: boolean, error?: unknown }>} outcome.
     */
    async saveSettings() {
      if (state.draft === null) return { ok: false };
      const problems = precheckDraft(state.draft);
      if (problems.length > 0) {
        notify('error', `未保存：${problems.slice(0, 4).join('；')}`);
        return { ok: false, problems };
      }
      return await track('save', async () => {
        try {
          const body = await api.putSettings(documentFromDraft(state.draft));
          patch({ settings: body.settings ?? null, draft: draftFromSettings(body.settings), dirty: false });
          notify('success', '设置已保存。');
          return { ok: true };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Discover one provider's models from its own API, then keep the result.
     *
     * This is remote discovery, not a catalog read: the host calls the provider's
     * configured endpoint with that provider's credential reference. Consequences
     * this function has to honour:
     *
     *   * an empty list plus a `discovery` diagnosis is a *failure*, not "the
     *     provider serves nothing", so it is reported as one and no merge is
     *     attempted;
     *   * discovery never returns capabilities. New ids arrive with `efforts: []`,
     *     so the operator still has to declare what a model supports;
     *   * a host that predates the route (a carrier 404) gets the old fallback,
     *     which is then labelled honestly as a catalog read rather than as
     *     discovery.
     * @param {string} providerId - provider id.
     */
    async fetchModels(providerId) {
      patch({ loading: { ...state.loading, [`models:${providerId}`]: true } });
      try {
        let models = [];
        let source = 'remote';
        let providerError = null;
        let discovery = null;
        try {
          const body = await api.fetchModels(providerId);
          models = Array.isArray(body.models) ? body.models : [];
          providerError = body.error ?? null;
          discovery = body.discovery ?? null;
          source = typeof body.source === 'string' ? body.source : 'remote';
        } catch (error) {
          // Only a carrier-level 404 means "this host does not serve the route".
          // Our own handler answers 404 with a JSON `PROVIDER_UNKNOWN` code, and
          // that is a real refusal to report, not a reason to fall back.
          const routeMissing = error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE';
          if (!routeMissing) throw error;
          const body = await api.getCatalog({});
          const entry = (body.catalog ?? []).find((candidate) => candidate.providerId === providerId);
          models = Array.isArray(entry?.models) ? entry.models : [];
          providerError = entry?.error ?? null;
          source = 'catalog';
          discovery = {
            attempted: false,
            failed: providerError !== null,
            code: providerError?.code ?? null,
            message: 'this host does not serve model discovery yet; the configured catalog was read instead',
          };
        }
        const failed = source === 'remote' && discovery?.failed === true;
        patch({
          modelCatalog: {
            ...state.modelCatalog,
            [providerId]: { models, source, error: providerError, discovery, fetchedAt: now() },
          },
        });
        if (source === 'catalog') {
          notify('info', '宿主尚未提供从提供方获取模型的接口，已改用模型目录结果（不是远程模型列表）。');
        }
        if (source === 'remote' && discovery?.failed !== true && providerError !== null) {
          notify('error', `提供方「${providerId}」无法解析模型：${providerError.message ?? providerError.code ?? ''}`);
        }
        if (failed) {
          notify('error', `从提供方「${providerId}」获取模型失败：${describeError(providerError ?? discovery)}`);
          return { ok: false, models: [], source, error: providerError };
        }
        return { ok: true, models, source, discovery };
      } catch (error) {
        patch({
          modelCatalog: {
            ...state.modelCatalog,
            [providerId]: {
              models: [],
              source: 'error',
              error: { code: error?.code ?? '', message: describeError(error) },
              discovery: { attempted: true, failed: true, code: error?.code ?? '' },
              fetchedAt: now(),
            },
          },
        });
        notify('error', describeError(error));
        return { ok: false, error };
      } finally {
        if (!disposed) patch({ loading: { ...state.loading, [`models:${providerId}`]: false } });
      }
    },

    /**
     * Merge discovered models into the draft provider, keeping manual-only entries.
     *
     * The asymmetry is the point: a model the operator already declared keeps its
     * declared `efforts` (discovery cannot lend or revoke a capability), a newly
     * discovered id arrives with no efforts at all, and an id the endpoint did not
     * list is never removed — a manual entry stays configured.
     * @param {string} providerId - provider id.
     * @param {object[]} models - `[{ id, efforts }]`.
     */
    mergeModelsIntoDraft(providerId, models) {
      store.editDraft((draft) => {
        const provider = draft.providers.find((entry) => entry.id === providerId);
        if (provider === undefined) return;
        for (const model of models) {
          if (typeof model?.id !== 'string' || model.id === '') continue;
          const existing = provider.models.find((entry) => entry.id === model.id);
          if (existing !== undefined) {
            // Nothing to do: the operator's own declaration wins, and discovery
            // never returns a capability to fill in.
            continue;
          }
          const served = Array.isArray(model.efforts) ? [...model.efforts] : [];
          provider.models.push({ id: model.id, efforts: served });
        }
      });
    },

    /**
     * Read whether one provider's credential is configured.
     * @param {string} providerId - provider id.
     */
    async credentialStatus(providerId) {
      patch({ loading: { ...state.loading, [`credential:${providerId}`]: true } });
      try {
        const body = await api.credentialStatus(providerId);
        patch({
          credentials: {
            ...state.credentials,
            [providerId]: { ...(body.credential ?? {}), loaded: true },
          },
        });
        return { ok: true, credential: body.credential };
      } catch (error) {
        patch({
          credentials: {
            ...state.credentials,
            [providerId]: {
              configured: null,
              loaded: true,
              unavailable: true,
              reason: describeError(error),
            },
          },
        });
        return { ok: false, error };
      } finally {
        if (!disposed) patch({ loading: { ...state.loading, [`credential:${providerId}`]: false } });
      }
    },

    /**
     * Forward a credential value to the host and forget it.
     * @param {string} providerId - provider id.
     * @param {string} value - the literal; discarded immediately after the call.
     */
    async setCredential(providerId, value) {
      const literal = typeof value === 'string' ? value : '';
      if (literal.trim() === '') {
        notify('error', describeError(new ApiError('CREDENTIAL_EMPTY', 'no value was entered')));
        return { ok: false };
      }
      return await track(`credential:${providerId}`, async () => {
        try {
          const body = await api.setCredential(providerId, literal);
          patch({
            credentials: { ...state.credentials, [providerId]: { ...(body.credential ?? {}), loaded: true } },
          });
          notify('success', `已保存提供方「${providerId}」的密钥（值不会回显）。`);
          return { ok: true, credential: body.credential };
        } catch (error) {
          // A carrier-level 404 is "this host has no credential route"; a JSON
          // refusal with its own code is a real answer and is shown as such.
          notify('error', error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE'
            ? describeError(new ApiError('CREDENTIAL_SEAM_UNAVAILABLE', 'credential route unavailable'))
            : describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Remove one provider's stored credential.
     * @param {string} providerId - provider id.
     */
    async unsetCredential(providerId) {
      return await track(`credential:${providerId}`, async () => {
        try {
          const body = await api.unsetCredential(providerId);
          patch({
            credentials: { ...state.credentials, [providerId]: { ...(body.credential ?? {}), loaded: true } },
          });
          notify('success', `已清除提供方「${providerId}」的密钥。`);
          return { ok: true, credential: body.credential };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Run one provider's layered connectivity check.
     * @param {object} form - `{ providerId, model, reasoningEffort }`.
     */
    async checkConnectivity(form) {
      const providerId = String(form?.providerId ?? '');
      if (providerId === '') {
        notify('error', '请先选择提供方。');
        return { ok: false };
      }
      return await track(`connectivity:${providerId}`, async () => {
        try {
          const body = { providerId };
          if (typeof form.model === 'string' && form.model !== '') body.model = form.model;
          if (typeof form.reasoningEffort === 'string' && form.reasoningEffort !== '') body.reasoningEffort = form.reasoningEffort;
          const answer = await api.checkConnectivity(body);
          patch({ connectivity: { ...state.connectivity, [providerId]: answer.report ?? null } });
          return { ok: true, report: answer.report };
        } catch (error) {
          patch({ connectivity: { ...state.connectivity, [providerId]: null } });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Read the Codex integration status. Read-only: this is what `init()` calls,
     * so opening the page never writes to the Codex home.
     */
    async refreshCodexStatus() {
      return await track('codexStatus', async () => {
        try {
          const body = await api.getCodexStatus();
          patch({ codex: body.codex ?? null, codexError: null });
          return { ok: true, codex: body.codex ?? null, switch: body.switch ?? null };
        } catch (error) {
          // A host that predates this route answers 404: that is "not served
          // here", not "Codex is not installed", so it is shown as unavailable.
          const unavailable = error?.code === 'HTTP_404' || error?.code === 'USER_PLANE_UNKNOWN_ROUTE';
          patch({
            codex: null,
            codexError: unavailable
              ? '当前宿主未提供 Codex 集成接口（插件版本可能较旧）。'
              : describeError(error),
          });
          return { ok: false, error };
        }
      });
    },

    /**
     * Perform one explicit Codex action and keep its outcome.
     *
     * This is only reachable from a button click: nothing calls it from `init()`,
     * from `saveSettings()` or from a render pass. Installed files are therefore
     * always the result of an operator decision.
     * @param {'install'|'repair'|'remove'} action - action to perform.
     */
    async runCodexAction(action) {
      if (!CODEX_ACTIONS.includes(action)) {
        notify('error', `未知的 Codex 操作：${String(action)}`);
        return { ok: false };
      }
      return await track('codexAction', async () => {
        try {
          const body = await api.runCodexAction(action);
          const outcome = {
            action: body.action ?? action,
            changed: Array.isArray(body.changed) ? body.changed : [],
            refused: Array.isArray(body.refused) ? body.refused : [],
          };
          const codex = body.codex ?? state.codex;
          patch({ codex, codexError: null, codexOutcome: outcome });
          const summary = describeCodexOutcome(outcome);
          const failed = outcome.refused.length > 0;
          notify(failed ? 'error' : 'success', summary === '' ? '操作完成。' : summary);
          return { ok: !failed, outcome, codex };
        } catch (error) {
          patch({ codexOutcome: null });
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Read the task list. */
    async loadTasks() {
      return await track('tasks', async () => {
        try {
          const body = await api.listTasks();
          patch({ tasks: Array.isArray(body.tasks) ? body.tasks : [] });
          return { ok: true, tasks: body.tasks ?? [] };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Read one task with its prompt and evidence.
     * @param {string} taskId - task identity.
     */
    async openTask(taskId) {
      return await track('taskDetail', async () => {
        try {
          const body = await api.getTask(taskId);
          patch({ taskDetail: body.task ?? null });
          return { ok: true, task: body.task };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /**
     * Cancel one task as the operator.
     * @param {string} taskId - task identity.
     */
    async cancelTask(taskId) {
      return await track('cancelTask', async () => {
        try {
          const body = await api.cancelTask(taskId);
          patch({
            tasks: state.tasks.map((task) => (task.taskId === taskId ? { ...task, ...body.task } : task)),
            taskDetail: state.taskDetail?.taskId === taskId ? { ...state.taskDetail, ...body.task } : state.taskDetail,
          });
          notify('success', '已请求取消。');
          return { ok: true, task: body.task };
        } catch (error) {
          notify('error', describeError(error));
          return { ok: false, error };
        }
      });
    },

    /** Load everything the page needs; the catalog is loaded but not awaited. */
    async init() {
      await Promise.all([store.refreshStatus(), store.loadSettings(), store.loadNativeProviders(), store.loadTasks()]);
      // Diagnostic read only. `init` must never perform a Codex write: installing
      // files is an explicit operator action, not a side effect of opening a page.
      void store.refreshCodexStatus();
      void store.loadCatalog();
    },

    /** Release subscriptions and drop the one-time token. */
    dispose() {
      disposed = true;
      state = { ...state, token: null, tokenConnectionId: null };
      listeners.clear();
    },
  };

  return store;
}
