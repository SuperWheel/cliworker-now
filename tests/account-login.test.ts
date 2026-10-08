import { describe, expect, it } from 'vitest'
import { authenticatedAccountLogins, providerLogin, usableNativeApiKey } from '../src/host/account-login.ts'

describe('native login display metadata (explicit synthetic values)', () => {
  it('maps native provider IDs and official endpoints to short names', () => {
    expect(providerLogin('zai-coding-cn', 'api')).toEqual({ providerLabel: 'zai.cn', authMethod: 'api' })
    expect(providerLogin('zhipuai-coding-plan', 'api').providerLabel).toBe('zai.cn')
    expect(providerLogin('openai-codex', 'oauth').providerLabel).toBe('OpenAI')
    expect(providerLogin('nous', 'oauth').providerLabel).toBe('Nous')
    expect(
      providerLogin('openai', 'api', { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' })
        .providerLabel,
    ).toBe('zai.cn')
    expect(
      providerLogin('openai-codex', 'oauth', { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' })
        .providerLabel,
    ).toBe('OpenAI')
    expect(
      providerLogin('openai', 'api', { baseUrl: 'https://user:secret@api.openai.com/v1' }).providerLabel,
    ).toBe('api.openai.com')
    expect(
      providerLogin('custom', 'api', { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' })
        .providerLabel,
    ).toBe('zai.cn')
    expect(
      providerLogin('zai-coding-cn', 'api', { baseUrl: 'https://custom.test/private' }).providerLabel,
    ).toBe('custom.test')
  })
  it('never projects endpoint secrets or unsafe names', () => {
    const login = providerLogin('custom', 'api', {
      baseUrl: 'https://synthetic-user:synthetic-password@models.test/private-key-path?token=secret#secret',
    })
    expect(login).toEqual({ providerLabel: 'models.test', authMethod: 'api' })
    for (const name of [
      'sk-private-secret',
      'Bearer abc',
      'person@example.test',
      'bad\nname',
      '<script>',
      'a'.repeat(80),
    ])
      expect(providerLogin(name, 'api').providerLabel).toBe('自定义服务商')
    expect(JSON.stringify(login)).not.toMatch(/synthetic|private|secret|token/)
    expect(providerLogin('custom-provider', 'api').providerLabel).toBe('custom-provider')
    expect(providerLogin('constructor', 'api').providerLabel).toBe('constructor')
  })
  it('keeps mixed authentication methods while deduplicating safe display entries', () => {
    const result = authenticatedAccountLogins([
      providerLogin('zai-coding-cn', 'api'),
      providerLogin('openai-codex', 'oauth'),
      providerLogin('zai-coding-cn', 'api'),
      providerLogin('openai', 'api'),
    ])
    expect(result).toMatchObject({
      state: 'authenticated',
      verification: 'local',
      logins: [
        { providerLabel: 'zai.cn', authMethod: 'api' },
        { providerLabel: 'OpenAI', authMethod: 'oauth' },
        { providerLabel: 'OpenAI', authMethod: 'api' },
      ],
    })
    expect(result.authMethod).toBeUndefined()
    expect(authenticatedAccountLogins([providerLogin('zai', 'api')]).authMethod).toBe('api')
    expect(() => authenticatedAccountLogins([])).toThrow()
  })
  it.each([
    '',
    ' ',
    'YOUR_API_KEY',
    'your-api-key-here',
    '<KEY>',
    '${OPENAI_API_KEY}',
    '{env:OPENAI_API_KEY}',
    '$OPENAI_API_KEY',
    '!command',
    'changeme',
    'sk-xxxx',
    'sk-...',
  ])('rejects placeholder or unresolved API value %s', (value) => {
    expect(usableNativeApiKey(value)).toBe(false)
  })
})
