import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import QRCode from 'qrcode'
import { IlinkClient, type IlinkProtocolClient, type LoginQr, type LoginStatus } from './ilink.js'
import { StateStore, type TokenState } from './pairing.js'

export interface LoginDependencies {
  readonly createClient?: (
    token: TokenState,
    persistToken: (token: TokenState) => void,
  ) => IlinkProtocolClient
  readonly pollIntervalMs?: number
  readonly output?: (chunk: string) => void
}

export async function login(
  dataDir = '~/.dsh-wechat',
  signal?: AbortSignal,
  dependencies: LoginDependencies = {},
): Promise<void> {
  const dir = resolve(expandHomePath(dataDir))
  const store = new StateStore(dir)
  const token = store.loadToken()
  const persistToken = (next: TokenState): void => store.saveToken(next)
  const client = dependencies.createClient?.(token, persistToken)
    ?? new IlinkClient(token, { persistToken })
  const pollIntervalMs = dependencies.pollIntervalMs ?? 2_000
  const output = dependencies.output ?? ((chunk: string) => process.stdout.write(chunk))
  try {
    for (let round = 1; round <= 3; round += 1) {
      const qr = await getQrWithRetry(client, signal)
      const qrPath = resolve(dir, 'wx_qr.png')
      const dataUrl = await QRCode.toDataURL(qr.imageContent, { margin: 1 })
      writeFileSync(qrPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), { mode: 0o600 })
      chmodSync(qrPath, 0o600)
      const terminalQr = await QRCode.toString(qr.imageContent, { type: 'terminal', small: true })
      output(`${terminalQr}\n二维码图片：${qrPath}\n`)

      while (!signal?.aborted) {
        await wait(pollIntervalMs, signal)
        let status: LoginStatus
        try {
          status = await client.getQrStatus(qr.qrcodeId, signal)
        } catch (error) {
          if (signal?.aborted) throw error
          continue
        }
        output(`二维码状态：${status.status}\n`)
        if (status.status === 'confirmed') {
          client.acceptLogin(status)
          output('微信登录成功。\n')
          return
        }
        if (status.status === 'expired') break
      }
      if (round < 3) output('二维码已过期，正在刷新。\n')
    }
    throw new Error('二维码多次过期，请重新运行登录')
  } finally {
    await client.close()
  }
}

async function getQrWithRetry(client: IlinkProtocolClient, signal?: AbortSignal): Promise<LoginQr> {
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await client.getBotQr(signal)
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
      if (attempt < 5) await wait(2 ** attempt * 1_000, signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('多次重试仍未获取到二维码')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('登录已取消'))
      return
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', aborted, { once: true })
    function done(): void {
      signal?.removeEventListener('abort', aborted)
      resolveWait()
    }
    function aborted(): void {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('登录已取消'))
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('登录已取消')))
  void login(process.argv[2], controller.signal).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`登录失败：${message}\n`)
    process.exitCode = 1
  })
}
