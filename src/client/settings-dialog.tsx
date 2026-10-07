import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Menu,
  Modal,
  StateDot,
  Switch,
  Tooltip,
  IconChevronDownOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular,
  IconUserOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CLI_IDS,
  CLI_LABELS,
  isRetiredCli,
  effortLabel,
  type CliId,
  type ModelChoice,
  type Preference,
} from '../shared/types.ts'
import type { AccountAction, AccountStatus } from '../shared/accounts.ts'
import { modelName } from '../shared/models.ts'
import { visibleModelChoices } from '../shared/model-presentation.ts'
import { AccountTerminal } from './account-terminal.tsx'
import { BrandIcon, Glyph } from './icons.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'
import { RolePresetsPane } from './role-presets.tsx'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  api: API
  sessionId: string
  initialCli: CliId
  openNativeSettings?: () => void
}
interface Catalog {
  cli: CliId
  models: ModelChoice[]
  preference?: Preference
  notice?: string
}
type Enabled = Record<CliId, boolean>
type CatalogConnection = 'unknown' | 'success' | 'failed'
interface AccountEntry {
  loading: boolean
  data?: AccountStatus
  error?: string
}
function readEnabled(raw: string): Enabled {
  const parsed = JSON.parse(raw)
  if (!parsed?.enabled || CLI_IDS.some((id) => typeof parsed.enabled[id] !== 'boolean')) {
    throw new Error('CLI 开关状态不完整，请重新打开设置')
  }
  return parsed.enabled
}
function connectionStatus(
  enabled: boolean | undefined,
  account?: AccountEntry,
  catalogConnection: CatalogConnection = 'unknown',
  settingsError = '',
) {
  if (enabled === false) return { state: 'disabled', label: '已关闭' }
  if (settingsError) return { state: 'failed', label: 'CLI 开关配置读取失败，请重新打开设置' }
  if (enabled === undefined || !account || account.loading) return { state: 'pending', label: '正在检查连接' }
  if (!account.error && account.data?.state === 'unconfigured')
    return { state: 'unconfigured', label: account.data.summary || '尚未配置 CLI' }
  if (account.error || !account.data || ['unavailable', 'unauthenticated'].includes(account.data.state)) {
    return { state: 'failed', label: account.error || account.data?.summary || '连接失败' }
  }
  if (catalogConnection === 'failed') return { state: 'failed', label: '模型目录读取失败，请刷新模型重试' }
  if (!['authenticated', 'configured'].includes(account.data.state)) {
    return {
      state: 'unknown',
      label: 'CLI 已安装，连接状态待验证',
    }
  }
  return {
    state: 'connected',
    label:
      account.data.state === 'authenticated'
        ? account.data.verification === 'local'
          ? '已保存登录信息，未进行远程验证'
          : 'CLI 报告账号已登录，未进行远程验证'
        : '已读取本地凭据配置，未进行远程验证',
  }
}

/** Native modal owns focus, dismissal, theme, elevation and entrance animation. */
export function SettingsDialog(props: SettingsDialogProps) {
  // Closing unmounts pending requests and the user-operated account terminal.
  return props.open ? <OpenSettingsDialog {...props} /> : null
}
function OpenSettingsDialog({
  onClose,
  api,
  sessionId,
  initialCli,
  openNativeSettings,
}: SettingsDialogProps) {
  const [cli, setCli] = useState<CliId>(isRetiredCli(initialCli) ? 'hermes' : initialCli)
  const [page, setPage] = useState<'cli' | 'roles'>('cli')
  const [cliExpanded, setCliExpanded] = useState(true)
  const cliGroupId = useId()
  const [enabled, setEnabled] = useState<Enabled>()
  const [order, setOrder] = useState<readonly CliId[]>(CLI_IDS)
  const [settingsError, setSettingsError] = useState('')
  const [togglingCli, setTogglingCli] = useState<CliId>()
  const [toggleErrors, setToggleErrors] = useState<Partial<Record<CliId, string>>>({})
  const [accounts, setAccounts] = useState<Partial<Record<CliId, AccountEntry>>>({})
  const [verifiedCatalogs, setVerifiedCatalogs] = useState<Partial<Record<CliId, CatalogConnection>>>({})
  const catalogResult = useCallback((id: CliId, verified: CatalogConnection) => {
    setVerifiedCatalogs((old) => ({ ...old, [id]: verified }))
  }, [])
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const probes = useRef(new Map<CliId, AbortController>())
  const toggleController = useRef<AbortController>()

  const refreshAccount = useCallback(
    (id: CliId) => {
      if (!enabledRef.current?.[id] || probes.current.has(id)) return
      const controller = new AbortController()
      probes.current.set(id, controller)
      setAccounts((old) => ({ ...old, [id]: { data: old[id]?.data, loading: true } }))
      void (async () => {
        try {
          const next: AccountStatus = JSON.parse(
            value(await api.cliworker.accountStatus(sessionId, id, controller.signal)),
          )
          if (next.cli !== id) throw new Error('收到不匹配的 CLI 账号状态，请重试')
          if (!controller.signal.aborted)
            setAccounts((old) => ({ ...old, [id]: { data: next, loading: false } }))
        } catch (error) {
          if (!controller.signal.aborted)
            setAccounts((old) => ({ ...old, [id]: { loading: false, error: operationMessage(error) } }))
        } finally {
          if (probes.current.get(id) === controller) probes.current.delete(id)
        }
      })()
    },
    [api, sessionId],
  )

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const next = readEnabled(value(await api.cliworker.cliSettings(sessionId, controller.signal)))
        if (controller.signal.aborted) return
        enabledRef.current = next
        setEnabled(next)
        // Keep this ordering for the lifetime of the open dialog. A toggle does
        // not move the row under the pointer; reopening applies the saved order.
        setOrder([...CLI_IDS].sort((a, b) => Number(next[b]) - Number(next[a])))
      } catch (error) {
        if (!controller.signal.aborted) setSettingsError(operationMessage(error))
      }
    })()
    return () => {
      controller.abort()
      toggleController.current?.abort()
      for (const probe of probes.current.values()) probe.abort()
      probes.current.clear()
    }
  }, [api, sessionId])
  useEffect(() => {
    if (!enabled) return
    for (const id of CLI_IDS) {
      if (enabled[id]) {
        if (!accounts[id]) refreshAccount(id)
      } else {
        probes.current.get(id)?.abort()
        probes.current.delete(id)
        if (accounts[id])
          setAccounts((old) => {
            const next = { ...old }
            delete next[id]
            return next
          })
      }
    }
    // A completed or failed probe is cached until explicitly refreshed. This
    // effect runs only when enablement changes, never on each response/render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshAccount])

  async function toggleCli(id: CliId, nextValue: boolean) {
    if (!enabled || toggleController.current) return
    const controller = new AbortController()
    toggleController.current = controller
    setTogglingCli(id)
    setToggleErrors((old) => ({ ...old, [id]: '' }))
    try {
      const next = readEnabled(
        value(await api.cliworker.setCliEnabled(sessionId, id, nextValue, controller.signal)),
      )
      if (!controller.signal.aborted) {
        enabledRef.current = next
        setEnabled(next)
        if (!next[id]) catalogResult(id, 'unknown')
      }
    } catch (error) {
      if (!controller.signal.aborted) setToggleErrors((old) => ({ ...old, [id]: operationMessage(error) }))
    } finally {
      if (!controller.signal.aborted) {
        toggleController.current = undefined
        setTogglingCli(undefined)
      }
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="CLI Worker 设置"
      closeLabel="关闭设置"
      className="cwn-settings-dialog"
      contentClassName="cwn-settings-content"
    >
      <div className="cwn-settings-layout">
        <nav className="cwn-settings-nav" aria-label="CLI 设置导航">
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="cwn-settings-nav-primary"
            aria-label="智能体设置"
            aria-pressed={page === 'roles'}
            onClick={() => setPage('roles')}
          >
            <span className="cwn-settings-nav-icon" aria-hidden="true">
              <IconUserOutlineRegular size={20} />
            </span>
            <span className="cwn-settings-nav-label">智能体设置</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="cwn-settings-nav-primary"
            aria-label="CLI 连接"
            aria-expanded={cliExpanded}
            aria-controls={cliGroupId}
            onClick={() => setCliExpanded((expanded) => !expanded)}
          >
            <span className="cwn-settings-nav-icon" aria-hidden="true">
              <IconLinkOutlineRegular size={20} />
            </span>
            <span className="cwn-settings-nav-label">CLI 连接</span>
            <IconChevronDownOutlineRegular size={14} className="cwn-settings-nav-chevron" />
          </Button>
          <div
            id={cliGroupId}
            className="cwn-settings-cli-group"
            data-expanded={cliExpanded}
            aria-hidden={!cliExpanded}
            {...(!cliExpanded ? { inert: '' } : {})}
          >
            <div className="cwn-settings-cli-group-inner">
              {order.map((id) => {
                const connection = connectionStatus(
                  enabled?.[id],
                  accounts[id],
                  verifiedCatalogs[id],
                  settingsError,
                )
                return (
                  <Button
                    key={id}
                    type="button"
                    variant="ghost"
                    size="md"
                    className="cwn-settings-cli-item"
                    aria-label={`${CLI_LABELS[id]} 设置`}
                    aria-pressed={page === 'cli' && cli === id}
                    tabIndex={cliExpanded ? undefined : -1}
                    data-enabled={enabled?.[id] !== false}
                    onClick={() => {
                      setCli(id)
                      setPage('cli')
                    }}
                  >
                    <BrandIcon cli={id} size={22} />
                    <span className="cwn-settings-nav-label">{CLI_LABELS[id]}</span>
                    <Tooltip label={connection.label} side="right" portal>
                      <span className="cwn-settings-nav-status" role="img" aria-label={connection.label}>
                        {connection.state === 'pending' ? (
                          <StateDot state="ongoing" size={12} />
                        ) : (
                          <span className="cwn-connection-dot" data-state={connection.state} />
                        )}
                      </span>
                    </Tooltip>
                  </Button>
                )
              })}
            </div>
          </div>
        </nav>
        {page === 'roles' ? (
          <RolePresetsPane api={api} sessionId={sessionId} />
        ) : (
          <CliSettings
            openNativeSettings={openNativeSettings}
            key={`${sessionId}:${cli}`}
            api={api}
            sessionId={sessionId}
            cli={cli}
            enabled={enabled?.[cli]}
            account={accounts[cli]}
            connection={connectionStatus(enabled?.[cli], accounts[cli], verifiedCatalogs[cli], settingsError)}
            onRefreshAccount={() => refreshAccount(cli)}
            onCatalogResult={catalogResult}
            onToggle={(next) => void toggleCli(cli, next)}
            toggleBusy={!!togglingCli}
            toggling={togglingCli === cli}
            settingsError={settingsError}
            toggleError={toggleErrors[cli] || ''}
          />
        )}
      </div>
    </Modal>
  )
}

function NativeChoice({
  label,
  selected,
  choices,
  disabled,
  onChange,
}: {
  label: string
  selected: string
  choices: { id: string; label: string }[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  return (
    <Menu
      open={open && !disabled}
      onClose={() => setOpen(false)}
      portal
      align="start"
      className="cwn-settings-choice"
      listClassName="cwn-settings-choice-menu"
      selectedId={selected}
      items={choices}
      onSelect={(id) => {
        onChange(id)
        setOpen(false)
      }}
      anchor={
        <Button
          type="button"
          variant="outline"
          size="md"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          disabled={disabled}
          onClick={() => setOpen((old) => !old)}
        >
          <span>
            {choices.find((choice) => choice.id === selected)?.label ??
              (label === '默认思考强度' ? '选择强度' : '选择模型')}
          </span>
          <IconChevronDownOutlineRegular size={14} />
        </Button>
      }
    />
  )
}

function SectionProgress({ loading, label }: { loading: boolean; label: string }) {
  return (
    <span className="cwn-section-progress" role="status" aria-label={loading ? label : undefined}>
      {loading && <StateDot state="ongoing" size={14} />}
    </span>
  )
}

/** Render only the Host's safe identity projection, never raw CLI output. */
function AccountSummary({
  account,
  enabled,
  loading,
  settingsError,
  logout,
  connection,
}: {
  logout?: ReactNode
  account?: AccountEntry
  enabled?: boolean
  loading: boolean
  settingsError: string
  connection: ReturnType<typeof connectionStatus>
}) {
  const data = account?.data
  const current = enabled === true && !loading && !settingsError && !account?.error
  const authenticated = current && data?.state === 'authenticated'
  const apiLogin = authenticated && data.authMethod === 'api'
  const state = connection.state
  const label =
    enabled === false
      ? '已关闭'
      : settingsError
        ? '状态暂不可用'
        : loading
          ? '正在读取登录信息…'
          : account?.error
            ? '状态暂不可用'
            : connection.state === 'failed'
              ? data?.state === 'unauthenticated'
                ? '登录失效'
                : '配置或连接失败'
              : authenticated
                ? apiLogin
                  ? 'API 登录'
                  : '已登录'
                : data?.state === 'unconfigured'
                  ? data.installed
                    ? '未配置'
                    : '未安装'
                  : data?.state === 'configured'
                    ? '已配置'
                    : connection.state === 'connected'
                      ? '模型目录已连接'
                      : '状态待确认'
  const detail =
    enabled === false
      ? '开启后即可管理账号与模型。'
      : settingsError
        ? '请重新打开设置后重试'
        : loading
          ? ''
          : account?.error
            ? account.error
            : connection.state === 'failed'
              ? connection.label
              : authenticated
                ? data.verification === 'local'
                  ? '本地登录信息，未进行远程验证'
                  : apiLogin
                    ? '使用 CLI 当前配置的 API 凭据，未进行远程验证'
                    : '登录状态由 CLI 提供，未进行远程验证'
                : data?.state === 'configured'
                  ? '已读取本地凭据配置，未进行远程验证'
                  : connection.state === 'connected'
                    ? [data?.summary, connection.label].filter(Boolean).join('；')
                    : (data?.summary ?? '')
  return (
    <div className="cwn-account-summary" data-account-state={current ? data?.state : undefined} role="status">
      <div className="cwn-account-status-line">
        <Tooltip label={detail || label} side="top" portal>
          <span className="cwn-account-login" data-state={state}>
            <span className="cwn-account-status-dot" data-state={state} aria-hidden="true" />
            {label}
          </span>
        </Tooltip>
        {authenticated && !apiLogin && (
          <span className="cwn-account-label" title={data.accountLabel}>
            {data.accountLabel || 'CLI 未提供账号信息'}
          </span>
        )}
        {authenticated && logout}
      </div>
      {(!authenticated || connection.state === 'failed') && detail && (
        <div className="cwn-account-detail" role="status">
          {detail}
        </div>
      )}
    </div>
  )
}
function CliSettings({
  openNativeSettings,
  api,
  sessionId,
  cli,
  enabled,
  account,
  connection,
  onRefreshAccount,
  onCatalogResult,
  onToggle,
  toggleBusy,
  toggling,
  settingsError,
  toggleError,
}: {
  openNativeSettings?: () => void
  api: API
  sessionId: string
  cli: CliId
  enabled?: boolean
  account?: AccountEntry
  connection: ReturnType<typeof connectionStatus>
  onRefreshAccount: () => void
  onCatalogResult: (cli: CliId, verified: CatalogConnection) => void
  onToggle: (enabled: boolean) => void
  toggleBusy: boolean
  toggling: boolean
  settingsError: string
  toggleError: string
}) {
  const [catalog, setCatalog] = useState<Catalog>()
  const [modelLoading, setModelLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [modelError, setModelError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const [modelRevision, refreshModels] = useState(0)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<Preference['effort']>('default')
  const [action, setAction] = useState<AccountAction>()
  const [chosenAction, setChosenAction] = useState<AccountStatus['actions'][number]>()
  const saveController = useRef<AbortController>()
  useEffect(() => () => saveController.current?.abort(), [])
  useEffect(() => {
    if (!enabled) {
      setModelLoading(false)
      onCatalogResult(cli, 'unknown')
      return
    }
    const controller = new AbortController()
    setModelLoading(true)
    setModelError('')
    setSaved(false)
    void (async () => {
      try {
        const next: Catalog = JSON.parse(
          value(await api.cliworker.catalogForCli(sessionId, cli, controller.signal)),
        )
        if (next.cli !== cli) throw new Error('收到不匹配的 CLI 模型目录，请重试')
        if (controller.signal.aborted) return
        setCatalog(next)
        onCatalogResult(cli, next.models.length > 0 ? 'success' : 'failed')
        if (!next.models.length) setModelError('此 CLI 未返回可用模型，请刷新重试')
        const preferred = next.preference ? modelName(next.preference) : ''
        const saved = next.models.find(
          (item) =>
            item.id === preferred ||
            Object.values(item.variants ?? {}).includes(next.preference?.model ?? ''),
        )
        const chosen = next.preference ? saved : visibleModelChoices(next.models)[0]
        if (next.preference && !saved && next.models.length)
          setModelError('原默认模型已不可用，请重新选择模型')
        setModel(chosen?.id ?? '')
        setEffort(
          next.preference && chosen?.efforts?.includes(next.preference.effort)
            ? next.preference.effort
            : (chosen?.efforts?.[0] ?? 'default'),
        )
      } catch (error) {
        if (!controller.signal.aborted) {
          setCatalog(undefined)
          onCatalogResult(cli, 'failed')
          setModel('')
          setModelError(operationMessage(error))
        }
      } finally {
        if (!controller.signal.aborted) setModelLoading(false)
      }
    })()
    return () => controller.abort()
  }, [api, sessionId, cli, enabled, modelRevision, onCatalogResult])
  const inactive = !enabled || toggling
  const settingsPending = enabled === undefined && !settingsError
  const accountLoading = !settingsError && enabled !== false && (!account || account.loading)
  const supportedEfforts = catalog?.models.find((item) => item.id === model)?.efforts ?? []
  const validPreference = !!catalog && !!model && supportedEfforts.includes(effort)
  async function save() {
    if (inactive || saving || modelLoading || !validPreference || saveController.current) return
    const controller = new AbortController()
    saveController.current = controller
    setSaving(true)
    setSaveError('')
    setSaved(false)
    try {
      value(
        await api.cliworker.configure(sessionId, JSON.stringify({ cli, model, effort }), controller.signal),
      )
      if (!controller.signal.aborted) setSaved(true)
    } catch (error) {
      if (!controller.signal.aborted) setSaveError(operationMessage(error))
    } finally {
      if (!controller.signal.aborted) {
        saveController.current = undefined
        setSaving(false)
      }
    }
  }
  const changeModel = (id: string) => {
    setModel(id)
    setSaved(false)
    const efforts = catalog?.models.find((item) => item.id === id)?.efforts ?? ['default']
    if (!efforts.includes(effort)) setEffort(efforts[0] ?? 'default')
  }
  const finishedAccountAction = () => {
    onRefreshAccount()
    refreshModels((n) => n + 1)
  }
  const closeAccount = () => {
    setAction(undefined)
  }
  const accountAction = (id: AccountAction) => {
    const item = account?.data?.actions.find((candidate) => candidate.id === id)
    const label =
      item?.target === 'models'
        ? id === 'login'
          ? '登录设置'
          : '打开原生设置'
        : (item?.label ??
          (id === 'logout'
            ? '退出登录'
            : id === 'manage'
              ? '账号终端'
              : ['omp', 'pi', 'hermes', 'opencode'].includes(cli)
                ? '登录设置'
                : '登录 / 切换账号'))
    return (
      <Tooltip label={item?.description || account?.data?.summary || label} side="top" portal>
        <Button
          type="button"
          variant={id === 'logout' ? 'ghost' : 'outline'}
          size="md"
          className={
            id === 'logout'
              ? 'cwn-account-logout'
              : id === 'manage'
                ? 'cwn-account-manage'
                : 'cwn-account-login-action'
          }
          aria-label={label}
          disabled={
            inactive ||
            accountLoading ||
            !!account?.error ||
            !!action ||
            !item ||
            (item.target === 'models' && !openNativeSettings)
          }
          onClick={() => {
            if (!inactive && item) {
              if (item.target === 'models') {
                openNativeSettings?.()
                return
              }
              setChosenAction(item)
              setAction(item.id)
            }
          }}
        >
          {id === 'logout' ? (
            <>
              <Glyph name="logout" />
              退出
            </>
          ) : item?.target === 'models' ? (
            label
          ) : id === 'manage' ? (
            <>
              <Glyph name="tool" />
              账号终端
            </>
          ) : item?.label === '登录设置' ? (
            '登录设置'
          ) : account?.data?.state === 'authenticated' ? (
            '切换账号'
          ) : (
            '登录账号'
          )}
        </Button>
      </Tooltip>
    )
  }
  return (
    <div className="cwn-settings-pane" aria-label={`${CLI_LABELS[cli]} 配置`}>
      <div className="cwn-cli-identity" data-enabled={enabled !== false}>
        <div className="cwn-settings-cli-name">
          <BrandIcon cli={cli} size={40} />
          <div>
            <h2>{CLI_LABELS[cli]}</h2>
            <p className="cwn-cli-subtitle">管理账号与模型偏好</p>
          </div>
        </div>
        <div className="cwn-cli-toggle">
          <SectionProgress
            loading={settingsPending || toggling}
            label={toggling ? '正在保存 CLI 开关' : '正在读取 CLI 开关'}
          />
          <Switch
            checked={enabled ?? false}
            onChange={onToggle}
            label={`启用 ${CLI_LABELS[cli]}`}
            disabled={enabled === undefined || toggleBusy || saving || !!action}
            title={action ? '请先关闭账号终端' : undefined}
          />
        </div>
      </div>
      <div className="cwn-cli-toggle-status" role="status">
        {settingsError ||
          toggleError ||
          (enabled === false ? '已关闭；历史记录仍可查看，开启后可继续使用。' : '')}
      </div>
      <section className="cwn-settings-section" aria-label="账号与登录">
        <div className="cwn-settings-section-head">
          <h3>账号与登录</h3>
          <div className="cwn-settings-section-tools">
            <SectionProgress loading={accountLoading} label={`正在读取 ${CLI_LABELS[cli]} 账号…`} />
            <Tooltip label="刷新登录状态" side="top" portal>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="cwn-refresh"
                aria-label="刷新状态"
                disabled={inactive || accountLoading}
                onClick={onRefreshAccount}
              >
                <IconRefreshOutlineRegular size={16} />
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="cwn-account-row">
          <AccountSummary
            account={account}
            connection={connection}
            enabled={enabled}
            loading={accountLoading}
            settingsError={settingsError}
            logout={accountAction('logout')}
          />
          <div className="cwn-account-actions">
            {accountAction('login')}
            {accountAction('manage')}
          </div>
        </div>
        {action && enabled && (
          <Modal
            open
            onClose={closeAccount}
            title={`${CLI_LABELS[cli]} · ${chosenAction?.label ?? '账号终端'}`}
            closeLabel="关闭账号操作"
            className="cwn-account-dialog"
            contentClassName="cwn-account-dialog-content"
          >
            <AccountTerminal
              api={api}
              sessionId={sessionId}
              cli={cli}
              action={action}
              onClose={() => setAction(undefined)}
              onFinished={finishedAccountAction}
            />
          </Modal>
        )}
      </section>
      <section className="cwn-settings-section" aria-label="项目默认设置">
        <div className="cwn-settings-section-head">
          <h3>项目默认设置</h3>
          <div className="cwn-settings-section-tools">
            <SectionProgress
              loading={!settingsError && enabled !== false && (modelLoading || settingsPending)}
              label={`正在读取 ${CLI_LABELS[cli]} 模型…`}
            />
            <Tooltip label="刷新模型列表" side="top" portal>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="cwn-refresh"
                aria-label="刷新模型"
                disabled={inactive || modelLoading || saving}
                onClick={() => refreshModels((n) => n + 1)}
              >
                <IconRefreshOutlineRegular size={16} />
              </Button>
            </Tooltip>
          </div>
        </div>
        <form
          className="cwn-settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="cwn-setting-row">
            <span className="cwn-setting-row-text">
              <span>模型</span>
              <span className="cwn-setting-description">此项目新任务使用的默认模型</span>
            </span>
            <NativeChoice
              label="默认模型"
              selected={model}
              choices={visibleModelChoices(catalog?.models ?? [], model).map((item) => ({
                id: item.id,
                label: item.label,
              }))}
              disabled={inactive || modelLoading || saving || !catalog}
              onChange={changeModel}
            />
          </label>
          <label className="cwn-setting-row">
            <span className="cwn-setting-row-text">
              <span>思考强度</span>
              <span className="cwn-setting-description">仅提供当前模型支持的选项</span>
            </span>
            <NativeChoice
              label="默认思考强度"
              selected={effort}
              choices={supportedEfforts.map((id) => ({ id, label: effortLabel(id) }))}
              disabled={inactive || modelLoading || saving || !catalog}
              onChange={(id) => {
                setEffort(id as Preference['effort'])
                setSaved(false)
              }}
            />
          </label>
          <p className="cwn-settings-notice cwn-settings-hint" role="status">
            {modelError || ''}
          </p>
          <div className="cwn-settings-save">
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={inactive || modelLoading || saving || !validPreference}
            >
              {saving && <StateDot state="ongoing" size={14} />}保存默认值
            </Button>
            <span className="cwn-settings-feedback-slot" role="status">
              {saveError || (saved ? '默认设置已保存' : '')}
            </span>
          </div>
        </form>
      </section>
    </div>
  )
}
