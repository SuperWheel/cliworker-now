import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Menu,
  Modal,
  StateDot,
  Tooltip,
  IconChevronDownOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CLI_IDS,
  CLI_LABELS,
  effortLabel,
  type CliId,
  type ModelChoice,
  type Preference,
} from '../shared/types.ts'
import type { AccountAction, AccountStatus } from '../shared/accounts.ts'
import { modelName } from '../shared/models.ts'
import { AccountTerminal } from './account-terminal.tsx'
import { BrandIcon } from './icons.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  api: API
  sessionId: string
  initialCli: CliId
}
interface Catalog {
  cli: CliId
  models: ModelChoice[]
  preference?: Preference
  notice?: string
}

/** Native modal owns focus, dismissal, theme, elevation and entrance animation. */
export function SettingsDialog(props: SettingsDialogProps) {
  // Closing unmounts pending requests and the user-operated account terminal.
  return props.open ? <OpenSettingsDialog {...props} /> : null
}
function OpenSettingsDialog({ onClose, api, sessionId, initialCli }: SettingsDialogProps) {
  const [cli, setCli] = useState(initialCli)
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
          {CLI_IDS.map((id) => (
            <Button
              key={id}
              type="button"
              variant="ghost"
              size="md"
              aria-label={`${CLI_LABELS[id]} 设置`}
              aria-pressed={cli === id}
              onClick={() => setCli(id)}
            >
              <BrandIcon cli={id} size={22} />
              {CLI_LABELS[id]}
            </Button>
          ))}
        </nav>
        <CliSettings key={`${sessionId}:${cli}`} api={api} sessionId={sessionId} cli={cli} />
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

function CliSettings({ api, sessionId, cli }: { api: API; sessionId: string; cli: CliId }) {
  const [account, setAccount] = useState<AccountStatus>()
  const [catalog, setCatalog] = useState<Catalog>()
  const [accountLoading, setAccountLoading] = useState(true)
  const [modelLoading, setModelLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [modelError, setModelError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  const [accountRevision, refreshAccount] = useState(0)
  const [modelRevision, refreshModels] = useState(0)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<Preference['effort']>('default')
  const [action, setAction] = useState<AccountAction>()
  const saveController = useRef<AbortController>()
  // Each selected CLI owns a fresh component. Aborting on cleanup prevents late
  // discovery/save results from affecting another CLI or a reopened dialog.
  useEffect(() => () => saveController.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setAccountLoading(true)
    setAccountError('')
    void (async () => {
      try {
        const next: AccountStatus = JSON.parse(
          value(await api.cliworker.accountStatus(sessionId, cli, controller.signal)),
        )
        if (next.cli !== cli) throw new Error('收到不匹配的 CLI 账号状态，请重试')
        if (!controller.signal.aborted) setAccount(next)
      } catch (error) {
        if (!controller.signal.aborted) setAccountError(operationMessage(error))
      } finally {
        if (!controller.signal.aborted) setAccountLoading(false)
      }
    })()
    return () => controller.abort()
  }, [api, sessionId, cli, accountRevision])
  useEffect(() => {
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
        const preferred = next.preference ? modelName(next.preference) : ''
        const chosen = next.models.find((item) => item.id === preferred) ?? next.models[0]
        setModel(chosen?.id ?? '')
        setEffort(
          next.preference && chosen?.efforts?.includes(next.preference.effort)
            ? next.preference.effort
            : (chosen?.efforts?.[0] ?? 'default'),
        )
      } catch (error) {
        if (!controller.signal.aborted) {
          setCatalog(undefined)
          setModel('')
          setModelError(operationMessage(error))
        }
      } finally {
        if (!controller.signal.aborted) setModelLoading(false)
      }
    })()
    return () => controller.abort()
  }, [api, sessionId, cli, modelRevision])
  const supportedEfforts = catalog?.models.find((item) => item.id === model)?.efforts ?? []
  const validPreference = !!catalog && !!model && supportedEfforts.includes(effort)
  async function save() {
    if (saving || modelLoading || !validPreference || saveController.current) return
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
    refreshAccount((n) => n + 1)
    refreshModels((n) => n + 1)
  }
  return (
    <div className="cwn-settings-pane" aria-label={`${CLI_LABELS[cli]} 配置`}>
      <section className="cwn-settings-section" aria-label="账号与登录">
        <div className="cwn-settings-section-head">
          <h3>账号与登录</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={accountLoading}
            onClick={() => refreshAccount((n) => n + 1)}
          >
            刷新状态
          </Button>
        </div>
        {accountLoading ? (
          <div className="cwn-local-loading" role="status">
            <StateDot state="ongoing" size={14} />
            {`正在读取 ${CLI_LABELS[cli]} 账号…`}
          </div>
        ) : accountError ? (
          <div className="cwn-settings-feedback" role="status">
            {accountError}
            <Button type="button" variant="ghost" size="sm" onClick={() => refreshAccount((n) => n + 1)}>
              重试账号状态
            </Button>
          </div>
        ) : account ? (
          <>
            <p className="cwn-account-summary" data-account-state={account.state}>
              {account.summary}
            </p>
            <div className="cwn-account-actions">
              {account.actions.map((item) => (
                <Tooltip key={item.id} label={item.description} side="bottom" portal>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!!action}
                    onClick={() => setAction(item.id)}
                  >
                    {item.label}
                  </Button>
                </Tooltip>
              ))}
            </div>
          </>
        ) : null}
        {action && (
          <AccountTerminal
            api={api}
            sessionId={sessionId}
            cli={cli}
            action={action}
            onClose={() => setAction(undefined)}
            onFinished={finishedAccountAction}
          />
        )}
      </section>
      <section className="cwn-settings-section" aria-label="项目默认设置">
        <div className="cwn-settings-section-head">
          <h3>项目默认设置</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={modelLoading || saving}
            onClick={() => refreshModels((n) => n + 1)}
          >
            刷新模型
          </Button>
        </div>
        <form
          className="cwn-settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {modelLoading && (
            <div className="cwn-local-loading" role="status">
              <StateDot state="ongoing" size={14} />
              {`正在读取 ${CLI_LABELS[cli]} 模型…`}
            </div>
          )}
          <label>
            模型
            <NativeChoice
              label="默认模型"
              selected={model}
              choices={(catalog?.models ?? []).map((item) => ({ id: item.id, label: item.id }))}
              disabled={modelLoading || saving || !catalog}
              onChange={changeModel}
            />
          </label>
          <label>
            思考强度
            <NativeChoice
              label="默认思考强度"
              selected={effort}
              choices={supportedEfforts.map((id) => ({
                id,
                label: effortLabel(id),
              }))}
              disabled={modelLoading || saving || !catalog}
              onChange={(id) => {
                setEffort(id as Preference['effort'])
                setSaved(false)
              }}
            />
          </label>
          {modelError && (
            <div className="cwn-settings-feedback" role="status">
              {modelError}
              <Button type="button" variant="ghost" size="sm" onClick={() => refreshModels((n) => n + 1)}>
                重试模型查询
              </Button>
            </div>
          )}
          {catalog?.notice && <p className="cwn-settings-hint">{catalog.notice}</p>}
          <p className="cwn-settings-hint">仅影响此项目、此 CLI 之后新建的子 Agent，已有会话保留原配置。</p>
          {saveError && (
            <div className="cwn-settings-feedback" role="status">
              {saveError}
            </div>
          )}
          <div className="cwn-settings-save">
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={modelLoading || saving || !validPreference}
            >
              {saving && <StateDot state="ongoing" size={14} />}保存默认值
            </Button>
            {saved && <span role="status">默认设置已保存</span>}
          </div>
        </form>
      </section>
    </div>
  )
}
