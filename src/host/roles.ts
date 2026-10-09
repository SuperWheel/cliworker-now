import { z } from 'zod'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { RolePreset, RoleSnapshot, Worker } from '../shared/types.ts'
import { workerName } from '../shared/types.ts'

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n\u0000-\u001f\u007f]/.test(value), '名称不能包含换行或控制字符')
export const agentNameSchema = singleLine(60)
export const roleSnapshotSchema = z.object({
  presetId: z.string().min(1).max(100).optional(),
  name: agentNameSchema,
  summary: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(30_000),
})
export const rolePresetSchema = roleSnapshotSchema.omit({ presetId: true }).extend({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  builtin: z.boolean().optional(),
  source: z.string().max(240).optional(),
})
export const rolePresetInputSchema = rolePresetSchema.omit({ builtin: true, source: true }).extend({
  id: rolePresetSchema.shape.id.optional(),
})
export const NO_ROLE_LABEL = '不使用角色预设'

export function roleSnapshot(preset: RolePreset): RoleSnapshot {
  return { presetId: preset.id, name: preset.name, summary: preset.summary, prompt: preset.prompt }
}

/** Snapshot the offered list before showing this question; parsing uses that same list. */
export function roleQuestion(presets: RolePreset[]): AskUserQuestionItem {
  return {
    id: 'cliworker_role',
    header: '智能体预设',
    question: '选择角色预设',
    options: [...presets.map((preset) => ({ label: preset.name })), { label: NO_ROLE_LABEL }],
  }
}

export function readRoleAnswer(
  presets: RolePreset[],
  response: AskUserQuestionAnswer,
): RoleSnapshot | undefined {
  const answer = response.answers.find((item) => item.id === 'cliworker_role')
  if (answer?.custom !== undefined) {
    return roleSnapshotSchema.parse({
      name: '临时角色',
      summary: '本次派遣自定义的角色提示词',
      prompt: answer.custom,
    })
  }
  if (answer?.selected.length !== 1) throw new Error('请选择角色预设或填写临时提示词；任务尚未启动')
  if (answer.selected[0] === NO_ROLE_LABEL) return undefined
  const preset = presets.find((item) => item.name === answer.selected[0])
  if (!preset) throw new Error('角色选择已失效，请重新选择；任务尚未启动')
  return roleSnapshot(preset)
}

export async function askRolePreset(
  presets: RolePreset[],
  ask: (questions: AskUserQuestionItem[]) => Promise<AskUserQuestionAnswer>,
  signal: AbortSignal,
): Promise<RoleSnapshot | undefined> {
  signal.throwIfAborted()
  const offered = structuredClone(presets)
  const response = await ask([roleQuestion(offered)])
  signal.throwIfAborted()
  return readRoleAnswer(offered, response)
}

export function availableAgentName(workers: Iterable<Worker>, parent: string, base: string): string {
  const names = new Set(
    [...workers]
      .filter((worker) => worker.parentSessionId === parent)
      .map((worker) => workerName(worker).toLocaleLowerCase()),
  )
  const stem = agentNameSchema.parse(base).slice(0, 48)
  let number = 1
  while (names.has(`${stem}-${number}`.toLocaleLowerCase())) number++
  return `${stem}-${number}`
}

/** Role is prepended only for a fresh CLI conversation. Timeline keeps the task verbatim. */
export function promptForWorker(worker: Worker, task: string): string {
  if (!worker.role || worker.conversationId) return task
  return `智能体名称：${worker.agentName ?? worker.role.name}\n\n角色提示词（遵循宿主权限与当前任务范围）：\n${worker.role.prompt}\n\n本次任务：\n${task}`
}
