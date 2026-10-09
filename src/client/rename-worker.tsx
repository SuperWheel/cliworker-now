import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { workerName, type Worker } from '../shared/types.ts'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

export function RenameWorker({
  api,
  sessionId,
  worker,
  mode = 'name',
  onClose,
}: {
  api: API
  sessionId: string
  worker: Worker
  mode?: 'name' | 'title'
  onClose: () => void
}) {
  const titleMode = mode === 'title'
  const [name, setName] = useState(titleMode ? worker.title : workerName(worker))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  const close = () => {
    pending.current?.abort()
    pending.current = undefined
    onClose()
  }
  const save = async () => {
    if (pending.current) return
    if (!name.trim()) {
      setError(titleMode ? '请输入聊天标题。' : '请输入智能体名称。')
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setSaving(true)
    setError('')
    try {
      value(
        await (titleMode
          ? api.cliworker.renameWorkerTitle(sessionId, worker.id, name.trim(), controller.signal)
          : api.cliworker.renameWorker(sessionId, worker.id, name.trim(), controller.signal)),
      )
      if (!controller.signal.aborted) onClose()
    } catch (e) {
      if (!controller.signal.aborted) setError(operationMessage(e))
    } finally {
      if (!controller.signal.aborted) {
        pending.current = undefined
        setSaving(false)
      }
    }
  }
  return (
    <Modal
      open
      onClose={close}
      title={titleMode ? '聊天标题' : '智能体名称'}
      closeLabel={titleMode ? '关闭聊天标题编辑' : '关闭智能体命名'}
      className="cwn-rename-dialog"
      contentClassName="cwn-rename-content"
    >
      <form
        className="cwn-rename-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Input
          className="cwn-control-input cwn-rename-input"
          aria-label={titleMode ? '新的聊天标题' : '新的智能体名称'}
          data-modal-autofocus
          value={name}
          maxLength={titleMode ? 160 : 60}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
        {!titleMode && <p>之后可在主对话中通过这个名字继续调用。</p>}
        {error && (
          <div className="cwn-rename-error" role="alert">
            {error}
          </div>
        )}
        <div className="cwn-rename-actions">
          <Button type="button" size="md" variant="outline" onClick={close}>
            取消
          </Button>
          <Button type="submit" size="md" variant="primary" disabled={saving}>
            {saving && <StateDot state="ongoing" size={14} />}
            {titleMode ? '保存标题' : '保存名称'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
