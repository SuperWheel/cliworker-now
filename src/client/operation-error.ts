/** Keep transport traces out of the conversation and selection options. */
export function operationMessage(error: unknown): string {
  const text = String(error)
  if (/HTTP 404/.test(text)) return '插件服务尚未更新，请重启 DeepSeek Harness 后重试。现有记录不会丢失。'
  if (/transport failure|Failed to fetch|NetworkError/.test(text)) return '暂时无法连接插件服务，请稍后重试。'
  return text
    .replace(/^.*cliworker\/unavailable[^:]*:\s*/, '')
    .replace(/^(?:(?:[A-Za-z_$][\w$]*Error|Error):\s*)+/, '')
}
