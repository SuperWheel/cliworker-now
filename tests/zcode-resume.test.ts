import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ZCodeProtocol } from '../src/host/zcode-adapter.ts'

// Explicit simulated native processes: no installed CLI, API, credential or model is used.
const roots: string[] = []
const live: ChildProcess[] = []
afterEach(() => {
  for (const child of live.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(scenario = 'normal', explicitDefault = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zcode-resume-test-')))
  roots.push(root)
  const executable = join(root, 'simulated-native.mjs')
  const requestPath = join(root, 'resume-request.json')
  const auditPath = join(root, 'audit.ndjson')
  const conversationId = 'sess_fixture'
  const selection = {
    providerId: 'native-custom',
    modelId: 'new-model/with-slash',
    ...(explicitDefault ? { options: { reasoningLevel: 'high' } } : {}),
  }
  const argv = [
    process.execPath,
    executable,
    '--cwd',
    root,
    '--mode',
    'plan',
    '--output-format',
    'stream-json',
    '--disallowedTools',
    'Agent,Task,Skill,SendMessage',
    '--resume',
    conversationId,
    '--prompt',
    '任务：\nSimulated user task; $(touch nope) `touch also-nope`',
  ]
  const request = { executable, argv, project: root, conversationId, selection }
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 })
  writeFileSync(
    executable,
    `
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
const audit = value => appendFileSync(join(root, 'audit.ndjson'), JSON.stringify(value) + '\\n', { mode: 0o600 });
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
const store = join(root, 'native-selection.json');
const sessionId = 'sess_fixture';
const initial = { providerId:'old-native',modelId:'old-model',options:{reasoningLevel:'low'} };
const snapshot = () => ({ session:{sessionId:scenario==='wrong-session'?'sess_wrong':sessionId}, settings:{ model:{current:existsSync(store)?JSON.parse(readFileSync(store,'utf8')):initial, available:[{ref:{providerId:'native-custom',modelId:'new-model/with-slash'},reasoning:{levels:[{value:'low'},{value:'high'},{value:'disabled'}],defaultLevel:scenario==='no-default'?'unsupported':'disabled'}}]}}});
const server = process.argv.includes('app-server');
audit({type:server?'server-start':'headless-start',pid:process.pid,args:process.argv.slice(2)});
process.on('exit',()=>audit({type:server?'server-exit':'headless-exit',pid:process.pid}));
process.on('SIGTERM',()=>{audit({type:'terminated',server,pid:process.pid});if(!['hang-resume','hang-close'].includes(scenario))process.exit(0)});
if(server){
  const input=createInterface({input:process.stdin});
  let keep;
  if(['hang-resume','hang-close'].includes(scenario))keep=setInterval(()=>{},1000);
  input.on('line',line=>{
    const value=JSON.parse(line);audit({type:'rpc',...value});
    if(!value.method)return;
    if(value.method==='session/resume'){
      if(scenario==='hang-resume')return;
      if(scenario==='server-crash'){process.stderr.write('SENSITIVE_NATIVE_KEY');process.exit(7)};
      output({id:'native-runtime',method:'session/requestRuntimePreferences',params:{}});
      output({id:'native-interaction',method:'provider/requestRuntimeHeaders',params:{}});
      output({id:value.id,result:snapshot()});
    }else if(value.method==='session/setModel'){
      if(scenario==='rpc-error'){process.stderr.write('SENSITIVE_NATIVE_KEY');output({id:value.id,error:{message:'SENSITIVE_NATIVE_KEY'}});return};
      writeFileSync(store,JSON.stringify(value.params.model),{mode:0o600});
      output({id:value.id,result:snapshot()});
    }else if(value.method==='session/read'){
      const state=snapshot();
      if(scenario==='wrong-model')state.settings.model.current.modelId='wrong-model';
      if(scenario==='wrong-effort')state.settings.model.current.options.reasoningLevel='low';
      output({id:value.id,result:state});
    }else if(value.method==='session/close'){
      output({id:value.id,result:{closed:scenario!=='not-closed'}});
    }else {output({id:value.id,error:{message:'SENSITIVE_NATIVE_KEY'}})}
  });
  input.on('close',()=>{audit({type:'server-eof'});if(scenario!=='hang-close')process.exit(0)});
}else{
  const selected=JSON.parse(readFileSync(store,'utf8'));
  const observed=scenario==='observed-mismatch'?{...selected,modelId:'wrong-observed'}:selected;
  output({type:'session.updated',sessionId,payload:{providerId:observed.providerId,modelId:observed.modelId}});
  if(scenario==='cancel-headless'){output({type:'model.streaming',sessionId,payload:{kind:'text_delta',assistantMessageId:'msg',delta:'Simulated partial'}});setInterval(()=>{},1000)}
  else if(scenario==='observed-mismatch'){setInterval(()=>{},1000)}
  else{output({type:'turn.completed',sessionId,payload:{resultType:'success'}});output({type:'result',sessionId,response:'Simulated selected-model response'});}
}
`,
    { mode: 0o600 },
  )
  const records = () =>
    existsSync(auditPath)
      ? readFileSync(auditPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const launch = () => {
    const child = spawn(process.execPath, [resolve('src/host/zcode-resume.mjs'), requestPath], {
      cwd: root,
      env: { ...process.env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, 'personal.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    live.push(child)
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
      (fulfill, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => fulfill({ code, signal, stdout, stderr }))
      },
    )
    return { child, done }
  }
  return { root, request, requestPath, records, launch }
}

async function waitFor(check: () => boolean) {
  const until = Date.now() + 5000
  while (!check()) {
    if (Date.now() > until) throw new Error('Simulated process did not reach the requested stage')
    await new Promise((fulfill) => setTimeout(fulfill, 10))
  }
}
function assertExited(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow()
}

describe('ZCode resume selection wrapper (simulated native processes)', () => {
  it('sets and reads back model/effort before headless, closes metadata first, and forwards existing NDJSON', async () => {
    const f = fixture()
    const result = await f.launch().done
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(f.requestPath)).toBe(false)
    const records = f.records()
    const rpc = records.filter((value) => value.type === 'rpc' && value.method)
    expect(rpc.map((value) => value.method)).toEqual([
      'session/resume',
      'session/setModel',
      'session/read',
      'session/close',
    ])
    expect(rpc[0].params).toMatchObject({
      sessionId: 'sess_fixture',
      mcpServers: [],
      toolAllowlist: [],
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    })
    expect(rpc[1].params).toEqual({
      sessionId: 'sess_fixture',
      model: f.request.selection,
      persistAsWorkspaceLastUsed: false,
    })
    expect(records.findIndex((value) => value.type === 'server-exit')).toBeLessThan(
      records.findIndex((value) => value.type === 'headless-start'),
    )
    expect(records.find((value) => value.type === 'headless-start').args).toEqual(f.request.argv.slice(2))
    expect(records.some((value) => value.method === 'session/send')).toBe(false)
    expect(records.find((value) => value.id === 'native-runtime').result).toMatchObject({
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
    })
    expect(records.find((value) => value.id === 'native-interaction').error).toBeDefined()
    expect(result.stdout).not.toContain('settings')
    const ids: string[] = []
    const parser = new ZCodeProtocol(
      () => {},
      (id) => ids.push(id),
      1024 * 1024,
    )
    parser.feed(result.stdout)
    parser.end()
    expect(ids).toEqual(['sess_fixture'])
    expect(parser.result).toMatchObject({ status: 'SUCCESS', response: 'Simulated selected-model response' })
    for (const record of records.filter((value) => value.type.endsWith('-start'))) assertExited(record.pid)
  })

  it('uses only the matching model native default when the request does not override reasoning', async () => {
    const f = fixture('normal', false)
    expect((await f.launch().done).code).toBe(0)
    expect(f.records().find((value) => value.method === 'session/setModel').params.model.options).toEqual({
      reasoningLevel: 'disabled',
    })
  })

  it.each([
    'wrong-session',
    'wrong-model',
    'wrong-effort',
    'no-default',
    'rpc-error',
    'server-crash',
    'not-closed',
  ])('%s never starts a prompt process and never exposes native errors', async (scenario) => {
    const f = fixture(scenario, scenario !== 'no-default')
    const result = await f.launch().done
    expect(result.code).toBe(1)
    expect(f.records().some((value) => value.type === 'headless-start')).toBe(false)
    expect(result.stdout).toContain('会话选型或协议验证失败')
    expect(result.stdout + result.stderr).not.toContain('SENSITIVE_NATIVE_KEY')
    const parser = new ZCodeProtocol(
      () => {},
      () => {},
      1024 * 1024,
    )
    parser.feed(result.stdout)
    parser.end()
    expect(parser.result?.status).toBe('ERROR')
    for (const record of f.records().filter((value) => value.type === 'server-start'))
      assertExited(record.pid)
  })

  it.each(['hang-resume', 'hang-close'])(
    'cancelling %s waits for metadata exit and does not spawn headless',
    async (scenario) => {
      const f = fixture(scenario),
        running = f.launch()
      await waitFor(() =>
        f
          .records()
          .some(
            (value) => value.method === (scenario === 'hang-resume' ? 'session/resume' : 'session/close'),
          ),
      )
      running.child.kill('SIGTERM')
      const result = await running.done
      expect(result.code).toBe(143)
      expect(result.stdout).toContain('任务已停止')
      expect(result.stderr).toBe('')
      expect(f.records().some((value) => value.type === 'headless-start')).toBe(false)
      assertExited(f.records().find((value) => value.type === 'server-start').pid)
    },
  )

  it('cancels the prompt process and preserves an error terminal after partial output', async () => {
    const f = fixture('cancel-headless'),
      running = f.launch()
    await waitFor(() => f.records().some((value) => value.type === 'headless-start'))
    running.child.kill('SIGTERM')
    const result = await running.done
    expect(result.code).toBe(143)
    const parser = new ZCodeProtocol(
      () => {},
      () => {},
      1024 * 1024,
    )
    parser.feed(result.stdout)
    parser.end()
    expect(parser.result?.status).toBe('ERROR')
    assertExited(f.records().find((value) => value.type === 'headless-start').pid)
  })

  it('rejects a later observed model mismatch and removes the prompt process', async () => {
    const f = fixture('observed-mismatch')
    const result = await f.launch().done
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('wrong-observed')
    const parser = new ZCodeProtocol(
      () => {},
      () => {},
      1024 * 1024,
    )
    parser.feed(result.stdout)
    parser.end()
    expect(parser.result?.status).toBe('ERROR')
    assertExited(f.records().find((value) => value.type === 'headless-start').pid)
  })

  it('refuses a symlink request without reading or launching the target', async () => {
    const f = fixture(),
      outside = join(f.root, 'sensitive-source.json')
    rmSync(f.requestPath)
    writeFileSync(outside, 'SENSITIVE_NATIVE_KEY', { mode: 0o600 })
    symlinkSync(outside, f.requestPath)
    const result = await f.launch().done
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('SENSITIVE_NATIVE_KEY')
    expect(readFileSync(outside, 'utf8')).toBe('SENSITIVE_NATIVE_KEY')
    expect(f.records()).toEqual([])
  })

  it('rejects altered permission argv before starting metadata', async () => {
    const f = fixture()
    f.request.argv[f.request.argv.indexOf('--mode') + 1] = 'yolo'
    writeFileSync(f.requestPath, JSON.stringify(f.request), { mode: 0o600 })
    const result = await f.launch().done
    expect(result.code).toBe(1)
    expect(f.records()).toEqual([])
  })
})
