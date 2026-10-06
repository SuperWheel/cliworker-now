import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { workerName, type Worker } from '../shared/types.ts'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

export function RenameWorker({
  api,
  sessionId,
  worker,
  onClose,
}: {
  api: API
  sessionId: string
  worker: Worker
  onClose: () => void
}) {
  const [name, setName] = useState(workerName(worker))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  const save = async () => {
    if (pending.current) return
    if (!name.trim()) {
      setError('请输入智能体名称。')
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setSaving(true)
    setError('')
    try {
      value(await api.cliworker.renameWorker(sessionId, worker.id, name.trim(), controller.signal))
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
      onClose={onClose}
      title="智能体名称"
      closeLabel="关闭智能体命名"
      className="cwn-rename-dialog"
    >
      <form
        className="cwn-rename-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Input
          className="cwn-control-input"
          aria-label="新的智能体名称"
          autoFocus
          value={name}
          maxLength={60}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
        <p>之后可在主对话中通过这个名字继续调用。</p>
        <div className="cwn-role-feedback" role="alert">
          {error}
        </div>
        <div className="cwn-role-editor-actions">
          <Button type="button" size="md" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" size="md" variant="primary" disabled={saving}>
            {saving && <StateDot state="ongoing" size={14} />}保存名称
          </Button>
        </div>
      </form>
    </Modal>
  )
}
